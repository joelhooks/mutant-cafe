import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import type { RunConfig } from "@mutant-cafe/core";
import { generateFunction } from "../src/Generate.ts";
import { makeTypeScriptOracle } from "../src/TypeScriptOracle.ts";
import type { MutableFunction } from "../src/TypeOracle.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const config = (): RunConfig => ({
  root, tsconfig: "packages/engine/test/fixtures/identity/tsconfig.json",
  include: ["packages/engine/test/fixtures/identity/src/identity.ts"], exclude: [], functionFilter: [], jobs: 1,
  timeoutMultiplier: 5, minimumTimeoutMs: 20_000, neverTimeoutMs: 100, outDir: "mutants.out",
});

const discover = () => makeTypeScriptOracle().discover(config()).functions
  .filter(fn => fn.name === "target").flatMap(fn => [...generateFunction(fn)]);

const erased = (text: string) => ts.transpileModule(`async function* mutation() { ${text} }`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;

describe("runtime mutation identity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not change an ID when discovery only changes union annotation order", () => {
    const fullMutants = discover();
    const read = ts.sys.readFile;
    vi.spyOn(ts.sys, "readFile").mockImplementation((file, encoding) => {
      const text = read(file, encoding);
      return file.replaceAll("\\", "/").endsWith("/identity/src/identity.ts") ? text?.replace("First | Second", "Second | First") : text;
    });
    const targetedMutants = discover();
    const full = fullMutants.find(mutant => mutant.genre === "EffectDie");
    const targeted = targetedMutants.find(mutant => mutant.genre === "EffectDie");
    expect(full).toBeDefined();
    expect(targeted).toBeDefined();
    expect(full!.replacement.text).not.toBe(targeted!.replacement.text);
    expect(full!.span).toEqual(targeted!.span);
    expect(erased(full!.replacement.text)).toBe(erased(targeted!.replacement.text));
    expect(full!.id).toBe(targeted!.id);
    const operator = (description: string) => description.replace(/ -> .*? with /u, " with ");
    const indexed = new Map(targetedMutants.map(mutant => [operator(mutant.description), mutant]));
    expect(new Set(fullMutants.map(mutant => mutant.id)).size).toBe(fullMutants.length);
    expect(indexed.size).toBe(fullMutants.length);
    for (const mutant of fullMutants) {
      const counterpart = indexed.get(operator(mutant.description));
      expect(counterpart).toBeDefined();
      expect(erased(counterpart!.replacement.text)).toBe(erased(mutant.replacement.text));
      expect(counterpart!.id).toBe(mutant.id);
    }
  });

  it("keeps context and runtime import differences without hashing physical line shifts", () => {
    const fn = makeTypeScriptOracle().discover(config()).functions.find(fn => fn.name === "target")!;
    const die = (input: MutableFunction) => [...generateFunction(input)].find(mutant => mutant.genre === "EffectDie")!;
    const original = die(fn);
    expect(die({ ...fn, identityFile: "src/other.ts" }).id).not.toBe(original.id);
    expect(die({ ...fn, name: "other" }).id).not.toBe(original.id);
    expect(die({ ...fn, identityOrdinal: (fn.identityOrdinal ?? 0) + 1 }).id).not.toBe(original.id);
    expect(die({ ...fn, startOffset: fn.startOffset + 100, endOffset: fn.endOffset + 100,
      span: { start: { ...fn.span.start, line: fn.span.start.line + 2 }, end: { ...fn.span.end, line: fn.span.end.line + 2 } },
    }).id).toBe(original.id);
    const imported = (moduleName: string): MutableFunction => ({
      ...fn,
      api: (module, member) => `__mutation_${module}.${member}`,
      extraImports: [{ namespace: "__mutation_Effect", statement: `import * as __mutation_Effect from ${JSON.stringify(moduleName)};` }],
    });
    expect(die(imported("effect/Effect")).id).not.toBe(die(imported("another-effect")).id);
  });
});
