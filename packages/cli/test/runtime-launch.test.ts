import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunReport } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

for (const mode of ["cold", "warm"] as const) it.live(`forwards conditions from the real ${mode} CLI invocation`, () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mutant-cli-runtime-" }).pipe(Effect.flatMap(fs.realPath));
  yield* fs.makeDirectory(`${root}/node_modules/mc-test-preload`, { recursive: true });
  yield* fs.symlink(path.resolve(import.meta.dirname, "../../../fixtures/tagged-errors/node_modules/vitest"), `${root}/node_modules/vitest`);
  yield* fs.writeFileString(`${root}/node_modules/mc-test-preload/package.json`, '{"name":"mc-test-preload","type":"module","exports":"./index.mjs"}');
  yield* fs.writeFileString(`${root}/node_modules/mc-test-preload/index.mjs`, 'process.env.MC_BARE_PID = String(process.pid);');
  yield* fs.writeFileString(`${root}/package.json`, JSON.stringify({ type: "module", scripts: { test: "vitest run" },
    imports: { "#choice": { "mutant-cafe-source": "./custom.cjs", default: "./default.cjs" } } }));
  yield* fs.writeFileString(`${root}/custom.cjs`, 'module.exports = "custom";');
  yield* fs.writeFileString(`${root}/default.cjs`, 'module.exports = "default";');
  yield* fs.writeFileString(`${root}/setup.mjs`, 'process.env.MC_RUNTIME_PID = String(process.pid);');
  yield* fs.writeFileString(`${root}/tsconfig.json`, '{"compilerOptions":{"module":"NodeNext","target":"ESNext","noEmit":true},"include":["value.ts"]}');
  yield* fs.writeFileString(`${root}/value.ts`, 'export const accept = (n: number): boolean => n > 0;');
  yield* fs.writeFileString(`${root}/value.test.ts`, 'import { expect, it } from "vitest"; import { accept } from "./value.ts"; it("accepts", () => expect(accept(1)).toBe(true));');
  yield* fs.writeFileString(`${root}/vitest.config.ts`, `
    import { createRequire } from "node:module";
    const choice = createRequire(import.meta.url)("#choice");
    if (choice !== "custom") throw new Error("missing runtime condition: " + choice);
    if (process.env.MC_RUNTIME_PID !== String(process.pid)) throw new Error("missing relative runtime preload");
    if (process.env.MC_BARE_PID !== String(process.pid)) throw new Error("missing package-name runtime preload");
    export default { test: { maxWorkers: 1 } };`);

  const bun = process.versions.bun !== undefined;
  const bin = path.resolve(import.meta.dirname, "../src/bin.ts");
  // Choosing an inspector port without enabling the inspector is safe and
  // still presents a flag the CLI should warn about exactly once per process.
  const cli = yield* ChildProcess.make(process.execPath, ["--inspect-port=0", "--conditions=mutant-cafe-source",
    bun ? "--preload" : "--import", "./setup.mjs", "--import", "mc-test-preload", bin, `--${mode}`, "--jobs", "1"],
    { cwd: root, env: { ...process.env, BUN_OPTIONS: undefined, NODE_OPTIONS: undefined } });
  const [stdout, stderr, exit] = yield* Effect.all([Stream.mkString(Stream.decodeText(cli.stdout)), Stream.mkString(Stream.decodeText(cli.stderr)), cli.exitCode], { concurrency: "unbounded" });
  const output = stderr + stdout;
  const warning = "Warning: not forwarding runtime flags to Vitest children: --inspect-port";
  expect(stderr.split("\n").filter(line => line.includes(warning))).toHaveLength(1);
  expect(stdout).not.toContain(warning);
  expect(Number(exit), output).toBe(2);
  expect(output).not.toContain("Cannot verify Vitest resolved selection");
  const report = yield* Schema.decodeEffect(Schema.fromJsonString(RunReport))(yield* fs.readFileString(`${root}/mutants.out/outcomes.json`));
  expect(report.baseline.runnerMode).toBe(mode);
  expect(report.results.map(row => row.outcome).sort()).toEqual(["caught", "missed"]);
  if (mode === "cold") {
    // The physical launchers, reporters and ownership scripts are fresh by design.
    const template = (command: readonly string[]) => command.map(arg => arg
      .replace(/^(--reporter=)?\/.*\/mutant-vitest-[^/]+\/(launch|reporter)\.mjs$/, "$1<vitest>/$2.mjs")
      .replace(/^\/.*\/mutant-processes-[^/]+\/register\.mjs$/, "<owner>/register.mjs"));
    const first = report.results[0]!.testCommand;
    const second = report.results[1]!.testCommand;
    expect(first).not.toEqual(second);
    expect(template(first)).toEqual(template(second));
    expect(first.filter(arg => arg === "--conditions=mutant-cafe-source")).toHaveLength(1);
    expect(first.filter(arg => arg === "--preload")).toHaveLength(bun ? 1 : 0);
    expect(first).toContain(bun ? `--preload=${root}/setup.mjs` : `--import=${new URL(`file://${root}/setup.mjs`).href}`);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000);
