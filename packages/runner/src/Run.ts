import {
  reportMetadata, excludeLinkedCandidates, sanitizeReportTelemetry, MutantSource, MutantResult, NotMutated, ReachabilityProbe, Reporter, Scratch, TestRunner,
  Baseline, BaselineFailed, BaselineTimedOut, formatTestCommand, type Mutant,
  type GenerationError, type ReportWriteError, type RunConfig, type RunReport,
  type ScratchDir, ScratchError, type TestSpawnError
} from "@mutant-cafe/core";
import { createEffectActor, createEffectLogic, join, send, setupEffect } from "@xstate/effect";
import { types } from "xstate";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Pool from "effect/Pool";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { unreliableFor } from "./Preflight.ts";

type RunError = BaselineFailed | BaselineTimedOut | ScratchError | TestSpawnError | GenerationError | ReportWriteError;
// XState freezes plain context objects in development. A pool is a live
// resource, not immutable run data; keep its internals behind a class handle.
class ScratchPool {
  readonly value: Pool.Pool<ScratchDir, ScratchError>;
  constructor(value: Pool.Pool<ScratchDir, ScratchError>) { this.value = value; }
}
interface RunState {
  readonly baseline: Baseline;
  readonly timeoutMs: number;
  readonly failure: RunError | undefined;
  readonly pool: ScratchPool | undefined;
  readonly pending: ReadonlyArray<Mutant>;
  readonly results: ReadonlyArray<MutantResult>;
  readonly reported: boolean;
  readonly notMutated: ReadonlyArray<NotMutated>;
  readonly probes: ReadonlyArray<ReachabilityProbe>;
  readonly hostRestarts: number;
  readonly poolResets: number;
}

