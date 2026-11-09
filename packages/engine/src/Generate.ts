// A content digest is pure synchronous work; Effect 4.1.2 has no Crypto module.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import ts from "typescript";
import type { Genre, Mutant } from "@mutant-cafe/core";
import type { MutableFunction, Value } from "./TypeOracle.ts";

/** Generate from the oracle description; deferred compiler checks stay behind its port. */
export function* generateFunction(fn: MutableFunction): Generator<Mutant, string | undefined> {
  const issue = fn.generationIssue?.();
  if (issue) return issue;
  const api = fn.api;
  const candidate = (genre: Genre, expression: string, value: Value = { text: "", synthetic: false }, description = expression): Mutant => {
    // A return annotation on the inner function preserves the public inferred
    // contract, even when this replacement only produces never or Option<never>.
    const pinned = `((): ${fn.returnType} => (${expression}))()`;
    const text = fn.block
      ? `{ return ${fn.generator ? "yield* " : ""}${pinned}; }`
      : `(${pinned})`;
    return makeMutant(fn, genre, text, value.synthetic, description);
  };
  const shape = fn.shape;
  const fits = (value: Value): boolean => new TextEncoder().encode(value.text).byteLength <= 2048;
  const values = "values" in shape ? shape.values.filter(fits) : [];
  switch (shape.kind) {
    case "Effect": {
      const succeed = api("Effect", "succeed");
      if (succeed) {
        for (const value of values) {
          if (!fn.equivalentValues.includes(value.text) && !(fn.generator && value.text === fn.literal)) yield candidate("EffectSucceed", `${succeed}(${value.text})`, value);
        }
      }
      const fail = api("Effect", "fail");
      const catchTag = api("Effect", "catchTag");
      for (const error of shape.errors) {
        if (fail && fits(error)) yield candidate("EffectFail", `${fail}(${error.text})`, error, `${fail}(${error.text}) [${error.synthetic ? "synthetic tag cast" : "constructed error"}]`);
        const recoveries: ReadonlyArray<Value | undefined> = values.length
          ? shape.enumerateRecoveries ? values : values.slice(0, 1)
          : [undefined];
        // Evaluate the original body, rather than replacing its error path with an unconditional failure.
        const gen = api("Effect", "gen");
        const original = fn.generator
          ? gen && `((): ${fn.returnType} => ${gen}(function* () ${fn.original}))()`
          : fn.block ? `((): ${fn.returnType} => ${fn.original})()` : `((): ${fn.returnType} => (${fn.original}))()`;
        for (const value of recoveries) {
          const die = api("Effect", "die");
          const recovery = value && succeed ? `${succeed}(${value.text})`
            : die ? `${die}(${JSON.stringify(`mutant.cafe: swallowed ${error.tag}`)})` : undefined;
          if (catchTag && recovery && original) {
            yield candidate(value ? "SwallowTag" : "TagToDefect", `${original}.pipe(${catchTag}(${JSON.stringify(error.tag)}, () => ${recovery}))`, value, value ? `body.pipe(${catchTag}(${JSON.stringify(error.tag)}, () => ${recovery}))` : `turn ${error.tag} into a defect`);
          }
        }
      }
      const die = api("Effect", "die");
      if (die) yield candidate("EffectDie", `${die}("mutant.cafe")`);
      const never = api("Effect", "never");
      if (never) yield candidate("EffectNever", never);
      break;
    }
    case "Option": {
      const none = api("Option", "none");
      const some = api("Option", "some");
      if (none) yield candidate("OptionNone", `${none}()`);
      if (some) for (const value of values) yield candidate("OptionSome", `${some}(${value.text})`, value);
      break;
    }
    case "Stream": {
      const empty = api("Stream", "empty");
      const make = api("Stream", "make");
      const fail = api("Stream", "fail");
      if (empty) yield candidate("StreamEmpty", empty);
      if (make) for (const value of values) yield candidate("StreamOne", `${make}(${value.text})`, value);
      if (fail) for (const error of shape.errors) if (fits(error)) yield candidate("StreamFail", `${fail}(${error.text})`, error);
      break;
    }
    case "Layer": {
      const layer = api("Layer", "effectContext");
      const fail = api("Effect", "fail");
      const die = api("Effect", "die");
      if (layer && die) yield candidate("LayerDie", `${layer}(${die}("mutant.cafe"))`);
      if (layer && fail) {
        // Layer output is contravariant. Let the pinned return type infer the
        // complete output context, not just the first service found in the body.
        for (const error of shape.errors) if (fits(error)) yield candidate("LayerFail", `${layer}(${fail}(${error.text}))`, error);
      }
      break;
    }
    case "Void":
      yield makeMutant(fn, "FnValue", "{}", false, "an empty body");
      break;
    default: {
      const genre = shape.kind === "Boolean" ? "BooleanFlip" : shape.kind === "Literal" ? "LiteralCycle" : "FnValue";
      for (const value of values) {
        if (value.text === fn.literal) continue;
        yield candidate(genre, value.text, value);
      }
    }
  }
}

function makeMutant(fn: MutableFunction, genre: Genre, text: string, synthetic: boolean, description: string): Mutant {
  const additions = fn.extraImports?.filter(item => text.includes(`${item.namespace}.`)) ?? [];
  const prefix = fn.sourcePrefix ?? "";
  const insertion = fn.importInsertionOffset ?? 0;
  const replacement = additions.length && fn.sourcePrefix !== undefined
    ? { startOffset: 0, endOffset: fn.endOffset, text: prefix.slice(0, insertion) + (insertion ? "\n" : "") + additions.map(item => item.statement).join("\n") + "\n" + prefix.slice(insertion) + text }
    : { startOffset: fn.startOffset, endOffset: fn.endOffset, text };
  // Identity describes the logical edit, never the physical prefix retained to
  // insert imports. Source line shifts above a binding do not retarget its id.
  const runtime = ts.transpileModule(`${additions.map(item => item.statement).join("\n")}\nasync function* mutation() { ${text} }`, {
    fileName: fn.file,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, removeComments: true, verbatimModuleSyntax: true },
  }).outputText;
  const id = createHash("sha256").update(JSON.stringify([fn.identityFile ?? fn.file, fn.name, fn.identityOrdinal ?? 0, fn.logicalSpan, genre, runtime])).digest("hex").slice(0, 24);
  return {
    id, file: fn.file, functionName: fn.name, returnType: fn.returnType, displayReturnType: fn.displayReturnType, genre,
    description: `replace ${fn.name} -> ${fn.returnType} with ${description}`,
    span: fn.span, replacement, synthetic,
  };
}
