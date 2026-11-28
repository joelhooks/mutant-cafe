import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import { fileURLToPath } from "node:url";
import type { RunConfig } from "@mutant-cafe/core";
import { makeMutantSource, makeTypeScriptOracle } from "../src/index.ts";

const fixture = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const config = (root: string): RunConfig => ({ root, tsconfig: "tsconfig.json", include: [], exclude: [], functionFilter: [], jobs: 1,
  timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out" });

const fixtures = [
  ...[".", "constructor-order", "coverage", "helper-selection", "honesty", "viability"].map(name => `./fixtures/${name}/`),
  ...["parallel", "processes", "warm"].map(name => `../../runner/test/fixtures/${name}/`),
  "../../../fixtures/tagged-errors/",
];

it.each(fixtures)("has unique IDs over a full generation of %s", dir =>
  Effect.runPromise(Effect.gen(function* () {
    const source = makeMutantSource(makeTypeScriptOracle());
    const mutants = yield* Stream.runCollect(source.generate(config(fixture(dir))));
    expect(mutants.length).toBeGreaterThan(0);
    expect(new Set(mutants.map(mutant => mutant.id)).size).toBe(mutants.length);
  })), 20_000);

it.effect("distinguishes type-only representatives and rejects a duplicate before emitting any mutants", () => Effect.gen(function* () {
  const run = config(fixture("./fixtures/"));
  const real = makeTypeScriptOracle();
  const fn = real.discover(run).functions[0]!;
  const makeSource = (choices: string[]) => makeMutantSource({ ...real, discover: () => ({ notMutated: [], functions: [{
    ...fn, equivalentValues: [], literal: undefined, generationIssue: () => undefined,
    shape: { kind: "Boolean", values: choices.map(text => ({ text, synthetic: false })) },
  }] }) });
  const a = "Option.none<A>()";
  const b = "Option.none<B>()";
  const separated = yield* Stream.runCollect(makeSource([a, b]).generate(run));
  expect(separated).toHaveLength(2);
  expect(separated[0]?.id).not.toBe(separated[1]?.id);
  const emitted: string[] = [];
  const duplicate = yield* makeSource([a, a]).generate(run).pipe(
    Stream.tap(mutant => Effect.sync(() => { emitted.push(mutant.id); })), Stream.runDrain, Effect.result,
  );
  expect(emitted).toEqual([]);
  expect(Result.isFailure(duplicate) ? duplicate.failure._tag : "emitted successfully").toBe("DuplicateMutantId");
}), 20_000);
