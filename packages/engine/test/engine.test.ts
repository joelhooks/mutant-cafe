// Integration tests exercise the real compiler and runtime filesystem boundaries.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { MutantSource, type Mutant, type RunConfig } from "@mutant-cafe/core";
import { makeMutantSource, makeTypeScriptOracle, MutantSourceLive } from "../src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const config = (tsconfig: string, overrides: Partial<RunConfig> = {}): RunConfig => ({
  root, tsconfig, include: [], exclude: [], functionFilter: [], jobs: 1,
  timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100,
  outDir: "mutants.out", ...overrides,
});
const fixture = config("fixtures/tagged-errors/tsconfig.json");
const extra = config("packages/engine/test/fixtures/tsconfig.json");
const collect = (source: MutantSource["Service"], input: RunConfig) => Stream.runCollect(source.generate(input));
const makeSource = () => makeMutantSource(makeTypeScriptOracle());

// Runtime entry point is known from the real fixture and exercised by both error scenarios.
interface AccountModule {
  readonly withdraw: (account: { id: string; balance: number; frozen: boolean }, amount: number) => Effect.Effect<unknown, { readonly _tag: string }>;
}
function loadMutation<A = AccountModule>(mutant: Mutant) {
  return Effect.gen(function* () {
    const original = yield* Effect.promise(() => readFile(mutant.file, "utf8"));
    const edit = mutant.replacement;
    const text = original.slice(0, edit.startOffset) + edit.text + original.slice(edit.endOffset);
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(resolve(root, "packages/engine/test/runtime-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    // Multi-module fixtures retain sibling imports in the runtime copy.
    for (const statement of ts.createSourceFile(mutant.file, original, ts.ScriptTarget.Latest, true).statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith("./")) {
        const sibling = statement.moduleSpecifier.text;
        const content = yield* Effect.promise(() => readFile(resolve(dirname(mutant.file), sibling), "utf8"));
        yield* Effect.promise(() => writeFile(resolve(directory, sibling), content));
      }
    }
    const file = resolve(directory, "account.mjs");
    yield* Effect.promise(() => writeFile(file, ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText));
    // SAFETY: each caller supplies the contract declared by its real fixture and exercises it.
    return yield* Effect.promise((): Promise<A> => import(pathToFileURL(file).href));
  });
}

describe("honest value coverage", () => {
  const input = config("packages/engine/test/fixtures/honesty/tsconfig.json", { include: ["**/values.ts"] });

  it.effect("isolates an unresolved typed call while analysing a bound generic method and its neighbours", () => Effect.gen(function* () {
    const source = makeSource();
    const all = { ...input, include: ["**/bound.ts", "**/unresolved.ts"] };
    const mutants = yield* collect(source, all);
    const bound = mutants.filter(mutant => mutant.functionName === "guardedInsert");
    expect(bound.length).toBeGreaterThan(0);
    expect(mutants.some(mutant => mutant.functionName === "healthy")).toBe(true);
    for (const mutant of bound) expect((yield* source.checkViable(mutant)).diagnostics).toEqual([]);
    const skipped = yield* source.notMutated(all);
    const broken = skipped.find(item => item.functionName === "unresolved");
    expect(broken?.file).toMatch(/unresolved\.ts$/);
    expect(broken?.span?.start.line).toBe(3);
    expect(broken?.reason).toMatch(/^analysis failed:/);
    // Inspect the actual checker result: this call has a signature but no declaration.
    const parsed = ts.getParsedCommandLineOfConfigFile(resolve(root, all.tsconfig), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(String(diagnostic.code)); } })!;
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    const unresolved = program.getSourceFiles().find(file => file.fileName.endsWith("/honesty/src/unresolved.ts"))!;
    let declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined;
    let found = false;
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.typeArguments?.length) {
        const signature = checker.getResolvedSignature(node);
        expect(signature).toBeDefined();
        declaration = signature?.declaration;
        found = true;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(unresolved);
    expect(found).toBe(true);
    expect(declaration).toBeUndefined();
    const discovered = makeTypeScriptOracle().discover(all);
    expect(discovered.functions.some(fn => fn.name === "unresolved")).toBe(true);
    expect(discovered.notMutated.some(item => item.functionName === "unresolved")).toBe(false);
    expect(mutants.some(mutant => mutant.functionName === "unresolved")).toBe(false);
  }), 30_000);

  it.effect("covers both boolean recoveries, and exposes a one-sided assertion", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, input);
    const results: boolean[] = [];
    const weakOutcomes: string[] = [];
    const weakTest = (exit: Exit.Exit<boolean, unknown>): void => {
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(false);
    };
    for (const mutant of mutants.filter(m => m.functionName === "service.allowed" && m.genre === "SwallowTag")) {
      expect((yield* source.checkViable(mutant)).diagnostics).toEqual([]);
      const module = yield* loadMutation<{ service: { allowed: (id: string) => Effect.Effect<boolean> } }>(mutant);
      const exit = yield* Effect.exit(module.service.allowed("example"));
      if (Exit.isSuccess(exit)) results.push(exit.value);
      const weakResult = yield* Effect.result(Effect.try(() => weakTest(exit)));
      weakOutcomes.push(Result.isFailure(weakResult) ? "caught" : "missed");
    }
    expect(results.sort()).toEqual([false, true]);
    // Execute a one-sided assertion: it accepts false recovery and rejects true recovery.
    expect(weakOutcomes.sort()).toEqual(["caught", "missed"]);
    const modes: string[] = [];
    for (const mutant of mutants.filter(m => m.functionName === "mode")) {
      const module = yield* loadMutation<{ mode: (n: number) => string }>(mutant);
      modes.push(module.mode(0));
    }
    expect(modes.sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const constants = mutants.filter(m => m.functionName === "always");
    expect(constants).toHaveLength(1);
    expect((yield* loadMutation<{ always: () => boolean }>(constants[0]!)).always()).toBe(false);
    const generatorConstants = mutants.filter(m => m.functionName === "stable" && m.genre === "EffectSucceed");
    expect(generatorConstants).toHaveLength(1);
    const generator = yield* loadMutation<{ stable: () => Effect.Effect<boolean> }>(generatorConstants[0]!);
    expect(yield* generator.stable()).toBe(false);
  }).pipe(Effect.scoped), 30_000);

  it.effect("bounds recursive Json to representatives and deduplicates collapsing values", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, input);
    const json = mutants.filter(m => m.functionName === "json" && !m.description.endsWith("with _key"));
    expect(json.length).toBeLessThanOrEqual(7);
    const values: unknown[] = [];
    for (const mutant of json) values.push((yield* loadMutation<{ json: (key: string) => unknown }>(mutant)).json("key"));
    expect(new Set(values.map(value => JSON.stringify(value)))).toEqual(new Set([null, "", 0, false, [], {}].map(value => JSON.stringify(value))));
    const collapsed: unknown[] = [];
    for (const mutant of mutants.filter(m => m.functionName === "collapse")) collapsed.push((yield* loadMutation<{ collapse: () => unknown }>(mutant)).collapse());
    expect(collapsed).toEqual([{ a: 0 }]);
    const capped = (yield* source.notMutated(input)).find(item => item.functionName === "json");
    expect(capped?.reason).toMatch(/\d+ more values not generated/);
  }).pipe(Effect.scoped), 30_000);

  it.effect("returns every assignable parameter, including branded and structural subtypes", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, input);
    const branded = mutants.find(m => m.functionName === "shardId" && m.description.endsWith("with parent"));
    expect(branded).toBeDefined();
    if (branded) {
      expect((yield* source.checkViable(branded)).diagnostics).toEqual([]);
      const module = yield* loadMutation<{ shardId: (parent: string, n: number) => string }>(branded);
      const original = yield* loadMutation<{ shardId: (parent: string, n: number) => string }>({ ...branded, replacement: { startOffset: 0, endOffset: 0, text: "" } });
      const assertDerived = (derive: (parent: string, n: number) => string): void => expect(derive("parent", 2)).not.toBe("parent");
      assertDerived(original.shardId);
      expect(() => assertDerived(module.shardId)).toThrow();
    }
    for (const [name, parameter] of [["wider", "parent"], ["coordinates", "point"]]) {
      const identity = mutants.find(m => m.functionName === name && m.description.endsWith(`with ${parameter}`));
      expect(identity, name).toBeDefined();
      if (identity) expect((yield* source.checkViable(identity)).diagnostics).toEqual([]);
    }
  }).pipe(Effect.scoped), 30_000);

  it.effect("reports distinct real callbacks and unconstructible errors at their own locations", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, input);
    const skipped = yield* source.notMutated(input);
    const callbacks = skipped.filter(item => item.functionName.startsWith("label"));
    expect(callbacks).toHaveLength(3);
    expect(new Set(callbacks.map(item => JSON.stringify(item.span)))).toHaveLength(3);
    for (const item of skipped) {
      expect(item.span?.start.line).toBeGreaterThan(0);
      expect(item.span?.start.column).toBeGreaterThan(0);
      expect(item.reason).not.toContain("~effect/");
    }
    expect(callbacks.every(item => item.reason === "callback position (not mutated yet)")).toBe(true);
    expect(skipped.some(item => item.functionName === "Id")).toBe(false);
    expect(mutants.some(item => item.functionName === "label")).toBe(true);
    expect(skipped.find(item => item.functionName === "attempt.catch")).toBeDefined();
    expect(new Set(skipped.map(item => JSON.stringify(item))).size).toBe(skipped.length);
    for (const [name, tag] of [["unavailable", "Hidden"], ["inferredUnavailable", "Hidden"], ["unbuildable", "NeedsCallback"]]) {
      expect(skipped.find(item => item.functionName === name)?.reason).toContain(`cannot construct ${tag}:`);
      const generated = mutants.filter(m => m.functionName === name);
      expect(generated.filter(m => m.genre === "SwallowTag")).toHaveLength(2);
      expect(generated.some(m => m.genre === "EffectDie")).toBe(true);
      for (const mutant of generated) expect((yield* source.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
    }
    expect(mutants.some(m => m.functionName === "state")).toBe(true);
    const stateMutant = mutants.find(m => m.functionName === "state")!;
    expect((yield* source.checkViable(stateMutant)).diagnostics).toEqual([]);
    expect(skipped.find(item => item.functionName === "factory")?.reason).toContain("return not synthesizable (field config); inner functions mutated");
    expect(mutants.some(item => item.functionName === "factory.guards.allowed")).toBe(true);
    expect(skipped.find(item => item.functionName === "deepState")?.reason).toContain("depth limit (4)");
  }), 30_000);
});

