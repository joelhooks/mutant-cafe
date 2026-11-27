// Runtime argv is a Node/Bun boundary, not a command line to replay.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, resolve } from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { pathToFileURL } from "node:url";

const isPath = (value: string) => isAbsolute(value) || /^\.{1,2}([/\\]|$)/.test(value);

export function runtimeArgs(argv: readonly string[], cwd: string, bun: boolean): {
  args: string[];
  dropped: string[];
} {
  const args: string[] = [];
  const dropped: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]!;
    // Node supports attached values on its short flags, e.g. -Csource.
    const attached = /^(-[Crep])(?:=)?(.+)$/.exec(raw);
    const equals = raw.indexOf("=");
    const key = attached?.[1] ?? (equals < 0 ? raw : raw.slice(0, equals));
    const inline = attached?.[2] ?? (equals < 0 ? undefined : raw.slice(equals + 1));
    if (["-e", "--eval", "-p", "--print", "-i", "--interactive", "-c", "--check"].includes(key)) {
      dropped.push(key);
      // Anything after an entry mode may belong to that invocation, not to a child.
      break;
    }
    if (/^--(?:inspect|test|watch)(?:-|$)/.test(key)) {
      dropped.push(key);
      continue;
    }
    const condition = key === "--conditions" || key === "-C";
    const preload = key === "--require" || key === "-r" || key === "--import" || (bun && key === "--preload");
    const loader = !bun && (key === "--loader" || key === "--experimental-loader");
    if (!bun && key === "--experimental-import-meta-resolve") {
      if (inline === undefined) args.push(key);
      continue;
    }
    if (!condition && !preload && !loader) continue;
    const value = inline ?? argv[index + 1];
    if (!value || (inline === undefined && value.startsWith("-"))) continue;
    if (inline === undefined) index++;
    if (condition) {
      args.push(`--conditions=${value}`);
      continue;
    }
    const option = bun ? "--preload" : loader ? "--experimental-loader" : key === "--import" ? key : "--require";
    const location = !isPath(value) ? value : option === "--import" || loader
      ? pathToFileURL(resolve(cwd, value)).href : resolve(cwd, value);
    args.push(`${option}=${location}`);
  }
  return { args, dropped };
}
