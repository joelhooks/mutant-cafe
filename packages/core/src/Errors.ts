import * as Schema from "effect/Schema";
import { Genre } from "./Mutant.ts";

export class ProgramLoadError extends Schema.TaggedError<ProgramLoadError>()("ProgramLoadError", {
  tsconfig: Schema.String,
  reason: Schema.optional(Schema.Literal("selection")),
  diagnostics: Schema.Array(Schema.String),
}) {}

const MutationSite = Schema.Struct({ file: Schema.String, functionName: Schema.String, genre: Genre, line: Schema.Int });
export class DuplicateMutantId extends Schema.TaggedError<DuplicateMutantId>()("DuplicateMutantId", {
  id: Schema.String,
  first: MutationSite,
  second: MutationSite,
}) {
  override get message(): string {
    const site = (target: typeof MutationSite.Type) => `${target.file}:${target.line} (${target.functionName}, ${target.genre})`;
    return `Duplicate mutant ID ${this.id}: ${site(this.first)} and ${site(this.second)}. Generation stopped to prevent overwriting mutant artifacts. Please report this as a bug.`;
  }
}
export type GenerationError = ProgramLoadError | DuplicateMutantId;

/** Keep the actual argv in reports, but name the runner in human diagnostics. */
export const formatTestCommand = (command: ReadonlyArray<string>): string => {
  const launcher = command.findIndex(arg => !arg.startsWith("-") && /[\\/]mutant-vitest-[^\\/]+[\\/]launch\.mjs$/.test(arg));
  return launcher > 0
    ? `vitest ${command.slice(launcher + 1).filter(arg => arg === "--reporter=default" || !arg.startsWith("--reporter=")).join(" ")} (via ${command.join(" ")})`
    : command.join(" ");
};

export class BaselineFailed extends Schema.TaggedError<BaselineFailed>()("BaselineFailed", {
  exitCode: Schema.Int,
  command: Schema.Array(Schema.String),
  output: Schema.String,
}) {}

export class BaselineTimedOut extends Schema.TaggedError<BaselineTimedOut>()("BaselineTimedOut", {
  timeoutMs: Schema.Int,
  command: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class ScratchError extends Schema.TaggedError<ScratchError>()("ScratchError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

export class TestSpawnError extends Schema.TaggedError<TestSpawnError>()("TestSpawnError", {
  kind: Schema.optional(Schema.Literals(["reporter", "vitest-version"])),
  command: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class DiffParseError extends Schema.TaggedError<DiffParseError>()("DiffParseError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class ReportWriteError extends Schema.TaggedError<ReportWriteError>()("ReportWriteError", {
  path: Schema.String,
  message: Schema.String,
}) {}
