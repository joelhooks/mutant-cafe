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
    return `import { Effect } from "effect";${noise}class E extends Error { readonly _tag = "E" as const; }${noise}` +
      Array.from({ length: 8 }, (_, i) => `export const f${i} = (n: number): Effect.Effect<${annotation}, E> ${noise}=> ${noise}n > ${style === "runtime" ? i + 1 : i} ? Effect.fail(new E()) : Effect.succeed({ a: String(n), b: n });`).join(noise) +
      `\nexport function scopes() {
        { const twin = (n: number): boolean => n > 0; if (twin(1)) return true; }
        { const twin = (n: number): boolean => n > 0; return twin(1); }
      }`;
  };
  const enumerate = (style: Parameters<typeof model>[0]) => Effect.gen(function* () {
    yield* fs.writeFileString(`${root}/model.ts`, model(style));
    return makeTypeScriptOracle().discover(config).functions.flatMap(fn => [...generateFunction(fn)]);
  });
  const base = yield* enumerate("base");
  const ids = (mutants: typeof base) => mutants.map(mutant => mutant.id).sort();
  const wraps = (mutants: typeof base) => ids(mutants.filter(mutant => mutant.genre === "SwallowTag"));
  expect(wraps(base)).toHaveLength(8);
  expect(ids(yield* enumerate("types"))).toEqual(ids(base));
  expect(ids(yield* enumerate("trivia"))).toEqual(ids(base));
  expect(wraps(yield* enumerate("runtime")).every(id => !wraps(base).includes(id))).toBe(true);
  const twins = base.filter(mutant => mutant.functionName.endsWith("twin"));
  expect(twins).toHaveLength(4);
  expect(new Set(ids(twins)).size).toBe(4);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);
