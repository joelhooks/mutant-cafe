import { MutantSource, ProgramLoadError, type Mutant, type NotMutated, type RunConfig, type Viability } from "@mutant-cafe/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { generateFunction } from "./Generate.ts";
import type { TypeOracle } from "./TypeOracle.ts";
import { makeTypeScriptOracle } from "./TypeScriptOracle.ts";

export { makeTypeScriptOracle } from "./TypeScriptOracle.ts";
export type { TypeOracle } from "./TypeOracle.ts";

/** Each layer build owns its warm compiler and original-source cache. */
export const MutantSourceLive: Layer.Layer<MutantSource> = Layer.effect(
  MutantSource,
  Effect.sync(() => makeMutantSource(makeTypeScriptOracle())),
);

export function makeMutantSource(oracle: TypeOracle): MutantSource["Service"] {
  // Discovery results belong to the call, not to the warm compiler. Asking for
  // another selection cannot clear a caller's skips or partially consumed stream.
  const discover = (config: RunConfig) => Effect.try({
    try: () => {
      const discovered = oracle.discover(config);
      const notMutated: NotMutated[] = [...discovered.notMutated];
      const mutants: Mutant[] = [];
      const byId = new Map<string, Mutant>();
      const failed = new Set<typeof discovered.functions[number]>();
      const generatedFunctions = discovered.functions.map(fn => {
        try {
          const iterator = generateFunction(fn);
          const generated: Mutant[] = [];
          let step = iterator.next();
          while (!step.done) { generated.push(step.value); step = iterator.next(); }
          if (step.value) {
            failed.add(fn);
            notMutated.push({ file: fn.file, functionName: fn.name, span: fn.span, reason: step.value });
            return { fn, generated: [] };
          }
          return { fn, generated };
        }
        catch (error) {
          failed.add(fn);
          notMutated.push({ file: fn.file, functionName: fn.name, span: fn.span,
            reason: `analysis failed: ${error instanceof Error ? error.message : String(error)}` });
          return { fn, generated: [] };
        }
      });
      for (const { fn, generated } of generatedFunctions) {
        if (failed.has(fn)) continue;
        {
          const reasons = [...(fn.notices ?? [])];
          if (!generated.length && !reasons.length) reasons.push(fn.skipReason ?? `return not synthesizable (type ${fn.displayReturnType})`);
          const innerMutated = !generated.length && generatedFunctions.some(({ fn: inner, generated }) => inner.file === fn.file && inner.startOffset > fn.startOffset
            && inner.endOffset < fn.endOffset && generated.length > 0);
          if (innerMutated && !generated.length) {
            for (let i = 0; i < reasons.length; i++) if (reasons[i]!.startsWith("return not synthesizable")) reasons[i] += "; inner functions mutated";
          }
          if (reasons.length) notMutated.push({ file: fn.file, functionName: fn.name, span: fn.span, reason: [...new Set(reasons)].join("; ") });
        }
        for (const mutant of generated) {
          const previous = byId.get(mutant.id);
          if (previous) throw new ProgramLoadError({ tsconfig: config.tsconfig, diagnostics: [
            `Duplicate mutant ID ${mutant.id}: ${previous.file}:${previous.span.start.line} ${previous.description}; ${mutant.file}:${mutant.span.start.line} ${mutant.description}`,
          ] });
          byId.set(mutant.id, mutant);
          mutants.push(mutant);
        }
      }
      return { mutants, notMutated: [...new Map(notMutated.map(item => [JSON.stringify(item), item])).values()] };
    },
    catch: (error) => {
      if (Schema.is(ProgramLoadError)(error)) return error;
      // Unexpected outer defects are not config failures. Target analysis is isolated above.
      throw error;
    },
  });
  return {
    notMutated: (config) => discover(config).pipe(Effect.map(result => result.notMutated)),
    generate: (config) => Stream.unwrap(discover(config).pipe(Effect.map(result => Stream.fromIterable(result.mutants)))),
    checkViable: (mutant) => Effect.sync((): Viability => {
      try { return oracle.checkViable(mutant); }
      catch (error) { return { viable: false, diagnostics: [], analysisFailed: {
        file: mutant.file, functionName: mutant.functionName, span: mutant.span,
        reason: `analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      } }; }
    }),
  };
}
