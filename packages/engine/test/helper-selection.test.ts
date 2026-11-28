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

it.each([false, undefined])("keeps a default include with intent %s from opting into test directories", explicitIncludes => {
  const selected = makeTypeScriptOracle().discover({ ...config, include: ["**/*.{ts,tsx}"], explicitIncludes });
  expect(selected.functions.map(fn => fn.name)).toEqual(["production"]);
});

it("honors explicit fake and workload globs under test directories", () => {
  const selected = makeTypeScriptOracle().discover({ ...config, explicitIncludes: true, include: [
    "src/**/*.ts", "tests/**/*.fake.ts", "tests/**/*.workload.ts", "test/**/*.fake.ts", "test/**/*.workload.ts"
  ] });
  expect(selected.functions.map(fn => fn.name).sort()).toEqual(["fake", "nestedMock", "nestedTestHelper", "production", "singularFake", "singularWorkload", "workload"]);
});

it("opts nested support folders in through a production glob and lets excludes opt them back out", () => {
  const explicit = { ...config, explicitIncludes: true, include: ["src/**/*.ts"] };
  const selected = makeTypeScriptOracle().discover(explicit);
  expect(selected.functions.map(fn => fn.name).sort()).toEqual(["nestedMock", "nestedTestHelper", "production"]);
  const excluded = makeTypeScriptOracle().discover({ ...explicit, exclude: ["**/{test,tests,__tests__,__mocks__}/**"] });
  expect(excluded.functions.map(fn => fn.name)).toEqual(["production"]);
});

it.each([
  ["test", ["singularFake", "singularWorkload"]],
  ["tests", ["fake", "workload"]],
  ["__tests__", ["internalTestHelper"]],
  ["__mocks__", ["mockHelper"]],
] as const)("includes explicit helpers under %s without adding assertion or declaration files", (directory, names) => {
  const selected = makeTypeScriptOracle().discover({ ...config, explicitIncludes: true, include: [`${directory}/**/*.ts`] });
  expect(selected.functions.map(fn => fn.name).sort()).toEqual(names);
});

it("still excludes declarations, test and spec assertion files with broad explicit includes", () => {
  const selected = makeTypeScriptOracle().discover({ ...config, include: ["**/*.ts"], explicitIncludes: true });
  expect(selected.functions.map(fn => fn.name).sort()).toEqual(["fake", "internalTestHelper", "mockHelper", "nestedMock", "nestedTestHelper", "production", "singularFake", "singularWorkload", "workload"]);
});
