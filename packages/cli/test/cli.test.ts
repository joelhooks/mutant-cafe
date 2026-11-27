import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BaselineFailed, BaselineTimedOut, MutantSource, Reporter, Scratch, TestRunner, RunReport, type Mutant, type NotMutated } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { expect } from "vitest";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { runCli, type Run } from "../src/Command.ts";
import { makeReporter, mutantLine } from "../src/Reporter.ts";
import { reportExitCode } from "../src/ExitCode.ts";
import { countsLine } from "../src/Summary.ts";
import { makeMutantSource, makeTypeScriptOracle } from "@mutant-cafe/engine";
import { selectInDiff } from "../src/Diff.ts";
import { unifiedDiff } from "../src/UnifiedDiff.ts";

const mutant = (options: { file?: string; line?: number; id?: string } = {}): Mutant => ({
  id: options.id ?? "withdraw-missed", file: options.file ?? "account.ts", functionName: "withdraw", returnType: "boolean",
  genre: "BooleanFlip", description: "replace body with false", synthetic: false,
  span: { start: { line: options.line ?? 1, column: 1 }, end: { line: options.line ?? 1, column: 30 } },
  replacement: { startOffset: 0, endOffset: 0, text: "// mutant\n" },
});
const report = (root: string, mutants: ReadonlyArray<Mutant>): RunReport => ({
  schemaVersion: 2, tool: "mutant.cafe", root, baseline: { durationMs: 10, testCommand: ["vitest", "run"] }, timeoutMs: 20_000,
  results: mutants.map((mutant) => ({ mutant, outcome: "missed", durationMs: 5, testCommand: ["vitest", "related", mutant.file], diagnostics: [] })),
});
it("includes actual host restarts and pool resets in the summary", () => {
  expect(countsLine({ ...report("/fixture", []), hostRestarts: 2, poolResets: 7 }, 0)).toContain("2 host restarts, 7 pool resets");
});
it("reports measured per-mutant backstop percentiles without inventing missing samples", () => {
  const base = report("/fixture", [mutant(), mutant(), mutant(), mutant()]);
  const measured = { ...base, results: base.results.map((result, index) => index === 3 ? result : { ...result, backstopMs: [1, 2, 9][index]! }) };
  expect(countsLine(measured, 0)).toContain("backstop per mutant p50 2.0 ms, p90 9.0 ms (3 measured)");
  expect(countsLine(base, 0)).not.toContain("backstop per mutant");
});
const missedRun: Run = (config, mutants) => Effect.gen(function*() {
  const reporter = yield* Reporter;
  const output = report(config.root, mutants);
  for (const result of output.results) yield* reporter.progress(result);
  return output;
});
const invoke = (root: string, args: ReadonlyArray<string>, mutants: ReadonlyArray<Mutant>, run: Run = missedRun, skipped: ReadonlyArray<NotMutated> = []) => runCli({ root, args, run }).pipe(
  Effect.provideService(MutantSource, { notMutated: () => Effect.succeed(skipped), generate: () => Stream.fromIterable(mutants), checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) }),
  Effect.provideService(Scratch, { acquire: () => Effect.die("Unexpected scratch acquisition in CLI adapter test") }),
  Effect.provideService(TestRunner, { baseline: () => Effect.die("Unexpected baseline"), runRelated: () => Effect.die("Unexpected test spawn") }),
);
const project = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-cli-" });
  yield* fs.writeFileString(`${root}/account.ts`, "export const isEmpty = () => true;\n");
  return root;
});

it.live("the real CLI reports three distinct missed mutants with root-relative clickable paths", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors");
  const output = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-cli-e2e-" });
  const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [
    path.resolve(import.meta.dirname, "../src/bin.ts"), "--jobs", "1", "--output", path.join(output, "report")
  ], { cwd: root }));
  const [stdout, stderr, exit] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(handle.stdout)),
    Stream.mkString(Stream.decodeText(handle.stderr)),
    handle.exitCode
  ], { concurrency: "unbounded" });
  expect(Number(exit), stderr).toBe(2);
  const lines = (yield* fs.readFileString(path.join(output, "report/missed.txt"))).trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(new Set(lines).size).toBe(3);
  for (const line of lines) {
    expect(line).toMatch(/^src\/account\.ts:\d+:\d+: replace /);
    expect(stdout).toContain(line);
    expect(line).not.toContain(root);
  }
  const report = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(
    yield* fs.readFileString(path.join(output, "report/outcomes.json"))
  );
  expect(report.results.filter((result) => result.outcome === "caught")).toHaveLength(6);
  expect(report.results.every((result) => path.isAbsolute(result.mutant.file))).toBe(true);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 60_000);

