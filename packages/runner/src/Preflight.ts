import { DEFAULT_BASELINE_TIMEOUT_MS, SelectionIssue, type Baseline } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { acquireProcessTree } from "./ProcessTree.ts";

const Issues = Schema.Array(SelectionIssue);

// Run against installed Vitest. Source mapping is evidence, not an override of
// its selection: built-entry issues are conditional on the tests actually run.
const probe = String.raw`
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = process.cwd();
const issues = [];
const pkg = JSON.parse(await readFile("package.json", "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; }));
const script = pkg.scripts?.test;
const vitestScript = !script || /(?:^|[\s/])vitest(?=\s|$|[;&|])/.test(script);
const delegated = script && /(?:\bturbo\s+(?:run\s+)?test\b|\bpnpm\s+(?:-r|--recursive|--filter\s+\S+)\s+(?:run\s+)?test\b)/.test(script);
const otherRunner = script && /(?:^|&&\s*|;\s*)(?:(?:pnpm\s+exec|npx)\s+)?(?:node\s+(?:\S+\s+)*--test(?=\s|$)|(?:jest|mocha|ava|tap)(?=\s|$)|bun\s+test(?=\s|$))/.test(script);
if (otherRunner) {
  issues.push({ kind: "runner", reason: 'package.json scripts.test = ' + JSON.stringify(script) + '; mutant.cafe only runs Vitest' });
} else {
  if (!vitestScript) issues.push({ kind: "warning", reason: 'package.json scripts.test = ' + JSON.stringify(script) + (delegated ? '; delegated test runner: Vitest selection is unverified' : '; unknown test wrapper: Vitest selection is unverified') });
  let ctx;
  try {
    const { createVitest } = await import("vitest/node");
    ctx = await createVitest("test", { root, watch: false, cache: false, fsModuleCache: false });
    const selected = new Set((await ctx.globTestSpecifications()).map(spec => resolve(spec.moduleId)));
    const sources = new Map();
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", ".brain", ".pi", ".agent_sources", "mutants.out", "dist"].includes(entry.name)) continue;
        const file = resolve(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (/\.[cm]?[jt]sx?$/.test(file)) sources.set(file, await readFile(file, "utf8"));
      }
    }
    await walk(root);
    // Read only explicit rootDir/outDir evidence, including JSONC and extends.
    // Do not depend on a compiler API in the tested package or infer build layout.
    async function configOptions(file, seen = new Set()) {
      if (seen.has(file)) throw new Error('cyclic tsconfig extends');
      const text = await readFile(file, 'utf8');
      const json = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('"') ? token : token.replace(/[^\r\n]/g, ' '))
        .replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (token, string) => string ?? '');
      const config = JSON.parse(json);
      let options = {};
      for (const base of Array.isArray(config.extends) ? config.extends : typeof config.extends === 'string' ? [config.extends] : []) {
        const path = base.startsWith('.') || isAbsolute(base) ? resolve(dirname(file), base) : createRequire(file).resolve(base);
        const candidate = await readFile(path).then(() => path, () => path + '.json');
        options = { ...options, ...await configOptions(candidate, new Set([...seen, file])) };
      }
      for (const key of ['rootDir', 'outDir']) if (typeof config.compilerOptions?.[key] === 'string') options[key] = resolve(dirname(file), config.compilerOptions[key]);
      return options;
    }
    let options = {};
    try { options = await configOptions(resolve(root, process.argv[1])); }
    catch { /* No proven mapping: restrict by importing tests only. */ }
    function sourceFile(path) {
      return [path, path.replace(/\.[cm]?js$/, '.ts'), path.replace(/\.[cm]?js$/, '.mts'), path.replace(/\.[cm]?js$/, '.cts'), path + '.ts', path + '.tsx', path + '.mts', path + '.cts', resolve(path, 'index.ts')].find(p => sources.has(p) && !/\.d\.[cm]?ts$/.test(p));
    }
    function exportTypes(specifier) {
      const key = specifier === pkg.name ? '.' : './' + specifier.slice(pkg.name.length + 1);
      let entry = pkg.exports;
      let wildcard;
      if (entry && typeof entry === 'object' && Object.keys(entry).some(key => key.startsWith('.'))) {
        if (key in entry) entry = entry[key];
        else {
          const pattern = Object.keys(entry).find(pattern => pattern.includes('*') && key.startsWith(pattern.split('*')[0]) && key.endsWith(pattern.split('*')[1]));
          if (!pattern) return;
          const [before, after] = pattern.split('*');
          wildcard = key.slice(before.length, after.length ? -after.length : undefined);
          entry = entry[pattern];
        }
      } else if (key !== '.') return;
      function types(value) {
        if (!value || typeof value !== 'object') return;
        if (typeof value.types === 'string') return value.types;
        return types(value.types) ?? types(value.import) ?? types(value.default);
      }
      const path = types(entry) ?? (key === '.' ? pkg.types : undefined);
      return typeof path === 'string' ? resolve(root, wildcard === undefined ? path : path.replaceAll('*', wildcard)) : undefined;
    }
    function mappedSource(entry, types) {
      for (const path of [types, entry]) {
        if (!path) continue;
        if (/\.[cm]?tsx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path)) {
          const direct = sourceFile(path);
          if (direct) return direct;
        }
        if (!options.rootDir || !options.outDir) continue;
        const inside = relative(options.outDir, path);
        if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) continue;
        const stem = inside.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, '');
        const mapped = sourceFile(resolve(options.rootDir, stem));
        if (mapped) return mapped;
      }
    }
    const edges = new Map();
    const built = [];
    for (const [file, text] of sources) {
      const dependencies = new Set();
      edges.set(file, dependencies);
      for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g)) {
        let target;
        let source;
        const specifier = match[1];
        if (specifier.startsWith('.')) target = resolve(dirname(file), specifier);
        else {
          try {
            const self = pkg.name && (specifier === pkg.name || specifier.startsWith(pkg.name + '/'));
            target = self ? fileURLToPath(import.meta.resolve(specifier)) : createRequire(file).resolve(specifier);
            if (self && (!/\.[cm]?tsx?$/.test(target) || /\.d\.[cm]?ts$/.test(target))) {
              source = mappedSource(target, exportTypes(specifier));
              built.push({ importer: file, source, reason: relative(root, file) + ' imports ' + specifier + '; self entry resolves to built output ' + relative(root, target) + ', not mutated TypeScript source' + (source ? '; mapped source ' + relative(root, source) : '; source mapping unavailable') });
            }
          } catch { continue; }
        }
        const candidate = source ?? sourceFile(target);
        if (candidate) dependencies.add(candidate);
      }
    }
    function dependencies(file, seen = new Set()) {
      if (seen.has(file)) return seen;
      seen.add(file);
      for (const dependency of edges.get(file) ?? []) dependencies(dependency, seen);
      return seen;
    }
    const closures = new Map([...selected].map(file => [file, dependencies(file)]));
    for (const entry of built) {
      const testFiles = [...selected].filter(file => closures.get(file).has(entry.importer)).map(file => relative(root, file));
      if (testFiles.length) issues.push({ kind: 'built', ...(entry.source ? { files: [...dependencies(entry.source)].map(file => relative(root, file)) } : {}), testFiles, reason: entry.reason });
    }
    const reached = new Set([...closures.values()].flatMap(files => [...files]));
    for (const [file, text] of sources) {
      const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        || (/["'](?:node:test|vitest|@effect\/vitest)["']/.test(text) && /\b(?:it|test|describe)\s*(?:\.|\()/.test(text));
      if (reached.has(file) || !testFile) continue;
      for (const target of dependencies(file)) {
        if (target !== file) issues.push({ kind: 'target', file: relative(root, target), reason: relative(root, file) + ' imports this target but is absent from Vitest resolved test files' });
      }
    }
  } catch (error) {
    issues.push({ kind: 'warning', reason: 'Cannot verify Vitest resolved selection: ' + String(error) });
  } finally { await ctx?.close(); }
}
console.log('mutant-cafe-preflight:' + JSON.stringify([...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()]));
`;