/** A separate actor owns each run. Its resources outlive invoked phase tasks. */
export const runMutants = Effect.fn("Runner.runMutants")(function* (
  config: RunConfig, mutants?: Stream.Stream<Mutant, GenerationError>
) {
  const scratch = yield* Scratch;
  const tests = yield* TestRunner;
  const source = yield* MutantSource;
  const reporter = yield* Reporter;
  const scope = yield* Scope.Scope;
  const path = yield* Path.Path;
  const jobs = Math.max(1, Math.floor(config.jobs));
  const metadata = reportMetadata(source.typescriptVersion);
  const report = (state: RunState): RunReport => sanitizeReportTelemetry({
    ...metadata, schemaVersion: 2, tool: "mutant.cafe", root: config.root,
    baseline: state.baseline, timeoutMs: state.timeoutMs, results: state.results, notMutated: state.notMutated, reachabilityProbes: state.probes, hostRestarts: state.hostRestarts, poolResets: state.poolResets,
    ...(state.failure === undefined ? {} : { failure: state.failure._tag === "BaselineTimedOut" ? `BaselineTimedOut: ${state.failure.message}` : state.failure._tag === "BaselineFailed" ? `${state.failure._tag}: ${formatTestCommand(state.failure.command)}\n${state.failure.output.slice(-8000)}` : String(state.failure) })
  }).report;
  const capture = <A, R>(effect: Effect.Effect<A, RunError, R>) => Effect.result(effect);
  const copying = createEffectLogic(({ input }: { input: number }) => capture(Effect.gen(function* () {
    const acquire = Effect.gen(function* () {
      const dir = yield* scratch.acquire(config.root);
      if (tests.open) yield* tests.open(dir, config.cold ?? false, config.warm ?? false, input);
      return dir;
    }).pipe(Effect.mapError(error => error._tag === "ScratchError" ? error : new ScratchError({ operation: "warm runner", path: config.root, message: String(error) })));
    const pool = yield* Pool.make({ acquire, size: jobs }).pipe(
      Effect.provideService(Scope.Scope, scope));
    // Force the first acquisition in the copying phase. The pool owns the
    // tree; this short lease does not reserve a worker during later tests.
    yield* Effect.scoped(Pool.get(pool));
    return new ScratchPool(pool);
  })));
  const baselining = createEffectLogic(({ input }: { input: ScratchPool | undefined }) => capture(Effect.gen(function* () {
    if (input === undefined) return yield* Effect.die("Missing scratch pool");
    const baseline = yield* Effect.scoped(Effect.gen(function* () {
      const dir = yield* Pool.get(input.value);
      return yield* tests.baseline(dir, path.isAbsolute(config.tsconfig) ? path.relative(config.root, config.tsconfig) : config.tsconfig, config.baselineTimeoutMs);
    }));
    return { baseline, timeoutMs: config.timeoutMs ?? Math.max(config.minimumTimeoutMs, Math.ceil(config.timeoutMultiplier * baseline.durationMs)) };
  })));
  const generating = createEffectLogic(() => capture(Stream.runCollect(mutants ?? source.generate(config))));
  const testing = createEffectLogic(({ input }: { input: {
    readonly state: RunState;
    readonly record: (result: MutantResult) => Effect.Effect<void>;
    readonly skip: (entry: NotMutated) => Effect.Effect<void>;
    readonly probe: (entry: ReachabilityProbe) => Effect.Effect<void>;
    readonly updateBaseline: (entry: Baseline) => Effect.Effect<void>;
  } }) => capture(Effect.gen(function* () {
    const dirs = input.state.pool?.value;
    if (dirs === undefined) return yield* Effect.die("Missing scratch pool");
    // Exclude original-path links before viability, calibration or poisoning.
    // Reuse the existing SKIP event: linked files are not failed mutations.
    const linkedRoots = yield* Effect.scoped(Pool.get(dirs).pipe(Effect.map(dir => dir.linkedRoots ?? [])));
    const eligible = yield* excludeLinkedCandidates(config.root, input.state.pending, linkedRoots);
    for (const entry of eligible.notMutated) yield* input.skip(entry);
    const pending = eligible.mutants;
    let baseline = input.state.baseline;
    const viabilityById = new Map<string, Effect.Success<ReturnType<typeof source.checkViable>>>();
    // Auto needs a count before sampling; forced modes check inside the jobs
    // stream so oracle work overlaps native test processes. Auto preflight is
    // concurrent too, and reports rejected candidates as soon as they finish.
    const preReported = new Set<string>();
    if (!config.cold && !config.warm && tests.calibrate) yield* Effect.forEach(pending, mutant => Effect.gen(function* () {
      const viability = yield* source.checkViable(mutant);
      viabilityById.set(mutant.id, viability);
      if (viability.analysisFailed) { preReported.add(mutant.id); yield* input.skip(viability.analysisFailed); }
      else if (!viability.viable) {
        preReported.add(mutant.id);
        const result: MutantResult = { mutant, outcome: "unviable", durationMs: 0, testCommand: [], diagnostics: viability.diagnostics };
        yield* input.record(result);
        yield* reporter.progress(result);
      }
    }), { concurrency: jobs, discard: true });
    const unreachable = new Map<string, ReachabilityProbe>();
    const selectRelated = tests.selectRelated;
    const probeReachability = tests.probeReachability;
    if (input.state.baseline.probeSupported && selectRelated && probeReachability) {
      const seen = new Set<string>();
      const builtTests = input.state.baseline.unreliable?.flatMap(issue => issue.kind === "built" ? issue.testFiles : []) ?? [];
      for (const mutant of pending) {
        if (viabilityById.has(mutant.id) && !viabilityById.get(mutant.id)?.viable) continue;
        const file = path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file;
        if (seen.has(file)) continue;
        seen.add(file);
        if (unreliableFor(input.state.baseline, file, builtTests).length) continue;
        const probe = yield* Effect.scoped(Effect.gen(function* () {
          const dir = yield* Pool.get(dirs);
          if (!dir.poison) return undefined;
          const files = yield* selectRelated(dir, file);
          if (files === undefined || files.length) return undefined;
          return yield* probeReachability(dir, { ...mutant, file }, input.state.timeoutMs);
        }));
        if (probe) {
          yield* input.probe(probe);
          if (probe.status === "unreachable") unreachable.set(file, probe);
        }
      }
    }
    const calibrate = tests.calibrate;
    if (calibrate) {
      const testable = pending.filter(mutant => {
        const file = path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file;
        return viabilityById.get(mutant.id)?.viable && !unreachable.has(file) && !unreliableFor(baseline, file).length;
      }).length;
      const selected = yield* Effect.scoped(Effect.gen(function* () {
        const dir = yield* Pool.get(dirs);
        return yield* calibrate(dir, testable, config.jobs);
      }));
      baseline = { ...baseline, ...selected };
      yield* input.updateBaseline(baseline);
    }
    if (!config.cold && !config.warm) yield* Console.warn(`Vitest auto mode: ${baseline.runnerMode ?? "cold"}; ${baseline.runnerModeReason ?? "Cold execution; no warm session"}`);
    // Measure the original related selection once per file before applying any
    // mutant. Slow unrelated tests must not manufacture a caught never mutant.
    const neverBudgets = new Map<string, number>();
    const neverLimits = new Map<string, number>();
    const neverBases = new Map<string, number>();
    const neverAllowances = new Map<string, number>();
    for (const mutant of pending) {
      if (viabilityById.has(mutant.id) && !viabilityById.get(mutant.id)?.viable) continue;
      if (unreachable.has(path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file)) continue;
      if (mutant.genre !== "EffectNever" || neverBudgets.has(mutant.file) || unreliableFor(input.state.baseline, path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file).length > 0) continue;
      let probeTimeout = Math.max(1, Math.floor(input.state.timeoutMs / 2));
      const originalTimeouts = new Set(Object.values(baseline.testTimeoutDetails ?? {}));
      while (originalTimeouts.has(probeTimeout)) probeTimeout++;
      const measured = yield* Effect.scoped(Effect.gen(function* () {
        const dir = yield* Pool.get(dirs);
        return yield* tests.runRelated(dir, path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file, input.state.timeoutMs, probeTimeout);
      }));
      if (measured.status === "timedOut") return yield* new BaselineTimedOut({ timeoutMs: input.state.timeoutMs, command: measured.command,
        message: `Clean related probe exceeded ${input.state.timeoutMs / 1000} seconds. Increase --timeout for a longer probe.` });
      if (measured.status === "failed") {
        return yield* new BaselineFailed({ exitCode: 1, output: measured.output, command: measured.command });
      }
      const files = measured.testFiles ?? Object.keys(measured.testDurations ?? baseline.testDurations ?? {});
      // The clean baseline owns timings. The related probe selects files only;
      // its imposed test timeout must not become an alleged explicit override.
      const slowest = Math.max(0, ...files.map(file => baseline.testDurations?.[file] ?? measured.testDurations?.[file] ?? 0));
      const relatedDuration = baseline.testFileDurations === undefined ? baseline.durationMs :
        files.reduce((sum, file) => sum + (baseline.testFileDurations?.[file] ?? 0), 0);
      neverAllowances.set(mutant.file, Math.ceil(relatedDuration) + (baseline.startupMs ?? 0));
      neverBases.set(mutant.file, slowest);
      neverBudgets.set(mutant.file, Math.max(2_000, config.neverTimeoutMs, Math.ceil(slowest * config.timeoutMultiplier)));
      // A default changes under the clean probe's imposed timeout. An explicit
      // option remains identical, including an option equal to the config default.
      const explicit = Object.entries(baseline.testTimeoutDetails ?? {}).filter(([key, value]) => value > 0 && measured.testTimeoutDetails?.[key] === value).map(([, value]) => value);
      neverLimits.set(mutant.file, Math.max(0, ...explicit));
    }
    yield* Stream.fromIterable(pending).pipe(
      Stream.mapEffect((mutant) => Effect.scoped(Effect.gen(function* () {
        if (preReported.has(mutant.id)) return;
        const viability = viabilityById.get(mutant.id) ?? (yield* source.checkViable(mutant));
        if (viability.analysisFailed) { yield* input.skip(viability.analysisFailed); return; }
        if (!viability.viable) {
          const result: MutantResult = { mutant, outcome: "unviable", durationMs: 0, testCommand: [], diagnostics: viability.diagnostics };
          yield* input.record(result);
          yield* reporter.progress(result);
          return;
        }
        const localFile = path.isAbsolute(mutant.file) ? path.relative(config.root, mutant.file) : mutant.file;
        const unreliable = unreliableFor(input.state.baseline, localFile);
        if (unreliable.length) {
          const result: MutantResult = { mutant, outcome: "unreliable", durationMs: 0, testCommand: input.state.baseline.testCommand, diagnostics: unreliable.map(issue => issue.reason) };
          yield* input.record(result);
          yield* reporter.progress(result);
          return;
        }
        const cached = unreachable.get(localFile);
        if (cached) {
          const result: MutantResult = { mutant, outcome: "untested", durationMs: 0, testCommand: [],
            diagnostics: ["The full-suite module-load probe passed without loading this file"] };
          yield* input.record(result);
          yield* reporter.progress(result);
          return;
        }
        const dir = yield* Pool.get(dirs);
        const testTimeoutMs = mutant.genre === "EffectNever" ? neverBudgets.get(mutant.file)! : undefined;
        const timeoutMs = testTimeoutMs === undefined ? input.state.timeoutMs : Math.max(testTimeoutMs, neverLimits.get(mutant.file) ?? 0) + (neverAllowances.get(mutant.file) ?? 0);
        const run = yield* Effect.acquireUseRelease(
          dir.apply(mutant),
          () => Effect.gen(function* () {
            if (tests.invalidate) yield* tests.invalidate(dir, localFile);
            return yield* tests.runRelated(dir, localFile, timeoutMs, testTimeoutMs);
          }),
          // Restore and re-invalidate even on interruption before leasing again.
          () => Effect.gen(function* () {
            yield* dir.revert(mutant);
            if (tests.invalidate) yield* tests.invalidate(dir, localFile);
          }).pipe(Effect.orDie)
        );
        const selectedIssues = unreliableFor(input.state.baseline, localFile, run.testFiles);
        const result: MutantResult = {
          mutant,
          // A kill before collection proves nothing about whether tests noticed.
          outcome: selectedIssues.length ? "unreliable" : run.status === "timedOut" ? (mutant.genre === "EffectNever" && run.testsCollected ? "caught" : "timeout")
            : run.status === "failed" ? "caught" : run.status === "untested" ? "untested" : "missed",
          durationMs: run.durationMs,
          timeoutMs: testTimeoutMs ?? timeoutMs,
          outerTimeoutMs: timeoutMs,
          ...(testTimeoutMs === undefined ? {} : { hangBudgetBaseMs: neverBases.get(mutant.file) }),
          backstopMs: run.backstopMs,
          telemetryWarnings: run.telemetryWarnings,
          testWorkers: run.testWorkers,
          testConcurrency: run.testConcurrency,
          testCommand: run.command,
          diagnostics: selectedIssues.map(issue => issue.reason),
          ...(run.output === "" ? {} : { output: run.output })
        };
        yield* input.record(result);
        yield* reporter.progress(result);
      })), { concurrency: jobs }),
      Stream.runDrain
    );
  })));
  const reporting = createEffectLogic(({ input }: { input: RunState }) => capture(Effect.gen(function* () {
    const stats = yield* tests.stats ?? Effect.succeed({ hostRestarts: 0, poolResets: 0 });
    if (!input.reported) yield* reporter.write({ ...report(input), ...stats });
    return stats;
  })));
  // generating -> (empty: reporting | copying -> baseline -> testing) -> reporting -> done.
  // Domain failures travel as actor outputs; completed results are events so
  // interruption can report the machine's current state, not a task-local array.
  const machine = setupEffect({
    schemas: {
      context: types<RunState>(),
      events: { CANCEL: Schema.Struct({}), RESULT: Schema.Struct({ result: MutantResult }), SKIP: Schema.Struct({ entry: NotMutated }), PROBE: Schema.Struct({ entry: ReachabilityProbe }), BASELINE: Schema.Struct({ entry: Baseline }) }
    },
    actors: { copying, baselining, generating, testing, reporting }
  }).createMachine({
    context: {
      baseline: { durationMs: 0, testCommand: [] },
      timeoutMs: config.timeoutMs ?? config.minimumTimeoutMs,
      failure: undefined, pool: undefined, pending: [], results: [], reported: false, notMutated: [], probes: [], hostRestarts: 0, poolResets: 0
    },
    output: ({ context }) => context,
    initial: "generating",
    on: {
      CANCEL: { target: ".interrupted" },
      BASELINE: ({ context, event }) => ({ context: { ...context, baseline: event.entry } }),
      PROBE: ({ context, event }) => ({ context: { ...context, probes: [...context.probes, event.entry] } }),
      SKIP: ({ context, event }) => ({ context: { ...context, notMutated: [...new Map([...context.notMutated, event.entry].map(entry => [JSON.stringify(entry), entry])).values()] } }),
      RESULT: ({ context, event }) => ({ context: { ...context, results: [...context.results, event.result] } })
    },
    states: {
      copying: { invoke: { src: "copying", input: ({ context }) => context.pending.length, onDone: ({ context, event }) => Result.isSuccess(event.output)
        ? { target: "baseline", context: { ...context, pool: event.output.success } }
        : { target: "failed", context: { ...context, failure: event.output.failure } } } },
      baseline: { invoke: {
        src: "baselining", input: ({ context }) => context.pool,
        onDone: ({ context, event }) => Result.isSuccess(event.output)
          ? { target: "testing", context: { ...context, ...event.output.success } }
          : { target: "reporting", context: { ...context, failure: event.output.failure,
            baseline: (event.output.failure._tag === "BaselineFailed" || event.output.failure._tag === "BaselineTimedOut") ? { durationMs: 0, testCommand: event.output.failure.command } : context.baseline
          } }
      } },
      generating: { invoke: { src: "generating", onDone: ({ context, event }) => Result.isSuccess(event.output)
        ? { target: event.output.success.length ? "copying" : "reporting", context: { ...context, pending: event.output.success } }
        : { target: "reporting", context: { ...context, failure: event.output.failure } } } },
      testing: { invoke: {
        src: "testing", input: ({ context, self }) => ({
          state: context,
          // Queue completion before progress can trigger CANCEL. The parent's
          // FIFO mailbox commits this result before handling that cancellation.
          record: (result) => send(self, { type: "RESULT", result }),
          skip: (entry) => send(self, { type: "SKIP", entry }),
          probe: (entry) => send(self, { type: "PROBE", entry }),
          updateBaseline: (entry) => send(self, { type: "BASELINE", entry })
        }),
        onDone: ({ context, event }) => ({ target: "reporting", context: {
          ...context, failure: Result.isFailure(event.output) ? event.output.failure : context.failure
        } })
      } },
      reporting: { invoke: {
        src: "reporting", input: ({ context }) => context,
        onDone: ({ context, event }) => ({ target: "done", context: {
          ...context, ...(Result.isSuccess(event.output) ? event.output.success : {}), reported: Result.isSuccess(event.output), failure: Result.isFailure(event.output) ? event.output.failure : context.failure
        } })
      } },
      interrupted: { invoke: {
        src: "reporting", input: ({ context }) => context,
        onDone: ({ context, event }) => ({ target: "done", context: {
          ...context, ...(Result.isSuccess(event.output) ? event.output.success : {}), reported: Result.isSuccess(event.output), failure: Result.isFailure(event.output) ? event.output.failure : context.failure
        } })
      } },
      failed: { type: "final" },
      done: { type: "final" }
    }
  });
  // Close the actor host before the outer pool scope. Stopping an invocation
  // requests interruption; host release waits for its process/revert finalizers.
  const state = yield* Effect.scoped(Effect.gen(function* () {
    const actor = yield* createEffectActor(machine);
    // Domain failures are task outputs; only unexpected actor defects reach join.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Domain errors are captured above.
    return yield* join(actor).pipe(Effect.orDie, Effect.onInterrupt(() => Effect.gen(function* () {
      yield* send(actor, { type: "CANCEL" });
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Wait for the partial report before releasing the actor host.
      yield* join(actor).pipe(Effect.orDie);
    })));
  }));
  if (state.failure !== undefined) return yield* state.failure;
  return report(state);
}, Effect.scoped);
