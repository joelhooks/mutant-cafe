import ts from "typescript";
import { expect, it } from "vitest";
import { runtimeEditFingerprint, runtimeSyntax, sourceReferences } from "../src/RuntimeEdit.ts";

const source = (text: string) => ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
const fingerprint = (expression: string, module?: string, additions: string[] = []) => runtimeEditFingerprint(expression, additions, module === undefined ? undefined : () => [module, "*"]);

it("uses concrete kind names, never numeric kinds or enum range aliases", () => {
  const syntax = runtimeSyntax(source('f(1, "2")'));
  expect(JSON.stringify(syntax)).toContain('["NumericLiteral","1"]');
  expect(JSON.stringify(syntax)).toContain('["StringLiteral","2"]');
  expect(JSON.stringify(syntax)).toContain('["OpenParenToken","("]');
  expect(JSON.stringify(syntax)).not.toMatch(/\[\d/);
});

it.each([
  ["f<A>(x as B)", "/* comment */ f<C>(x satisfies D)"],
  ["(x: A, y: B): C => (x as C)", "( x: B, y: A, ): A => x!"],
  ["() => { const x: X = 1; return x }", "() => { type X = number; const x = 1; return x; }"],
  ["({ a: 'x', b: 0x10 })", '( { a: "x", b: 16, } )'],
])("erases type syntax and trivia: %s", (left, right) => expect(fingerprint(left)).toBe(fingerprint(right)));

it.each([
  ["f(1)", "f(2)"],
  ["f(9_007_199_254_740_992)", "f(9_007_199_254_740_993)"],
  ["(a?.b).c", "a?.b.c"],
  ["() => { return\nx; }", "() => { return x; }"],
  ["/a b/.test(x)", "/ab/.test(x)"],
  ["{ a: 1, b: 2 }", "{ b: 2, a: 1 }"],
])("distinguishes runtime expressions: %s", (left, right) => expect(fingerprint(left)).not.toBe(fingerprint(right)));

it("distinguishes used runtime and generated imports, but not unused type imports", () => {
  expect(fingerprint("api.f()", "one")).not.toBe(fingerprint("api.f()", "two"));
  expect(fingerprint("api.f()", undefined, ['import * as api from "one"'])).not.toBe(fingerprint("api.f()", undefined, ['import * as api from "two"']));
});

it("only fingerprints imports reached by actual value references", () => {
  const edit = (code: string, module: string) => runtimeEditFingerprint(code, [], name => name === "f" ? [module, "f"] : undefined);
  const original = (code: string, module: string) => {
    const file = source(`import { f, type T } from '${module}';\n${code}`);
    const options = { noLib: true, noResolve: true, types: [] };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = name => name === file.fileName ? file : undefined;
    const checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
    return runtimeSyntax(file.statements[1]!, sourceReferences(checker));
  };
  for (const code of ["x.f()", "(f: () => void) => f()", "({ f: 0 })", "(x: T) => x"]) {
    expect(edit(code, "one")).toBe(edit(code, "two"));
    expect(original(code, "one")).toEqual(original(code, "two"));
  }
  for (const code of ["f()", "({ f })", "() => f()", "x[f]"]) {
    expect(edit(code, "one")).not.toBe(edit(code, "two"));
    expect(original(code, "one")).not.toEqual(original(code, "two"));
  }
});

it("discriminates representatives even when their runtime edits are equal", () => {
  const edit = (value: string) => runtimeEditFingerprint(`Effect.succeed(${value})`, [], undefined, undefined, value);
  expect(edit("Option.none<A>()")).not.toBe(edit("Option.none<B>()"));
  expect(edit("x as A")).not.toBe(edit("x satisfies A"));
  expect(edit("Option.none<A>()")).toBe(edit(" Option.none< A >() /* trivia */"));
});

it("uses original runtime body structure in generated wrappers", () => {
  const wrap = (body: string) => runtimeEditFingerprint("catchTag('x', () => 0)", [], undefined, runtimeSyntax(source(body)));
  expect(wrap("const x: number = 1; run(x)")).toBe(wrap("/* notes */ const x = 1; run(x);"));
  expect(wrap("const x = 1; run(x)")).not.toBe(wrap("const x = 2; run(x)"));
});