it.live("the real CLI catches a viable multi-service layer failure", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../../engine/test/fixtures/viability");
  const output = yield* fs.makeTempDirectoryScoped({ prefix: "multi-layer-e2e-" });
  const handle = yield* ChildProcess.make(process.execPath, [
    path.resolve(import.meta.dirname, "../src/bin.ts"), "--file", "src/layers.ts", "--output", path.join(output, "report"),
  ], { cwd: root });
  const [logs, code] = yield* Effect.all([
    Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode,
  ], { concurrency: "unbounded" });
  expect(Number(code), logs).toBe(0);
  const report = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(
    yield* fs.readFileString(path.join(output, "report/outcomes.json")),
  );
  expect(report.results.map(r => r.mutant.genre).sort()).toEqual(["LayerDie", "LayerFail"]);
  for (const result of report.results) {
    expect(result.outcome, logs).toBe("caught");
    expect(result.diagnostics).toEqual([]);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000);

it.live("runs all coverage shapes and writes honest skips, with caught and missed examples", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../../engine/test/fixtures/coverage");
  const output = yield* fs.makeTempDirectoryScoped({ prefix: "coverage-e2e-" });
  const handle = yield* ChildProcess.make(process.execPath, [path.resolve(import.meta.dirname, "../src/bin.ts"), "--jobs", "1", "--output", path.join(output, "report")], { cwd: root });
  const [logs, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], { concurrency: "unbounded" });
  expect(Number(code), logs).toBe(2);
  const report = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(path.join(output, "report/outcomes.json")));
  expect(report.results.filter(r => ["unviable", "unreliable", "timeout"].includes(r.outcome))).toEqual([]);
  const groups = [
    ["layerOnly", "idleOnly"], ["live", "idle"], ["layerFunction", "idleLayerFunction"], ["StaticService.layer", "StaticService.idle"],
    ["internal"], ["internalEffect"], ["untraced"], ["Greeter.layer.greet"], ["Greeter.layer.send"],
    ["policy.canEdit"], ["machine.guards.allowed"], ["guardFor.<inner>"], ["brand"], ["set", "idleSet"],
    ["map", "idleMap"], ["object"], ["identityCandidate"], ["identityGeneric"], ["report"], ["scoped"], ["mapped"],
  ];
  for (const group of groups) {
    const outcomes = report.results.filter(r => group.includes(r.mutant.functionName)).map(r => r.outcome);
    expect(outcomes, group.join(", ")).toContain("caught");
    expect(outcomes, group.join(", ")).toContain("missed");
  }
  for (const name of ["weakLayer", "weakInternal", "Greeter.layer.loose", "weakPolicy.allowed", "weakGuardFor.<inner>", "weakBrand", "weakSet", "weakMap", "weakObject", "weakIdentity"]) {
    expect(report.results.some(result => result.mutant.functionName === name && result.outcome === "missed"), `exercised weak assertion: ${name}`).toBe(true);
  }
  const skipped = yield* fs.readFileString(path.join(output, "report/not-mutated.txt"));
  expect(skipped).toContain("generic: generic");
  expect(skipped).toMatch(/src\/shapes\.ts:\d+:\d+: opaque: return not synthesizable \(field call\)(?:\r?\n|$)/);
  expect(report.results.some(result => result.mutant.functionName === "opaque.call")).toBe(false);
  expect(skipped).toMatch(/src\/shapes\.ts:\d+:\d+: opaqueWithWork: return not synthesizable \(field call\); inner functions mutated/);
  const callback = report.results.filter(result => result.mutant.functionName === "opaqueWithWork.call");
  expect(callback).toHaveLength(1);
  expect(callback[0]?.outcome).toBe("caught");
  expect(logs).toContain("Baseline command:");
  expect(logs).toContain("not mutated");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 300_000);

