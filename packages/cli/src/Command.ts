import { DEFAULT_BASELINE_TIMEOUT_MS, formatTestCommand, ConfigFile, MutantList, MutantSource, Reporter, RunConfig, type BaselineFailed, type BaselineTimedOut, type Mutant, type ProgramLoadError, ReportWriteError, type RunReport, type Scratch, type ScratchError, type TestRunner, type TestSpawnError } from "@mutant-cafe/core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { selectDiffScope } from "./Diff.ts";
import { errorExitCode, reportExitCode } from "./ExitCode.ts";
import { makeReporter, mutantLine } from "./Reporter.ts";
import { markdownSummary } from "./Summary.ts";

import { git, repositoryRoot, UsageError } from "./Git.ts";
export { UsageError } from "./Git.ts";

export type Run = (config: RunConfig, mutants: ReadonlyArray<Mutant>) => Effect.Effect<RunReport,
  BaselineFailed | BaselineTimedOut | ScratchError | TestSpawnError | ProgramLoadError | ReportWriteError,
  MutantSource | Scratch | TestRunner | Reporter | Path.Path>;

const flags = {
  list: Flag.Boolean("list").pipe(Flag.withDefault(false), Flag.withDescription("List mutants and skipped function count without running tests")),
  inDiff: Flag.String("in-diff").pipe(Flag.optional, Flag.withDescription("Only mutate bodies overlapping this unified diff")),
  inDiffRange: Flag.String("in-diff-range").pipe(Flag.optional, Flag.withDescription("Only mutate bodies overlapping git diff A...B or A..B; exclusive with --in-diff")),
  maxMutants: Flag.Int("max-mutants").pipe(Flag.optional, Flag.withDescription("Keep first N selected mutants ordered by repository path, line, column, id; N >= 0")),
  format: Flag.String("format").pipe(Flag.withDefault("text"), Flag.withDescription("Output format: text (default), json (--list only), or github (Markdown and GITHUB_STEP_SUMMARY)")),
  summaryMd: Flag.String("summary-md").pipe(Flag.optional, Flag.withDescription("Write Markdown summary to this file")),
  summaryMarker: Flag.String("summary-marker").pipe(Flag.withDefault("<!-- mutant.cafe -->"), Flag.withDescription("Override the first-line sticky-comment marker")),
  advisory: Flag.Boolean("advisory").pipe(Flag.withDefault(false), Flag.withDescription("Exit 0 for outcomes and baseline failure; keep usage/internal errors")),
  include: Flag.String("file").pipe(Flag.atLeast(0), Flag.withDescription("Include source glob relative to package root; repeatable")),
  exclude: Flag.String("exclude").pipe(Flag.atLeast(0), Flag.withDescription("Exclude source glob; repeatable")),
  exportedOnly: Flag.Boolean("exported-only").pipe(Flag.withDefault(false), Flag.withDescription("Only exported binding paths, returned curried functions and Layer service methods; exclude local helpers")),
  warm: Flag.Boolean("warm").pipe(Flag.withDefault(false), Flag.withDescription("Force a persistent Vitest instance instead of automatic selection")),
  cold: Flag.Boolean("cold").pipe(Flag.withDefault(false), Flag.withDescription("Start a fresh Vitest process for each test execution")),
  jobs: Flag.Int("jobs").pipe(Flag.optional, Flag.withDescription("Concurrent scratch/test workers; default 1")),
  timeout: Flag.Finite("timeout").pipe(Flag.optional, Flag.withDescription("Absolute test timeout in seconds, including startup")),
  baselineTimeout: Flag.Finite("baseline-timeout").pipe(Flag.optional, Flag.withDescription("Overall baseline deadline in seconds, including selection and startup; default 1800 (30 minutes)")),
  timeoutMultiplier: Flag.Finite("timeout-multiplier").pipe(Flag.optional, Flag.withDescription("Baseline duration multiplier; default 5")),
  minimumTimeout: Flag.Finite("minimum-test-timeout").pipe(Flag.optional, Flag.withDescription("Minimum test timeout in seconds")),
  output: Flag.String("output").pipe(Flag.withDefault("mutants.out"), Flag.withDescription("Report directory; default mutants.out")),
  tsconfig: Flag.String("tsconfig").pipe(Flag.withDefault("tsconfig.json"), Flag.withDescription("TypeScript project path; default tsconfig.json")),
};

