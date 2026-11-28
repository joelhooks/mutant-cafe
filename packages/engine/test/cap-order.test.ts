import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { makeTypeScriptOracle } from "../src/TypeScriptOracle.ts";

it.live("caps original tags first and follows declarations through inference, nesting and imports", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const tags = [..."stuvwxyz"];
  const member = (tag: string) => `{ tag: "${tag}", value: number }`;
  const union = (order: string[]) => order.map(member).join(" | ");
  yield* fs.writeFileString(`${root}/a.ts`, tags.slice(0, 4).map(tag => `export type ${tag} = ${member(tag)};`).join("\n"));
  yield* fs.writeFileString(`${root}/b.ts`, tags.slice(4).map(tag => `export type ${tag} = ${member(tag)};`).join("\n"));
  yield* fs.writeFileString(`${root}/choice.ts`, `import type {s,t,u,v} from "./a.js"; import type {w,x,y,z} from "./b.js"; export type Choice = ${tags.join(" | ")};`);
  const reversed = [...tags].reverse();
  yield* fs.writeFileString(`${root}/target.ts`, `
    import type { Choice } from "./choice.js";
    export const external = (value: number): Choice => ({ tag: "w", value });
    type Nested = ${union(reversed)};
    export const nested = (): { inner: Nested } | undefined => undefined;
    export function inferred(value: number) {
      ${reversed.map(tag => `const ${tag} = { tag: "${tag}" as const, value };`).join("\n")}
      return ${reversed.slice(0, -1).map((tag, i) => `value === ${i} ? ${tag} :`).join(" ")} s;
    }
  `);
  const discover = (files: string[], include: string[]) => Effect.gen(function* () {
    yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ files, compilerOptions: { module: "NodeNext", strict: true, skipLibCheck: true } }));
    const result = makeTypeScriptOracle().discover({ root, tsconfig: "tsconfig.json", include, exclude: [], functionFilter: [], jobs: 1,
      timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out" });
    return Object.fromEntries(result.functions.map(fn => [fn.name, "values" in fn.shape ? fn.shape.values.flatMap(value => {
      const tag = /"tag": \("([^"]+)"/.exec(value.text)?.[1];
      return tag ? [tag] : [];
    }) : []]));
  });
  const roots = ["a.ts", "b.ts", "target.ts"];
  const expected = { external: ["w", "s", "t", "u", "v", "x"], nested: ["z"], inferred: ["z", "y", "x", "w", "v", "u"] };
  expect(yield* discover(roots, [])).toEqual(expected);
  expect(yield* discover([...roots].reverse(), ["target.ts"])).toEqual(expected);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);

it.live("promotes the original tag before canonical-text fallback candidates", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  // An inferred union with object declarations in three files has neither an
  // annotated union to rank nor one source file to use for declaration order.
  yield* fs.writeFileString(`${root}/a.ts`, `export const z = { tag: "z" } as const; export const t = { tag: "t" } as const; export const u = { tag: "u" } as const;`);
  yield* fs.writeFileString(`${root}/b.ts`, `export const y = { tag: "y" } as const; export const x = { tag: "x" } as const; export const v = { tag: "v" } as const; export const s = { tag: "s" } as const;`);
  yield* fs.writeFileString(`${root}/target.ts`, `
    import { z, t, u } from "./a.js";
    import { y, x, v, s } from "./b.js";
    export function fallback(n: number) {
      if (n === 0) return { tag: "w" } as const;
      return n === 1 ? z : n === 2 ? y : n === 3 ? x : n === 4 ? v : n === 5 ? u : n === 6 ? t : s;
    }
  `);
  for (const files of [["a.ts", "b.ts", "target.ts"], ["target.ts", "b.ts", "a.ts"]]) {
    yield* fs.writeFileString(`${root}/tsconfig.json`, JSON.stringify({ files, compilerOptions: { module: "NodeNext", strict: true, skipLibCheck: true } }));
    const { functions } = makeTypeScriptOracle().discover({ root, tsconfig: "tsconfig.json", include: ["target.ts"], exclude: [], functionFilter: [], jobs: 1,
      timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out" });
    const shape = functions.find(fn => fn.name === "fallback")?.shape;
    expect(shape && "values" in shape && shape.values.map(value => /"tag": \("([^"]+)"/.exec(value.text)?.[1]))
      .toEqual(["w", "s", "t", "u", "v", "x"]);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000);
