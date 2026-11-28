import ts from "typescript";

const erasedModifiers = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.DeclareKeyword, ts.SyntaxKind.AbstractKeyword, ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.OverrideKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.PrivateKeyword,
]);

export type BindingLookup = (name: string) => readonly string[] | undefined;
type ReferenceLookup = (node: ts.Identifier) => readonly string[] | undefined;

// The reverse enum map has moving range aliases, e.g. FirstLiteralToken.
const kindNames = new Map<number, string>();
for (const [name, value] of Object.entries(ts.SyntaxKind)) {
  if (typeof value === "number" && !/^(?:First|Last)[A-Z]/.test(name) && !kindNames.has(value)) kindNames.set(value, name);
}
const kindName = (node: ts.Node): string => {
  const name = kindNames.get(node.kind);
  if (!name) throw new Error(`Missing runtime syntax name for ${ts.SyntaxKind[node.kind]}`);
  return name;
};

function numericText(node: ts.NumericLiteral): string {
  const raw = node.getText().replaceAll("_", "").toLowerCase();
  if (Math.abs(Number(node.text)) <= Number.MAX_SAFE_INTEGER) return node.text;
  // TypeScript's parser already rounds some unsafe literals in node.text.
  return /^(?:0[xob][\da-f]+|[1-9]\d*)$/.test(raw) ? BigInt(raw).toString() : raw;
}

function importBinding(symbol: ts.Symbol | undefined): readonly string[] | undefined {
  const node = symbol?.declarations?.[0];
  if (!node) return;
  const clause = ts.isImportClause(node) ? node : ts.isNamespaceImport(node) ? node.parent
    : ts.isImportSpecifier(node) && !node.isTypeOnly ? node.parent.parent : undefined;
  if (!clause || clause.isTypeOnly || !ts.isImportDeclaration(clause.parent) || !ts.isStringLiteral(clause.parent.moduleSpecifier)) return;
  return [clause.parent.moduleSpecifier.text, ts.isImportClause(node) ? "default" : ts.isNamespaceImport(node) ? "*"
    : ts.isImportSpecifier(node) ? (node.propertyName ?? node.name).text : ""];
}

function referenceSymbol(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
}

export function sourceReferences(checker: ts.TypeChecker): ReferenceLookup {
  return node => isValueReference(node) ? importBinding(referenceSymbol(node, checker)) : undefined;
}

export function bindingsAt(checker: ts.TypeChecker, site: ts.Node): BindingLookup {
  const cache = new Map<string, readonly string[] | undefined>();
  return name => {
    if (!cache.has(name)) cache.set(name, importBinding(checker.resolveName(name, site, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false)));
    return cache.get(name);
  };
}

/** Parser syntax, not checker display text or emitted JavaScript. Keep token
 * and statement boundaries without a compiler emit for every candidate. */
