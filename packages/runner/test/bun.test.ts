import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { acquireProcessTree } from "../src/ProcessTree.ts";
import { openWarmRunner } from "../src/WarmRunner.ts";

const dependencies = decodeURIComponent(new URL("../../../fixtures/tagged-errors/node_modules", import.meta.url).pathname);

it.live.skipIf(process.versions.bun === undefined)("registers a live Bun selector before another tree inspects its scratch", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "bun-owned-selector-" }).pipe(Effect.flatMap(fs.realPath));
  yield* fs.symlink(dependencies, `${root}/node_modules`);
  yield* fs.writeFileString(`${root}/package.json`, '{"type":"module","scripts":{"test":"vitest run"}}');
  yield* fs.writeFileString(`${root}/value.ts`, "export const value = 1;");
  yield* fs.writeFileString(`${root}/value.test.ts`, 'import { it, expect } from "vitest"; import { value } from "./value.ts"; it("value", () => expect(value).toBe(1));');
  yield* fs.writeFileString(`${root}/vitest.config.ts`, 'export default { test: { maxWorkers: 1, include: ["value.test.ts"] } };');
  const ledgerPaths: string[] = [];
  const warnings: string[] = [];
  const original = yield* Console.Console;
  const tracked: FileSystem.FileSystem = {
    ...fs,
    makeTempDirectory: options => fs.makeTempDirectory({ ...options, directory: root }).pipe(
      Effect.tap(directory => Effect.sync(() => {
        if (options?.prefix === "mutant-processes-") ledgerPaths.push(`${directory}/pids.jsonl`);
      }))
    )
  };
  yield* Effect.scoped(Effect.gen(function* () {
    const dir = { path: root, apply: () => Effect.void, revert: () => Effect.void };
    const selector = yield* openWarmRunner(dir, reason => { warnings.push(reason); }, { quiet: true, selectionOnly: true });
    expect(yield* selector.select("value.ts")).toEqual([`${root}/value.test.ts`]);
    expect(ledgerPaths).toHaveLength(1);
    const rows = yield* fs.readFileString(ledgerPaths[0]!);
    expect(rows.trim()).not.toBe("");
    const entry = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, birth: Schema.String })))(rows.trim().split("\n")[0]!);
    expect(entry.pid).toBeGreaterThan(0);
    expect(entry.birth).not.toBe("");
    const other = yield* acquireProcessTree(root);
    yield* other.cleanup;
    expect(yield* selector.select("value.ts")).toEqual([`${root}/value.test.ts`]);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, tracked),
    Effect.provideService(Console.Console, { ...original, warn: (...args: ReadonlyArray<unknown>) => { warnings.push(args.join(" ")); } })
  ));
  expect(warnings).toEqual([]);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);
