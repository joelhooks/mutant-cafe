import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MutantSource, Scratch, TestRunner } from "@mutant-cafe/core";
import { makeMutantSource, makeTypeScriptOracle } from "@mutant-cafe/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { runCli } from "../src/Command.ts";

it.live("distinguishes CLI defaults from explicit flag and config helper selections", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const original = yield* Console.Console;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-include-intent-" });
  yield* fs.makeDirectory(`${root}/src`);
  yield* fs.makeDirectory(`${root}/tests`);
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ESNext", module: "NodeNext", strict: true }, include: ["src/**/*.ts", "tests/**/*.ts"] }));
  yield* fs.writeFileString(`${root}/src/value.ts`, "export const production = (): boolean => true;");
  yield* fs.writeFileString(`${root}/tests/value.fake.ts`, "export const fake = (): boolean => true;");
  yield* fs.writeFileString(`${root}/tests/value.workload.ts`, "export const workload = (): boolean => true;");
  const invoke = (args: ReadonlyArray<string>) => Effect.gen(function* () {
    const source = makeMutantSource(makeTypeScriptOracle());
    const files: string[] = [];
    const code = yield* runCli({ root, args: ["--list", "--format", "json", ...args], run: () => Effect.die("Unexpected mutation execution") }).pipe(
      Effect.provideService(MutantSource, { ...source, generate: config => source.generate(config).pipe(
        Stream.tap(mutant => Effect.sync(() => { files.push(path.relative(root, mutant.file)); }))
      ) }),
      Effect.provideService(Scratch, { acquire: () => Effect.die("Unexpected scratch acquisition") }),
      Effect.provideService(TestRunner, { baseline: () => Effect.die("Unexpected baseline"), runRelated: () => Effect.die("Unexpected test spawn") }),
      Effect.provideService(Console.Console, { ...original, log: () => {} })
    );
    expect(code).toBe(0);
    return [...new Set(files)].sort();
  });
  expect(yield* invoke([])).toEqual(["src/value.ts"]);
  expect(yield* invoke(["--file", "tests/**/*.fake.ts"])).toEqual(["tests/value.fake.ts"]);
  yield* fs.writeFileString(`${root}/mutants.config.json`, JSON.stringify({ include: ["tests/**/*.workload.ts"] }));
  expect(yield* invoke([])).toEqual(["tests/value.workload.ts"]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);