interface PreflightOptions { readonly processesSince?: number | undefined; readonly onBackstop?: (ms: number) => void }
export const preflight = Effect.fn("TestRunner.preflight")(function* (root: string, tsconfig = "tsconfig.json", timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS, options: PreflightOptions = {}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const since = options.processesSince ?? (yield* Clock.currentTimeMillis);
  const owned = yield* acquireProcessTree(root, options.onBackstop, since);
  yield* owned.trace("preflight-start", { budgetMs: timeoutMs });
  const output = yield* spawner.string(ChildProcess.make(process.execPath, [...owned.preloadArgs, "--input-type=module", "--eval", probe, tsconfig], { cwd: root, env: owned.env, detached: true, killSignal: "SIGKILL", forceKillAfter: "100 millis", stdin: "ignore" })).pipe(Effect.onInterrupt(() => owned.cleanup));
  yield* owned.trace("preflight-done");
  const encoded = output.split("\n").find(line => line.startsWith("mutant-cafe-preflight:"))?.slice("mutant-cafe-preflight:".length);
  const issues = encoded === undefined
    ? [{ kind: "warning" as const, reason: "Vitest selection probe returned no evidence" }]
    : yield* Schema.decodeEffect(Schema.fromJsonString(Issues))(encoded);
  return issues;
}, (effect, _root, _tsconfig = "tsconfig.json", timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS, _options: PreflightOptions = {}) => effect.pipe(Effect.timeout(timeoutMs), Effect.scoped));

/** Only runner/omitted-target evidence is unconditional. Built imports require
 * both a source-closure match (when known) and the actual selected test set. */
export function unreliableFor(baseline: Baseline, file: string, testFiles?: ReadonlyArray<string>): ReadonlyArray<SelectionIssue> {
  return baseline.unreliable?.filter(issue => {
    switch (issue.kind) {
      case "runner": return true;
      case "warning": return false;
      case "target": return issue.file === file;
      case "built": return (issue.files === undefined || issue.files.includes(file))
        && (testFiles?.some(test => issue.testFiles.includes(test)) ?? false);
    }
  }) ?? [];
}
