import { cleanTelemetry, DEFAULT_BASELINE_TIMEOUT_MS, BaselineFailed, BaselineTimedOut, formatTestCommand, TestRunner, TestSpawnError, type ScratchDir, type TestRun, type SelectionIssue, type Mutant } from "@mutant-cafe/core";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import { preflight } from "./Preflight.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Resolve the target Vitest API for an external setup module.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { openWarmRunner } from "./WarmRunner.ts";
import { reporterSource, vitestLauncherSource, type ProbeOptions } from "./VitestHost.ts";
import { acquireProcessTree } from "./ProcessTree.ts";
import { chooseMode, startupCost, type Calibration } from "./Mode.ts";

const baselineTimedOut = (timeoutMs: number, command: ReadonlyArray<string>) => new BaselineTimedOut({ timeoutMs, command,
  message: `Baseline exceeded ${timeoutMs / 1000} seconds overall, including selection and startup. Increase --baseline-timeout (seconds), or baselineTimeoutMs in mutants.config.json, for a longer suite.` });

export const TestRunnerLive = Layer.effect(TestRunner, Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let warmDisabled = false;
  let modeReason: string | undefined;
  const sessions = new Map<string, Effect.Success<ReturnType<typeof openWarmRunner>>>();
  const auto = new Map<string, { readonly startupMs: number; readonly mutants: number }>();
  const primers = new Map<string, TestRun>();
  const backstopTotals = new Map<string, number>();
  let baselineBudgetMs = DEFAULT_BASELINE_TIMEOUT_MS;
  const lastCommands = new Map<string, ReadonlyArray<string>>();
  const onBackstop = (dir: string) => (ms: number) => { backstopTotals.set(dir, (backstopTotals.get(dir) ?? 0) + ms); };
  const scopes = new Map<string, Scope.Scope>();
  const openedAt = new Map<string, number>();
  const selectors = new Map<string, Effect.Success<ReturnType<typeof openWarmRunner>>>();
  let automaticMode: "pending" | "cold" | "warm" = "pending";
  let hostRestarts = 0;
  let poolResets = 0;
  let warned = false;
  const warn = (message: string) => Effect.suspend(() => { if (warned) return Effect.void; warned = true; return Console.warn(message); });
  const sessionOptions = { onRestart: () => { hostRestarts++; }, onPoolReset: () => { poolResets++; } };
  const execute = Effect.fn("TestRunner.execute")(function* (dir: ScratchDir, args: ReadonlyArray<string>, timeoutMs?: number, testTimeoutMs?: number, forceCold = false, probe?: ProbeOptions) {
    const overallMs = timeoutMs ?? baselineBudgetMs;
    const beforeBackstop = backstopTotals.get(dir.path) ?? 0;
    const backstopMs = () => Math.max(0, (backstopTotals.get(dir.path) ?? 0) - beforeBackstop);
    const session = sessions.get(dir.path);
    if (session !== undefined && !warmDisabled && !auto.has(dir.path) && !forceCold) {
      if (timeoutMs === undefined) yield* Console.error(`Baseline command: vitest run --reporter=default (warm Node API, cwd: ${dir.path})`);
      const run = yield* session.run(args[0] === "related" ? args[1] : undefined, overallMs, testTimeoutMs ?? (timeoutMs === undefined ? undefined : Math.max(1, Math.floor(timeoutMs / 2))), probe);
      if (run !== undefined) return { ...run, backstopMs: backstopMs(), exitCode: run.status === "passed" || run.status === "untested" ? 0 : 1 };
    }
    // Dependency directories are linked to the source checkout. Disable both
    // result and transform caches so Vitest cannot write through those links.
    // Launch the project's installed CLI through our already-running Node.
    // No PATH search, npm wrapper, shell shim or package-manager install checks
    // may block the parent thread before its startup deadline can fire.
    const reporterDir = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-vitest-" }).pipe(
      Effect.mapError((error) => new TestSpawnError({ command: ["vitest"], message: String(error) })));
    const reporter = path.join(reporterDir, "reporter.mjs");
    const launcher = path.join(reporterDir, "launch.mjs");
    yield* fs.writeFileString(launcher, vitestLauncherSource).pipe(Effect.mapError(error => new TestSpawnError({ command: ["vitest"], message: String(error) })));
    const marker = `mutant-cafe:${path.basename(reporterDir)}:`;
    // Vitest's reporter lifecycle is the machine-readable selection/progress
    // boundary. No human output parsing, and partial failures survive an outer kill.
    yield* fs.writeFileString(reporter, reporterSource(marker, probe)).pipe(Effect.mapError((error) => new TestSpawnError({ command: ["vitest"], message: String(error) })));
    const command = [process.execPath, ...process.execArgv, launcher, ...args, "--reporter=default", `--reporter=${reporter}`, "--bail", "1",
      ...(timeoutMs === undefined ? [] : ["--testTimeout", String(testTimeoutMs ?? Math.max(1, Math.floor(timeoutMs / 2))), "--hookTimeout", String(testTimeoutMs ?? Math.max(1, Math.floor(timeoutMs / 2)))]),
      "--no-cache", "--no-fsModuleCache"];
    // Keep diagnostics off stdout so GitHub output is a Markdown document.
    const started = yield* Clock.currentTimeMillis;
    const owned = yield* acquireProcessTree(dir.path, onBackstop(dir.path), openedAt.get(dir.path)).pipe(Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(error => new TestSpawnError({ command, message: String(error) })));
    const chunks: Array<string> = [];
    let exitCode = 1;
    const child = Effect.scoped(Effect.gen(function* () {
      if (timeoutMs === undefined) yield* Console.error(`Baseline command: ${formatTestCommand(command)} (cwd: ${dir.path})`);
      lastCommands.set(dir.path, command);
      yield* owned.trace("cold-spawn-start", { budgetMs: overallMs });
      const handle = yield* spawner.spawn(ChildProcess.make(command[0]!, command.slice(1), {
        cwd: dir.path,
        env: owned.env,
        // Node's scoped spawner kills the detached process group, not just pnpm.
        detached: true,
        killSignal: "SIGKILL",
        forceKillAfter: "100 millis",
        stdin: "ignore"
      }));
      yield* Effect.sync(() => owned.addRoot(handle.pid));
      yield* owned.trace("cold-spawn", { childPid: handle.pid });
      const collect = handle.all.pipe(Stream.decodeText(), Stream.runForEach((chunk) =>
        Effect.sync(() => { chunks.push(chunk); })));
      const [code] = yield* Effect.all([handle.exitCode.pipe(Effect.tap(() => owned.cleanup)), collect], { concurrency: "unbounded" });
      exitCode = code;
      return code === 0 ? "passed" as const : "failed" as const;
    }).pipe(Effect.onInterrupt(() => owned.cleanup)));
    const status = yield* child.pipe(
      Effect.timeout(overallMs),
      Effect.catchTag("TimeoutError", () => Effect.sync(() => { exitCode = 124; chunks.push(`\nVitest timed out after ${overallMs}ms overall, including startup.\n`); return "timedOut" as const; }))
    ).pipe(Effect.mapError((error) => new TestSpawnError({ command, message: error.message })));
    yield* owned.cleanup;
    const ended = yield* Clock.currentTimeMillis;
    const output = chunks.join("");
    const failed = output.includes(marker + "failed");
    const selection = output.split("\n").find(line => line.includes(marker + "selected:"))?.split(marker + "selected:")[1];
    const selected = selection === undefined ? [] : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(selection).pipe(
      Effect.mapError(error => new TestSpawnError({ command, kind: "reporter", message: `Internal cold reporter protocol error in selected files: ${String(error)}` })));
    const telemetryWarnings: string[] = [];
    for (const part of output.split(marker + "telemetryWarning:").slice(1)) {
      const warning = Schema.decodeOption(Schema.fromJsonString(Schema.String))(part.split("\n")[0]!);
      if (warning._tag === "Some") telemetryWarnings.push(warning.value);
    }
    const testDurations: Record<string, number> = {};
    const testFileDurations: Record<string, number> = {};
    let firstTestStart = 0;
    const testTimeouts: Record<string, number> = {};
    const testTimeoutDetails: Record<string, number> = {};
    for (const line of output.split("\n")) {
      const entry = line.split(marker + "duration:")[1];
      if (entry === undefined) continue;
      const decoded = Schema.decodeOption(Schema.fromJsonString(Schema.Struct({ file: Schema.String, duration: Schema.Finite, timeout: Schema.Finite, key: Schema.String, start: Schema.Finite })))(entry);
      if (decoded._tag === "None") { telemetryWarnings.push("Internal reporter telemetry error: invalid cold timing marker; omitted"); continue; }
      const timing = decoded.value;
      if (timing.start > 0) firstTestStart = firstTestStart ? Math.min(firstTestStart, timing.start) : timing.start;
      testDurations[timing.file] = Math.max(testDurations[timing.file] ?? 0, timing.duration);
      testTimeoutDetails[timing.key] = timing.timeout;
      testTimeouts[timing.file] = Math.max(testTimeouts[timing.file] ?? 0, timing.timeout);
    }
    for (const part of output.split(marker + "fileDuration:").slice(1)) {
      const decoded = Schema.decodeOption(Schema.fromJsonString(Schema.Struct({ file: Schema.String, duration: Schema.Finite })))(part.split("\n")[0]!);
      if (decoded._tag === "None") { telemetryWarnings.push("Internal reporter telemetry error: invalid cold file timing marker; omitted"); continue; }
      const timing = decoded.value;
      testFileDurations[timing.file] = timing.duration;
    }
    const run: TestRun = {
      status: failed ? "failed" : status === "passed" && output.includes(marker + "empty") ? "untested" : status,
      durationMs: ended - started, command, output,
      testsCollected: output.includes(marker + "collected"),
      testFiles: selected, testDurations, testTimeouts, testTimeoutDetails, testFileDurations,
      startupMs: firstTestStart ? Math.max(0, Math.ceil(firstTestStart - started)) : 0,
      probeSupported: output.includes(marker + "probeSupported:true"),
      probeLoaded: output.includes(marker + "probeLoaded"),
      testWorkers: output.includes(marker + "workers:") ? Number(output.split(marker + "workers:")[1]?.split("\n")[0]) : undefined,
      testConcurrency: Math.max(0, ...output.split(marker + "concurrency:").slice(1).map(part => Number(part.split("\n")[0]))),
    };
    const cleaned = cleanTelemetry(run, "cold run");
    return { ...cleaned.value, backstopMs: backstopMs(), telemetryWarnings: [...telemetryWarnings, ...cleaned.warnings], exitCode };
  }, Effect.scoped);
  return TestRunner.of({
    stats: Effect.sync(() => ({ hostRestarts, poolResets })),
    open: Effect.fn("TestRunner.open")(function* (dir: ScratchDir, cold: boolean, warm = false, mutants = 1) {
      scopes.set(dir.path, yield* Scope.Scope);
      openedAt.set(dir.path, yield* Clock.currentTimeMillis);
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        sessions.delete(dir.path); selectors.delete(dir.path); auto.delete(dir.path); primers.delete(dir.path); scopes.delete(dir.path); backstopTotals.delete(dir.path); openedAt.delete(dir.path); lastCommands.delete(dir.path);
        if (scopes.size === 0) { baselineBudgetMs = DEFAULT_BASELINE_TIMEOUT_MS; warmDisabled = false; automaticMode = "pending"; hostRestarts = 0; poolResets = 0; warned = false; modeReason = undefined; }
      }));
      if (cold) modeReason = "Explicit --cold";
      if (cold || warmDisabled || (!warm && automaticMode === "cold")) return;
      const started = yield* Clock.currentTimeMillis;
      const session = yield* openWarmRunner(dir, reason => { warmDisabled = true; modeReason = reason; }, { ...sessionOptions, quiet: !warm, warn, onBackstop: onBackstop(dir.path), processesSince: openedAt.get(dir.path) }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(error => error._tag === "TestSpawnError" ? error : new TestSpawnError({ command: ["vitest", "warm"], message: String(error) })));
      sessions.set(dir.path, session);
      if (warmDisabled || (!warm && automaticMode === "cold")) { yield* session.disable; return; }
      if (warm) modeReason = "Explicit --warm; supported configuration";
      if (!warm && automaticMode === "pending") auto.set(dir.path, { startupMs: (yield* Clock.currentTimeMillis) - started, mutants });

    }),
    invalidate: (dir, file) => sessions.get(dir.path)?.invalidate(file) ?? Effect.void,
    selectRelated: Effect.fn("TestRunner.selectRelated")(function* (dir: ScratchDir, file: string) {
      const session = sessions.get(dir.path);
      if (session !== undefined && !warmDisabled) return yield* session.select(file);
      let selector = selectors.get(dir.path) ?? selectors.values().next().value;
      if (!selector) {
        const scope = scopes.get(dir.path);
        if (!scope) return undefined;
        selector = yield* openWarmRunner(dir, () => {}, { quiet: true, selectionOnly: true, onBackstop: onBackstop(dir.path), processesSince: openedAt.get(dir.path) }).pipe(Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Scope.Scope, scope), Effect.mapError(error => error._tag === "TestSpawnError" ? error : new TestSpawnError({ command: ["vitest", "select"], message: String(error) })));
        selectors.set(dir.path, selector);
      }
      return yield* selector.select(file);
    }),
    probeReachability: Effect.fn("TestRunner.probeReachability")(function* (dir: ScratchDir, mutant: Mutant, timeoutMs: number) {
      if (!dir.poison) return { file: mutant.file, status: "unsupported" as const, durationMs: 0, testCommand: [], output: "Scratch adapter cannot poison modules" };
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-probe-" });
      const signal = path.join(temporary, "loaded");
      const control = path.join(temporary, "control");
      const token = `mutant-cafe-probe:${path.basename(temporary)}`;
      const setupFile = path.join(temporary, "setup.mjs");
      const vitest = yield* Effect.try({ try: () => pathToFileURL(path.join(path.dirname(createRequire(path.join(dir.path, "package.json")).resolve("vitest/package.json")), "dist/index.js")).href,
        catch: error => new TestSpawnError({ command: ["vitest", "probe"], message: String(error) }) });
      yield* fs.writeFileString(setupFile, `import { beforeAll, afterAll } from ${JSON.stringify(vitest)};
        beforeAll(() => globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(control)}, "ready"));
        afterAll(() => { if (globalThis[Symbol.for(${JSON.stringify(token)})]) throw new Error(${JSON.stringify(token)}); });`);
      const started = yield* Clock.currentTimeMillis;
      const invalidate = () => sessions.get(dir.path)?.invalidate(mutant.file) ?? Effect.void;
      const run = yield* Effect.acquireUseRelease(
        dir.poison(mutant, signal, token),
        () => Effect.gen(function* () {
          yield* invalidate();
          return yield* execute(dir, ["run", "--passWithNoTests"], timeoutMs, undefined, false, { token, setupFile });
        }),
        () => dir.revert(mutant).pipe(Effect.andThen(invalidate), Effect.orDie)
      );
      const supported = yield* fs.exists(control);
      const loaded = (yield* fs.exists(signal)) || run.probeLoaded === true;
      return { file: mutant.file,
        status: !supported ? "unsupported" as const : run.status === "passed" && !loaded ? "unreachable" as const : "reachable" as const,
        durationMs: (yield* Clock.currentTimeMillis) - started, testCommand: run.command, output: run.output };
    }, effect => effect.pipe(Effect.scoped, Effect.mapError(error => error._tag === "ScratchError" || error._tag === "TestSpawnError" ? error :
      new TestSpawnError({ command: ["vitest", "probe"], message: String(error) })))),
    baseline: Effect.fn("TestRunner.baseline")(function* (dir: ScratchDir, tsconfig?: string, timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS) {
      baselineBudgetMs = timeoutMs;
      lastCommands.delete(dir.path);
      const unreliable: ReadonlyArray<SelectionIssue> = yield* preflight(dir.path, tsconfig, timeoutMs, { processesSince: openedAt.get(dir.path), onBackstop: onBackstop(dir.path) }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.catch(error => Effect.succeed([{ kind: "warning" as const, reason: `Cannot verify runner selection: ${String(error)}` }])));
      for (const issue of unreliable) yield* Console.warn(`Warning (${issue.kind}): ${issue.reason}`);
      if (unreliable.some(issue => issue.kind === "runner")) {
        const command = ["npx", "--no", "vitest", "run", "--passWithNoTests"];
        yield* Console.warn(`Baseline command (not executed: unsupported runner): ${command.join(" ")}`);
        return { durationMs: 0, testCommand: command, unreliable };
      }
      const run = yield* execute(dir, ["run", "--passWithNoTests"], undefined, undefined, auto.has(dir.path));
      if (run.status === "timedOut") return yield* baselineTimedOut(timeoutMs, run.command);
      if (run.status !== "passed" && run.status !== "untested") {
        return yield* Effect.fail(new BaselineFailed({ exitCode: run.exitCode, output: run.output, command: run.command }));
      }
      if (sessions.has(dir.path)) yield* sessions.get(dir.path)!.invalidate(run.testFiles?.[0] ?? "package.json");
      if (auto.has(dir.path)) primers.set(dir.path, run);
      return { durationMs: run.durationMs, testCommand: run.command, unreliable, hostPid: run.hostPid, telemetryWarnings: run.telemetryWarnings, testTimeoutDetails: run.testTimeoutDetails,
        testDurations: run.testDurations, testTimeouts: run.testTimeouts, testWorkers: run.testWorkers, testConcurrency: run.testConcurrency,
        testFileDurations: run.testFileDurations, startupMs: run.startupMs, probeSupported: run.probeSupported,
        runnerModeReason: modeReason ?? (auto.has(dir.path) ? "Auto calibration pending" : "Cold execution; no warm session"),
        runnerMode: sessions.has(dir.path) && !warmDisabled && !auto.has(dir.path) ? "warm" as const : "cold" as const };
    }, (effect, dir, _tsconfig?: string, timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS) => effect.pipe(
      Effect.timeout(timeoutMs), Effect.catchTag("TimeoutError", () => Effect.fail(baselineTimedOut(timeoutMs, lastCommands.get(dir.path) ?? []))))),
    calibrate: Effect.fn("TestRunner.calibrate")(function* (dir: ScratchDir, mutants: number, copies: number) {
      const primer = primers.get(dir.path) ?? primers.values().next().value;
      if (!primer || automaticMode !== "pending" || auto.size === 0 || warmDisabled) return {};
      const disable = Effect.gen(function* () {
        automaticMode = "cold"; warmDisabled = true; auto.clear();
        for (const session of sessions.values()) yield* session.disable;
      });
      if (mutants <= (primer.testFiles?.length ?? 0)) {
        modeReason = `Auto: small selection (${mutants} testable mutants across ${primer.testFiles?.length ?? 0} files)`;
        yield* disable;
        yield* Console.warn(`Vitest auto mode: cold; small selection (${mutants} testable mutants across ${primer.testFiles?.length ?? 0} files), skipping paired calibration`);
        return { runnerMode: "cold" as const, runnerModeReason: modeReason, testableMutants: mutants };
      }
      // A successful primer warmed the filesystem for BOTH measured runs.
      const startups = [...auto.values()].map(entry => entry.startupMs);
      auto.clear();
      // Finish the cold process before warm global-setup services are started.
      const cold = yield* execute(dir, ["run", "--passWithNoTests"], undefined, undefined, true);
      if (cold.status === "timedOut") return yield* baselineTimedOut(baselineBudgetMs, cold.command);
      if (cold.status !== "passed" && cold.status !== "untested") return yield* new BaselineFailed({ exitCode: cold.exitCode, output: cold.output, command: cold.command });
      const warm = yield* execute(dir, ["run", "--passWithNoTests"]);
      if (warm.status === "timedOut") return yield* baselineTimedOut(baselineBudgetMs, warm.command);
      if (warm.status !== "passed" && warm.status !== "untested") return yield* new BaselineFailed({ exitCode: warm.exitCode, output: warm.output, command: warm.command });
      const calibration: Calibration = { coldMs: cold.durationMs, warmMs: warm.durationMs,
        warmStartupMs: startupCost(startups, copies),
        overheadMs: warm.durationMs + cold.durationMs, coldStartupMs: cold.startupMs ?? 0, warmRunStartupMs: warm.startupMs ?? 0, testFiles: cold.testFiles?.length ?? 0, mutants };
      const sameSelection = JSON.stringify([...(warm.testFiles ?? [])].sort()) === JSON.stringify([...(cold.testFiles ?? [])].sort());
      const choice = !warmDisabled && warm.status === cold.status && sameSelection ? chooseMode(calibration) : "cold";
      modeReason = warmDisabled ? (modeReason ?? "Warm execution failed during calibration") : !sameSelection || warm.status !== cold.status ? "Auto: cold/warm selection or status mismatch" : `Auto: paired measurements favor ${choice}`;
      automaticMode = choice;
      auto.clear();
      yield* Console.warn(`Vitest auto mode: ${choice}; paired cold ${cold.durationMs} ms, warm ${warm.durationMs} ms; ${mutants} testable mutants, ${copies} copies, startup ${calibration.warmStartupMs} ms`);
      if (choice === "cold") yield* disable;
      else if (sessions.has(dir.path)) yield* sessions.get(dir.path)!.invalidate(warm.testFiles?.[0] ?? "package.json");
      const run = choice === "cold" ? cold : warm;
      return { runnerMode: choice, runnerModeReason: modeReason, calibration, testableMutants: mutants, hostPid: run.hostPid };
    }),
    runRelated: Effect.fn("TestRunner.runRelated")(function* (dir: ScratchDir, file: string, timeoutMs: number, testTimeoutMs?: number) {
      const related = yield* execute(dir, ["related", file, "--run", "--passWithNoTests"], timeoutMs, testTimeoutMs);
      if (related.status !== "untested") return related;
      const remaining = Math.max(1, timeoutMs - related.durationMs);
      const full = yield* execute(dir, ["run", "--passWithNoTests"], remaining, testTimeoutMs);
      return { ...full, status: full.status === "passed" ? "untested" as const : full.status, durationMs: related.durationMs + full.durationMs, backstopMs: (related.backstopMs ?? 0) + (full.backstopMs ?? 0),
        output: related.output + "\nFull-suite fallback:\n" + full.output };
    })
  });
}));
