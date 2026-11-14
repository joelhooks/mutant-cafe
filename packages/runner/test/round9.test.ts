import { expect, it } from "@effect/vitest";
import { formatTestCommand, TestRunner } from "@mutant-cafe/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestRunnerLive } from "../src/TestRunner.ts";
import { ProcessInspector } from "../src/ProcessTree.ts";
import { preflight } from "../src/Preflight.ts";
import { openWarmRunner } from "../src/WarmRunner.ts";

const dependencies = decodeURIComponent(new URL("../../../fixtures/tagged-errors/node_modules", import.meta.url).pathname);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "calibration-budget-" });
  yield* fs.symlink(dependencies, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module","scripts":{"test":"vitest run"}}');
  yield* fs.writeFileString(`${root}/tsconfig.json`, '{"compilerOptions":{"target":"ESNext","module":"NodeNext","noEmit":true},"include":["value.ts"]}');
  yield* fs.writeFileString(`${root}/value.ts`, "export const value = 1;");
  yield* fs.writeFileString(`${root}/value.test.ts`, 'import { it, expect } from "vitest"; import { value } from "./value.ts"; it("value", () => expect(value).toBe(1));');
  yield* fs.writeFileString(`${root}/vitest.config.ts`, 'export default { test: { maxWorkers: 1, include: ["value.test.ts"] } };');
  return { path: root, apply: () => Effect.void, revert: () => Effect.void };
});

it.live("jobs 2 auto calibration on the other copy uses the custom run-level baseline budget", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const first = yield* fixture;
  const second = yield* fixture;
  let stall = false;
  const tracked: FileSystem.FileSystem = { ...fs, writeFileString: (path, text, options) => fs.writeFileString(path,
    stall && path.endsWith("/launch.mjs") ? 'setInterval(() => {}, 1000); await new Promise(() => {});\n' + text : text, options) };
  yield* Effect.scoped(Effect.gen(function* () {
    const tests = yield* TestRunner;
    if (!tests.open || !tests.calibrate) return yield* Effect.die("Expected real warm calibration services");
    // Explicitly choose copy B, independent of pool lease scheduling, to model
    // the jobs=2 case that used to fall back to the default on every other copy.
    yield* tests.open(first, false, false, 8);
    yield* tests.open(second, false, false, 8);
    expect(Object.keys((yield* tests.baseline(first, undefined, 5000)).testDurations ?? {})).toHaveLength(1);
    stall = true;
    const result = yield* tests.calibrate(second, 8, 2).pipe(Effect.timeout(12_000), Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("BaselineTimedOut");
      if (result.failure._tag === "BaselineTimedOut") {
        expect(result.failure.timeoutMs).toBe(5000);
        expect(result.failure.message).toContain("exceeded 5 seconds");
      }
    }
  }).pipe(Effect.provide(TestRunnerLive), Effect.provideService(FileSystem.FileSystem, tracked)));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000);