describe("round-two honesty regressions", () => {
  const input = config("packages/engine/test/fixtures/honesty/tsconfig.json");

  it.effect("keeps Layer builds, synthetic failures, notices and initializer-located exclusions", () => Effect.gen(function* () {
    const source = makeSource();
    const selected = { ...input, include: ["**/layers.ts"] };
    const mutants = yield* collect(source, selected);
    for (const name of ["configLayer", "memoryLayer", "combined"]) {
      const variants = mutants.filter(item => item.functionName === name);
      expect(variants.map(item => item.genre).sort()).toEqual(["LayerDie", "LayerFail"]);
      for (const mutant of variants) expect((yield* source.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
    }
    expect(mutants.filter(item => item.functionName === "controlLayer").map(item => item.genre)).toEqual(["LayerDie"]);
    const skipped = yield* source.notMutated(selected);
    expect(skipped.find(item => item.functionName === "combined")?.reason).toBe("cannot construct ReadProblem: field call");
    expect(skipped.find(item => item.functionName === "combined")?.span).toEqual(mutants.find(item => item.functionName === "combined")?.span);
    expect(skipped.find(item => item.functionName === "excludedLayer")?.reason).toContain("@mutants-skip");
    expect((yield* source.notMutated({ ...selected, exportedOnly: true })).find(item => item.functionName === "internalLayer")?.reason).toContain("--exported-only");
    expect((yield* source.notMutated({ ...selected, functionFilter: ["configLayer"] })).find(item => item.functionName === "combined")?.reason).toContain("function filter");
    const broken = { ...input, include: ["**/layer-hole.ts", "**/bound.ts"] };
    const discovered = makeTypeScriptOracle().discover(broken);
    expect(discovered.functions.some(fn => fn.name === "holeLayer" && fn.shape.kind === "Layer")).toBe(true);
    expect(discovered.notMutated.some(item => item.functionName === "holeLayer")).toBe(false);
    expect((yield* source.notMutated(broken)).find(item => item.functionName === "holeLayer")?.reason).toMatch(/^analysis failed:/);
    expect((yield* collect(source, broken)).some(item => item.functionName === "healthy")).toBe(true);
  }), 30_000);

  it.effect("bounds expanding types and wide text, prioritizes the original discriminant, and caps large recoveries", () => Effect.gen(function* () {
    const source = makeSource();
    const selected = { ...input, include: ["**/limits.ts"] };
    const mutants = yield* collect(source, selected);
    const skipped = yield* source.notMutated(selected);
    expect(mutants.some(item => ["recursive", "wide"].includes(item.functionName))).toBe(false);
    expect(skipped.find(item => item.functionName === "recursive")?.reason).toContain("depth limit (4)");
    expect(skipped.find(item => item.functionName === "wide")?.reason).toContain("2048 bytes");
    const variants: string[] = [];
    for (const mutant of mutants.filter(item => item.functionName === "diagnostic")) {
      const module = yield* loadMutation<{ diagnostic: (flag: boolean) => { kind: string; message: string } }>(mutant);
      const result = module.diagnostic(true);
      variants.push(result.kind);
      expect(result.message).toBe("");
    }
    expect(variants).toEqual(["K9", "K0", "K1", "K2", "K3", "K4"]);
    expect(skipped.find(item => item.functionName === "diagnostic")?.reason).toContain("4 more values not generated");
    expect(mutants.filter(item => item.functionName === "nine")).toHaveLength(6);
    expect(skipped.find(item => item.functionName === "nine")?.reason).toContain("3 more values not generated");
    const literals: string[] = [];
    for (const mutant of mutants.filter(item => item.functionName === "literal")) literals.push((yield* loadMutation<{ literal: () => string }>(mutant)).literal());
    expect(literals.sort()).toEqual(["a", "c"]);
    expect(mutants.filter(item => item.functionName === "many" && item.genre === "SwallowTag")).toHaveLength(2);
    expect(mutants.filter(item => item.functionName === "four" && item.genre === "SwallowTag")).toHaveLength(8);
    for (const name of ["numeric", "text", "struct"]) expect(mutants.filter(item => item.functionName === name && item.genre === "SwallowTag")).toHaveLength(2);
    expect(skipped.some(item => item.functionName.startsWith("excluded.<callback>"))).toBe(false);
    const filtered = yield* source.notMutated({ ...selected, functionFilter: ["diagnostic"] });
    expect(filtered.some(item => item.functionName === "internal.<callback>")).toBe(false);
    const exported = yield* source.notMutated({ ...selected, exportedOnly: true });
    expect(exported.some(item => item.functionName === "internal.<callback>")).toBe(false);
  }).pipe(Effect.scoped), 30_000);

  it.effect("represents a real declaration-less viability hole as a located skip, not unviable", () => Effect.gen(function* () {
    const source = makeSource();
    const [mutant] = yield* collect(source, { ...input, include: ["**/viability.ts"] });
    expect(mutant).toBeDefined();
    const broken = { ...mutant!, replacement: { ...mutant!.replacement, text: "dynamic<boolean>()" } };
    const result = yield* source.checkViable(broken);
    expect(result.analysisFailed?.reason).toMatch(/^analysis failed:/);
    expect(result.analysisFailed?.span).toEqual(mutant!.span);
    expect(result.diagnostics).toEqual([]);
  }));
});

describe("checker-directed mutation", () => {
  it.effect("keeps skips local to discovery and excludes local helpers from exported binding paths", () => Effect.gen(function* () {
    const oracle = makeTypeScriptOracle();
    const input = config("packages/engine/test/fixtures/coverage/tsconfig.json");
    const first = oracle.discover({ ...input, exportedOnly: true });
    const snapshot = [...first.notMutated];
    const second = oracle.discover(input);
    expect(first.notMutated).toEqual(snapshot);
    expect(first.notMutated).not.toBe(second.notMutated);
    for (const name of ["helperOwner.localDeclaration", "helperOwner.localArrow"]) {
      expect(second.functions.some(fn => fn.name === name), name).toBe(true);
      expect(first.functions.some(fn => fn.name === name), name).toBe(false);
      expect(first.notMutated.find(item => item.functionName === name)?.reason).toContain("--exported-only");
    }
    for (const name of ["Greeter.layer.greet", "Greeter.layer.send", "parenthesized.<inner>", "blocked.<inner>", "curriedEffect.<inner>"]) expect(first.functions.some(fn => fn.name === name), name).toBe(true);
    for (const name of ["callbacks", "argument"]) expect(second.notMutated.find(item => item.functionName === `${name}.<callback>`)?.reason).toBe("callback position (not mutated yet)");
    const service = makeMutantSource(oracle);
    const curried = yield* collect(service, { ...input, functionFilter: ["parenthesized.<inner>", "blocked.<inner>", "curriedEffect.<inner>"] });
    expect(curried.length).toBeGreaterThan(6);
    for (const mutant of curried) expect((yield* service.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
    const narrow = service.generate({ ...input, functionFilter: ["generic"] });
    yield* collect(service, input);
    expect(yield* Stream.runCollect(narrow)).toEqual([]);
    expect((yield* service.notMutated({ ...input, functionFilter: ["generic"] })).some(item => item.functionName === "generic")).toBe(true);
  }), 30_000);

  it.effect("follows exported object aliases and named exports without promoting called helpers", () => Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(resolve(root, "packages/engine/test/aliases-"))),
      directory => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.promise(() => writeFile(resolve(directory, "tsconfig.json"), JSON.stringify({ extends: resolve(root, "tsconfig.base.json"), compilerOptions: { erasableSyntaxOnly: false }, include: ["input.ts"] })));
    yield* Effect.promise(() => writeFile(resolve(directory, "input.ts"), `
import { Context, Effect, Layer } from "effect";
namespace PrivateSpace { export const hidden = (n: number): boolean => n > 0; }
export namespace PublicSpace { const hidden = (n: number): boolean => n > 0; export const visible = (n: number): boolean => n > 0; }
const aliased = (n: number): boolean => n > 0;
const internalObject = { aliased };
export const api = { nested: internalObject };
const listed = (n: number): boolean => n > 0;
export { listed };
const called = (n: number): boolean => n > 0;
export const caller = (n: number): boolean => called(n);
const serviceFn = (n: number): Effect.Effect<number> => Effect.succeed(n);
class Service extends Context.Service<Service, { readonly run: (n: number) => Effect.Effect<number>; readonly inline: (n: number) => Effect.Effect<number> }>()("Service") {}
export const serviceFactory = () => {
  const factoryLocal = (n: number) => Effect.succeed(n);
  return Layer.effect(Service, Effect.gen(function* () {
    return Service.of({ run: serviceFn, inline: (n: number) => factoryLocal(n) });
  }));
};
`));
    const source = makeSource();
    const mutants = yield* collect(source, config(resolve(directory, "tsconfig.json"), { exportedOnly: true }));
    for (const name of ["aliased", "listed", "caller", "serviceFn", "serviceFactory.inline", "PublicSpace.visible"]) expect(mutants.some(item => item.functionName === name), name).toBe(true);
    expect(mutants.some(item => item.functionName === "called")).toBe(false);
    for (const name of ["PrivateSpace.hidden", "PublicSpace.hidden"]) expect(mutants.some(item => item.functionName === name)).toBe(false);
    expect(mutants.some(item => item.functionName === "serviceFactory.factoryLocal")).toBe(false);
    for (const mutant of mutants) expect((yield* source.checkViable(mutant)).diagnostics).toEqual([]);
  }).pipe(Effect.scoped), 30_000);

  it.effect("keeps logical ids across prefix edits and inserts mutation imports after shebangs and directives", () => Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(resolve(root, "packages/engine/test/prologue-"))),
      directory => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const file = resolve(directory, "input.ts");
    yield* Effect.promise(() => writeFile(resolve(directory, "tsconfig.json"), JSON.stringify({ extends: resolve(root, "tsconfig.base.json"), include: ["input.ts"] })));
    const original = '#!/usr/bin/env node\n"use client";\n"use strict";\nimport { Context, Layer } from "effect";\nclass Key extends Context.Service<Key, { readonly n: number }>()("Key") {}\nexport const live = Layer.succeed(Key, { n: 1 });\n';
    yield* Effect.promise(() => writeFile(file, original));
    const input = config(resolve(directory, "tsconfig.json"), { functionFilter: ["live"] });
    const source = makeSource();
    const first = (yield* collect(source, input))[0]!;
    expect(first.replacement.startOffset).toBe(0);
    expect((yield* source.checkViable(first)).diagnostics).toEqual([]);
    const mutated = first.replacement.text + original.slice(first.replacement.endOffset);
    expect(mutated.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(mutated.indexOf("import * as __mutantCafeEffect")).toBeGreaterThan(mutated.indexOf('"use strict"'));
    const changed = original.replace("export const live", "// documentation above the binding\nexport const live");
    yield* Effect.promise(() => writeFile(file, changed));
    const next = (yield* collect(makeSource(), input))[0]!;
    expect(next.span.start.line).toBe(first.span.start.line + 1);
    expect(next.id).toBe(first.id);
  }).pipe(Effect.scoped), 30_000);

  it.effect("covers internal, nested and value shapes without generating ill-typed generic or pipeable mutants", () => Effect.gen(function* () {
    const source = makeSource();
    const input = config("packages/engine/test/fixtures/coverage/tsconfig.json");
    const mutants = yield* collect(source, input);
    for (const name of ["layerOnly", "idleOnly", "live", "idle", "StaticService.layer", "internal", "internalEffect", "untraced", "Greeter.layer.greet", "Greeter.layer.send", "policy.canEdit", "machine.guards.allowed", "guardFor.<inner>", "brand", "set", "map", "object", "identityCandidate", "identityGeneric", "report", "scoped", "mapped"]) {
      const items = mutants.filter(m => m.functionName === name);
      expect(items.length, name).toBeGreaterThan(0);
      for (const mutant of items) expect((yield* source.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
    }
    expect(mutants.some(m => m.functionName === "identityCandidate" && m.replacement.text.includes("=> (n)"))).toBe(true);
    expect(mutants.some(m => m.functionName === "generic")).toBe(false);
    const skipped = yield* source.notMutated(input);
    expect(skipped.find(s => s.functionName === "generic")?.reason).toContain("generic");
    expect(skipped.find(s => s.functionName === "opaque")?.reason).toContain("field call");
    const elementIdentity = mutants.filter(m => m.functionName === "genericElement");
    expect(elementIdentity).toHaveLength(1);
    expect(elementIdentity[0]!.description).toContain("with xs");
    expect((yield* source.checkViable(elementIdentity[0]!)).diagnostics).toEqual([]);
    expect(skipped.find(s => s.functionName === "reader.get")?.reason).toContain("generic");
    const restricted = yield* collect(source, { ...input, exportedOnly: true });
    expect(restricted.some(m => ["internal", "internalEffect", "untraced", "machine.guards.allowed"].includes(m.functionName))).toBe(false);
    expect((yield* source.notMutated({ ...input, exportedOnly: true })).find(s => s.functionName === "internal")?.reason).toContain("--exported-only");
    const repeated = yield* collect(makeSource(), input);
    expect(repeated.map(m => m.id)).toEqual(mutants.map(m => m.id));
  }), 30_000);

  for (const name of ["twice", "find"]) {
    it.effect(`preserves scoped return types and callers for ${name} (B1/B2)`, () => Effect.gen(function* () {
      const source = makeSource();
      const mutants = yield* collect(source, config("packages/engine/test/fixtures/viability/tsconfig.json", { functionFilter: [name] }));
      expect(mutants.length).toBeGreaterThan(3);
      for (const mutant of mutants) {
        expect((yield* source.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
      }
    }), 30_000);
  }

  it.effect("keeps literal recovery, visible constructors, transitive brands, union errors and exported names viable (B10–B17)", () => Effect.gen(function* () {
    const source = makeSource();
    const input = config("packages/engine/test/fixtures/viability/tsconfig.json");
    const mutants = yield* collect(source, input);
    for (const name of ["read", "imported", "digest", "checkAll", "branded", "reported", "callback"]) {
      const items = mutants.filter(m => m.functionName === name);
      expect(items.length, name).toBeGreaterThan(0);
      for (const mutant of items) expect((yield* source.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
    }
    const digest = mutants.filter(m => m.functionName === "digest");
    for (const genre of ["EffectFail", "SwallowTag", "EffectDie", "EffectNever"]) expect(digest.some(m => m.genre === genre), genre).toBe(true);
    expect(mutants.some(m => m.functionName === "inner")).toBe(false);
    const read = mutants.filter(m => m.functionName === "read");
    // An unconditional success removes the failing branch: it is not a no-op.
    const removedFailure = read.find(m => m.genre === "EffectSucceed");
    expect(removedFailure).toBeDefined();
    if (removedFailure) {
      const module = yield* loadMutation<{ read: (ok: boolean) => Effect.Effect<unknown, Error> }>(removedFailure);
      expect(Exit.isSuccess(yield* Effect.exit(module.read(false)))).toBe(true);
    }
    expect(read.some(m => m.genre === "SwallowTag")).toBe(true);
    for (const name of ["read", "imported"]) {
      const fail = mutants.find(m => m.functionName === name && m.genre === "EffectFail");
      expect(fail?.synthetic, name).toBe(false);
      expect(fail?.description).toContain("constructed error");
    }
    for (const name of ["read", "imported"]) {
      const mutant = mutants.find(m => m.functionName === name && m.genre === "EffectFail")!;
      const module = yield* loadMutation<{ readonly read: (ok: boolean) => Effect.Effect<unknown, Error>; readonly imported: () => Effect.Effect<unknown, Error> }>(mutant);
      const exit = yield* Effect.exit(name === "read" ? module.read(true) : module.imported());
      expect(Exit.hasFails(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(reason => reason._tag === "Fail");
        expect(failure && "error" in failure && failure.error instanceof Error).toBe(true);
      }
    }
    expect(mutants.some(m => m.functionName === "same" && m.genre === "EffectSucceed")).toBe(false);
    const selected = yield* collect(makeSource(), { ...input, include: ["**/advanced.ts"] });
    expect(selected.map(m => [m.id, m.replacement])).toEqual(mutants.filter(m => m.file.endsWith("/advanced.ts")).map(m => [m.id, m.replacement]));
  }), 30_000);

  it.effect("keeps a failing multi-service layer viable", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, config("packages/engine/test/fixtures/viability/tsconfig.json", { functionFilter: ["services"] }));
    expect(mutants.map(m => m.genre).sort()).toEqual(["LayerDie", "LayerFail"]);
    for (const mutant of mutants) expect((yield* source.checkViable(mutant)).diagnostics).toEqual([]);
  }));

  it.effect("gives every generated mutant a distinct description within its function", () => Effect.gen(function* () {
    const source = makeSource();
    for (const input of [fixture, extra]) {
      const mutants = yield* collect(source, input);
      expect(mutants.length).toBeGreaterThan(0);
      const functions = new Map<string, Set<string>>();
      for (const mutant of mutants) {
        const key = JSON.stringify([mutant.file, mutant.functionName, mutant.span]);
        const descriptions = functions.get(key) ?? new Set<string>();
        expect(descriptions.has(mutant.description), mutant.description).toBe(false);
        descriptions.add(mutant.description);
        functions.set(key, descriptions);
      }
    }
  }));

  it.effect("swallows precisely the two declared errors while preserving the other path", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, fixture);
    const swallows = mutants.filter((m) => m.functionName === "withdraw" && m.genre === "SwallowTag");
    expect(swallows).toHaveLength(2);
    const recovered: string[] = [];
    for (const mutant of swallows) {
      const module = yield* loadMutation(mutant);
      const frozen = yield* Effect.exit(module.withdraw({ id: "a", balance: 10, frozen: true }, 1));
      const overdrawn = yield* Effect.exit(module.withdraw({ id: "a", balance: 10, frozen: false }, 11));
      expect([Exit.isSuccess(frozen), Exit.isSuccess(overdrawn)].filter(Boolean)).toHaveLength(1);
      recovered.push(Exit.isSuccess(frozen) ? "Frozen" : "Overdrawn");
    }
    expect(recovered.sort()).toEqual(["Frozen", "Overdrawn"]);
  }));

  it.effect("type-checks every real fixture mutant and rejects an ill-typed edit without poisoning the next check", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, fixture);
    expect(mutants.length).toBeGreaterThan(8);
    for (const mutant of mutants) {
      const viability = yield* source.checkViable(mutant);
      expect(viability.diagnostics, mutant.description).toEqual([]);
      expect(viability.viable).toBe(true);
    }
    const boolean = mutants.find((m) => m.functionName === "isEmpty")!;
    const bad = { ...boolean, replacement: { ...boolean.replacement, text: '{ return "not a boolean"; }' } };
    const failure = yield* source.checkViable(bad);
    expect(failure.viable).toBe(false);
    expect(failure.diagnostics.some((d) => d.includes("TS2322"))).toBe(true);
    expect((yield* source.checkViable(boolean)).viable).toBe(true);
  }), 30_000);

  it.effect("discovers wrappers, methods, and non-Effect genres, skips JSDoc tags, and checks their viability", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, extra);
    const names = new Set(mutants.map((m) => m.functionName));
    expect(names.has("skipped")).toBe(false);
    expect(names.has("skippedArrow")).toBe(false);
    expect(names.has("privateFunction")).toBe(true);
    expect(names.has("mapped")).toBe(false);
    expect(names.has("nothing")).toBe(false); // The empty body is already the replacement.
    expect(mutants.filter(m => m.functionName === "generated" && m.genre === "EffectDie")).toHaveLength(1);
    for (const name of ["bool", "literal", "numeric", "words", "array", "option", "stream", "layer", "generated", "named", "program", "maybe", "nested", "synthetic", "Counter.value"]) expect(names.has(name), name).toBe(true);
    expect(mutants.some((m) => m.functionName === "synthetic" && m.genre === "EffectFail" && m.synthetic)).toBe(true);
    expect(mutants.some((m) => m.functionName === "nested" && m.genre === "EffectSucceed")).toBe(true);
    expect(mutants.some((m) => m.functionName === "maybe" && m.genre === "OptionSome")).toBe(true);
    const genres = new Set(mutants.map((m) => m.genre));
    for (const genre of ["OptionNone", "OptionSome", "StreamEmpty", "StreamOne", "StreamFail", "LayerFail", "LiteralCycle", "FnValue"]) expect(genres.has(genre as Mutant["genre"]), genre).toBe(true);
    for (const mutant of mutants) expect((yield* source.checkViable(mutant)).diagnostics, mutant.description).toEqual([]);
  }), 30_000);

  it.effect("labels conversion to a defect honestly when no success value exists", () => Effect.gen(function* () {
    const source = makeSource();
    const mutants = yield* collect(source, extra);
    const swallow = mutants.find((m) => m.functionName === "program" && m.genre === "TagToDefect");
    expect(swallow).toBeDefined();
    if (!swallow) return;
    expect(swallow.synthetic).toBe(false);
    expect((yield* source.checkViable(swallow)).viable).toBe(true);
    const module = yield* loadMutation<{ readonly program: Effect.Effect<never, { readonly _tag: "Missing" }> }>(swallow);
    const exit = yield* Effect.exit(module.program);
    expect(Exit.hasDies(exit)).toBe(true);
    expect(Exit.hasFails(exit)).toBe(false);
  }));

  it.effect("honors file and function filters and produces stable content ids", () => Effect.gen(function* () {
    const source = makeSource();
    const input = config(fixture.tsconfig, { include: ["**/account.ts"], functionFilter: ["isEmpty"] });
    const first = yield* collect(source, input);
    expect(first).toHaveLength(2);
    expect(first.every((m) => m.functionName === "isEmpty")).toBe(true);
    expect((yield* collect(source, input)).map((m) => m.id)).toEqual(first.map((m) => m.id));
    expect(yield* collect(source, { ...input, exclude: ["**/account.ts"] })).toEqual([]);
  }));

  it.effect("exposes the service layer and reports unreadable tsconfigs in the typed channel", () => Effect.gen(function* () {
    const source = yield* MutantSource;
    expect(source.typescriptVersion).toBe(ts.version);
    const result = yield* collect(source, config("missing-tsconfig.json")).pipe(Effect.flip);
    expect(result).toMatchObject({ _tag: "ProgramLoadError", diagnostics: [expect.any(String)] });
  }).pipe(Effect.provide(MutantSourceLive)));
});