export const makeCommand = (options: {
  readonly root: string;
  readonly run: Run;
  readonly onExit?: (code: number) => Effect.Effect<void>;
}) => Command.make("mutant-cafe", flags, (input) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(options.root);
  if (input.cold && input.warm) return yield* new UsageError({ message: "--warm and --cold are mutually exclusive" });
  const range = Option.getOrUndefined(input.inDiffRange);
  const inDiff = Option.getOrUndefined(input.inDiff);
  const maxMutants = Option.getOrUndefined(input.maxMutants);
  const summaryMd = Option.getOrUndefined(input.summaryMd);
  if (range !== undefined && inDiff !== undefined) return yield* new UsageError({ message: "--in-diff-range and --in-diff are mutually exclusive" });
  if (range !== undefined && (!/^[^\s.][^\s]*\.{2,3}[^\s.][^\s]*$/.test(range) || range.startsWith("-") || range.includes("...."))) {
    return yield* new UsageError({ message: "--in-diff-range expects A...B or A..B" });
  }
  if (maxMutants !== undefined && (!Number.isSafeInteger(maxMutants) || maxMutants < 0)) return yield* new UsageError({ message: "--max-mutants must be a nonnegative safe integer" });
  if (!["text", "json", "github"].includes(input.format) || (input.format === "json" && !input.list)) return yield* new UsageError({ message: "--format expects text, github, or json with --list" });
  if (/[\r\n]/.test(input.summaryMarker)) return yield* new UsageError({ message: "--summary-marker must be one line" });
  const gitRoot = range !== undefined ? yield* repositoryRoot(root) : yield* repositoryRoot(root).pipe(Effect.catch(() => Effect.succeed(root)));
  const diffText = range === undefined ? undefined : yield* git(gitRoot, ["diff", "--no-ext-diff", "--no-color", range, "--"]);
  const configPath = path.join(root, "mutants.config.json");
  const fileConfig = (yield* fs.exists(configPath))
    ? yield* fs.readFileString(configPath).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ConfigFile))),
      Effect.mapError((error) => new UsageError({ message: `Invalid mutants.config.json: ${String(error)}` })),
    ) : {};
  const timeoutMs = Option.map(input.timeout, (seconds) => Math.ceil(seconds * 1000));
  const config = yield* Schema.decodeEffect(RunConfig)({
    root,
    tsconfig: input.tsconfig,
    exportedOnly: input.exportedOnly,
    include: input.include.length > 0 ? input.include : fileConfig.include ?? ["**/*.{ts,tsx}"],
    explicitIncludes: input.include.length > 0 || fileConfig.include !== undefined,
    exclude: input.exclude.length > 0 ? input.exclude : fileConfig.exclude ?? [],
    functionFilter: fileConfig.functionFilter ?? [],
    ...(inDiff === undefined ? {} : { inDiff }),
    cold: input.cold,
    warm: input.warm,
    jobs: Option.getOrElse(input.jobs, () => fileConfig.jobs ?? 1),
    ...(Option.isSome(timeoutMs) ? { timeoutMs: timeoutMs.value } : {}),
    baselineTimeoutMs: Option.match(input.baselineTimeout, { onNone: () => fileConfig.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS, onSome: seconds => Math.ceil(seconds * 1000) }),
    timeoutMultiplier: Option.getOrElse(input.timeoutMultiplier, () => fileConfig.timeoutMultiplier ?? 5),
    minimumTimeoutMs: Option.match(input.minimumTimeout, { onNone: () => fileConfig.minimumTimeoutMs ?? 20_000, onSome: (seconds) => Math.ceil(seconds * 1000) }),
    neverTimeoutMs: 1_000,
    outDir: input.output,
  }).pipe(Effect.mapError((error) => new UsageError({ message: String(error) })));
  if (config.jobs < 1 || config.timeoutMultiplier <= 0 || config.minimumTimeoutMs <= 0 || (config.timeoutMs !== undefined && config.timeoutMs <= 0) || (config.baselineTimeoutMs !== undefined && config.baselineTimeoutMs <= 0)) {
    return yield* new UsageError({ message: "Jobs and timeout values must be positive" });
  }
  const source = yield* MutantSource;
  const generated = yield* Stream.runCollect(source.generate(config)).pipe(
    Effect.mapError((error) => error.reason === "selection"
      ? new UsageError({ message: error.diagnostics.join("\n") }) : error)
  );
  const skipped = yield* source.notMutated(config);
  const selected = inDiff === undefined && diffText === undefined ? { mutants: generated, notMutated: skipped }
    : yield* selectDiffScope({ root, diffPath: inDiff ?? `git diff ${range}`, ...(diffText === undefined ? {} : { diffText }), mutants: generated, notMutated: skipped });
  const relative = (mutant: Mutant) => path.relative(gitRoot, path.resolve(root, mutant.file)).replaceAll("\\", "/");
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const ordered = [...selected.mutants].sort((a, b) => compare(relative(a), relative(b)) || a.span.start.line - b.span.start.line || a.span.start.column - b.span.start.column || compare(a.id, b.id));
  const mutants = ordered.slice(0, maxMutants);
  const notMutated = selected.notMutated;
  const counts = { selected: ordered.length, run: 0, budgetSkipped: ordered.length - mutants.length };
  if (mutants.length === 0) {
    const cause = ordered.length > 0 ? "budget" : range !== undefined ? "range"
      : inDiff !== undefined || diffText !== undefined ? "diff"
      : config.functionFilter.length || config.exportedOnly ? "filter" : "file selection";
    yield* Console.error(`0 mutants selected (${counts.selected} before budget); cause: ${cause}. Baseline skipped.`);
  }
  const markdown = input.format === "github" || summaryMd !== undefined ? {
    gitRoot, marker: input.summaryMarker, advisory: input.advisory, stdout: input.format === "github",
    files: [...(summaryMd === undefined ? [] : [path.resolve(root, summaryMd)]),
      ...(input.format === "github" && process.env.GITHUB_STEP_SUMMARY ? [process.env.GITHUB_STEP_SUMMARY] : [])],
  } : undefined;
  if (input.list && markdown !== undefined) {
    const text = markdownSummary({ ...markdown, root, path, notMutated: notMutated.length,
      report: { schemaVersion: 2, tool: "mutant.cafe", root, baseline: { durationMs: 0, testCommand: [] }, timeoutMs: 0, results: [], ...counts } });
    for (const file of new Set(markdown.files)) yield* fs.writeFileString(file, text).pipe(
      Effect.mapError(error => new ReportWriteError({ path: file, message: String(error) })));
    if (markdown.stdout) {
      yield* Console.log(text);
      if (options.onExit !== undefined) yield* options.onExit(0);
      return;
    }
  }
  if (input.list && input.format === "json") {
    yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(MutantList))({ schemaVersion: 2, tool: "mutant.cafe", mutants, notMutated, counts }));
    if (options.onExit !== undefined) yield* options.onExit(0);
    return;
  }
  if (input.list) {
    for (const mutant of mutants) yield* Console.log(mutantLine(mutant, config.root, path));
    const perFile = new Map<string, number>();
    for (const mutant of mutants) {
      const file = path.relative(root, path.resolve(root, mutant.file));
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    for (const [file, count] of [...perFile].sort(([a], [b]) => a.localeCompare(b))) yield* Console.log(`${file}: ${count} mutants`);
    yield* Console.log(`${mutants.length} mutants total; ${notMutated.length} not mutated; ${counts.selected} selected, 0 run, ${counts.budgetSkipped} budget-skipped`);
    if (options.onExit !== undefined) yield* options.onExit(0);
    return;
  }
  const reporter = yield* makeReporter({ root, outDir: config.outDir, mutants, notMutated, selected: counts.selected, budgetSkipped: counts.budgetSkipped, ...(markdown === undefined ? {} : { markdown }) });
  // Selection is final here: no scratch tree or test process can add information when it is empty.
  const report = yield* (mutants.length === 0
    ? Effect.succeed<RunReport>({ schemaVersion: 2, tool: "mutant.cafe", root,
      baseline: { durationMs: 0, testCommand: [] }, timeoutMs: 0, results: [] })
    : options.run(config, mutants)).pipe(Effect.provideService(Reporter, reporter),
    Effect.catchTag("BaselineFailed", error => Effect.gen(function*() {
      const failed: RunReport = { schemaVersion: 2, tool: "mutant.cafe", root,
        baseline: { durationMs: 0, testCommand: error.command }, timeoutMs: config.timeoutMs ?? config.minimumTimeoutMs, results: [],
        failure: `BaselineFailed: ${formatTestCommand(error.command)}\n${error.output.slice(-8000)}` };
      yield* reporter.write(failed);
      if (!input.advisory) return yield* error;
      if (markdown === undefined) yield* Console.log("Advisory: baseline failed; would exit 4 without --advisory.");
      return failed;
    })), Effect.catchTag("BaselineTimedOut", error => Effect.gen(function* () {
      const timedOut: RunReport = { schemaVersion: 2, tool: "mutant.cafe", root,
        baseline: { durationMs: 0, testCommand: error.command }, timeoutMs: config.timeoutMs ?? config.minimumTimeoutMs, results: [],
        failure: `BaselineTimedOut: ${error.message}` };
      yield* reporter.write(timedOut);
      if (!input.advisory) return yield* error;
      return timedOut;
    })));
  if (input.advisory && reportExitCode(report) !== 0 && markdown === undefined) yield* Console.log(`Advisory: would exit ${reportExitCode(report)} without --advisory.`);
  yield* reporter.write(report);
  if (options.onExit !== undefined) yield* options.onExit(input.advisory ? 0 : reportExitCode(report));
}));

// The executable's runtime supplies core services. No engine or runner package is
// imported here; the integration layer owns that choice.
export const runCli = Effect.fn("runCli")(function*(options: {
  readonly root: string;
  readonly args: ReadonlyArray<string>;
  readonly run: Run;
}) {
  const code = yield* Ref.make(0);
  const command = makeCommand({ ...options, onExit: (value) => Ref.set(code, value) });
  yield* Command.runWith(command, { version: "0.1.6" })(options.args).pipe(
    Effect.catch((error) => Effect.gen(function*() {
      yield* Console.error(error._tag === "ProgramLoadError" ? `${error.tsconfig}:\n${error.diagnostics.join("\n")}`
        : error._tag === "BaselineTimedOut" ? error.message
        : error._tag === "BaselineFailed" ? `Baseline failed (${error.exitCode}): ${formatTestCommand(error.command)}\n${error.output.slice(-8000)}`
        : String(error));
      yield* Ref.set(code, errorExitCode(error));
    })),
    Effect.catchDefect((defect) => Effect.gen(function*() {
      yield* Console.error(`Internal error: ${String(defect)}`);
      yield* Ref.set(code, 70);
    })),
  );
  return yield* Ref.get(code);
});
