import ts from "typescript";
import { expect, it } from "vitest";
import { runtimeBindings, runtimeEditFingerprint, runtimeSyntax } from "../src/RuntimeEdit.ts";

const source = (text: string) => ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
const fingerprint = (expression: string, importSource = "", additions: string[] = []) => runtimeEditFingerprint(expression, additions, runtimeBindings(source(importSource)));

it.each([
  ["f<A>(x as B)", "/* comment */ f<C>(x satisfies D)"],
  ["(x: A, y: B): C => (x as C)", "( x: B, y: A, ): A => x!"],
  ["() => { const x: X = 1; return x }", "() => { type X = number; const x = 1; return x; }"],
  ["({ a: 'x', b: 0x10 })", '( { a: "x", b: 16, } )'],
])("erases type syntax and trivia: %s", (left, right) => expect(fingerprint(left)).toBe(fingerprint(right)));

it.each([
  ["f(1)", "f(2)"],
  ["(a?.b).c", "a?.b.c"],
  ["() => { return\nx; }", "() => { return x; }"],
  ["/a b/.test(x)", "/ab/.test(x)"],
  ["{ a: 1, b: 2 }", "{ b: 2, a: 1 }"],
])("distinguishes runtime expressions: %s", (left, right) => expect(fingerprint(left)).not.toBe(fingerprint(right)));

it("distinguishes used runtime and generated imports, but not unused type imports", () => {
  expect(fingerprint("api.f()", 'import * as api from "one"')).not.toBe(fingerprint("api.f()", 'import * as api from "two"'));
  expect(fingerprint("f()", 'import { f } from "one"')).not.toBe(fingerprint("f()", 'import { g as f } from "one"'));
  expect(fingerprint("f()", 'import type { R } from "one"')).toBe(fingerprint("f()", 'import type { R } from "two"'));
  expect(fingerprint("api.f()", "", ['import * as api from "one"'])).not.toBe(fingerprint("api.f()", "", ['import * as api from "two"']));
});

it("uses original runtime body structure in generated wrappers", () => {
  const wrap = (body: string) => runtimeEditFingerprint("catchTag('x', () => 0)", [], undefined, runtimeSyntax(source(body)));
  expect(wrap("const x: number = 1; run(x)")).toBe(wrap("/* notes */ const x = 1; run(x);"));
  expect(wrap("const x = 1; run(x)")).not.toBe(wrap("const x = 2; run(x)"));
});