it.live("prints TypeScript diagnostics and a failed baseline command, retaining outcomes.json", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* project;
  const fixture = path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors");
  yield* fs.symlink(`${fixture}/node_modules`, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, noEmit: true }, include: ["account.ts"] }));
  yield* fs.writeFileString(`${root}/broken.test.ts`, 'import { it, expect } from "vitest"; import { isEmpty } from "./account.ts"; it("broken original", () => expect(isEmpty()).toBe(false));');
  const invoke = (args: string[]) => Effect.gen(function* () {
    const handle = yield* ChildProcess.make(process.execPath, [path.resolve(import.meta.dirname, "../src/bin.ts"), ...args], { cwd: root });
    const [logs, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], { concurrency: "unbounded" });
    return { logs, code: Number(code) };
  });
  const failed = yield* invoke(["--cold"]);
  expect(failed.code, failed.logs).toBe(4);
  expect(failed.logs).toContain("Baseline command:");
  expect(failed.logs).toContain("Baseline failed (1): vitest run");
  expect(failed.logs).toContain("broken original");
  const report = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
  expect(report.failure).toContain("launch.mjs run");
  expect(report.failure).toContain("broken original");
  const command = report.baseline.testCommand;
  const launcher = command.find(arg => /\/mutant-vitest-[^/]+\/launch\.mjs$/.test(arg));
  if (!launcher) throw new Error(`Missing Vitest launcher in ${JSON.stringify(command)}`);
  const runtimeArgs = command.slice(1, command.indexOf(launcher));
  if (process.versions.bun !== undefined && runtimeArgs.length > 0) {
    expect(runtimeArgs).toEqual(["--preload", expect.stringMatching(/\/mutant-processes-[^/]+\/register\.mjs$/)]);
  } else {
    expect(runtimeArgs).toEqual([]);
  }
  expect(command).toEqual([process.execPath, ...runtimeArgs, launcher, "run", "--passWithNoTests", "--reporter=default",
    `--reporter=${path.join(path.dirname(launcher), "reporter.mjs")}`, "--bail", "1", "--no-cache", "--no-fsModuleCache"]);
  expect(failed.logs).toContain(report.baseline.testCommand.join(" "));
  yield* fs.writeFileString(`${root}/account.ts`, "export const broken = (;");
  const invalid = yield* invoke(["--list"]);
  expect(invalid.code).toBe(1);
  expect(invalid.logs).toContain(`${root}/tsconfig.json`);
  expect(invalid.logs).toMatch(/TS\d+:/);
  yield* fs.writeFileString(`${root}/account.ts`, "export const isEmpty = () => true;\n");
  yield* fs.writeFileString(`${root}/unparseable.json`, '{ "compilerOptions": ');
  yield* fs.writeFileString(`${root}/bad-extends.json`, JSON.stringify({ extends: "./absent-base.json", include: ["account.ts"] }));
  for (const name of ["missing.json", "unparseable.json", "bad-extends.json"]) {
    const result = yield* invoke(["--list", "--tsconfig", name]);
    expect(result.code, result.logs).toBe(1);
    expect(result.logs).toContain(`${root}/${name}`);
    expect(result.logs).toMatch(/TS\d+:/);
  }
  const help = yield* invoke(["--help"]);
  for (const description of ["List mutants", "Only mutate bodies", "Include source glob", "Exclude source glob", "Only exported binding paths", "Concurrent scratch", "Absolute test timeout", "Baseline duration multiplier", "Minimum test timeout", "Report directory", "TypeScript project path"]) expect(help.logs).toContain(description);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 60_000);

