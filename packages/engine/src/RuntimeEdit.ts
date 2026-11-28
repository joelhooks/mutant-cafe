import ts from "typescript";

const erasedModifiers = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.DeclareKeyword, ts.SyntaxKind.AbstractKeyword, ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.OverrideKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.PrivateKeyword,
]);

type Bindings = ReadonlyMap<string, readonly string[]>;

/** Runtime syntax, not checker display text or emitted JavaScript. The syntax
 * tree preserves statement boundaries and regex/template tokens without a
 * compiler emit for every candidate. */
export function runtimeSyntax(node: ts.Node, bindings?: Bindings): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return runtimeSyntax(node.expression, bindings);
  }
  if (ts.isExpressionWithTypeArguments(node)) return runtimeSyntax(node.expression, bindings);
  if (ts.isParenthesizedExpression(node) && !ts.isOptionalChain(node.expression)) return runtimeSyntax(node.expression, bindings);
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeNode(node)
    || (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword)) return undefined;
  if (ts.isFunctionDeclaration(node) && !node.body) return undefined;
  if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return undefined;
  if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "this") return undefined;
  if (ts.isIdentifier(node)) return [node.kind, node.text, bindings?.get(node.text)];
  if (ts.isStringLiteral(node)) return [node.kind, node.text];
  if (ts.isNumericLiteral(node)) return [node.kind, Number(node.text)];
  const source = node.getSourceFile();
  const children = node.getChildren(source);
  if (!children.length) return node.kind < ts.SyntaxKind.FirstNode ? [node.kind, node.getText(source)] : [node.kind];
  const typed = node as ts.Node & {
    readonly type?: ts.TypeNode; readonly typeArguments?: ts.NodeArray<ts.TypeNode>;
    readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>; readonly questionToken?: ts.Node; readonly exclamationToken?: ts.Node;
  };
  const typeList = typed.typeArguments ?? typed.typeParameters;
  const parameterProperty = ts.isParameter(node) && ts.isConstructorDeclaration(node.parent);
  return [node.kind, ...children.filter((child, index) => {
    if (child.kind === ts.SyntaxKind.JSDocComment || child === typed.type || child === typed.questionToken || child === typed.exclamationToken) return false;
    if (typed.type && child.kind === ts.SyntaxKind.ColonToken && children[index + 1] === typed.type) return false;
    if (typeList && (child.kind === ts.SyntaxKind.LessThanToken || child.kind === ts.SyntaxKind.GreaterThanToken ||
      (child.kind === ts.SyntaxKind.SyntaxList && child.pos === typeList.pos && child.end === typeList.end))) return false;
    if (child.kind === ts.SyntaxKind.SemicolonToken && !ts.isForStatement(node) && !ts.isEmptyStatement(node)) return false;
    if (child.kind === ts.SyntaxKind.CommaToken && index === children.length - 1) return false;
    return parameterProperty || !erasedModifiers.has(child.kind);
  }).flatMap(child => {
    // SyntaxList is a parser container, not syntax of its own.
    if (child.kind === ts.SyntaxKind.SyntaxList) return child.getChildren(source)
      .filter((item, index, items) => (parameterProperty || !erasedModifiers.has(item.kind)) && !(item.kind === ts.SyntaxKind.CommaToken && index === items.length - 1))
      .flatMap(item => { const token = runtimeSyntax(item, bindings); return token === undefined ? [] : [token]; });
    const token = runtimeSyntax(child, bindings);
    return token === undefined ? [] : [token];
  })];
}

export function runtimeBindings(source: ts.SourceFile): Bindings {
  const bindings = new Map<string, readonly string[]>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const module = statement.moduleSpecifier.text;
    if (clause.name) bindings.set(clause.name.text, [module, "default"]);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, [module, "*"]);
    if (named && ts.isNamedImports(named)) for (const item of named.elements) {
      if (!item.isTypeOnly) bindings.set(item.name.text, [module, item.propertyName?.text ?? item.name.text]);
    }
  }
  return bindings;
}

// Common generated values repeat across large projects. Bound the cache and
// don't retain source files, original bodies or project-specific imports.
const bareEdits = new Map<string, string>();

export function runtimeEditFingerprint(expression: string, additions: readonly string[], bindings?: Bindings, original?: unknown): string {
  const canCache = !bindings?.size;
  let syntax = canCache ? bareEdits.get(expression) : undefined;
  if (syntax === undefined) {
    const source = ts.createSourceFile("runtime-edit.ts", expression === "{}" ? "{}" : `(${expression})`, ts.ScriptTarget.Latest, true);
    syntax = JSON.stringify(runtimeSyntax(source, bindings));
    if (canCache) {
      if (bareEdits.size >= 256) bareEdits.clear();
      bareEdits.set(expression, syntax);
    }
  }
  return JSON.stringify([syntax, additions, original]);
}
