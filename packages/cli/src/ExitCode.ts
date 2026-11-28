import type { RunReport } from "@mutant-cafe/core";

export const reportExitCode = (report: RunReport): number =>
  report.results.some((result) => result.outcome === "missed") ? 2 :
    report.results.some((result) => result.outcome === "unreliable") ? 7 :
      report.results.some((result) => result.outcome === "untested") ? 2 :
        report.results.some((result) => result.outcome === "timeout") || report.failure?.startsWith("BaselineTimedOut:") ? 3 : 0;

export const errorExitCode = (error: { readonly _tag: string; readonly kind?: string | undefined }): number => {
  switch (error._tag) {
    case "BaselineFailed": return 4;
    case "BaselineTimedOut": return 3;
    case "TestSpawnError": return error.kind === "vitest-version" ? 8 : 70;
    case "DiffMismatch": return 5;
    case "DiffParseError": return 6;
    case "DuplicateMutantId": return 9;
    case "ProgramLoadError": case "UsageError": case "ShowHelp": case "InvalidValue": case "MissingFlag":
    case "UnrecognizedArgument": return 1;
    default: return 70;
  }
};