it.effect("selects import-adding mutants by their logical span and scopes skip reports to touched files", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureRoot = path.resolve(import.meta.dirname, "../../engine/test/fixtures/coverage");
  const file = path.join(fixtureRoot, "src/layers-only.ts");
  const original = yield* fs.readFileString(file);
  const source = makeMutantSource(makeTypeScriptOracle());
  const items = yield* Stream.runCollect(source.generate({ root: fixtureRoot, tsconfig: "tsconfig.json", include: ["src/layers-only.ts"], exclude: [], functionFilter: ["layerOnly"], jobs: 1, timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 1000, outDir: "mutants.out" }));
  expect(items).toHaveLength(1);
  expect(items[0]?.replacement.startOffset).toBe(0);
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "logical-diff-" });
  const patch = path.join(temp, "edit.diff");
  const name = "packages/engine/test/fixtures/coverage/src/layers-only.ts";
  yield* fs.writeFileString(patch, unifiedDiff(original.replace('import { Context, Layer }', 'import { Context, Layer } /* before */'), original, name));
  expect(yield* selectInDiff({ root: fixtureRoot, diffPath: patch, mutants: items })).toEqual([]);
  yield* fs.writeFileString(patch, unifiedDiff(original.replace('Layer.succeed(Only, { n: 1 })', 'Layer.succeed(Only, { n: 9 })'), original, name));
  expect((yield* selectInDiff({ root: fixtureRoot, diffPath: patch, mutants: items })).map(item => item.id)).toEqual(items.map(item => item.id));

  const root = yield* project;
  const before = yield* fs.readFileString(`${root}/account.ts`);
  const after = before.replace("true", "false");
  yield* fs.writeFileString(`${root}/account.ts`, after);
  yield* fs.writeFileString(`${root}/other.ts`, "export const other = 1;\n");
  yield* fs.writeFileString(`${root}/edit.diff`, unifiedDiff(before, after, "account.ts"));
  const skipped = [
    { file: `${root}/account.ts`, functionName: "touched", reason: "opaque" },
    { file: `${root}/other.ts`, functionName: "untouched", reason: "generic" },
  ];
  expect(yield* invoke(root, ["--in-diff", "edit.diff"], [], missedRun, skipped)).toBe(0);
  const report = yield* fs.readFileString(`${root}/mutants.out/not-mutated.txt`);
  expect(report).toContain("touched: opaque");
  expect(report).not.toContain("untouched");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000);

