import { expect, it } from "@effect/vitest";
import { TestRunner } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { acquireProcessTree } from "../src/ProcessTree.ts";
import { preflight } from "../src/Preflight.ts";
import { TestRunnerLive } from "../src/TestRunner.ts";
import { openWarmRunner } from "../src/WarmRunner.ts";

const dependencies = decodeURIComponent(new URL("../../../fixtures/tagged-errors/node_modules", import.meta.url).pathname);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "bun-owned-" }).pipe(Effect.flatMap(fs.realPath));
  yield* fs.symlink(dependencies, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module","scripts":{"test":"vitest run"}}');
  yield* fs.writeFileString(`${root}/value.ts`, "export const value = 1;");
  yield* fs.writeFileString(`${root}/value.test.ts`, 'import { it, expect } from "vitest"; import { value } from "./value.ts"; it("value", () => expect(value).toBe(1));');
  yield* fs.writeFileString(`${root}/vitest.config.ts`, 'export default { test: { maxWorkers: 1, include: ["value.test.ts"] } };');
  return { path: root, apply: () => Effect.void, revert: () => Effect.void };
});

it.live.skipIf(process.versions.bun === undefined)("registers a live Bun selector before another tree inspects its scratch", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fixture;
  const root = dir.path;
  const ledgerPaths: string[] = [];
  const warnings: string[] = [];
  const original = yield* Console.Console;
  const tracked: FileSystem.FileSystem = {
    ...fs,
    makeTempDirectory: options => fs.makeTempDirectory({ ...options, directory: root }).pipe(
      Effect.tap(directory => Effect.sync(() => {
        if (options?.prefix === "mutant-processes-") ledgerPaths.push(`${directory}/pids.jsonl`);
      }))
    )
  };
  yield* Effect.scoped(Effect.gen(function* () {
    const selector = yield* openWarmRunner(dir, reason => { warnings.push(reason); }, { quiet: true, selectionOnly: true });
    expect(yield* selector.select("value.ts")).toEqual([`${root}/value.test.ts`]);
    expect(ledgerPaths).toHaveLength(1);
    const rows = yield* fs.readFileString(ledgerPaths[0]!);
    expect(rows.trim()).not.toBe("");
    const entry = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, birth: Schema.String })))(rows.trim().split("\n")[0]!);
    expect(entry.pid).toBeGreaterThan(0);
    expect(entry.birth).not.toBe("");
    const other = yield* acquireProcessTree(root);
    yield* other.cleanup;
    expect(yield* selector.select("value.ts")).toEqual([`${root}/value.test.ts`]);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, tracked),
    Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } })
  ));
  expect(warnings).toEqual([]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);

const ConfigProcess = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, registered: Schema.Boolean }));
const TraceRow = Schema.fromJsonString(Schema.Struct({
  stage: Schema.String, pid: Schema.Int, ppid: Schema.Int,
  targetPid: Schema.optional(Schema.Int), childPid: Schema.optional(Schema.Int)
}));

for (const mode of ["preflight", "cold"] as const) it.live.skipIf(process.versions.bun === undefined)(`registers the real Bun ${mode} process before it runs the Vitest config`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fixture;
  const trace = `${dir.path}/trace.jsonl`;
  const configPids = `${dir.path}/config-pids`;
  yield* fs.writeFileString(`${dir.path}/tsconfig.json`, '{"compilerOptions":{"module":"NodeNext"},"include":["value.ts"]}');
  yield* fs.writeFileString(`${dir.path}/vitest.config.ts`, `
    import { appendFileSync, readFileSync } from "node:fs";
    const rows = readFileSync(process.env.MUTANT_CAFE_PROCESS_LEDGER, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
    const registered = rows.some(row => row.pid === process.pid && row.birth);
    appendFileSync(${JSON.stringify(configPids)}, JSON.stringify({ pid: process.pid, registered }) + "\\n");
    export default { test: { maxWorkers: 1, include: ["value.test.ts"] } };
  `);
  const key = "MUTANT_CAFE_PROCESS_TRACE";
  const previous = process.env[key];
  yield* Effect.acquireRelease(
    Effect.sync(() => { process.env[key] = trace; }),
    () => Effect.sync(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; })
  );
  if (mode === "preflight") expect(yield* preflight(dir.path, undefined, 5000)).toEqual([]);
  else expect(Object.keys((yield* (yield* TestRunner).baseline(dir, undefined, 5000)).testDurations ?? {})).toHaveLength(1);

  const configured = yield* Effect.forEach((yield* fs.readFileString(configPids)).trim().split("\n"), Schema.decodeEffect(ConfigProcess));
  const pids = new Set(configured.map(row => row.pid));
  const rows = yield* Effect.forEach((yield* fs.readFileString(trace)).trim().split("\n"), Schema.decodeEffect(TraceRow));
  const coldPid = rows.find(row => row.stage === "cold-spawn")?.childPid;
  if (mode === "cold") expect(pids.has(coldPid ?? 0)).toBe(true);
  else expect(pids.size).toBe(1);
  for (const { registered } of configured) expect(registered).toBe(true);
  for (const pid of pids) {
    expect(rows.some(row => row.stage === "ps-record-done" && row.pid === pid && row.targetPid === pid && row.ppid === process.pid)).toBe(true);
    expect(rows.some(row => row.stage === "preload-ready" && row.pid === pid)).toBe(true);
  }
}).pipe(Effect.scoped, Effect.provide(TestRunnerLive), Effect.provide(NodeServices.layer)), 20_000);
