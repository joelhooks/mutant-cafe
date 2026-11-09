import { expect, it } from "vitest";
import type { RunConfig } from "@mutant-cafe/core";
import { makeTypeScriptOracle } from "../src/index.ts";

const config: RunConfig = {
  root: decodeURIComponent(new URL("./fixtures/helper-selection/", import.meta.url).pathname),
  tsconfig: "tsconfig.json", include: [], exclude: [], functionFilter: [], jobs: 1,
  timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out"
};

it("keeps test directories excluded without explicit includes", () => {
  const selected = makeTypeScriptOracle().discover(config);
  expect(selected.functions.map(fn => fn.name)).toEqual(["production"]);
});

it("keeps the CLI default include from opting into test directories", () => {
  const selected = makeTypeScriptOracle().discover({ ...config, include: ["**/*.{ts,tsx}"], explicitIncludes: false });
  expect(selected.functions.map(fn => fn.name)).toEqual(["production"]);
});

it("honors explicit fake and workload globs under test directories", () => {
  const selected = makeTypeScriptOracle().discover({ ...config, include: [
    "src/**/*.ts", "tests/**/*.fake.ts", "tests/**/*.workload.ts", "test/**/*.fake.ts", "test/**/*.workload.ts"
  ] });
  expect(selected.functions.map(fn => fn.name).sort()).toEqual(["fake", "production", "singularFake", "singularWorkload", "workload"]);
});

it("still excludes test and spec assertion files with broad explicit includes", () => {
  const selected = makeTypeScriptOracle().discover({ ...config, include: ["**/*.ts"] });
  expect(selected.functions.map(fn => fn.name).sort()).toEqual(["fake", "production", "singularFake", "singularWorkload", "workload"]);
});
