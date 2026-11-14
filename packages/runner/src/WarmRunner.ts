import { cleanTelemetry, DEFAULT_BASELINE_TIMEOUT_MS, TestSpawnError, type ScratchDir, type TestRun } from "@mutant-cafe/core";
import { createEffectActor, send, setupEffect } from "@xstate/effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node IPC (process.send) is not exposed by Effect's spawner.
import { spawn, type ChildProcess } from "node:child_process";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { acquireProcessTree, type OwnedProcessTree } from "./ProcessTree.ts";
import { reporterSource, vitestHostSource, type ProbeOptions } from "./VitestHost.ts";

const Message = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("retained"), pids: Schema.Array(Schema.Struct({ pid: Schema.Int, birth: Schema.String })) }),
  Schema.Struct({ type: Schema.Literal("invalidated") }),
  Schema.Struct({ type: Schema.Literal("collected") }),
  Schema.Struct({ type: Schema.Literal("failed") }),
  Schema.Struct({ type: Schema.Literal("selected"), files: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("selection"), files: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("probeLoaded") }),
  Schema.Struct({ type: Schema.Literal("quiescing") }), Schema.Struct({ type: Schema.Literal("quiesced") }), Schema.Struct({ type: Schema.Literal("healthy") }),
  Schema.Struct({ type: Schema.Literal("fallback"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("crash"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), status: Schema.Literals(["passed", "failed", "untested"]),
    testFiles: Schema.Array(Schema.String), testsCollected: Schema.Boolean,
    testDurations: Schema.Record(Schema.String, Schema.Finite), testTimeouts: Schema.Record(Schema.String, Schema.Finite), testWorkers: Schema.optional(Schema.Int), testConcurrency: Schema.optional(Schema.Int), telemetryWarnings: Schema.optional(Schema.Array(Schema.String)), testFileDurations: Schema.Record(Schema.String, Schema.Finite), firstTestStart: Schema.Finite, probeSupported: Schema.Boolean, probeLoaded: Schema.Boolean, testTimeoutDetails: Schema.Record(Schema.String, Schema.Finite), crashed: Schema.Boolean })
]);
type Message = typeof Message.Type;

export class ReporterMessageError extends Error { readonly kind = "reporter"; }
export function decodeWarmMessage(value: unknown): Message {
  try {
    const raw = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value);
    const cleaned = cleanTelemetry(raw, "warm message");
    if (raw.type === "result") {
      for (const [key, fallback] of Object.entries({ testDurations: {}, testTimeouts: {}, testFileDurations: {}, testTimeoutDetails: {}, firstTestStart: 0 }))
        if (cleaned.value[key] === undefined) Reflect.set(cleaned.value, key, fallback);
      const previous = cleaned.value.telemetryWarnings;
      Reflect.set(cleaned.value, "telemetryWarnings", [...(Array.isArray(previous) ? previous : []), ...cleaned.warnings]);
    }
    return Schema.decodeUnknownSync(Message)(cleaned.value);
  } catch (error) {
    // SchemaError.toString omits the actual value. This is a protocol frame,
    // not captured test stdout; keep a bounded diagnostic alongside the issue.
    const actual = (() => { try { return JSON.stringify(value)?.slice(0, 4096) ?? String(value); } catch { return "[unserializable frame]"; } })();
    throw new ReporterMessageError(`Internal warm reporter protocol error: ${String(error)}; received ${actual}`);
  }
}

