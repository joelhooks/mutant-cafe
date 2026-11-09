import { TestSpawnError } from "@mutant-cafe/core";
import { createEffectActor, createEffectLogic, join, send, setupEffect } from "@xstate/effect";
import { types } from "xstate";
import { processTraceSource } from "./ProcessTrace.ts";
import * as Console from "effect/Console";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- OS process inspection and PID signals have no portable Effect service.
import { execFile } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Adapt the OS inspector's callback API at this boundary.
import { promisify } from "node:util";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Ownership labels must not collide across unrelated processes.
import { randomUUID } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NODE_OPTIONS --import needs a file URL, including paths with spaces.
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
// Warning-only recognition spans selectors and execution sessions. These paths
// never authorize a signal: discover() still uses only its own ledger.
const liveLedgers = new Set<string>();
export const ProcessInspector = Context.Reference<{
  readonly inspect: (args: ReadonlyArray<string>) => Effect.Effect<{ readonly stdout: string }, TestSpawnError>;
  readonly signal?: (pid: number, signal: "SIGSTOP" | "SIGKILL") => void;
}>("mutant.cafe/ProcessInspector", { defaultValue: () => ({ inspect: args => Effect.tryPromise({
  try: signal => execute("/bin/ps", [...args], { signal, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 2000, env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" } }),
  catch: () => new TestSpawnError({ command: ["ps"], message: "Cannot inspect owned test processes" })
}) }) });
// A reaped or inaccessible PID makes lsof exit 1, even with useful stdout.
// Aborted, signalled and other failures must still take the warning path.
const PartialCwd = Schema.Struct({ code: Schema.Literal(1), stdout: Schema.String, signal: Schema.optional(Schema.Null), killed: Schema.optional(Schema.Literal(false)) });
export const inspectScratchCwd = (pids: ReadonlyArray<number>, probe: {
  readonly live: (pid: number) => boolean;
  readonly read: (pids: ReadonlyArray<number>, signal: AbortSignal) => Promise<{ readonly stdout: string }>;
} = {
  live: pid => { if (pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } },
  read: (pids, signal) => execute("/usr/sbin/lsof", ["-b", "-w", "-n", "-P", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { signal, encoding: "utf8", timeout: 2000, maxBuffer: 32 * 1024 * 1024, env: { PATH: process.env.PATH, LC_ALL: "C" } })
}) => Effect.tryPromise({
  // @effect-diagnostics-next-line asyncFunction:off -- Native execFile adapter preserves partial stdout while Effect supplies cancellation.
  try: async signal => {
    const live = pids.filter(probe.live);
    if (!live.length) return { stdout: "" };
    try { return await probe.read(live, signal); }
    catch (error) {
      const partial = Schema.decodeUnknownOption(PartialCwd)(error);
      if (partial._tag === "Some") return { stdout: partial.value.stdout };
      throw error;
    }
  },
  catch: () => new TestSpawnError({ command: ["lsof"], message: "Cannot inspect scratch working directories" })
});
const tokenKey = "MUTANT_CAFE_PROCESS_TOKEN";
const ledgerKey = "MUTANT_CAFE_PROCESS_LEDGER";
const preloadKey = "MUTANT_CAFE_PROCESS_PRELOAD";

// Record native children at spawn, not when their parent eventually exits.
// Updating builtin ESM exports also covers `import { spawn } from node:child_process`.
const preloadSource = `import cp from "node:child_process";
${processTraceSource}
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const nativeExec = Symbol.for("mutant.cafe.nativeExecFile");
const inspect = cp[nativeExec] ?? (cp[nativeExec] = cp.execFile);
const ledger = process.env.${ledgerKey};
const token = process.env.${tokenKey};
const preload = process.env.${preloadKey};
traceProcess("preload-start");
// Async native inspection plus an independent timer: execFileSync's timeout
// still waits for a kernel-blocked helper to exit, freezing the Node thread.
const record = pid => new Promise(resolve => {
  if (!pid || !ledger) return resolve();
  const began = performance.now();
  const phase = process.env.MUTANT_CAFE_PROCESS_PHASE;
  let settled = false; let child;
  const done = (stage, started = "") => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (started) try { appendFileSync(ledger, JSON.stringify({ pid, birth: started, phase }) + "\\n"); } catch {}
    traceProcess(stage, { targetPid: pid, elapsedMs: performance.now() - began });
    resolve();
  };
  const timer = setTimeout(() => {
    done("ps-record-timeout");
    try { child?.kill("SIGKILL"); } catch {}
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  }, 1000);
  traceProcess("ps-record-start", { targetPid: pid });
  try {
    child = inspect("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", env: { LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => done(error ? "ps-record-failed" : "ps-record-done", error ? "" : stdout.trim()));
  } catch { done("ps-record-failed"); }
});
if (ledger && token && preload) {
// Await only our own birth before user code can busy-loop. Child-spawn records
// are asynchronous; implicit Node children also record themselves here.
await record(process.pid);
traceProcess("preload-ready");
const environment = node => {
  const env = { ...process.env };
  const ownImport = "--import=" + preload;
  const original = (env.NODE_OPTIONS || "").replaceAll(ownImport, "").trim();
  if (node && env.${ledgerKey} === ledger && env.${tokenKey} === token) env.NODE_OPTIONS = (original + " " + ownImport).trim();
  else if (original) env.NODE_OPTIONS = original;
  else delete env.NODE_OPTIONS;
  return env;
};
const options = (value, node) => value?.env !== undefined ? value : ({ ...value, env: environment(node) });
for (const name of ["spawn", "fork", "execFile", "exec"]) {
  const original = cp[name];
  const wrapped = function (...args) {
    const index = name === "exec" ? 1 : Array.isArray(args[1]) || (args[1] === undefined && args.length > 2) ? 2 : 1;
    const value = typeof args[index] === "object" && args[index] !== null ? args[index] : undefined;
    const node = name === "fork" ? (value?.execPath || process.execPath) === process.execPath : args[0] === process.execPath;
    if (typeof args[index] === "function") args.splice(index, 0, options(undefined, node));
    else args[index] = options(value, node);
    traceProcess("spawn-start", { method: name, node });
    const child = original.apply(this, args);
    traceProcess("spawn-return", { method: name, childPid: child.pid, node });
    child.once("spawn", () => traceProcess("spawn", { method: name, childPid: child.pid, node }));
    // Exact birth inspection cannot block spawn: a minimal-env child can be
    // orphaned before this async callback if its parent exits immediately.
    // Without a birth row, surviving PPID edge or label, it stays warning-only
    // (cwd/argv backstop). A PID plus approximate spawn time is not reuse proof.
    void record(child.pid);
    return child;
  };
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const descriptors = Object.getOwnPropertyDescriptors(original);
  delete descriptors[custom];
  Object.defineProperties(wrapped, descriptors);
  if (name === "exec" || name === "execFile") Object.defineProperty(wrapped, custom, { value: (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = wrapped(...args, (error, stdout, stderr) => {
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({ stdout, stderr });
      });
    });
    promise.child = child;
    return promise;
  } });
  cp[name] = wrapped;
}
syncBuiltinESMExports();
}
`;

const Record = Schema.Struct({ pid: Schema.Int, birth: Schema.String });
type Record = typeof Record.Type;
interface ProcessInfo extends Record { readonly ppid: number; readonly pgid: number; readonly state: string; readonly argv: string }
interface CleanupState {
  readonly pending: ReadonlyArray<ProcessInfo>;
  readonly round: number;
  readonly failure: string | undefined;
}

export const acquireProcessTree = Effect.fn("ProcessTree.acquire")(function* (scratch?: string, onBackstop?: (durationMs: number) => void, processesSince?: number) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectory({ prefix: "mutant-processes-" });
  const ledger = `${directory}/pids.jsonl`;
  const script = `${directory}/register.mjs`;
  const token = yield* Effect.sync(randomUUID);
  const url = pathToFileURL(script).href;
  yield* fs.writeFileString(ledger, "");
  yield* fs.writeFileString(script, preloadSource);
  liveLedgers.add(ledger);
  const trace = (stage: string, details: { readonly [key: string]: number | string } = {}) => {
    const destination = process.env.MUTANT_CAFE_PROCESS_TRACE;
    return destination ? Clock.currentTimeMillis.pipe(Effect.flatMap(at => fs.writeFileString(destination, JSON.stringify({ at, pid: process.pid, ppid: process.ppid, stage, ...details }) + "\n", { flag: "a" })), Effect.timeout(100), Effect.catch(() => Effect.void)) : Effect.void;
  };
  const roots = new Set<number>();
  const command = ["vitest", "process-cleanup"];
  // Never include inspector output: it can contain environment values.
  const inspector = yield* ProcessInspector;
  // The complete sweep, not each PID or retry, owns this deadline. Actor tasks
  // must be interruptible too: stopping their host waits for invocation cleanup.
  let deadline = Infinity;
  let lastSnapshot: Map<number, ProcessInfo> | undefined;
  let ledgerRows: ReadonlyArray<Record> = [];
  const verified = new Map<number, ProcessInfo>();
  let effectiveKeep = new Set<number>();
  const kill = inspector.signal ?? ((pid: number, signal: "SIGSTOP" | "SIGKILL") => { process.kill(pid, signal); });
  const bounded = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>, limit = 7000) => Effect.suspend(() => {
    const remaining = Math.min(limit, deadline - performance.now());
    if (remaining <= 0) return Effect.fail(new TestSpawnError({ command, message: `Cleanup deadline exceeded during ${phase}` }));
    return effect.pipe(Effect.interruptible, Effect.timeout(remaining), Effect.mapError(() => new TestSpawnError({ command, message: `Cleanup ${phase} failed or exceeded its ${Math.ceil(remaining)} ms budget` })));
  });
  const inspect = (args: ReadonlyArray<string>) => bounded("ps inspection", Effect.gen(function* () {
    const began = performance.now();
    yield* trace("inspect-start", { operation: args[0] ?? "ps" });
    const result = yield* inspector.inspect(args);
    yield* trace("inspect-done", { elapsedMs: performance.now() - began });
    return result;
  }), 2000);
  const snapshot = Effect.gen(function* () {
    const result = yield* inspect(["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,args="]);
    const found = new Map<number, ProcessInfo>();
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid !== process.pid && !match[4]!.startsWith("Z")) found.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), state: match[4]!, birth: match[5]!.trim(), argv: match[6] ?? "" });
    }
    for (const [pid, item] of verified) if (found.get(pid)?.birth !== item.birth) verified.delete(pid);
    lastSnapshot = found;
    return found;
  });
  const discover = (preserved: ReadonlySet<number>, retained: ReadonlyArray<Record>) => Effect.gen(function* () {
    const registered = yield* fs.readFileString(ledger).pipe(Effect.mapError(() => new TestSpawnError({ command, message: "Cannot read the test process ownership ledger" })));
    ledgerRows = registered.split("\n").flatMap(line => {
      const parsed = Schema.decodeOption(Schema.fromJsonString(Record))(line);
      return parsed._tag === "Some" ? [parsed.value] : [];
    });
    const table = yield* snapshot;
    const keep = new Set(preserved);
    const subtrees = new Set(retained.filter(item => table.get(item.pid)?.birth === item.birth).map(item => item.pid));
    let keepAdded: boolean;
    do { keepAdded = false; for (const item of table.values()) if (subtrees.has(item.ppid) && !subtrees.has(item.pid)) { subtrees.add(item.pid); keepAdded = true; } } while (keepAdded);
    for (const pid of subtrees) keep.add(pid);
    effectiveKeep = keep;
    const owned = new Set<number>();
    const claim = (pid: number) => {
      owned.add(pid);
      const item = table.get(pid);
      if (item && !keep.has(pid)) verified.set(pid, item);
    };
    const closeDescendants = () => {
      let added: boolean;
      do {
        added = false;
        for (const item of table.values()) if (owned.has(item.ppid) && !owned.has(item.pid)) { claim(item.pid); added = true; }
      } while (added);
    };
    const uncertain = new Set<number>();
    for (const item of ledgerRows) if (table.get(item.pid)?.birth === item.birth) claim(item.pid);
    // Claim unlabelled descendants before fallible label inspection. Emergency
    // parent kills must not orphan children before the next sweep can claim them.
    closeDescendants();
    // A child may have daemonized and lost its PPID before cleanup. Its inherited
    // unguessable label remains evidence of ownership even across setsid/exec.
    // This raw output is never logged, returned, or stored in the report.
    if (process.platform === "linux") {
      yield* Effect.forEach([...table.keys()], pid => fs.readFileString(`/proc/${pid}/environ`).pipe(
        Effect.catch(() => Effect.succeed("")), Effect.tap(environment => Effect.sync(() => {
          if (!owned.has(pid) && environment.split("\0").includes(`${tokenKey}=${token}`)) { claim(pid); closeDescendants(); }
        }))), { concurrency: 8, discard: true });
    } else {
      const labelled = yield* inspect(["axeww", "-o", "pid=,lstart=,command="]);
      const label = new RegExp("(?:^|\\s)" + tokenKey + "=" + token + "(?:\\s|$)");
      // Environments can contain newlines. Bulk rows nominate candidates only;
      // verify their individual environment, never a token in somebody's argv.
      const rows = [...labelled.stdout.matchAll(/^\s*(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s/gm)];
      for (const [index, row] of rows.entries()) {
        const pid = Number(row[1]);
        const record = labelled.stdout.slice(row.index, rows[index + 1]?.index);
        if (owned.has(pid) || table.get(pid)?.birth !== row[2]?.trim() || !label.test(record)) continue;
        const argv = yield* inspect(["ww", "-p", String(pid), "-o", "command="]).pipe(Effect.result);
        const environment = yield* inspect(["eww", "-p", String(pid), "-o", "command="]).pipe(Effect.result);
        const after = yield* inspect(["ww", "-p", String(pid), "-o", "command="]).pipe(Effect.result);
        if (Result.isFailure(argv) || Result.isFailure(environment) || Result.isFailure(after)) continue;
        const prefix = argv.success.stdout.trimEnd();
        if (prefix && prefix === after.success.stdout.trimEnd() && environment.success.stdout.startsWith(prefix + " ") &&
          label.test(environment.success.stdout.slice(prefix.length))) uncertain.add(pid);
      }
    }
    // Discover non-Node descendants too, without assuming they kept our env.
    closeDescendants();
    // Darwin's ps output cannot distinguish a copied label inside an env value
    // from an actual key. A label alone must never authorize signalling another
    // session: require its birth ledger or current PPID chain, otherwise warn.
    const unverified = [...uncertain].filter(pid => !owned.has(pid));
    if (unverified.length && ![...owned].some(pid => !keep.has(pid))) return yield* new TestSpawnError({ command, message: `Cannot verify test process ownership for PIDs: ${unverified.join(", ")}; not signalled` });
    if (unverified.length) yield* Console.warn(`Warning: unverified process PIDs ${unverified.join(", ")}; not signalled. Cleaning verified descendants first.`);
    return [...owned].flatMap(pid => table.has(pid) && !keep.has(pid) ? [table.get(pid)!] : []);
  });
  const signal = (pending: ReadonlyArray<ProcessInfo>, value: "SIGSTOP" | "SIGKILL") => Effect.gen(function* () {
    const current = yield* snapshot;
    for (const item of pending) {
      if (current.get(item.pid)?.birth !== item.birth) continue; // PID was reused: it is no longer ours.
      yield* Effect.sync(() => {
        try {
          if (roots.has(item.pid) && current.get(item.pid)?.pgid === item.pid) kill(-item.pid, value);
        } catch { /* The group may already be gone. Still check the PID. */ }
        try { kill(item.pid, value); }
        catch { /* Verification below reports any survivor by PID. */ }
      });
    }
  });
  // A scratch-path match nominates a survivor for warning, never for killing.
  const inspectUnowned = Effect.gen(function* () {
    if (!scratch) return;
    const table = lastSnapshot ?? (yield* snapshot);
    const registered = yield* Effect.forEach([...liveLedgers], path => fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(""))));
    const known = new Set(registered.join("\n").split("\n").flatMap(line => {
      const parsed = Schema.decodeOption(Schema.fromJsonString(Record))(line);
      return parsed._tag === "Some" && table.get(parsed.value.pid)?.birth === parsed.value.birth ? [parsed.value.pid] : [];
    }));
    const candidates = new Set<number>();
    // A process older than this scratch session cannot have been started by its
    // tests. Round down for ps's one-second birth precision. No signal uses this
    // warning-only fence; Linux ownership-label discovery remains unchanged.
    const since = processesSince === undefined ? -Infinity : Math.floor(processesSince / 1000) * 1000;
    const possible = [...table.values()].filter(item => !known.has(item.pid) && (processesSince === undefined || Date.parse(item.birth + " UTC") >= since));
    for (const item of possible) if (item.argv.includes(scratch)) candidates.add(item.pid);
    if (process.platform === "linux") yield* Effect.forEach(possible.map(item => item.pid), pid => fs.readLink(`/proc/${pid}/cwd`).pipe(
      Effect.catch(() => Effect.succeed("")), Effect.tap(cwd => Effect.sync(() => { if (cwd === scratch || cwd.startsWith(scratch + "/")) candidates.add(pid); }))), { concurrency: 8, discard: true });
    else if (process.platform === "darwin" && possible.length) {
      const cwdStarted = performance.now();
      yield* trace("cwd-start", { candidates: possible.length });
      const cwd = yield* inspectScratchCwd(possible.map(item => item.pid)).pipe(Effect.catch(() => Console.warn("Warning: cannot inspect scratch working directories; argv backstop remains active").pipe(Effect.as({ stdout: "" }))));
      yield* trace("cwd-done", { elapsedMs: performance.now() - cwdStarted });
      let pid = 0;
      for (const row of cwd.stdout.split("\n")) {
        if (row.startsWith("p")) pid = Number(row.slice(1));
        if (row.startsWith("n") && (row.slice(1) === scratch || row.slice(1).startsWith(scratch + "/"))) candidates.add(pid);
      }
    }
    const survivors = [...candidates].filter(pid => table.has(pid) && !known.has(pid));
    if (survivors.length) yield* Console.warn(`Warning: unowned scratch-related process PIDs ${survivors.join(", ")} survived; not signalled because ownership is unproven`);
  }).pipe(Effect.catch(() => Console.warn("Warning: cannot inspect unowned scratch-related survivors; no unverified PID was signalled")));
  const warnUnowned = Effect.gen(function* () {
    if (!scratch) return;
    const started = yield* Clock.currentTimeMillis;
    // Do not repeat a failed first snapshot during teardown.
    if (!lastSnapshot) return yield* Console.warn("Warning: scratch backstop unavailable without a process snapshot; no unverified PID was signalled");
    yield* bounded("scratch backstop", inspectUnowned, 2000).pipe(Effect.catch(error => Console.warn(`Warning: ${error.message}; unowned PIDs were not signalled`)));
    const elapsed = Math.max(0, (yield* Clock.currentTimeMillis) - started);
    yield* Effect.sync(() => onBackstop?.(elapsed));
  });
  const semaphore = yield* Semaphore.make(1);
  type Outcome = "clean" | "warning";
  let closed: Outcome | undefined;
  const sweep = (preserved: ReadonlyArray<number>, retained: ReadonlyArray<Record> = []) => Effect.scoped(Effect.gen(function* () {
  deadline = performance.now() + 10_000;
  lastSnapshot = undefined;
  ledgerRows = [];
  verified.clear();
  const keep = new Set(preserved);
  effectiveKeep = keep;
  const discovering = createEffectLogic(() => bounded("discovery", discover(keep, retained)).pipe(Effect.result));
  const stopping = createEffectLogic(({ input }: { input: ReadonlyArray<ProcessInfo> }) => bounded("stop", signal(input, "SIGSTOP"), 3000).pipe(Effect.result));
  const killing = createEffectLogic(({ input }: { input: ReadonlyArray<ProcessInfo> }) => bounded("kill", signal(input, "SIGKILL"), 3000).pipe(Effect.result));
  // tracking -> discovering -> stopping -> killing -> verifying -> closed.
  // A newly discovered descendant repeats stopping. Unverifiable ownership
  // warns rather than blocking the remaining mutation run.
  const machine = setupEffect({ schemas: { context: types<CleanupState>(), events: { CLOSE: Schema.Struct({}) } },
    actors: { discovering, stopping, killing } }).createMachine({
    context: { pending: [], round: 0, failure: undefined }, output: ({ context }) => context,
    initial: "tracking", states: {
      tracking: { on: { CLOSE: { target: "discovering" } } },
      discovering: { invoke: { src: "discovering", onDone: ({ context, event }) => Result.isFailure(event.output)
        ? { target: "failed", context: { ...context, failure: event.output.failure.message } }
        : { target: event.output.success.length ? "stopping" : "closed", context: { ...context, pending: event.output.success } } } },
      stopping: { invoke: { src: "stopping", input: ({ context }) => context.pending, onDone: ({ context, event }) => Result.isFailure(event.output)
        ? { target: "failed", context: { ...context, failure: event.output.failure.message } }
        : { target: "killing" } } },
      killing: { invoke: { src: "killing", input: ({ context }) => context.pending, onDone: ({ context, event }) => Result.isFailure(event.output)
        ? { target: "failed", context: { ...context, failure: event.output.failure.message } }
        : { target: "verifying" } } },
      verifying: { invoke: { src: "discovering", onDone: ({ context, event }) => {
        if (Result.isFailure(event.output)) return { target: "failed", context: { ...context, failure: event.output.failure.message } };
        const remaining = event.output.success;
        if (!remaining.length) return { target: "closed", context: { ...context, pending: [] } };
        return context.round < 3 ? { target: "stopping", context: { ...context, pending: remaining, round: context.round + 1 } }
          : { target: "failed", context: { ...context, pending: remaining, failure: `Cannot kill owned test PIDs: ${remaining.map(item => item.pid).join(", ")}` } };
      } } },
      closed: { type: "final" }, failed: { type: "final" }
    }
  });
  const actor = yield* createEffectActor(machine);
  yield* send(actor, { type: "CLOSE" });
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Inspection failures are machine outputs; join failures are unexpected actor defects.
  const joined = yield* bounded("state machine", join(actor), 8000).pipe(Effect.result);
  const result = joined._tag === "Success" ? joined.success : { ...actor.getSnapshot().context, failure: joined.failure.message };
  if (result.failure) {
    yield* Effect.sync(() => {
      actor.stop();
      // A deadline cannot abandon children already birth-matched in this sweep.
      // No further inspection is required, and stale ledger-only PIDs never enter
      // this set. Signal individual PIDs, not groups that may contain keepers.
      for (const item of verified.values()) { try { kill(item.pid, "SIGKILL"); } catch { /* Warn below; exit could not be verified. */ } }
    });
    const unverified = [...new Set(ledgerRows.filter(item => !verified.has(item.pid) && !effectiveKeep.has(item.pid)).map(item => item.pid))];
    yield* Console.warn(`Warning: cleanup degraded; SIGKILL attempted for birth-verified PIDs ${[...verified.keys()].join(", ") || "none"}; exit unconfirmed; unverified ledger PIDs ${unverified.join(", ") || "none"} were not signalled`);
  }
  yield* warnUnowned;
  if (result.failure) yield* Console.warn(`Warning: ${result.failure} (tracked PIDs ${(result.pending.length ? result.pending.map(item => item.pid) : [...roots]).join(", ")}); ownership ledger kept at ${ledger}; continuing without reusing the host`);
  return result.failure ? "warning" as const : "clean" as const;
  })).pipe(Effect.uninterruptible);
  const reap = (preserved: ReadonlyArray<number>, retained: ReadonlyArray<Record> = []) => semaphore.withPermit(Effect.suspend(() => closed === undefined ? sweep(preserved, retained) : Effect.succeed(closed)));
  const cleanup = semaphore.withPermit(Effect.gen(function* () {
    if (closed === undefined) closed = yield* sweep([]);
  }));
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* cleanup;
    if (closed === "clean") yield* fs.remove(directory, { recursive: true }).pipe(Effect.interruptible, Effect.timeout(2000),
      Effect.catch(error => Console.warn(`Warning: cannot remove process ledger directory: ${error.message}`)));
  }).pipe(Effect.ensuring(Effect.sync(() => { liveLedgers.delete(ledger); }))));
  const existing = process.env.NODE_OPTIONS ?? "";
  const bun = process.versions.bun !== undefined;
  return {
    env: { ...process.env, MUTANT_CAFE_PROCESS_PHASE: undefined, [tokenKey]: token, [ledgerKey]: ledger, [preloadKey]: url, NODE_OPTIONS: bun ? existing : `${existing} --import=${url}`.trim() },
    preloadArgs: bun ? ["--preload", script] : [],
    addRoot: (pid: number) => { roots.add(pid); }, cleanup, reap, trace
  };
});
export type OwnedProcessTree = Effect.Success<ReturnType<typeof acquireProcessTree>>;