for (const supplied of [false, true]) it.live(supplied
  ? "a minimal-env orphan without a birth row stays warning-only after its parent exits"
  : "standalone preflight fences old unknown processes out of its finalizer backstop", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "preflight-fence-" });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const original = yield* Console.Console;
  const warnings: string[] = []; const signals: number[] = []; const costs: number[] = [];
  const tracked: FileSystem.FileSystem = { ...fs, makeTempDirectory: options => fs.makeTempDirectory({ ...options, directory: root }) };
  // This is the state left by a fast-exiting parent whose async birth callback
  // never completed: PPID 1, no ownership label and no ledger birth row. An argv
  // or cwd match is useful evidence for a warning, never authority to kill it.
  const orphan = `2147483000 1 2147483000 S Mon Jan 1 00:00:00 2001 node ${root}/orphan.js\n`;
  yield* preflight(root, undefined, 5000, { ...(supplied ? { processesSince: 0 } : {}), onBackstop: ms => { costs.push(ms); } }).pipe(
    Effect.provideService(FileSystem.FileSystem, tracked),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, { ...spawner, string: () => Effect.succeed("mutant-cafe-preflight:[]") }),
    Effect.provideService(ProcessInspector, { inspect: () => Effect.succeed({ stdout: orphan }), signal: pid => { signals.push(pid); } }),
    Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } }));
  expect(signals).toEqual([]);
  expect(costs).toHaveLength(1);
  if (supplied) expect(warnings.some(message => message.includes("2147483000") && message.includes("ownership is unproven"))).toBe(true);
  else expect(warnings).toEqual([]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("bounds a warm request under an interruption mask and replaces the retired host for the next run", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fixture;
  const flag = `${dir.path}/hold-run`;
  yield* fs.writeFileString(flag, "hold");
  let restarts = 0;
  const tracked: FileSystem.FileSystem = { ...fs, writeFileString: (path, text, options) => fs.writeFileString(path, path.endsWith("/host.mjs")
    ? text.replace('if (request.type !== "run") return;', `if (request.type !== "run") return;\n    try { readFileSync(${JSON.stringify(flag)}); return; } catch {}`)
    : text, options) };
  yield* Effect.scoped(Effect.gen(function* () {
    const warm = yield* openWarmRunner(dir, () => {}, { onRestart: () => { restarts++; } });
    const started = performance.now();
    const result = yield* warm.run(undefined, 400).pipe(Effect.uninterruptible);
    expect(result?.status).toBe("timedOut");
    expect(result?.testsCollected).toBe(false);
    expect(performance.now() - started).toBeLessThan(5000);
    yield* fs.remove(flag);
    yield* warm.invalidate("value.ts");
    expect((yield* warm.run(undefined, 5000))?.status).toBe("passed");
    expect(restarts).toBe(1);
  }).pipe(Effect.provideService(FileSystem.FileSystem, tracked)));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);

it("names Vitest and preserves the exact physical launcher argv in diagnostics", () => {
  const argv = ["/node", "/tmp/mutant-vitest-example/launch.mjs", "run", "--passWithNoTests", "--reporter=default", "--reporter=/tmp/reporter.mjs", "--bail", "1"];
  expect(formatTestCommand(argv)).toBe(`vitest run --passWithNoTests --reporter=default --bail 1 (via ${argv.join(" ")})`);
  expect(formatTestCommand(["vitest", "run"])).toBe("vitest run");
});

it.live("preserves runtime exec flags for cold conditional imports and the recorded command", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fixture;
  yield* fs.writeFileString(`${dir.path}/package.json`, JSON.stringify({
    type: "module", scripts: { test: "vitest run" },
    imports: { "#choice": { "mutant-cafe-source": "./source.json", default: "./default.json" } }
  }));
  yield* fs.writeFileString(`${dir.path}/source.json`, '{"mode":"source"}');
  yield* fs.writeFileString(`${dir.path}/default.json`, '{"mode":"default"}');
  yield* fs.writeFileString(`${dir.path}/vitest.config.ts`, `
    const require = process.getBuiltinModule("node:module").createRequire(import.meta.url);
    process.getBuiltinModule("node:fs").writeFileSync(new URL("./runtime-choice", import.meta.url), require("#choice").mode);
    export default { test: { maxWorkers: 1, include: ["value.test.ts"] } };`);
  const previous = process.execArgv;
  const flags = [...previous, "--conditions=mutant-cafe-source", "--no-warnings"];
  yield* Effect.acquireRelease(
    Effect.sync(() => { process.execArgv = flags; }),
    () => Effect.sync(() => { process.execArgv = previous; })
  );
  const baseline = yield* (yield* TestRunner).baseline(dir);
  expect(yield* fs.readFileString(`${dir.path}/runtime-choice`)).toBe("source");
  const entry = baseline.testCommand.findIndex(value => value.endsWith("/launch.mjs"));
  expect(baseline.testCommand[0]).toBe(process.execPath);
  expect(entry).toBeGreaterThan(flags.length);
  expect(baseline.testCommand.slice(entry - flags.length, entry)).toEqual(flags);
}).pipe(Effect.scoped, Effect.provide(TestRunnerLive), Effect.provide(NodeServices.layer)), 20_000);

it("names Vitest after runtime flags without hiding them from the physical argv", () => {
  const command = ["/node", "--conditions=source", "--no-warnings", "/tmp/mutant-vitest-example/launch.mjs", "run", "--reporter=default", "--reporter=/tmp/reporter.mjs"];
  expect(formatTestCommand(command)).toBe(`vitest run --reporter=default (via ${command.join(" ")})`);
});

it("does not mistake a runtime preload for the generated Vitest launcher", () => {
  const command = ["/node", "--require", "/tmp/launch.mjs", "--import=/tmp/launch.mjs", "/tmp/mutant-vitest-example/launch.mjs", "run"];
  expect(formatTestCommand(command)).toBe(`vitest run (via ${command.join(" ")})`);
});
