import * as Schema from "effect/Schema";

export const DEFAULT_BASELINE_TIMEOUT_MS = 30 * 60 * 1000;

export const RunConfig = Schema.Struct({
  root: Schema.String,
  tsconfig: Schema.String,
  include: Schema.Array(Schema.String),
  explicitIncludes: Schema.optional(Schema.Boolean),
  exclude: Schema.Array(Schema.String),
  functionFilter: Schema.Array(Schema.String),
  inDiff: Schema.optional(Schema.String),
  exportedOnly: Schema.optional(Schema.Boolean),
  cold: Schema.optional(Schema.Boolean),
  warm: Schema.optional(Schema.Boolean),
  jobs: Schema.Int,
  timeoutMs: Schema.optional(Schema.Int),
  baselineTimeoutMs: Schema.optional(Schema.Int),
  timeoutMultiplier: Schema.Finite,
  minimumTimeoutMs: Schema.Int,
  neverTimeoutMs: Schema.Int,
  outDir: Schema.String,
});
export type RunConfig = typeof RunConfig.Type;

export const ConfigFile = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  functionFilter: Schema.optional(Schema.Array(Schema.String)),
  jobs: Schema.optional(Schema.Int),
  timeoutMultiplier: Schema.optional(Schema.Finite),
  minimumTimeoutMs: Schema.optional(Schema.Int),
  baselineTimeoutMs: Schema.optional(Schema.Int),
});
export type ConfigFile = typeof ConfigFile.Type;
