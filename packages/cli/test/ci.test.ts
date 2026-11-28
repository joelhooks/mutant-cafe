import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { reportIdentity, BaselineFailed, MutantList, MutantSource, Reporter, RunReport, Scratch, TestRunner, type Mutant } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { expect } from "vitest";
import { runCli, type Run } from "../src/Command.ts";
import { markdownSummary } from "../src/Summary.ts";

const item = (id: string, file = "account.ts", line = 1, column = 1): Mutant => ({
  id, file, functionName: "answer", returnType: "boolean", genre: "BooleanFlip",
  description: "replace `answer` | false", synthetic: false,
  span: { start: { line, column }, end: { line, column: 50 } },
  replacement: { startOffset: 0, endOffset: 0, text: "// mutation\n" },
});
const report = (root: string, mutants: ReadonlyArray<Mutant>): RunReport => ({
  schemaVersion: 2, tool: "mutant.cafe", root, baseline: { durationMs: 1, testCommand: ["vitest", "run"] }, timeoutMs: 1000,
  results: mutants.map(mutant => ({ mutant, outcome: "missed", durationMs: 1, testCommand: [], diagnostics: [] })),
});
const invoke = (root: string, args: ReadonlyArray<string>, mutants: ReadonlyArray<Mutant>, run: Run = (config, mutants) => Effect.succeed(report(config.root, mutants))) => runCli({ root, args, run }).pipe(
  Effect.provideService(MutantSource, { generate: () => Stream.fromIterable(mutants), notMutated: () => Effect.succeed([{ file: `${root}/account.ts`, functionName: "generic", reason: "unsupported" }]), checkViable: () => Effect.succeed({ viable: true, diagnostics: [] }) }),
  Effect.provideService(Scratch, { acquire: () => Effect.die("Unexpected scratch") }),
  Effect.provideService(TestRunner, { baseline: () => Effect.die("Unexpected baseline"), runRelated: () => Effect.die("Unexpected test") }),
);
const spawn = (root: string, command: string, args: ReadonlyArray<string>, env?: Record<string, string>) => Effect.scoped(Effect.gen(function*() {
  const handle = yield* ChildProcess.make(command, args, { cwd: root, ...(env === undefined ? {} : { env, extendEnv: true }) });
  const [stdout, stderr, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode], { concurrency: "unbounded" });
  return { stdout, stderr, code: Number(code) };
}));
const cli = (root: string, args: ReadonlyArray<string>, env?: Record<string, string>) => spawn(root, process.execPath, [`${import.meta.dirname}/../src/bin.ts`, ...args], env);
const project = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-ci-" });
  yield* fs.writeFileString(`${root}/account.ts`, "export const answer = () => true;\n");
  return root;
});

