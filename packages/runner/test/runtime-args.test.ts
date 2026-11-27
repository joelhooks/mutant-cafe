import { expect, it } from "vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exercise the pure parser against native path semantics.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeArgs } from "../src/RuntimeArgs.ts";

const cwd = resolve("fixture", "project");
const absolute = (file: string) => resolve(cwd, file);
const url = (file: string) => pathToFileURL(absolute(file)).href;

it.each([
  { argv: ["--loader", "./hooks.mjs", "--experimental-loader=hooks"], args: [`--experimental-loader=${url("hooks.mjs")}`, "--experimental-loader=hooks"] },
  { argv: ["--experimental-import-meta-resolve", "--experimental-import-meta-resolve=true"], args: ["--experimental-import-meta-resolve"] },
  { argv: ["-Csource", "-C", "development", "-rsetup", "-r", "./setup.cjs"], args: ["--conditions=source", "--conditions=development", "--require=setup", `--require=${absolute("setup.cjs")}`] },
  { argv: ["--import", "tsx", "--import", "./init.mjs", `--require=${absolute("setup.cjs")}`], args: ["--import=tsx", `--import=${url("init.mjs")}`, `--require=${absolute("setup.cjs")}`] },
  { argv: ["--require", "--conditions=source", "--import"], args: ["--conditions=source"] },
  { argv: ["--conditions=", "--preload", "hook", "--no-warnings"], args: [] },
  { argv: ["--inspect-brk=0", "--test-name-pattern=foo", "--watch-path=src", "--conditions=source"], args: ["--conditions=source"], dropped: ["--inspect-brk", "--test-name-pattern", "--watch-path"] },
  ...["-e", "--eval", "-p", "--print", "-i", "--interactive", "-c", "--check"].map(flag => ({ argv: [flag, "--conditions=operand"], args: [], dropped: [flag] })),
  { argv: ["-p1", "--conditions=operand"], args: [], dropped: ["-p"] },
  { bun: true, argv: ["--preload", "./setup.ts", "--require=setup", "--import=tsx", "--experimental-loader=hooks", "--experimental-import-meta-resolve"], args: [`--preload=${absolute("setup.ts")}`, "--preload=setup", "--preload=tsx"] },
])("filters runtime argv: $argv", ({ argv, args, dropped, bun }) => {
  expect(runtimeArgs(argv, cwd, bun ?? false)).toEqual({ args, dropped: dropped ?? [] });
});