it.effect("gives unreliable its own exit code and publishes only report schema v2", () => Effect.gen(function* () {
  const root = yield* project;
  const base = report(root, [mutant()]);
  const unreliable = { ...base, results: base.results.map(result => ({ ...result, outcome: "unreliable" as const })) };
  expect(reportExitCode(unreliable)).toBe(7);
  expect(reportExitCode({ ...unreliable, results: [...unreliable.results, ...base.results] })).toBe(2);
  expect(reportExitCode({ ...unreliable, results: [...unreliable.results, { ...base.results[0]!, outcome: "timeout" }] })).toBe(7);
  expect(reportExitCode({ ...unreliable, results: [...unreliable.results, { ...base.results[0]!, outcome: "untested" }] })).toBe(7);
  expect(yield* invoke(root, [], [mutant()], () => Effect.succeed(unreliable))).toBe(7);
  expect(yield* Schema.decodeUnknownEffect(RunReport)({ ...base, schemaVersion: 1 }).pipe(Effect.result, Effect.map(Result.isFailure))).toBe(true);
  expect((yield* Schema.decodeEffect(RunReport)(base)).schemaVersion).toBe(2);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("writes missed output, returns CI failure, and rotates the previous run", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const items = [mutant()];
  expect(yield* invoke(root, [], items)).toBe(2);
  expect(yield* fs.readFileString(`${root}/mutants.out/missed.txt`)).toContain("account.ts:1:1: replace body with false");
  const first = yield* fs.readFileString(`${root}/mutants.out/outcomes.json`);
  expect(JSON.parse(first).results[0].outcome).toBe("missed");
  expect(yield* invoke(root, [], [])).toBe(0);
  expect(yield* fs.readFileString(`${root}/mutants.out.old/outcomes.json`)).toBe(first);
  expect(yield* fs.readFileString(`${root}/mutants.out/missed.txt`)).toBe("");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("writes mutants before execution, and outcome lists and logs during progress", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const item = mutant();
  const reporter = yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  expect(JSON.parse(yield* fs.readFileString(`${root}/mutants.out/mutants.json`))).toHaveLength(1);
  expect(yield* fs.exists(`${root}/mutants.out/diff/${item.id}.diff`)).toBe(true);
  const base = report(root, [item]);
  const output = { ...base, results: base.results.map((result) => ({ ...result, output: "raw test output" })) };
  yield* reporter.progress(output.results[0]!);
  expect(yield* fs.readFileString(`${root}/mutants.out/missed.txt`)).toContain(item.description);
  expect(yield* fs.readFileString(`${root}/mutants.out/logs/${item.id}.log`)).toBe("raw test output");
  yield* reporter.write(output);
  expect(reportExitCode(output)).toBe(2);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("persists outcomes before warning about invalid telemetry without changing the exit code", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem; const root = yield* project; const item = mutant();
  const events: string[] = [];
  const tracked: FileSystem.FileSystem = { ...fs, rename: (from, to) => fs.rename(from, to).pipe(Effect.tap(() => Effect.sync(() => { if (to.endsWith("outcomes.json")) events.push("persisted"); }))) };
  const writer = yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] }).pipe(Effect.provideService(FileSystem.FileSystem, tracked));
  const base = report(root, [item]);
  const bad: RunReport = { ...base, hostRestarts: NaN, baseline: { ...base.baseline, testWorkers: 0.5 }, results: base.results.map(result => ({ ...result, testWorkers: 0.5, testConcurrency: Infinity, durationMs: 0.5 })) };
  const original = yield* Console.Console;
  const warnings: string[] = [];
  yield* writer.write(bad).pipe(Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { events.push("warn"); warnings.push(args.join(" ")); } }));
  const saved = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
  expect(saved.results[0]?.outcome).toBe("missed"); expect(saved.results[0]?.testWorkers).toBeUndefined(); expect(saved.baseline.testWorkers).toBeUndefined();
  expect(reportExitCode(saved)).toBe(reportExitCode(base)); expect(reportExitCode(saved)).toBe(2);
  expect(events[0]).toBe("persisted"); expect(events).toContain("warn");
  expect(warnings.join(" ")).toContain("testWorkers=0.5");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("a real git diff of the fixture selects only mutants in the edited function", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-cli-diff-" });
  const fixture = yield* fs.readFileString(path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors/src/account.ts"));
  yield* fs.writeFileString(`${root}/account.ts`, fixture);
  const git = (args: ReadonlyArray<string>) => Effect.gen(function*() {
    const handle = yield* ChildProcess.make("git", args, { cwd: root });
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout));
    expect(Number(yield* handle.exitCode)).toBe(0);
    return text;
  });
  yield* git(["init", "--quiet"]);
  yield* git(["add", "account.ts"]);
  const edited = fixture.replace("balance: account.balance - amount", "balance: account.balance - amount - 1");
  yield* fs.writeFileString(`${root}/account.ts`, edited);
  const patch = yield* git(["diff", "--no-ext-diff", "--unified=3", "--", "account.ts"]);
  yield* fs.writeFileString(`${root}/edit.diff`, patch);
  const changedLine = edited.split("\n").findIndex((line) => line.includes("balance: account.balance - amount - 1")) + 1;
  const outsideLine = edited.split("\n").findIndex((line) => line.startsWith("export const isEmpty")) + 1;
  const inside = mutant({ line: changedLine, id: "inside" });
  const outside = mutant({ line: outsideLine, id: "outside" });
  const selected = yield* selectInDiff({ root, diffPath: "edit.diff", mutants: [inside, outside] });
  expect(selected.map((item) => item.id)).toEqual(["inside"]);
  expect(yield* invoke(root, ["--list", "--in-diff", "edit.diff"], [inside, outside])).toBe(0);
  expect(yield* fs.exists(`${root}/mutants.out`)).toBe(false);
  yield* fs.writeFileString(`${root}/account.ts`, fixture);
  expect(yield* invoke(root, ["--list", "--in-diff", "edit.diff"], [inside, outside])).toBe(5);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("resolves toplevel and --relative patches from a nested package (B6)", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "nested-diff-" });
  const nested = `${root}/packages/a`;
  yield* fs.makeDirectory(nested, { recursive: true });
  const run = (args: ReadonlyArray<string>) => Effect.gen(function* () {
    const handle = yield* ChildProcess.make("git", args, { cwd: nested });
    const output = yield* Stream.mkString(Stream.decodeText(handle.stdout));
    expect(Number(yield* handle.exitCode)).toBe(0);
    return output;
  });
  yield* fs.writeFileString(`${nested}/account.ts`, "export const f = () => true;\n");
  yield* run(["init", "--quiet", root]);
  yield* run(["add", "account.ts"]);
  yield* fs.writeFileString(`${root}/account.ts`, "export const unrelated = 1;\n");
  yield* fs.writeFileString(`${nested}/account.ts`, "export const f = () => false;\n");
  for (const args of [["diff"], ["diff", "--relative"]]) {
    yield* fs.writeFileString(`${nested}/edit.diff`, yield* run(args));
    expect((yield* selectInDiff({ root: nested, diffPath: "edit.diff", mutants: [mutant()] })).map(m => m.id)).toEqual(["withdraw-missed"]);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("bounds displayed types, preserves full JSON, and links every line to an id (B4)", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* project;
  const returnType = `{ ${"readonly field: number; ".repeat(100)} }`;
  const item = { ...mutant(), returnType, description: `replace withdraw -> ${returnType} with false` };
  const line = mutantLine(item, root, path);
  expect(line.length).toBeLessThan(180);
  expect(line).toContain("…");
  expect(line).toContain(item.id);
  expect(mutantLine({ ...item, displayReturnType: "RecordAlias" }, root, path)).toContain("-> RecordAlias with");
  const reporter = yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  yield* reporter.write(report(root, [item]));
  const output = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
  expect(output.results[0]?.mutant.returnType).toBe(returnType);
  const untested = { ...report(root, [item]), results: report(root, [item]).results.map(r => ({ ...r, outcome: "untested" as const })) };
  expect(reportExitCode(untested)).toBe(2);
  yield* reporter.write(untested);
  expect(yield* fs.readFileString(`${root}/mutants.out/untested.txt`)).toContain(item.id);
  const mixed = { ...untested, results: [...untested.results, { ...untested.results[0]!, outcome: "timeout" as const }] };
  expect(reportExitCode(mixed)).toBe(2);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("the real CLI rejects each unmatched --file and an outside path (B13)", () => Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors");
  const listed = yield* ChildProcess.make(process.execPath, [path.resolve(import.meta.dirname, "../src/bin.ts"), "--list"], { cwd: root });
  const listing = yield* Stream.mkString(Stream.decodeText(listed.stdout));
  expect(Number(yield* listed.exitCode)).toBe(0);
  expect(listing).toContain("9 mutants total");
  expect(listing).toContain("src/account.ts: 9 mutants");
  for (const args of [["--list", "--file", "src/nope.ts", "--file", "src/also-nope.ts"], ["--file", "../elsewhere.ts"]]) {
    const handle = yield* ChildProcess.make(process.execPath, [path.resolve(import.meta.dirname, "../src/bin.ts"), ...args], { cwd: root });
    const [output, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], { concurrency: "unbounded" });
    expect(Number(code), output).toBe(1);
    for (let i = 0; i < args.length; i++) if (args[i] === "--file") expect(output).toContain(args[i + 1]);
    if (args.includes("../elsewhere.ts")) expect(output).toContain("outside the package root");
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);

it.effect("malformed diffs exit 6 without running tests or creating reports", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  yield* fs.writeFileString(`${root}/bad.diff`, "--- a/account.ts\n+++ b/account.ts\n@@ -1,2 +1,1 @@\n+truncated\n");
  expect(yield* invoke(root, ["--in-diff", "bad.diff"], [mutant()], () => Effect.die("Must not execute"))).toBe(6);
  expect(yield* fs.exists(`${root}/mutants.out`)).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("forced modes reach the runner, default is auto, and conflicts are rejected", () => Effect.gen(function* () {
  const root = yield* project;
  const modes: Array<{ cold: boolean; warm: boolean }> = [];
  const run: Run = (config, mutants) => Effect.sync(() => {
    expect(config.baselineTimeoutMs).toBe(1_800_000);
    modes.push({ cold: config.cold ?? false, warm: config.warm ?? false });
    return report(config.root, mutants);
  });
  yield* invoke(root, ["--cold"], [mutant()], run);
  yield* invoke(root, ["--warm"], [mutant()], run);
  yield* invoke(root, [], [mutant()], run);
  expect(yield* invoke(root, ["--cold", "--warm"], [mutant()], run)).toBe(1);
  expect(modes).toEqual([{ cold: true, warm: false }, { cold: false, warm: true }, { cold: false, warm: false }]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("flags win over config and timeout flags use seconds", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const source = yield* fs.readFileString(`${root}/account.ts`);
  for (const file of ["a.ts", "b.ts"]) yield* fs.writeFileString(`${root}/${file}`, source);
  yield* fs.writeFileString(`${root}/mutants.config.json`, JSON.stringify({ jobs: 3, include: ["from-config.ts"], exclude: ["skip.ts"], timeoutMultiplier: 3, baselineTimeoutMs: 9000 }));
  const observed: Array<Parameters<Run>[0]> = [];
  const errors: string[] = [];
  const original = yield* Console.Console;
  const run: Run = (config, mutants) => Effect.sync(() => {
    observed.push(config);
    return report(config.root, mutants);
  });
  const code = yield* invoke(root, ["--jobs", "2", "--file", "a.ts", "--file", "b.ts", "--timeout", "1.5", "--baseline-timeout", "2", "--minimum-test-timeout", "2.5"], [mutant({ file: "a.ts" })], run).pipe(
    Effect.provideService(Console.Console, { ...original, error: (...args: ReadonlyArray<unknown>) => { errors.push(args.join(" ")); } }));
  expect({ code, errors }).toEqual({ code: 2, errors: [] });
  // Assert outside runCli's defect handler so Vitest shows the actual config diff.
  expect(observed.map(({ jobs, include, exclude, timeoutMs, baselineTimeoutMs, minimumTimeoutMs, timeoutMultiplier }) => ({
    jobs, include, exclude, timeoutMs, baselineTimeoutMs, minimumTimeoutMs, timeoutMultiplier,
  }))).toEqual([{ jobs: 2, include: ["a.ts", "b.ts"], exclude: ["skip.ts"], timeoutMs: 1500,
    baselineTimeoutMs: 2000, minimumTimeoutMs: 2500, timeoutMultiplier: 3 }]);
  expect(yield* invoke(root, ["--jobs", "0"], [])).toBe(1);
  expect(yield* invoke(root, ["--baseline-timeout", "0"], [])).toBe(1);
  yield* fs.writeFileString(`${root}/mutants.config.json`, '{"jobs":"bad"}');
  expect(yield* invoke(root, ["--list"], [])).toBe(1);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("maps baseline failure, timeouts, unviable mutants and internal defects for CI", () => Effect.gen(function*() {
  const root = yield* project;
  const baselineFailure: Run = () => Effect.fail(new BaselineFailed({ exitCode: 1, output: "Failing original suite", command: ["vitest", "run"] }));
  expect(yield* invoke(root, [], [mutant()], baselineFailure)).toBe(4);
  const baselineTimeout: Run = () => Effect.fail(new BaselineTimedOut({ timeoutMs: 2000, command: [], message: "Baseline exceeded 2 seconds. Increase --baseline-timeout." }));
  expect(yield* invoke(root, [], [mutant()], baselineTimeout)).toBe(3);
  expect(yield* invoke(root, ["--advisory"], [mutant()], baselineTimeout)).toBe(0);
  const timeoutRun: Run = (config, mutants) => Effect.succeed({ ...report(config.root, mutants), results: report(config.root, mutants).results.map((result) => ({ ...result, outcome: "timeout" })) });
  expect(yield* invoke(root, [], [mutant()], timeoutRun)).toBe(3);
  const unviableRun: Run = (config, mutants) => Effect.succeed({ ...report(config.root, mutants), results: report(config.root, mutants).results.map((result) => ({ ...result, outcome: "unviable" })) });
  expect(yield* invoke(root, [], [mutant()], unviableRun)).toBe(0);
  expect(yield* invoke(root, [], [mutant()], () => Effect.die("Unexpected engine defect"))).toBe(70);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("buffers a progress write failure and surfaces ReportWriteError at final write", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const item = mutant();
  const reporter = yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  const output = report(root, [item]);
  // Turn logs into a file to force a real filesystem failure, not a mock.
  yield* fs.remove(`${root}/mutants.out/logs`, { recursive: true });
  yield* fs.writeFileString(`${root}/mutants.out/logs`, "blocked");
  yield* reporter.progress(output.results[0]!);
  const result = yield* Effect.result(reporter.write(output));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("ReportWriteError");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("does not erase unrelated files at an output or backup path", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  yield* fs.makeDirectory(`${root}/mutants.out`);
  yield* fs.writeFileString(`${root}/mutants.out/keep.txt`, "user work");
  expect(yield* invoke(root, [], [])).toBe(70);
  expect(yield* fs.readFileString(`${root}/mutants.out/keep.txt`)).toBe("user work");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("emits a context-sized applicable patch with relative paths for an absolute mutant (B7)", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const original = Array.from({ length: 60 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";
  yield* fs.writeFileString(`${root}/account.ts`, original);
  const startOffset = original.indexOf("= 30;") + 2;
  const item = { ...mutant({ file: `${root}/account.ts` }), replacement: { startOffset, endOffset: startOffset + 2, text: "999" } };
  yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  const patch = yield* fs.readFileString(`${root}/mutants.out/diff/${item.id}.diff`);
  expect(patch.split("\n").length).toBeLessThan(15);
  expect(patch).not.toContain(root);
  const handle = yield* ChildProcess.make("git", ["apply", `mutants.out/diff/${item.id}.diff`], { cwd: root });
  expect(Number(yield* handle.exitCode)).toBe(0);
  expect(yield* fs.readFileString(`${root}/account.ts`)).toBe(original.replace("= 30;", "= 999;"));
  yield* fs.writeFileString(`${root}/account.ts`, original);
  const wrapped = { ...item, id: "wrapped", replacement: { startOffset: 0, endOffset: original.length, text: "// before\n" + original + "// after\n" } };
  yield* makeReporter({ root, outDir: "wrapped.out", mutants: [wrapped] });
  const wrapperPatch = yield* fs.readFileString(`${root}/wrapped.out/diff/wrapped.diff`);
  expect(wrapperPatch.match(/^@@ /gm)).toHaveLength(2);
  expect(wrapperPatch.split("\n").length).toBeLessThan(15);
  const apply = yield* ChildProcess.make("git", ["apply", "wrapped.out/diff/wrapped.diff"], { cwd: root });
  expect(Number(yield* apply.exitCode)).toBe(0);
  expect(yield* fs.readFileString(`${root}/account.ts`)).toBe(wrapped.replacement.text);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("plain diff paths apply with patch -p1, and paths needing quotes apply with git", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  for (const name of ["account.ts", "with space.ts"]) {
    const original = "export const answer = 1;\n";
    const modified = "export const answer = 2;\n";
    yield* fs.writeFileString(`${root}/${name}`, original);
    yield* fs.writeFileString(`${root}/path.diff`, unifiedDiff(original, modified, name));
    const handle = yield* ChildProcess.make(name.includes(" ") ? "git" : "patch", name.includes(" ") ? ["apply", "path.diff"] : ["-p1", "-i", "path.diff"], { cwd: root });
    const [logs, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode], { concurrency: "unbounded" });
    expect(Number(code), logs).toBe(0);
    expect(yield* fs.readFileString(`${root}/${name}`)).toBe(modified);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("context patches preserve insertions, deletions, repeated lines and newline changes", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const versions = ["", "a\n", "a", "a\nb\na\n", "b\na\nb\n", "\n", "a\nb\nc", "a\nx\nb\ny\nc\n"];
  for (const original of versions) for (const modified of versions) {
    const patch = unifiedDiff(original, modified, "account.ts");
    if (original === modified) { expect(patch).toBe(""); continue; }
    yield* fs.writeFileString(`${root}/account.ts`, original);
    yield* fs.writeFileString(`${root}/case.diff`, patch);
    const handle = yield* ChildProcess.make("git", ["apply", "case.diff"], { cwd: root });
    const [errors, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode], { concurrency: "unbounded" });
    expect(Number(code), errors + patch).toBe(0);
    expect(yield* fs.readFileString(`${root}/account.ts`)).toBe(modified);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("generated mutant patches apply cleanly to the original, including missing final newlines", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const original = "export const isEmpty = () => true;";
  yield* fs.writeFileString(`${root}/account.ts`, original);
  const startOffset = original.indexOf("true");
  const item = { ...mutant(), replacement: { startOffset, endOffset: startOffset + 4, text: "false" } };
  yield* makeReporter({ root, outDir: "mutants.out", mutants: [item] });
  const handle = yield* ChildProcess.make("git", ["apply", `mutants.out/diff/${item.id}.diff`], { cwd: root });
  expect(Number(yield* handle.exitCode)).toBe(0);
  expect(yield* fs.readFileString(`${root}/account.ts`)).toBe("export const isEmpty = () => false;");
  const selected = yield* selectInDiff({ root, diffPath: `mutants.out/diff/${item.id}.diff`, mutants: [item] });
  expect(selected.map((mutant) => mutant.id)).toEqual([item.id]);
  yield* fs.writeFileString(`${root}/account.ts`, "export const isEmpty = () => false;\n");
  expect(yield* invoke(root, ["--list", "--in-diff", `mutants.out/diff/${item.id}.diff`], [item])).toBe(5);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
