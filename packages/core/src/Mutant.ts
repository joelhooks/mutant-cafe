import * as Schema from "effect/Schema";
import manifest from "../../mutant-cafe/package.json" with { type: "json" };

export const Genre = Schema.Literals([
  "EffectSucceed",
  "EffectFail",
  "SwallowTag",
  "TagToDefect",
  "EffectDie",
  "EffectNever",
  "OptionNone",
  "OptionSome",
  "StreamEmpty",
  "StreamOne",
  "StreamFail",
  "LayerFail",
  "LayerDie",
  "SchemaAcceptAnything",
  "BooleanFlip",
  "LiteralCycle",
  "FnValue",
]);
export type Genre = typeof Genre.Type;

export const Span = Schema.Struct({
  start: Schema.Struct({ line: Schema.Int, column: Schema.Int }),
  end: Schema.Struct({ line: Schema.Int, column: Schema.Int }),
});
export type Span = typeof Span.Type;

export const Replacement = Schema.Struct({
  startOffset: Schema.Int,
  endOffset: Schema.Int,
  text: Schema.String,
});
export type Replacement = typeof Replacement.Type;

export const Mutant = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  functionName: Schema.String,
  returnType: Schema.String,
  displayReturnType: Schema.optional(Schema.String),
  genre: Genre,
  description: Schema.String,
  span: Span,
  replacement: Replacement,
  synthetic: Schema.Boolean,
});
export type Mutant = typeof Mutant.Type;

export const Outcome = Schema.Literals(["caught", "missed", "unviable", "timeout", "untested", "unreliable"]);
export type Outcome = typeof Outcome.Type;

export const MutantResult = Schema.Struct({
  mutant: Mutant,
  outcome: Outcome,
  durationMs: Schema.Int,
  testCommand: Schema.Array(Schema.String),
  diagnostics: Schema.Array(Schema.String),
  output: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Int),
  outerTimeoutMs: Schema.optional(Schema.Int),
  backstopMs: Schema.optional(Schema.Finite),
  hangBudgetBaseMs: Schema.optional(Schema.Finite),
  telemetryWarnings: Schema.optional(Schema.Array(Schema.String)),
  testWorkers: Schema.optional(Schema.Int),
  testConcurrency: Schema.optional(Schema.Int),
});
export type MutantResult = typeof MutantResult.Type;

export const SelectionIssue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("runner"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("warning"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("target"), file: Schema.String, reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("built"), files: Schema.optional(Schema.Array(Schema.String)), testFiles: Schema.Array(Schema.String), reason: Schema.String }),
]);
export type SelectionIssue = typeof SelectionIssue.Type;

export const Baseline = Schema.Struct({
  durationMs: Schema.Int,
  testCommand: Schema.Array(Schema.String),
  unreliable: Schema.optional(Schema.Array(SelectionIssue)),
  testDurations: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  testTimeouts: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  testWorkers: Schema.optional(Schema.Int),
  testConcurrency: Schema.optional(Schema.Int),
  testFileDurations: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  startupMs: Schema.optional(Schema.Int),
  probeSupported: Schema.optional(Schema.Boolean),
  testableMutants: Schema.optional(Schema.Int),
  telemetryWarnings: Schema.optional(Schema.Array(Schema.String)),
  hostPid: Schema.optional(Schema.Int),
  testTimeoutDetails: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  runnerMode: Schema.optional(Schema.Literals(["cold", "warm"])),
  runnerModeReason: Schema.optional(Schema.String),
  calibration: Schema.optional(Schema.Struct({ coldMs: Schema.Int, warmMs: Schema.Int, warmStartupMs: Schema.Int, overheadMs: Schema.optional(Schema.Int), coldStartupMs: Schema.optional(Schema.Int), warmRunStartupMs: Schema.optional(Schema.Int), testFiles: Schema.Int, mutants: Schema.Int })),
});
export type Baseline = typeof Baseline.Type;

export const NotMutated = Schema.Struct({
  // Optional on decode for existing schemaVersion 2 reports; discovery always supplies it.
  span: Schema.optional(Span),
  file: Schema.String,
  functionName: Schema.String,
  reason: Schema.String,
});
export type NotMutated = typeof NotMutated.Type;

// Additive optional fields preserve decoding of schemaVersion 2 reports.
export const SelectionCounts = Schema.Struct({
  selected: Schema.Int,
  run: Schema.Int,
  budgetSkipped: Schema.Int,
});
export type SelectionCounts = typeof SelectionCounts.Type;

// Missing metadata denotes a legacy report. Never compare IDs across epochs.
export const reportIdentity = { idEpoch: 1, toolVersion: manifest.version } as const;
const reportIdentityFields = {
  idEpoch: Schema.optional(Schema.Int),
  toolVersion: Schema.optional(Schema.String),
};

export const MutantList = Schema.Struct({
  ...reportIdentityFields,
  schemaVersion: Schema.Literal(2),
  tool: Schema.Literal("mutant.cafe"),
  mutants: Schema.Array(Mutant),
  notMutated: Schema.Array(NotMutated),
  counts: SelectionCounts,
});
export type MutantList = typeof MutantList.Type;

export const ReachabilityProbe = Schema.Struct({
  file: Schema.String,
  status: Schema.Literals(["unreachable", "reachable", "unsupported"]),
  durationMs: Schema.Int,
  testCommand: Schema.Array(Schema.String),
  output: Schema.String,
});
export type ReachabilityProbe = typeof ReachabilityProbe.Type;

export const RunReport = Schema.Struct({
  ...reportIdentityFields,
  hostRestarts: Schema.optional(Schema.Int),
  poolResets: Schema.optional(Schema.Int),
  reachabilityProbes: Schema.optional(Schema.Array(ReachabilityProbe)),
  selected: Schema.optional(Schema.Int),
  run: Schema.optional(Schema.Int),
  budgetSkipped: Schema.optional(Schema.Int),
  schemaVersion: Schema.Literal(2),
  tool: Schema.Literal("mutant.cafe"),
  root: Schema.String,
  baseline: Baseline,
  timeoutMs: Schema.Int,
  results: Schema.Array(MutantResult),
  failure: Schema.optional(Schema.String),
  notMutated: Schema.optional(Schema.Array(NotMutated)),
});
export type RunReport = typeof RunReport.Type;
