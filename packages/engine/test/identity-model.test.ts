import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { fileURLToPath } from "node:url";
import type { RunConfig } from "@mutant-cafe/core";
import { generateFunction } from "../src/Generate.ts";
import { makeTypeScriptOracle } from "../src/TypeScriptOracle.ts";

const dependencies = fileURLToPath(new URL("../../../fixtures/tagged-errors/node_modules", import.meta.url));
it.live("models runtime identity under annotation, trivia, line, binding and body edits", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mc-id-model-" });
  yield* fs.symlink(dependencies, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module"}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, '{"compilerOptions":{"module":"NodeNext","strict":true,"skipLibCheck":true},"files":["model.ts"]}');
  const config: RunConfig = { root, tsconfig: "tsconfig.json", include: [], exclude: [], functionFilter: [], jobs: 1,
    timeoutMultiplier: 5, minimumTimeoutMs: 20000, neverTimeoutMs: 100, outDir: "mutants.out" };
  const model = (style: "base" | "types" | "trivia" | "runtime") => {
    const noise = style === "trivia" ? "\n/* moved */\n\n" : " ";
    const annotation = style === "types" ? "{b:number,a:string}" : "{a:string,b:number}";
    return `import { Context, Effect, Layer } from "effect";${noise}class E extends Error { readonly _tag = "E" as const; }${noise}` +
      `export class Service extends Context.Service<Service, { readonly n: number }>()("Service") {}${noise}` +
      `export const layer = Layer.effect(Service,${noise}Effect.succeed({ n: 1 }));${noise}` +
      `export const defect = (): Effect.Effect<never, E> => ${noise}Effect.fail(${noise}new E(${style === "runtime" ? '"different"' : ''}));${noise}` +
      Array.from({ length: 8 }, (_, i) => `export const f${i} = (n: number): Effect.Effect<${annotation}, E> ${noise}=> ${noise}n > ${style === "runtime" ? i + 1 : i} ? Effect.fail(new E()) : Effect.succeed({ a: String(n), b: n });`).join(noise) +
      `\nexport function scopes() {
        { const twin = (n: number): boolean => n > 0; if (twin(1)) return true; }
        { const twin = (n: number): boolean => n > 0; return twin(1); }
      }`;
  };
  const enumerate = (style: Parameters<typeof model>[0]) => Effect.gen(function* () {
    yield* fs.writeFileString(`${root}/model.ts`, model(style));
    const functions = makeTypeScriptOracle().discover(config).functions;
    const layer = functions.find(fn => fn.name === "layer")!;
    // Layer values do not currently emit original-body wrappers. Assert their
    // shared oracle contract directly so future wrappers never fall back to text.
    expect(layer.runtimeOriginal).toBeTypeOf("function");
    return { layer: layer.runtimeOriginal?.(), mutants: functions.flatMap(fn => [...generateFunction(fn)].map(mutant => ({
      id: mutant.id, name: fn.name, genre: mutant.genre, site: [fn.identityFile, fn.name, fn.identityOrdinal, mutant.genre,
        mutant.description.slice(mutant.description.indexOf(" with ") + 6)],
    }))) };
  });
  const base = yield* enumerate("base");
  const sites = (mutants: typeof base.mutants) => new Map(mutants.map(mutant => [mutant.id, mutant.site]));
  const wraps = (mutant: typeof base.mutants[number]) => mutant.genre === "SwallowTag" || mutant.genre === "TagToDefect";
  expect(base.mutants.filter(mutant => mutant.genre === "SwallowTag")).toHaveLength(8);
  expect(base.mutants.filter(mutant => mutant.genre === "TagToDefect")).toHaveLength(1);
  for (const style of ["types", "trivia"] as const) {
    const edited = yield* enumerate(style);
    expect(sites(edited.mutants)).toEqual(sites(base.mutants));
    expect(edited.layer).toEqual(base.layer);
  }
  const runtime = yield* enumerate("runtime");
  const bySite = new Map(runtime.mutants.map(mutant => [JSON.stringify(mutant.site), mutant.id]));
  expect(bySite.size).toBe(base.mutants.length);
  for (const mutant of base.mutants) {
    const id = bySite.get(JSON.stringify(mutant.site));
    expect(id).toBeDefined();
    if (wraps(mutant)) expect(id).not.toBe(mutant.id);
    else expect(id).toBe(mutant.id);
  }
  const twins = base.mutants.filter(mutant => mutant.name.endsWith("twin"));
  expect(twins).toHaveLength(4);
  expect(sites(twins).size).toBe(4);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);