// One pending request per scratch copy. IPC carries only parsed reporter data;
// stdout is diagnostic text, never an outcome parser for the warm adapter.
class Host {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly tree: OwnedProcessTree;
  readonly scope: Scope.Closeable;
  output = "";
  collected = false;
  failed = false;
  testFiles: ReadonlyArray<string> = [];
  runPending: Promise<Message> | undefined;
  retained: ReadonlyArray<{ readonly pid: number; readonly birth: string }> = [];
  private pending: { resolve: (value: Message) => void; reject: (error: Error) => void } | undefined;
  private startup: Promise<Message>;
  private quiescing: (() => void) | undefined;
  private quiesced: (() => void) | undefined;
  constructor(root: string, script: string, reporter: string, tree: OwnedProcessTree, scope: Scope.Closeable, selectionOnly = false, decode = decodeWarmMessage) {
    this.tree = tree;
    this.scope = scope;
    this.child = spawn(process.execPath, [...tree.preloadArgs, script, reporter, selectionOnly ? "select" : "run"], {
      cwd: root, env: tree.env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    if (this.child.pid) tree.addRoot(this.child.pid);
    this.startup = this.wait();
    this.child.stdout?.on("data", chunk => { this.output += String(chunk); });
    this.child.stderr?.on("data", chunk => { this.output += String(chunk); });
    this.child.on("message", value => {
      try {
        const message = decode(value);
        if (message.type === "retained") { this.retained = message.pids; return; }
        if (message.type === "quiescing") { this.quiescing?.(); return; }
        if (message.type === "quiesced") { this.quiesced?.(); return; }
        if (message.type === "collected") { this.collected = true; return; }
        if (message.type === "failed") { this.failed = true; return; }
        if (message.type === "probeLoaded") return;
        if (message.type === "selected") { this.testFiles = message.files; return; }
        const pending = this.pending;
        this.pending = undefined;
        pending?.resolve(message);
      } catch (error) { this.pending?.reject(error instanceof ReporterMessageError ? error : new ReporterMessageError(String(error))); }
    });
    // @effect-diagnostics-next-line newPromise:off -- Promise bridge for the native IPC adapter, scoped by openWarmRunner.
    this.exited = new Promise<void>(resolve => this.child.once("close", () => {
      this.pending?.reject(new Error(`Vitest host exited: ${this.output.slice(-4000)}`));
      this.pending = undefined;
      resolve();
    }));
    this.child.on("error", error => { this.pending?.reject(error); this.pending = undefined; });
  }
  private wait() {
    // @effect-diagnostics-next-line newPromise:off -- One IPC reply, consumed by Effect.tryPromise at the service boundary.
    return new Promise<Message>((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  quiesce() {
    // Native IPC phase acknowledgements are separate from a still-pending run.
    // @effect-diagnostics-next-line newPromise:off -- IPC phase acknowledgement.
    const started = new Promise<void>(resolve => { this.quiescing = resolve; });
    // @effect-diagnostics-next-line newPromise:off -- IPC phase acknowledgement.
    const done = new Promise<void>(resolve => { this.quiesced = resolve; });
    this.post({ type: "quiesce" });
    return { started, done };
  }
  ready() { return this.startup; }
  request(message: object) {
    const response = this.wait();
    this.post(message);
    return response;
  }
  post(message: object) {
    if (this.child.connected) this.child.send(message, error => {
      if (error) this.pending?.reject(error);
    });
    else this.pending?.reject(new Error("Vitest host disconnected"));
  }
  close() { return Scope.close(this.scope, Exit.succeed(undefined)); }
  grace() {
    const self = this;
    return Effect.gen(function* () {
      self.post({ type: "close" });
      const exited = Effect.promise(() => self.exited);
      // The scope's next finalizer kills and verifies the entire owned tree,
      // even when the host exited but an escaped grandchild retained its pipes.
      const result = yield* exited.pipe(Effect.interruptible, Effect.timeout(500), Effect.result);
      if (result._tag === "Failure") yield* Effect.sync(() => {
        // Native ChildProcess still owns this handle; unlike a bare saved PID,
        // kill() cannot target a PID that was reaped and reused.
        self.child.kill("SIGKILL");
      });
    });
  }
}

// idle -> running -> cancelling -> (idle | restarting) -> idle
// Two crashes for one mutant: restarting -> failed -> cold (terminal).
const lifecycle = setupEffect({ schemas: { events: {
  RUN: Schema.Struct({}), DONE: Schema.Struct({}), CANCEL: Schema.Struct({}),
  RESTART: Schema.Struct({}), READY: Schema.Struct({}), FAIL: Schema.Struct({}), FALLBACK: Schema.Struct({})
} } }).createMachine({
  initial: "idle",
  on: { FAIL: { target: ".failed" }, FALLBACK: { target: ".cold" } },
  states: {
    idle: { on: { RUN: { target: "running" }, RESTART: { target: "restarting" } } },
    running: { on: { DONE: { target: "idle" }, CANCEL: { target: "cancelling" }, RESTART: { target: "restarting" } } },
    cancelling: { on: { DONE: { target: "idle" }, RESTART: { target: "restarting" } } },
    restarting: { on: { READY: { target: "idle" } } },
    failed: { on: { FALLBACK: { target: "cold" } } },
    cold: { type: "final" }
  }
});

export const openWarmRunner = Effect.fn("TestRunner.openWarm")(function* (dir: ScratchDir, onFallback: (reason: string) => void, options: { readonly selectionOnly?: boolean; readonly quiet?: boolean; readonly onRestart?: () => void; readonly onPoolReset?: () => void; readonly onBackstop?: (durationMs: number) => void; readonly processesSince?: number | undefined; readonly warn?: (message: string) => Effect.Effect<void>; readonly decodeMessage?: typeof decodeWarmMessage } = {}) {
  const fs = yield* FileSystem.FileSystem;
  const parentScope = yield* Scope.Scope;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-warm-" });
  const script = `${temp}/host.mjs`;
  const reporter = `${temp}/reporter.mjs`;
  yield* fs.writeFileString(script, vitestHostSource);
  yield* fs.writeFileString(reporter, reporterSource("mutant-warm:"));
  const actor = yield* createEffectActor(lifecycle);
  let host: Host | undefined;
  const attempt = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn,
    catch: error => new TestSpawnError({ command: ["vitest", "warm"], message: String(error), ...(error instanceof ReporterMessageError ? { kind: "reporter" as const } : {}) }) }).pipe(Effect.interruptible);
  const close = () => host === undefined ? Effect.void : host.close();
  const abortHost = (error: TestSpawnError) => Effect.gen(function* () {
    yield* send(actor, { type: "FAIL" });
    yield* close();
    return yield* error;
  });
  yield* Effect.addFinalizer(() => close().pipe(Effect.orDie));
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.succeed(undefined))).pipe(Effect.provideService(Scope.Scope, parentScope));
    const tree = yield* acquireProcessTree(dir.path, options.onBackstop, options.processesSince).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(error => new TestSpawnError({ command: ["vitest", "warm"], message: String(error) })));
    const active = new Host(dir.path, script, reporter, tree, scope, options.selectionOnly === true, options.decodeMessage);
    host = active;
    yield* Effect.addFinalizer(() => active.grace()).pipe(Effect.provideService(Scope.Scope, scope));
    const initialized = yield* attempt(() => host!.ready()).pipe(Effect.timeout(30_000),
      Effect.mapError(error => error._tag === "TestSpawnError" ? error : new TestSpawnError({ command: ["vitest", "warm"], message: String(error) })), Effect.result);
    if (initialized._tag === "Failure") return yield* abortHost(initialized.failure);
    const ready = initialized.success;
    if (ready.type !== "ready") {
      if (!options.quiet) yield* (options.warn ?? Console.warn)(`Warning: warm Vitest unavailable; using cold mode: ${"message" in ready ? ready.message : ready.type}`);
      yield* Effect.sync(() => onFallback("message" in ready ? ready.message : `Unexpected startup frame: ${ready.type}`));
      yield* send(actor, { type: "FALLBACK" });
      yield* close();
    }
  });
  const retire = Effect.gen(function* () {
    yield* send(actor, { type: "RESTART" });
    yield* close();
  });
  const restart = Effect.gen(function* () {
    yield* retire;
    yield* start;
    yield* Effect.sync(() => options.onRestart?.());
    if (actor.getSnapshot().value !== "cold") yield* send(actor, { type: "READY" });
  });
  yield* start;
  const isCold = () => actor.getSnapshot().value === "cold";
  const invalidate = Effect.fn("Warm.invalidate")(function* (file: string) {
    if (isCold() || actor.getSnapshot().value === "failed") return;
    if (actor.getSnapshot().value === "restarting") {
      // The caller restored the source before invalidating. Do not initialize a
      // replacement's config while the timed-out mutation is still on disk.
      yield* start;
      yield* Effect.sync(() => options.onRestart?.());
      if (!isCold()) yield* send(actor, { type: "READY" });
      return;
    }
    const result = yield* attempt(() => host!.request({ type: "invalidate", file })).pipe(Effect.timeout(1_000), Effect.result);
    if (result._tag === "Failure" && result.failure._tag === "TestSpawnError" && result.failure.kind === "reporter") return yield* abortHost(result.failure);
    // A fresh host has no stale transforms. Never return a dirty graph to the pool.
    if (result._tag === "Failure") yield* restart;
  });
  const finish = Effect.fn("Warm.finish")(function* (active: Host, pending: Promise<Message>) {
    const pool = active.quiesce();
    const started = yield* attempt(() => pool.started).pipe(Effect.timeout(500), Effect.result);
    const clean = yield* active.tree.reap(active.child.pid === undefined ? [] : [active.child.pid], active.retained);
    if (clean !== "clean" || started._tag === "Failure") return false;
    yield* attempt(() => pool.done).pipe(Effect.timeout(100), Effect.result);
    const settled = yield* attempt(() => pending).pipe(Effect.timeout(500), Effect.result);
    const health = settled._tag === "Success" ? yield* attempt(() => active.request({ type: "ping" })).pipe(Effect.timeout(500), Effect.result) : settled;
    return clean === "clean" && started._tag === "Success" && health._tag === "Success" && health.success.type === "healthy";
  });
  const run = Effect.fn("Warm.run")(function* (file: string | undefined, timeoutMs?: number, testTimeout?: number, probe?: ProbeOptions): Effect.fn.Return<TestRun | undefined, TestSpawnError> {
    if (isCold()) return undefined;
    if (options.selectionOnly) return yield* abortHost(new TestSpawnError({ command: ["vitest", "select"], kind: "reporter", message: "Selection-only host cannot execute tests" }));
    const command = ["vitest", ...(file ? ["related", file, "--run"] : ["run"]), "--reporter=default"];
    for (let crash = 0; crash < 2; crash++) {
      const active = host!;
      active.output = "";
      active.collected = false;
      active.failed = false;
      active.testFiles = [];
      const started = yield* Clock.currentTimeMillis;
      active.runPending = undefined;
      const budgetMs = timeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS;
      const operation = Effect.gen(function* () {
        yield* active.tree.trace("warm-attempt-start", { budgetMs });
        yield* send(actor, { type: "RUN" });
        const pending = active.request({ type: "run", file, testTimeout, probe });
        active.runPending = pending;
        return yield* attempt(() => pending);
      });
      const result = yield* operation.pipe(Effect.interruptible, Effect.timeout(budgetMs), Effect.result);
      const pending = active.runPending;
      if (result._tag === "Success" && result.success.type === "result" && !result.success.crashed) {
        if (pending && (yield* finish(active, pending))) yield* send(actor, { type: "DONE" });
        else yield* retire;
        return { ...result.success, startupMs: result.success.firstTestStart > 0 ? Math.max(0, Math.ceil(result.success.firstTestStart - started)) : 0,
          ...(active.child.pid === undefined ? {} : { hostPid: active.child.pid }), command, output: active.output, durationMs: (yield* Clock.currentTimeMillis) - started };
      }
      if (result._tag === "Failure" && result.failure._tag === "TimeoutError") {
        yield* Effect.sync(() => options.onPoolReset?.());
        yield* active.tree.trace("warm-deadline", { budgetMs });
        const failedAtDeadline = active.failed;
        yield* send(actor, { type: "CANCEL" });
        // cancelCurrentRun waits for the test: enforce a separate recovery grace.
        active.post({ type: "cancel" });
        if (pending && (yield* finish(active, pending))) yield* send(actor, { type: "DONE" });
        else yield* retire;
        return { status: failedAtDeadline ? "failed" : "timedOut", command, output: active.output, durationMs: (yield* Clock.currentTimeMillis) - started,
          ...(active.child.pid === undefined ? {} : { hostPid: active.child.pid }), testsCollected: active.collected, testFiles: active.testFiles };
      }
      if (result._tag === "Failure" && result.failure._tag === "TestSpawnError" && result.failure.kind === "reporter") return yield* abortHost(result.failure);
      yield* Effect.sync(() => options.onPoolReset?.());
      if (crash === 0) {
        yield* Console.warn(`Warning: Vitest pool crashed; restarting once: ${result._tag === "Failure" ? String(result.failure) : "message" in result.success ? result.success.message : result.success.type}`);
        if (pending && (yield* finish(active, pending))) yield* send(actor, { type: "DONE" });
        else yield* restart;
      }
      else {
        yield* send(actor, { type: "FAIL" });
        yield* close();
        yield* Console.warn("Warning: Vitest pool crashed twice for one mutant; using cold mode for the rest of this run");
        yield* Effect.sync(() => onFallback("Vitest pool crashed twice for one mutant"));
        yield* send(actor, { type: "FALLBACK" });
      }
      if (isCold()) return undefined;
    }
    return undefined;
  }, effect => effect.pipe(Effect.onInterrupt(() => Effect.gen(function* () {
    yield* send(actor, { type: "CANCEL" });
    const active = host;
    yield* Effect.sync(() => options.onPoolReset?.());
    active?.post({ type: "cancel" });
    if (active?.runPending && (yield* finish(active, active.runPending).pipe(Effect.orDie))) yield* send(actor, { type: "DONE" });
    else {
      yield* retire.pipe(Effect.orDie);
      // A cancelled run must not start a fresh host from its restore finalizer.
      yield* Effect.sync(() => onFallback("Interrupted run retired its unhealthy host"));
      yield* send(actor, { type: "FALLBACK" });
    }
  }))));
  const disable = Effect.gen(function* () {
    if (isCold()) return;
    yield* close();
    yield* send(actor, { type: "FALLBACK" });
  });
  const select = Effect.fn("Warm.select")(function* (file: string) {
    if (isCold()) return undefined;
    const result = yield* attempt(() => host!.request({ type: "select", file })).pipe(Effect.timeout(30_000), Effect.result);
    if (result._tag === "Success" && result.success.type === "selection") return result.success.files;
    if (result._tag === "Failure" && result.failure._tag === "TestSpawnError" && result.failure.kind === "reporter") return yield* abortHost(result.failure);
    yield* restart;
    return undefined;
  });
  return { run, invalidate, disable, select };
});