export function runtimeSyntax(node: ts.Node, bindings?: ReferenceLookup, eraseTypes = true): unknown {
  const syntax = (child: ts.Node) => runtimeSyntax(child, bindings, eraseTypes);
  if (eraseTypes) {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || ts.isExpressionWithTypeArguments(node)) return syntax(node.expression);
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeNode(node)
      || (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword)) return undefined;
    if (ts.isFunctionDeclaration(node) && !node.body) return undefined;
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return undefined;
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "this") return undefined;
  }
  if (ts.isParenthesizedExpression(node) && !ts.isOptionalChain(node.expression)) return syntax(node.expression);
  const kind = kindName(node);
  if (ts.isIdentifier(node)) return [kind, node.text, bindings?.(node)];
  if (ts.isStringLiteral(node)) return [kind, node.text];
  if (ts.isNumericLiteral(node)) return [kind, numericText(node)];
  const source = node.getSourceFile();
  const children = node.getChildren(source);
  if (!children.length) return node.kind < ts.SyntaxKind.FirstNode ? [kind, node.getText(source)] : [kind];
  const typed = node as ts.Node & {
    readonly type?: ts.TypeNode; readonly typeArguments?: ts.NodeArray<ts.TypeNode>;
    readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>; readonly questionToken?: ts.Node; readonly exclamationToken?: ts.Node;
  };
  const typeList = eraseTypes ? typed.typeArguments ?? typed.typeParameters : undefined;
  const keepModifier = (child: ts.Node) => !eraseTypes || (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent)) || !erasedModifiers.has(child.kind);
  return [kind, ...children.filter((child, index) => {
    if (child.kind === ts.SyntaxKind.JSDocComment || (eraseTypes && (child === typed.type || child === typed.questionToken || child === typed.exclamationToken))) return false;
    if (eraseTypes && typed.type && child.kind === ts.SyntaxKind.ColonToken && children[index + 1] === typed.type) return false;
    if (typeList && (child.kind === ts.SyntaxKind.LessThanToken || child.kind === ts.SyntaxKind.GreaterThanToken ||
      (child.kind === ts.SyntaxKind.SyntaxList && child.pos === typeList.pos && child.end === typeList.end))) return false;
    if (child.kind === ts.SyntaxKind.SemicolonToken && !ts.isForStatement(node) && !ts.isEmptyStatement(node)) return false;
    if (child.kind === ts.SyntaxKind.CommaToken && index === children.length - 1) return false;
    return keepModifier(child);
  }).flatMap(child => {
    // SyntaxList is a parser container, not syntax of its own.
    if (child.kind === ts.SyntaxKind.SyntaxList) return child.getChildren(source)
      .filter((item, index, items) => keepModifier(item) && !(item.kind === ts.SyntaxKind.CommaToken && index === items.length - 1))
      .flatMap(item => { const token = syntax(item); return token === undefined ? [] : [token]; });
    const token = syntax(child);
    return token === undefined ? [] : [token];
  })];
}

function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  return !((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
    || ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node)
    && !(ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent));
}

const editCache = new Map<string, { syntax: unknown; free: readonly string[] }>();
const representativeCache = new Map<string, unknown>();
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= 256) cache.clear();
  cache.set(key, value);
  return value;
}
const parse = (expression: string) => ts.createSourceFile("runtime-edit.ts", expression === "{}" ? "{}" : `(${expression})`, ts.ScriptTarget.Latest, true);

function editTemplate(expression: string) {
  const source = parse(expression);
  // Most generated expressions cannot introduce local bindings. Use a
  // standalone checker only for templates that can shadow free names.
  let scoped = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isClassLike(node)
      || ts.isFunctionDeclaration(node) || (ts.isFunctionExpression(node) && node.name)) scoped = true;
    if (!scoped) ts.forEachChild(node, visit);
  };
  visit(source);
  let checker: ts.TypeChecker | undefined;
  if (scoped) {
    const options = { noLib: true, noResolve: true, types: [] };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = name => name === source.fileName ? source : undefined;
    checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
  }
  const free = new Set<string>();
  const syntax = runtimeSyntax(source, node => {
    if (isValueReference(node) && (!checker || !referenceSymbol(node, checker)?.declarations?.length)) {
      free.add(node.text);
      return ["free"];
    }
  });
  return { syntax, free: [...free].sort() };
}

export function runtimeEditFingerprint(expression: string, additions: readonly string[], bindings?: BindingLookup, original?: unknown, representative?: string): string {
  const template = editCache.get(expression) ?? remember(editCache, expression, editTemplate(expression));
  const imports = bindings ? template.free.flatMap(name => {
    const binding = bindings(name);
    return binding ? [[name, binding]] : [];
  }) : [];
  const choice = representative === undefined ? undefined : representativeCache.get(representative)
    ?? remember(representativeCache, representative, runtimeSyntax(parse(representative), undefined, false));
  return JSON.stringify([template.syntax, imports, additions, original, choice]);
}
