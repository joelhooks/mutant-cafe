import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { RunConfig } from "@mutant-cafe/core";
import { generateFunction } from "../src/Generate.ts";
import { makeTypeScriptOracle } from "../src/TypeScriptOracle.ts";

const root = fileURLToPath(new URL("./fixtures/constructor-order/", import.meta.url));

const enumerate = (include: string[]) => {
  const config: RunConfig = {
    root, tsconfig: "tsconfig.json", include, exclude: [], functionFilter: [], jobs: 1,
    timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out",
  };
  return makeTypeScriptOracle().discover(config).functions
    .filter(fn => fn.name === "target").flatMap(fn => [...generateFunction(fn)]);
};

it("keeps constructor property order and IDs under single and multiple file filters", () => {
  const full = enumerate([]);
  const single = enumerate(["src/target.ts"]);
  const multiple = enumerate(["src/other.ts", "src/target.ts"]);
  expect(full.length).toBeGreaterThan(0);
  expect(single.map(mutant => mutant.id)).toEqual(full.map(mutant => mutant.id));
  expect(multiple.map(mutant => mutant.id)).toEqual(full.map(mutant => mutant.id));
  expect(single).toEqual(full);
  expect(multiple).toEqual(full);
  const constructed = full.find(mutant => mutant.genre === "EffectFail" && !mutant.synthetic);
  expect(constructed).toBeDefined();
  expect(constructed!.replacement.text).toContain('{ "cause": undefined, "path": "" }');
});