it.effect("budgets after selection in path/line/column/id order and never creates skipped outcomes", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  yield* fs.writeFileString(`${root}/z.ts`, "export const z = () => false;\n");
  const items = [item("z", "z.ts"), item("last", "account.ts", 2), item("b", "account.ts", 1, 2), item("a", "account.ts", 1, 2), item("first")];
  for (let run = 0; run < 2; run++) {
    const checked: Run = (config, mutants) => Effect.sync(() => {
      expect(mutants.map(m => m.id)).toEqual(["first", "a", "b"]);
      return report(config.root, mutants);
    });
    expect(yield* invoke(root, ["--max-mutants", "3", "--jobs", "1"], items, checked)).toBe(2);
    const output = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
    expect(output.results.map(result => result.mutant.id)).toEqual(["first", "a", "b"]);
    expect({ selected: output.selected, run: output.run, budgetSkipped: output.budgetSkipped }).toEqual({ selected: 5, run: 3, budgetSkipped: 2 });
  }
  expect(yield* invoke(root, ["--max-mutants", "0"], items, () => Effect.die("Zero budget invoked the runner"))).toBe(0);
  const zero = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
  expect(zero.results).toEqual([]);
  expect(zero.budgetSkipped).toBe(5);
  expect(zero.baseline.testCommand).toEqual([]);
  for (const args of [["--max-mutants", "-1"], ["--format", "wrong"], ["--format", "json"], ["--in-diff", "a", "--in-diff-range", "HEAD~1...HEAD"]]) expect(yield* invoke(root, args, items)).toBe(1);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("a range outside function bodies skips Vitest and writes an empty report and summary", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-empty-range-" });
  yield* fs.writeFileString(`${root}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["value.ts"] }));
  yield* fs.writeFileString(`${root}/vitest.config.ts`, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(`${root}/vitest-started`)}, "yes"); export default { test: { maxWorkers: 1 } };`);
  yield* fs.writeFileString(`${root}/value.test.ts`, 'import { it } from "vitest"; it("baseline executes", () => {});');
  const fixture = `${import.meta.dirname}/../../../fixtures/tagged-errors`;
  yield* fs.symlink(`${fixture}/node_modules`, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/value.ts`, "// first comment\nexport const value = (n: number): boolean => n > 0;\n");
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "before"]]) expect((yield* spawn(root, "git", args)).code).toBe(0);
  yield* fs.writeFileString(`${root}/value.ts`, "// changed comment\nexport const value = (n: number): boolean => n > 0;\n");
  for (const args of [["add", "value.ts"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "comment"]]) expect((yield* spawn(root, "git", args)).code).toBe(0);
  const result = yield* cli(root, ["--jobs", "1", "--in-diff-range", "HEAD~1...HEAD", "--summary-md", "summary.md"]);
  expect(result.code, result.stderr).toBe(0);
  expect(yield* fs.exists(`${root}/vitest-started`)).toBe(false);
  const output = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
  expect(output.baseline.testCommand).toEqual([]);
  expect(output.baseline.durationMs).toBe(0);
  expect(output.results).toEqual([]);
  expect(output.run).toBe(0);
  expect(yield* fs.readFileString(`${root}/summary.md`)).toContain("No actionable mutants.");
  expect(result.stderr).toContain("0 mutants selected (0 before budget); cause: range");
  const budget = yield* cli(root, ["--jobs", "1", "--max-mutants", "0"]);
  expect(budget.code, budget.stderr).toBe(0);
  expect(budget.stderr).toContain("0 mutants selected (2 before budget); cause: budget");
  expect(yield* fs.exists(`${root}/vitest-started`)).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);

it.live("real two-file budget runs three mutants in repeatable order", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-budget-" });
  const fixture = path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors");
  yield* fs.symlink(`${fixture}/node_modules`, `${root}/node_modules`);
  yield* fs.makeDirectory(`${root}/src`);
  yield* fs.makeDirectory(`${root}/test`);
  yield* fs.writeFileString(`${root}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
  yield* fs.writeFileString(`${root}/vitest.config.ts`, 'export default { test: { maxWorkers: 1 } };');
  yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true }, include: ["src"] }));
  for (const file of ["a", "z"]) yield* fs.writeFileString(`${root}/src/${file}.ts`, `export const ${file} = (n: number): boolean => n > 0;\n`);
  yield* fs.writeFileString(`${root}/test/values.test.ts`, 'import { it, expect } from "vitest"; import { a } from "../src/a.ts"; import { z } from "../src/z.ts"; it("both branches", () => { for (const f of [a, z]) { expect(f(1)).toBe(true); expect(f(-1)).toBe(false); } });');
  const listed = yield* cli(root, ["--list", "--format", "json"]);
  expect(listed.code, listed.stderr).toBe(0);
  const all = yield* Schema.decodeEffect(Schema.fromJsonString(MutantList))(listed.stdout);
  const physicalRoot = yield* fs.realPath(root);
  expect(all.mutants.map(m => path.relative(physicalRoot, m.file))).toEqual(["src/a.ts", "src/a.ts", "src/z.ts", "src/z.ts"]);
  let previous: ReadonlyArray<string> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = yield* cli(root, ["--jobs", "1", "--max-mutants", "3"]);
    expect(result.code, result.stderr).toBe(0);
    const output = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
    expect(output).toMatchObject({ ...reportIdentity, typescriptVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(output.typescriptVersion).toBe(all.typescriptVersion);
    expect(output.results.map(r => r.outcome)).toEqual(["caught", "caught", "caught"]);
    expect(output.results.map(r => r.mutant.id)).toEqual(all.mutants.slice(0, 3).map(m => m.id));
    expect({ selected: output.selected, run: output.run, budgetSkipped: output.budgetSkipped }).toEqual({ selected: 4, run: 3, budgetSkipped: 1 });
    if (previous !== undefined) expect(output.results.map(r => r.mutant.id)).toEqual(previous);
    previous = output.results.map(r => r.mutant.id);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 90_000);

it.live("JSON list is one published-schema document with the text ids and budget counts", () => Effect.gen(function*() {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors");
  const json = yield* cli(root, ["--list", "--format", "json", "--max-mutants", "3"]);
  expect(json.code, json.stderr).toBe(0);
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(MutantList))(json.stdout);
  expect(decoded).toMatchObject({ ...reportIdentity, typescriptVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  expect(decoded.counts).toEqual({ selected: 9, run: 0, budgetSkipped: 6 });
  expect(decoded.mutants).toHaveLength(3);
  expect(Array.isArray(decoded.notMutated)).toBe(true);
  const text = yield* cli(root, ["--list", "--max-mutants", "3"]);
  expect(text.code).toBe(0);
  const ids = [...text.stdout.matchAll(/\[([A-Za-z0-9_-]+)\]/g)].map(match => match[1]);
  expect(decoded.mutants.map(m => m.id)).toEqual(ids);
  expect(text.stdout).toContain("9 selected, 0 run, 6 budget-skipped");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);

it.live("keeps IDs and descriptions across file, exclusion, diff and root-order shards", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mc-id-filters-" });
  const tags = ["z", "y", "x", "w", "v", "u", "t", "s"];
  const variants = (order: string[]) => order.map(tag => `{ tag: ${JSON.stringify(tag)}, value: number }`).join(" | ");
  const definition = `export const tagged = (value: number): Choice => ({ tag: "z", value });`;
  yield* fs.writeFileString(`${root}/a.ts`, `type Primer = ${variants([...tags].reverse())};\nexport const prime = (value: number): Primer => ({ tag: "s", value });\n`);
  yield* fs.writeFileString(`${root}/z.ts`, `type Choice = ${variants(tags)};\n${definition}\n`);
  yield* fs.writeFileString(`${root}/identity.diff`, `diff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ b/z.ts\n@@ -2 +2 @@\n-${definition.replace('"z"', '"y"')}\n+${definition}\n`);
  const configure = (files: string[]) => fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ files, compilerOptions: { module: "NodeNext", skipLibCheck: true } }));
  yield* configure(["a.ts", "z.ts"]);
  const list = (args: string[]) => Effect.gen(function* () {
    const result = yield* cli(root, ["--list", "--format", "json", ...args]);
    expect(result.code, result.stderr).toBe(0);
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(MutantList))(result.stdout);
    return decoded.mutants.filter(mutant => mutant.functionName === "tagged").map(({ id, description }) => ({ id, description }));
  });
  const full = yield* list([]);
  expect(full.map(({ description }) => /with .*"tag": \("([^"]+)" as const\)/.exec(description)?.[1]).filter(Boolean).sort()).toEqual(["u", "v", "w", "x", "y", "z"]);
  for (const args of [["--file", "z.ts"], ["--exclude", "a.ts"], ["--in-diff", "identity.diff"]]) expect(yield* list(args)).toEqual(full);
  yield* configure(["z.ts", "a.ts"]);
  expect(yield* list([])).toEqual(full);
  yield* fs.writeFileString(`${root}/z.ts`, `type Choice<T> = ${variants(tags).replaceAll("value: number", "value: T")};\n${definition.replace(": Choice", ": Choice<number>")}\n`);
  const generic = yield* list([]);
  expect(generic.map(item => item.id)).toEqual(full.map(item => item.id));
  expect(yield* list(["--file", "z.ts"])).toEqual(generic);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000);

it.effect("reports unknown locations honestly and merges runtime analysis skips", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const run: Run = () => Effect.succeed({ ...report(root, []), notMutated: [{ file: `${root}/account.ts`, functionName: "answer", span: item("one").span, reason: "analysis failed: compiler declaration missing" }] });
  expect(yield* invoke(root, [], [item("one")], run)).toBe(0);
  const lines = yield* fs.readFileString(`${root}/mutants.out/not-mutated.txt`);
  expect(lines).toContain("account.ts:?:?: generic: unsupported");
  expect(lines).toContain("account.ts:1:1: answer: analysis failed:");
  const output = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
  expect(output.notMutated).toHaveLength(2);
  expect(output.results).toEqual([]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("Markdown uses the repository root, escapes cells and writes the requested marker", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  expect((yield* spawn(root, "git", ["init", "--quiet"])).code).toBe(0);
  yield* fs.makeDirectory(`${root}/packages/a`, { recursive: true });
  yield* fs.writeFileString(`${root}/packages/a/account.ts`, "export const answer = () => true;\n");
  expect(yield* invoke(`${root}/packages/a`, ["--summary-md", "summary.md", "--summary-marker", "<!-- custom -->", "--advisory"], [item("miss")])).toBe(0);
  const md = yield* fs.readFileString(`${root}/packages/a/summary.md`);
  expect(md.split("\n")[0]).toBe("<!-- custom -->");
  expect(md).toContain("| packages/a/account.ts:1 | answer | replace &#96;answer&#96; \\| false | missed |");
  expect(md).toContain("would exit 2");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.effect("empty and fully caught summaries explain that no action is needed", () => Effect.gen(function*() {
  const path = yield* Path.Path;
  for (const results of [[], report("/repo", [item("caught")]).results.map(result => ({ ...result, outcome: "caught" as const }))]) {
    const md = markdownSummary({ report: { ...report("/repo", []), results }, root: "/repo", gitRoot: "/repo", path, marker: "<!-- mutant.cafe -->", notMutated: 0, advisory: false });
    expect(md).toContain("No actionable mutants.");
    expect(md).not.toContain("| File:line |");
  }
}).pipe(Effect.provide(NodeServices.layer)));

it.effect("summary counts caught but only lists actionable outcomes, caps rows at 50", () => Effect.gen(function*() {
  const path = yield* Path.Path;
  const root = "/repo";
  const base = report(root, Array.from({ length: 54 }, (_, i) => item(`m${i}`)));
  const output: RunReport = { ...base, results: base.results.map((r, i) => ({ ...r, outcome: i === 0 ? "caught" : i === 1 ? "timeout" : i === 2 ? "untested" : i === 3 ? "unreliable" : "missed" })) };
  const md = markdownSummary({ report: output, root, gitRoot: root, path, marker: "<!-- mutant.cafe -->", notMutated: 0, advisory: false });
  expect(md.split("\n")[0]).toBe("<!-- mutant.cafe -->");
  expect(md).toContain("1 caught, 50 missed, 1 timeout, 0 unviable, 1 untested, 1 unreliable");
  expect(md.split("\n").filter(line => line.startsWith("| account.ts:1 |"))).toHaveLength(50);
  expect(md).toContain("and 3 more");
  expect(md).not.toContain("| caught |");
}).pipe(Effect.provide(NodeServices.layer)));

it.effect("advisory keeps usage and internal errors but reports baseline failure without failing", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const baseline: Run = () => Effect.fail(new BaselineFailed({ exitCode: 1, command: ["vitest", "run"], output: "known baseline failure" }));
  expect(yield* invoke(root, ["--advisory", "--summary-md", "baseline.md"], [item("m")], baseline)).toBe(0);
  const md = yield* fs.readFileString(`${root}/baseline.md`);
  expect(md).toContain("BaselineFailed");
  expect(md).toContain("known baseline failure");
  expect(md).not.toContain("No actionable mutants.");
  expect(md).toContain("would exit 4");
  expect(yield* invoke(root, ["--advisory", "--bad-flag"], [])).toBe(1);
  expect(yield* invoke(root, ["--advisory"], [item("m")], () => Effect.die("internal"))).toBe(70);
  for (const outcome of ["caught", "missed", "unviable", "timeout", "untested", "unreliable"] as const) {
    expect(yield* invoke(root, ["--advisory"], [item("m")], (config, mutants) => Effect.succeed({ ...report(config.root, mutants), results: report(config.root, mutants).results.map(result => ({ ...result, outcome })) }))).toBe(0);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

it.live("real tagged-errors advisory exits zero and writes identical GitHub/file summaries", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors");
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-github-" });
  const result = yield* cli(root, ["--jobs", "1", "--advisory", "--format", "github", "--summary-md", `${temp}/summary.md`, "--output", `${temp}/out`], { GITHUB_STEP_SUMMARY: `${temp}/step.md` });
  expect(result.code, result.stderr).toBe(0);
  const md = yield* fs.readFileString(`${temp}/summary.md`);
  expect(md.split("\n")[0]).toBe("<!-- mutant.cafe -->");
  expect(md).toContain("3 missed");
  expect(md).toContain("would exit 2");
  expect(md).toMatch(/\| fixtures\/tagged-errors\/src\/account.ts:\d+ \|/);
  expect(yield* fs.readFileString(`${temp}/step.md`)).toBe(md);
  expect(result.stdout.trimEnd()).toBe(md.trimEnd());
  expect(result.stderr).toContain("Baseline command:");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 60_000);

it.effect("range diff from a nested package matches a diff file and bad refs name git and stderr", () => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* project;
  const nested = `${root}/packages/a`;
  yield* fs.makeDirectory(nested, { recursive: true });
  yield* fs.writeFileString(`${nested}/account.ts`, "export const answer = () => true;\n");
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "before"]]) expect((yield* spawn(root, "git", args)).code).toBe(0);
  yield* fs.writeFileString(`${nested}/account.ts`, "export const answer = () => false;\n");
  for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "after"]]) expect((yield* spawn(root, "git", args)).code).toBe(0);
  const diff = yield* spawn(root, "git", ["diff", "HEAD~1...HEAD"]);
  yield* fs.writeFileString(`${nested}/change.diff`, diff.stdout);
  const items = [item("inside"), item("outside", `${root}/account.ts`)];
  const run: Run = (config, mutants) => Effect.sync(() => {
    expect(mutants.map(m => m.id)).toEqual(["inside"]);
    return report(config.root, mutants);
  });
  for (const args of [["--in-diff-range", "HEAD~1...HEAD"], ["--in-diff-range", "HEAD~1..HEAD"], ["--in-diff", "change.diff"]]) expect(yield* invoke(nested, args, items, run)).toBe(2);
  expect(yield* invoke(nested, ["--in-diff-range", "bad-ref...HEAD"], items)).toBe(1);
  // The executable validates refs before trying to load a TypeScript project.
  const bad = yield* cli(nested, ["--in-diff-range", "bad-ref...HEAD"]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("git diff --no-ext-diff --no-color bad-ref...HEAD --");
  expect(bad.stderr).toContain("fatal: bad revision 'bad-ref...HEAD'");
  const missingGit = yield* cli(nested, ["--in-diff-range", "HEAD~1...HEAD"], { PATH: "/nonexistent" });
  expect(missingGit.code).toBe(1);
  expect(missingGit.stderr).toContain("git rev-parse --show-toplevel");
  expect(missingGit.stderr).toContain("NotFound");
  const help = yield* cli(nested, ["--help"]);
  for (const flag of ["--max-mutants", "--format", "--summary-md", "--summary-marker", "--advisory", "--in-diff-range"]) expect(help.stdout).toContain(flag);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);
