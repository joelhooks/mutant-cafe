import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { RunConfig } from "@mutant-cafe/core";
import { generateFunction } from "../src/Generate.ts";
import { makeTypeScriptOracle } from "../src/TypeScriptOracle.ts";

const root = fileURLToPath(new URL("./fixtures/constructor-order/", import.meta.url));

const enumerate = (include: string[], name = "target") => {
  const config: RunConfig = {
    root, tsconfig: "tsconfig.json", include, exclude: [], functionFilter: [], jobs: 1,
    timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out",
  };
  return makeTypeScriptOracle().discover(config).functions
    .filter(fn => fn.name === name).flatMap(fn => [...generateFunction(fn)]);
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

it("keeps union-valued fields independent of earlier array discovery", () => {
  const full = enumerate([], "policy");
  const single = enumerate(["src/union-target.ts"], "policy");
  const multiple = enumerate(["src/other.ts", "src/union-target.ts"], "policy");
  expect(full.length).toBeGreaterThan(0);
  expect(single.map(mutant => mutant.id)).toEqual(full.map(mutant => mutant.id));
  expect(multiple.map(mutant => mutant.id)).toEqual(full.map(mutant => mutant.id));
  expect(single).toEqual(full);
  expect(multiple).toEqual(full);
});

it.each(["collision", "nested"])("orders colliding representatives deterministically for %s", name => {
  const full = enumerate([], name);
  const single = enumerate(["src/collision-target.ts"], name);
  const multiple = enumerate(["src/other.ts", "src/collision-target.ts"], name);
  expect(full.length).toBeGreaterThan(0);
  expect(single.map(mutant => mutant.id)).toEqual(full.map(mutant => mutant.id));
  expect(multiple.map(mutant => mutant.id)).toEqual(full.map(mutant => mutant.id));
  expect(single).toEqual(full);
  expect(multiple).toEqual(full);
});
