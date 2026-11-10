// Compiler-host boundary: TS requires synchronous native paths; matchesGlob has no Effect Path equivalent.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, resolve, relative, matchesGlob } from "node:path";
import ts from "typescript";
import { ProgramLoadError, type Mutant, type NotMutated, type RunConfig, type Viability } from "@mutant-cafe/core";
import type { MutableFunction, ReturnShape, TaggedValue, TypeOracle, Value } from "./TypeOracle.ts";

type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
type Family = "Effect" | "Option" | "Stream" | "Layer";

const diagnosticsText = (items: ReadonlyArray<ts.Diagnostic>): string[] => items.map((d) => {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return `TS${d.code}: ${message}`;
  const position = d.file.getLineAndCharacterOfPosition(d.start);
  return `${d.file.fileName}:${position.line + 1}:${position.character + 1} TS${d.code}: ${message}`;
});

class ProgramSession {
  readonly host: ts.CompilerHost;
  readonly originals = new Map<string, ts.SourceFile>();
  program: ts.Program;
  overlay: { file: string; text: string } | undefined;

  readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText([config.error]) });
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."));
    if (parsed.errors.length) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText(parsed.errors) });
    this.host = ts.createCompilerHost(parsed.options, true);
    const read = this.host.getSourceFile;
    this.host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
      const absolute = resolve(file);
      if (this.overlay?.file === absolute) return ts.createSourceFile(file, this.overlay.text, languageVersion, true);
      const cached = this.originals.get(absolute);
      if (cached) return cached;
      const source = read(file, languageVersion, onError, shouldCreateNewSourceFile);
      if (source) this.originals.set(absolute, source);
      return source;
    };
    this.program = ts.createProgram(parsed.fileNames, parsed.options, this.host);
    const errors = [...this.program.getOptionsDiagnostics(), ...this.program.getSyntacticDiagnostics()];
    if (errors.length) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText(errors) });
  }

  check(mutant: Mutant): Viability {
    const file = resolve(mutant.file);
    const source = this.originals.get(file);
    if (!source) return { viable: false, diagnostics: [], analysisFailed: { file: mutant.file, functionName: mutant.functionName, span: mutant.span, reason: "analysis failed: source file was not loaded" } };
    const { startOffset, endOffset, text } = mutant.replacement;
    if (startOffset < 0 || endOffset < startOffset || endOffset > source.text.length) {
      return { viable: false, diagnostics: ["Replacement offsets are outside the original file"] };
    }
    const analysisFailed = (reason: string): Viability => ({ viable: false, diagnostics: [],
      analysisFailed: { file: mutant.file, functionName: mutant.functionName, span: mutant.span, reason } });
    this.overlay = { file, text: source.text.slice(0, startOffset) + text + source.text.slice(endOffset) };
    try {
      const mutated = ts.createProgram({ rootNames: this.program.getRootFileNames(), options: this.program.getCompilerOptions(), host: this.host, oldProgram: this.program });
      const changed = mutated.getSourceFile(file);
      if (!changed) throw new Error(`Mutated source not found: ${file}`);
      const issue = typedCallIssue(changed, mutated.getTypeChecker(), true);
      if (issue) return analysisFailed(issue);
      const diagnostics = [...mutated.getSyntacticDiagnostics(changed), ...mutated.getSemanticDiagnostics(changed)];
      return { viable: diagnostics.length === 0, diagnostics: diagnosticsText(diagnostics) };
    } catch (error) {
      return analysisFailed(`analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.overlay = undefined;
    }
  }
}

/** TS 6 is intentionally a runtime analysis dependency, not the workspace compiler. */
export function makeTypeScriptOracle(): TypeOracle {
  const sessions = new Map<string, ProgramSession>();
  const owners = new Map<string, ProgramSession>();
  return {
    discover(config) {
      const notMutated: NotMutated[] = [];
      const functions: MutableFunction[] = [];
      const configPath = resolve(config.root, config.tsconfig);
      let session = sessions.get(configPath);
      if (!session) {
        session = new ProgramSession(configPath);
        sessions.set(configPath, session);
      }
      const checker = session.program.getTypeChecker();
      const matched = new Set<string>();
      for (const source of session.program.getSourceFiles()) {
        const file = resolve(source.fileName);
        const local = relative(config.root, file).replaceAll("\\", "/");
        // Test support lives beside the project, so judge it relative to the tsconfig.
        const project = relative(dirname(configPath), file).replaceAll("\\", "/");
        if (source.isDeclarationFile || local.startsWith("../") || /(?:^|\/)(?:node_modules|__tests__|__mocks__|tests?)\//.test(project) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(local)) continue;
        for (const glob of config.include) if (matchesGlob(local, glob)) matched.add(glob);
        if (config.include.length && !config.include.some((glob) => matchesGlob(local, glob))) continue;
        if (config.exclude.some((glob) => matchesGlob(local, glob))) continue;
        owners.set(file, session);
        const api = imports(source);
        const excluded = new Set<ts.Node>();
        const visit = (node: ts.Node): void => {
          try {
            if (isFunction(node) && node.body && !mutable(node, checker)) {
              if (!ts.findAncestor(node.parent, parent => excluded.has(parent))) notMutated.push({ file, functionName: `${functionName(node, checker)}.<callback>`, span: nodeSpan(node), reason: "callback position (not mutated yet)" });
            }
            if (isFunction(node) && node.body && mutable(node, checker)) {
              const name = functionName(node, checker);
              const reason = skipped(node) ? "excluded by @mutants-skip"
                : config.exportedOnly && !publicOwner(node, checker) ? "excluded by --exported-only"
                : config.functionFilter.length && !config.functionFilter.some(filter => matchesGlob(name, filter)) ? "excluded by function filter"
                : undefined;
              if (reason) { excluded.add(node); notMutated.push({ file, functionName: name, span: nodeSpan(node.body), reason }); }
              if (!reason && (!config.functionFilter.length || config.functionFilter.some((filter) => matchesGlob(name, filter)))) {
                const signature = checker.getSignatureFromDeclaration(node);
                if (signature) {
                  const wrapped = wrappedEffect(node, checker);
                  const type = wrapped ?? checker.getReturnTypeOfSignature(signature);
                  const generator = wrapped && ts.isFunctionExpression(node) ? node : generatorBody(node, checker);
                  const body = generator?.body ?? node.body;
                  const start = body.getStart(source);
                  const end = body.getEnd();
                  const a = source.getLineAndCharacterOfPosition(start);
                  const b = source.getLineAndCharacterOfPosition(end);
                  const beforePipeables = wrapped && ts.isFunctionExpression(node) ? generatorContract(node, checker) : undefined;
                  const shape = beforePipeables?.shape ?? shapeOf(type, checker, node, body);
                  const originals = equivalentSuccessValues(body, api);
                  if ((!beforePipeables && (type.flags & ts.TypeFlags.TypeParameter) && !("values" in shape && shape.values.length)) || (beforePipeables ? !nameableContract(beforePipeables, checker, node) : hasUnnameableType(type, checker, node))) {
                    notMutated.push({ file, functionName: name, span: nodeSpan(node), reason: "generic: naked or context-only type-parameter return" });
                  } else found.push({
                    file, name, functionLike: true, functionSpan: nodeSpan(body), generationIssue: () => typedCallIssue(body, checker), notices: shapeNotices(shape, type, checker, node), returnType: beforePipeables?.text ?? returnTypeText(type, checker, node),
                    displayReturnType: node.type?.getText(source) ?? checker.typeToString(type, node),
                    skipReason: beforePipeables ? `no synthesizable generator success value: ${beforePipeables.text}` : synthesisReason(type, checker, node),
                    equivalentValues: shape.kind === "Effect" ? shape.values.filter((value) => isEquivalentSuccess(value.text, originals)).map((value) => value.text) : [],
                    span: { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } },
                    startOffset: start, endOffset: end, original: body.getText(source),
                    identityFile: local, logicalSpan: { offset: start - node.getStart(source), length: end - start },
                    sourcePrefix: source.text.slice(0, start), importInsertionOffset: importInsertionOffset(source), extraImports: mutationImports(source),
                    literal: literalOfBody(body, checker),
                    block: ts.isBlock(body), generator: generator !== undefined,
                    shape, api,
                  });
                } else notMutated.push({ file, functionName: name, span: nodeSpan(node), reason: "missing callable signature" });
              }
            }
            // A Layer value is a buildable program even when it is not a function.
            if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) {
              const type = checker.getTypeAtLocation(node.initializer);
              if (family(type, checker)?.kind === "Layer") {
                const name = valuePath(node);
                const reason = skippedNode(node) ? "excluded by @mutants-skip"
                  : config.exportedOnly && !publicOwner(node, checker) ? "excluded by --exported-only"
                  : config.functionFilter.length && !config.functionFilter.some(filter => matchesGlob(name, filter)) ? "excluded by function filter" : undefined;
                if (reason) { excluded.add(node.initializer); notMutated.push({ file, functionName: name, span: nodeSpan(node.initializer), reason }); }
                if (!reason) {
                  const body = node.initializer;
                  const a = source.getLineAndCharacterOfPosition(body.getStart(source));
                  const b = source.getLineAndCharacterOfPosition(body.getEnd());
                  found.push({ file, name, functionLike: false, generationIssue: () => typedCallIssue(body, checker), notices: shapeNotices(shapeOf(type, checker, node, body), type, checker, node), returnType: returnTypeText(type, checker, node), displayReturnType: checker.typeToString(type, node),
                    equivalentValues: [], span: { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } },
                    startOffset: body.getStart(source), endOffset: body.getEnd(), original: body.getText(source), literal: undefined,
                    identityFile: local, logicalSpan: { offset: body.getStart(source) - node.getStart(source), length: body.getWidth(source) },
                    sourcePrefix: source.text.slice(0, body.getStart(source)), importInsertionOffset: importInsertionOffset(source), extraImports: mutationImports(source),
                    block: false, generator: false, shape: shapeOf(type, checker, node, body), api });
                }
              }
            }
          } catch (error) {
            // Source analysis is best-effort. A single checker hole must not masquerade as a config failure.
            const target = isFunction(node) ? node.body
              : (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) ? node.initializer : undefined;
            if (target) notMutated.push({ file, functionName: valuePath(node), span: nodeSpan(target),
              reason: `analysis failed: ${error instanceof Error ? error.message : String(error)}` });
          }
          ts.forEachChild(node, visit);
        };
        const found: MutableFunction[] = [];
        visit(source);
        const occurrences = new Map<string, number>();
        for (const fn of found) {
          const ordinal = occurrences.get(fn.name) ?? 0;
          occurrences.set(fn.name, ordinal + 1);
          functions.push({ ...fn, identityOrdinal: ordinal });
        }
      }
      const unmatched = config.include.filter((glob) => !matched.has(glob));
      if (unmatched.length) throw new ProgramLoadError({ tsconfig: configPath, reason: "selection", diagnostics: unmatched.map((glob) => {
        const target = relative(config.root, resolve(config.root, glob));
        const outside = target === ".." || target.startsWith("../");
        return `No source file matched ${JSON.stringify(glob)}${outside ? " (path is outside the package root)" : ""}`;
      }) });
      return { functions, notMutated: [...new Map(notMutated.map(item => [JSON.stringify(item), item])).values()] };
    },
    checkViable(mutant) {
      const session = owners.get(resolve(mutant.file));
      if (!session) return { viable: false, diagnostics: [], analysisFailed: { file: mutant.file, functionName: mutant.functionName, span: mutant.span, reason: "analysis failed: generate mutants before checking viability" } };
      return session.check(mutant);
    },
  };
}

function typedCallIssue(body: ts.Node, checker: ts.TypeChecker, includeNested = false): string | undefined {
  let issue: string | undefined;
  const visit = (node: ts.Node): void => {
    if (isFunction(node) && !includeNested) return; // Nested implementations have their own discovery boundary.
    if (ts.isCallExpression(node) && node.typeArguments?.length) {
      const signature = checker.getResolvedSignature(node);
      // Unresolved imports and any-typed receivers may produce a synthetic signature with no declaration.
      // A missing declaration is data, not an exception manufactured to exercise a catch.
      if (!signature || (!signature.declaration && checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.Any)) {
        issue = `analysis failed: compiler supplied no declaration for typed call ${node.expression.getText()}; check its import or receiver type`;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return issue;
}

function nodeSpan(node: ts.Node): Mutant["span"] {
  const source = node.getSourceFile();
  const a = source.getLineAndCharacterOfPosition(node.getStart(source));
  const b = source.getLineAndCharacterOfPosition(node.getEnd());
  return { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } };
}

function isFunction(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}


function functionValue(node: FunctionNode, checker: ts.TypeChecker): ts.Node {
  const wrapper = wrappedEffect(node, checker);
  // A generator passed to Effect.gen is an implementation, not a curried value.
  return wrapper && checker.getTypeAtLocation(node.parent).getCallSignatures().length ? node.parent : node;
}

function returnedBy(node: FunctionNode, checker: ts.TypeChecker): FunctionNode | undefined {
  let value = functionValue(node, checker);
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  const parent = value.parent;
  if (ts.isArrowFunction(parent) && parent.body === value) return parent;
  if (ts.isReturnStatement(parent) && parent.expression === value && ts.isBlock(parent.parent) && isFunction(parent.parent.parent)) return parent.parent.parent;
  return undefined;
}

function mutable(node: FunctionNode, checker: ts.TypeChecker): boolean {
  if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) return true;
  let current: ts.Node = wrappedEffect(node, checker) ? node.parent : node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return returnedBy(node, checker) !== undefined || ((ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent) || ts.isPropertyDeclaration(current.parent)) && current.parent.initializer === current);
}

function layerBody(boundary: FunctionNode, checker: ts.TypeChecker): boolean {
  let enclosing: ts.Node = boundary.parent;
  while (!ts.isSourceFile(enclosing) && !isFunction(enclosing)) {
    if (ts.isCallExpression(enclosing) && family(checker.getTypeAtLocation(enclosing), checker)?.kind === "Layer") return true;
    enclosing = enclosing.parent;
  }
  return false;
}

function returnsLayer(node: FunctionNode, checker: ts.TypeChecker): boolean {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return false;
  const type = checker.getReturnTypeOfSignature(signature);
  return (type.isUnion() ? type.types : [type]).every(member => family(member, checker)?.kind === "Layer");
}

function serviceProperty(node: ts.Node, boundary: FunctionNode, checker: ts.TypeChecker): boolean {
  if (!(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) || !ts.isObjectLiteralExpression(node.parent)) return false;
  const object = node.parent;
  const call = object.parent;
  return ts.isCallExpression(call) && call.arguments[0] === object
    && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "of"
    && ts.isReturnStatement(call.parent) && call.parent.parent === boundary.body && layerBody(boundary, checker);
}

function serviceMethod(node: FunctionNode, boundary: FunctionNode, checker: ts.TypeChecker): boolean {
  if (!layerBody(boundary, checker) || !boundary.body) return false;
  const declaration = ts.findAncestor(node, ts.isVariableDeclaration);
  let returned = false;
  const visit = (child: ts.Node): void => {
    if (isFunction(child)) return;
    if (ts.isReturnStatement(child) && child.expression && ts.isCallExpression(child.expression)) {
      const call = child.expression;
      const object = call.arguments[0];
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "of" && object && ts.isObjectLiteralExpression(object)) {
        returned ||= object.properties.some(prop => {
          if (ts.isPropertyAssignment(prop) && (prop.initializer === functionValue(node, checker)
            || (declaration && ts.isIdentifier(prop.initializer) && checker.getSymbolAtLocation(prop.initializer)?.valueDeclaration === declaration))) return true;
          if (ts.isShorthandPropertyAssignment(prop)) return checker.getShorthandAssignmentValueSymbol(prop)?.valueDeclaration === declaration;
          return false;
        });
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(boundary.body);
  return returned;
}

function exportedBinding(binding: ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration, checker: ts.TypeChecker): boolean {
  let declaration: ts.Declaration = binding;
  let symbol = binding.name ? checker.getSymbolAtLocation(binding.name) : undefined;
  let container = ts.findAncestor(binding, node => ts.isSourceFile(node) || ts.isModuleBlock(node));
  while (container) {
    const module = ts.isSourceFile(container) ? checker.getSymbolAtLocation(container)
      : ts.isModuleBlock(container) && ts.isModuleDeclaration(container.parent) ? checker.getSymbolAtLocation(container.parent.name) : undefined;
    if (!module || !checker.getExportsOfModule(module).some(item => {
      const target = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
      return target === symbol || target.valueDeclaration === declaration;
    })) return false;
    if (ts.isSourceFile(container)) return true;
    if (!ts.isModuleBlock(container) || !ts.isModuleDeclaration(container.parent)) return false;
    declaration = container.parent;
    symbol = module;
    container = ts.findAncestor(container.parent, node => ts.isSourceFile(node) || ts.isModuleBlock(node));
  }
  return false;
}

function publicOwner(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  let current = node;
  let binding: ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration | undefined;
  let value = isFunction(node) ? node : undefined;
  let throughService = false;
  while (!ts.isSourceFile(current)) {
    if (current !== node && isFunction(current)) {
      const method = value ? serviceMethod(value, current, checker) : serviceProperty(node, current, checker);
      if (!(value && returnedBy(value, checker) === current) && !method && !(throughService && returnsLayer(current, checker))) return false;
      throughService ||= method;
      value = current;
    }
    if (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) binding = current;
    current = current.parent;
  }
  if (!binding) return false;
  if (exportedBinding(binding, checker)) return true;
  // Follow value bindings (including shorthand aliases), not calls from an
  // exported implementation. Calling a helper does not make it a public path.
  let exposed = false;
  const declaration = binding;
  const visit = (child: ts.Node): void => {
    if (exposed) return;
    const referenced = ts.isShorthandPropertyAssignment(child) ? checker.getShorthandAssignmentValueSymbol(child)
      : ts.isPropertyAssignment(child) && ts.isIdentifier(child.initializer) ? checker.getSymbolAtLocation(child.initializer)
      : ts.isExportAssignment(child) && ts.isIdentifier(child.expression) ? checker.getSymbolAtLocation(child.expression) : undefined;
    if (referenced?.valueDeclaration === declaration) {
      exposed = ts.isExportAssignment(child) || publicOwner(child, checker, seen);
    }
    ts.forEachChild(child, visit);
  };
  visit(current);
  return exposed;
}

function skipped(node: FunctionNode): boolean { return skippedNode(node); }
function skippedNode(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (!ts.isSourceFile(current)) {
    if (ts.getJSDocTags(current).some((tag) => tag.tagName.text === "mutants-skip")) return true;
    current = current.parent;
  }
  return false;
}

function valuePath(node: ts.Node): string {
  const parts: string[] = [];
  let current = node;
  while (!ts.isSourceFile(current)) {
    if ((ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isModuleDeclaration(current)) && current.name) parts.unshift(current.name.getText());
    current = current.parent;
  }
  return parts.join(".") || "default";
}

function functionName(node: FunctionNode, checker: ts.TypeChecker): string {
  let path = valuePath(node);
  let parent = returnedBy(node, checker);
  while (parent) { path += ".<inner>"; parent = returnedBy(parent, checker); }
  return path;
}

function wrappedEffect(node: FunctionNode, checker: ts.TypeChecker): ts.Type | undefined {
  if (!ts.isFunctionExpression(node) || !node.asteriskToken || !ts.isCallExpression(node.parent)) return undefined;
  const result = checker.getTypeAtLocation(node.parent);
  if (family(result, checker)?.kind === "Effect") return result;
  const signature = result.getCallSignatures()[0];
  if (!signature) return undefined;
  const returned = checker.getReturnTypeOfSignature(signature);
  return family(returned, checker)?.kind === "Effect" ? returned : undefined;
}

function nameableContract(contract: { readonly types: ReadonlyArray<ts.Type> }, checker: ts.TypeChecker, node: ts.Node): boolean {
  return contract.types.every(type => !hasUnnameableType(type, checker, node));
}

function hasUnnameableType(type: ts.Type, checker: ts.TypeChecker, location: ts.Node): boolean {
  // An explicit return annotation already supplies an in-scope spelling (including type-only aliases).
  if (isFunction(location) && location.type && !location.asteriskToken) return false;
  const printed = ts.createSourceFile("contract.ts", `type Contract = ${returnTypeText(type, checker, location)};`, ts.ScriptTarget.Latest, true);
  let missing = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !checker.resolveName(node.typeName.text, location, ts.SymbolFlags.Type, false)) missing = true;
    ts.forEachChild(node, visit);
  };
  visit(printed);
  return missing;
}

function generatorContract(node: ts.FunctionExpression, checker: ts.TypeChecker): { shape: ReturnShape; text: string; types: ReadonlyArray<ts.Type> } | undefined {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature || !node.body) return undefined;
  const iterator = checker.getReturnTypeOfSignature(signature);
  const args = checker.getTypeArguments(iterator as ts.TypeReference);
  const [yielded, success] = args;
  if (!yielded || !success) return undefined;
  const effects = (yielded.isUnion() ? yielded.types : [yielded]).flatMap(t => {
    const f = family(t, checker);
    return f?.kind === "Effect" ? [f] : [];
  });
  const print = (t: ts.Type) => returnTypeText(t, checker, node);
  const union = (index: number) => [...new Set(effects.flatMap(f => f.args[index] ? [print(f.args[index]!)] : []))].join(" | ") || "never";
  return {
    types: [success, ...effects.flatMap(effect => effect.args.slice(1))],
    text: `import("effect/Effect").Effect<${print(success)}, ${union(1)}, ${union(2)}>`,

    shape: { kind: "Effect", values: boundedValues(success, checker, node).values, omittedValues: boundedValues(success, checker, node).omitted, synthesisIssues: boundedValues(success, checker, node).issues, enumerateRecoveries: smallFinite(success), errors: [...new Map(effects.flatMap(f => f.args[1] ? taggedValues(f.args[1], checker, node) : []).map(e => [e.tag, e])).values()] },
  };
}

function literalOfBody(body: ts.ConciseBody, checker: ts.TypeChecker): string | undefined {
  const first = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  const expression = ts.isBlock(body) ? first && ts.isReturnStatement(first) ? first.expression : undefined : body;
  if (!expression) return undefined;
  const type = checker.getTypeAtLocation(expression);
  return type.isStringLiteral() ? JSON.stringify(type.value) : type.isNumberLiteral() ? String(type.value)
    : type.flags & ts.TypeFlags.BooleanLiteral ? checker.typeToString(type) : undefined;
}

function generatorBody(node: FunctionNode, checker: ts.TypeChecker): ts.FunctionExpression | undefined {
  if (!node.body) return undefined;
  const expression = ts.isBlock(node.body)
    ? node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0]!) ? node.body.statements[0]!.expression : undefined
    : node.body;
  // The return type identifies Effect; only select a direct generator callback of the wrapper.
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature || family(checker.getReturnTypeOfSignature(signature), checker)?.kind !== "Effect") return undefined;
  if (expression && ts.isCallExpression(expression)) {
    return expression.arguments.find((arg): arg is ts.FunctionExpression => ts.isFunctionExpression(arg) && arg.asteriskToken !== undefined);
  }
  return undefined;
}

function imports(source: ts.SourceFile): MutableFunction["api"] {
  const namespaces = new Map<string, string>();
  const named = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const path = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (path.startsWith("effect/")) namespaces.set(path.slice(7), bindings.name.text);
      if (path === "effect") for (const module of ["Effect", "Option", "Stream", "Layer"]) namespaces.set(module, `${bindings.name.text}.${module}`);
    }
    if (ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (binding.isTypeOnly) continue;
      const imported = (binding.propertyName ?? binding.name).text;
      if (path === "effect") namespaces.set(imported, binding.name.text);
      else if (path.startsWith("effect/")) named.set(`${path.slice(7)}.${imported}`, binding.name.text);
    }
  }
  return (module, member) => {
    const namespace = namespaces.get(module);
    return namespace ? `${namespace}.${member}` : named.get(`${module}.${member}`) ?? `${mutationNamespace(source, module)}.${member}`;
  };
}

function importInsertionOffset(source: ts.SourceFile): number {
  let offset = source.text.startsWith("#!") ? (source.text.indexOf("\n") + 1 || source.text.length) : 0;
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    offset = statement.getEnd();
  }
  return offset;
}

function mutationNamespace(source: ts.SourceFile, module: string): string {
  let name = `__mutantCafe${module}`;
  while (source.text.includes(name)) name += "_";
  return name;
}

function mutationImports(source: ts.SourceFile): NonNullable<MutableFunction["extraImports"]> {
  return ["Effect", "Option", "Stream", "Layer"].map(module => {
    const namespace = mutationNamespace(source, module);
    return { namespace, statement: `import * as ${namespace} from "effect/${module}";` };
  });
}

function family(type: ts.Type, checker: ts.TypeChecker): { kind: Family; args: ReadonlyArray<ts.Type> } | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const name = symbol?.getName();
  // Declaration provenance prevents a user-defined Effect-shaped name from being mistaken for Effect.
  const fromEffect = symbol?.declarations?.some((d) => /(?:^|\/)effect\/(?:.*\/)?(?:Effect|Option|Stream|Layer)\.(?:d\.)?ts$/.test(d.getSourceFile().fileName));
  if (fromEffect && (name === "Effect" || name === "Option" || name === "Stream" || name === "Layer")) {
    const args = type.aliasTypeArguments ?? ((type.flags & ts.TypeFlags.Object) && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type as ts.TypeReference) : []);
    return { kind: name, args };
  }
  // Type aliases may hide a referenced interface; union aliases retain their own type arguments.
  const direct = type.getSymbol();
  if (direct && direct !== symbol) {
    const name = direct.getName();
    if ((name === "Effect" || name === "Stream" || name === "Layer") && direct.declarations?.some((d) => d.getSourceFile().fileName.includes("/effect/"))) {
      return { kind: name, args: checker.getTypeArguments(type as ts.TypeReference) };
    }
  }
  if (type.isUnion()) {
    const members = type.types;
    const option = members.every((member) => {
      const symbol = member.getSymbol();
      return (symbol?.name === "Some" || symbol?.name === "None") && symbol.declarations?.some((d) => /\/effect\/.*Option\.(?:d\.)?ts$/.test(d.getSourceFile().fileName));
    });
    if (option && members[0]) {
      const first = members.find((m) => m.getSymbol()?.name === "Some") ?? members[0];
      return { kind: "Option", args: checker.getTypeArguments(first as ts.TypeReference) };
    }
  }
  if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) {
    for (const base of checker.getBaseTypes(type as ts.InterfaceType) ?? []) {
      const detected = family(base, checker);
      if (detected) return detected;
    }
  }
  return undefined;
}

function shapeOf(type: ts.Type, checker: ts.TypeChecker, node: ts.Node, body: ts.ConciseBody): ReturnShape {
  if (type.isUnion() && type.types.every((member) => family(member, checker)?.kind === "Effect")) {
    const shapes = type.types.map((member) => shapeOf(member, checker, node, body));
    const successes = type.types.flatMap(member => family(member, checker)?.args[0] ?? []);
    const bounded = boundCandidates(successes.flatMap(success => valuesOf(success, checker, node)), successes, node);
    const errors = shapes.flatMap((shape) => shape.kind === "Effect" ? shape.errors : []);
    return { kind: "Effect",
      values: bounded.values, omittedValues: bounded.omitted, synthesisIssues: shapes.flatMap(shape => shape.synthesisIssues ?? []), enumerateRecoveries: bounded.values.length <= 4 && successes.every(smallFinite),
      errors: [...new Map(errors.map((error) => [error.tag, error])).values()].sort((a, b) => a.tag.localeCompare(b.tag, "en")),
    };
  }
  const detected = family(type, checker);
  if (detected) {
    const [a, e] = detected.args;
    if (detected.kind === "Layer") return { kind: "Layer", errors: e ? taggedValues(e, checker, node) : [] };
    const bounded = a ? boundedValues(a, checker, node) : { values: [], omitted: 0, issues: [] };
    const values = bounded.values;
    if (detected.kind === "Option") return { kind: "Option", values, omittedValues: bounded.omitted, synthesisIssues: bounded.issues };
    const errors = e ? taggedValues(e, checker, node) : [];
    return { kind: detected.kind, values, errors, omittedValues: bounded.omitted, synthesisIssues: bounded.issues, enumerateRecoveries: a !== undefined && smallFinite(a) };
  }
  if (type.flags & ts.TypeFlags.Void) return { kind: "Void", values: [] };
  const members = type.isUnion() ? type.types : [type];
  const boolean = members.every((t) => (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0);
  const literal = members.every((t) => t.isLiteral());
  const bounded = boundedValues(type, checker, node);
  const values = bounded.values;
  if (isFunction(node)) for (const parameter of node.parameters) {
    if (ts.isIdentifier(parameter.name) && checker.isTypeAssignableTo(checker.getTypeAtLocation(parameter), type)) {
      values.push({ text: parameter.name.text, synthetic: false });
    }
  }
  return { kind: boolean ? "Boolean" : literal ? "Literal" : "Value", values, omittedValues: bounded.omitted, synthesisIssues: bounded.issues };
}

function taggedValues(type: ts.Type, checker: ts.TypeChecker, location: ts.Node): TaggedValue[] {
  return (type.isUnion() ? type.types : [type]).flatMap((member) => {
    const tag = member.getProperty("_tag");
    if (!tag) return [];
    const tagType = checker.getTypeOfSymbolAtLocation(tag, location);
    if (!tagType.isStringLiteral()) return [];
    const value = constructError(member, checker, location, tagType.value);
    return [{ ...value, tag: tagType.value }];
  });
}

function constructError(type: ts.Type, checker: ts.TypeChecker, location: ts.Node, tag: string): Value & { readonly reason?: string } {
  const synthetic = (reason?: string): Value & { readonly reason?: string } => ({
    text: `({ _tag: ${JSON.stringify(tag)} } as unknown as ${returnTypeText(type, checker, location)})`, synthetic: true,
    ...(reason ? { reason } : {}),
  });
  const symbol = type.getSymbol();
  if (symbol) {
    const visible = checker.getSymbolsInScope(location, ts.SymbolFlags.Value | ts.SymbolFlags.Alias).find((candidate) => {
      if (candidate.declarations?.some((declaration) => (ts.isImportClause(declaration) && declaration.isTypeOnly)
        || (ts.isImportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)))) return false;
      const target = candidate.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(candidate) : candidate;
      // Exported Data.TaggedError classes may expose distinct value/type
      // symbols for the same class declaration.
      return target === symbol || (symbol.declarations?.some((declaration) => target.declarations?.includes(declaration)) ?? false);
    });
    if (visible) {
      const constructor = checker.getTypeOfSymbolAtLocation(visible, location).getConstructSignatures()[0];
      if (constructor) {
        const arguments_: string[] = [];
        for (const param of constructor.parameters) {
          const fields = checker.getTypeOfSymbolAtLocation(param, location);
          if (fields.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) continue;
          const issues = new Set<string>();
          const value = valuesOf(fields, checker, location, new Set(), 0, issues)[0];
          if (!value || value.synthetic) {
            const reason = synthesisReason(fields, checker, location);
            const field = /\(field ([^)]+)\)/.exec(reason)?.[1];
            const detail = field ? `field ${field}` : `argument ${param.name} is not synthesizable`;
            return synthetic(detail + (issues.size ? ` (${[...issues].join("; ")})` : ""));
          }
          const declaration = param.valueDeclaration;
          const rest = declaration && ts.isParameter(declaration) && declaration.dotDotDotToken;
          arguments_.push(`${rest ? "..." : ""}${value.text}`);
        }
        return { text: `new ${visible.name}(${arguments_.join(", ")})`, synthetic: false };
      }
    }
    if (symbol.declarations?.some(ts.isClassDeclaration)) {
      return synthetic(visible ? "constructor arguments are not synthesizable" : "class is not available as a value; import its constructor");
    }
  }
  return synthetic();
}

// Without UseAliasDefinedOutsideCurrentScope the checker emits import("./module").Name
// for names not visible here, including transitive error and Brand references.
function returnTypeText(type: ts.Type, checker: ts.TypeChecker, node: ts.Node): string {
  if (isFunction(node) && node.type && !node.asteriskToken && checker.getTypeFromTypeNode(node.type) === type) return node.type.getText();
  const print = (t: ts.Type): string => {
    if (t.isUnion()) return t.types.map(print).join(" | ");
    const symbol = t.getSymbol();
    if (symbol && !checker.resolveName(symbol.name, node, ts.SymbolFlags.Type, false)) {
      const alias = checker.getSymbolsInScope(node, ts.SymbolFlags.Type | ts.SymbolFlags.Alias).find(candidate => {
        const target = candidate.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(candidate) : candidate;
        return !!target.declarations?.length && checker.getDeclaredTypeOfSymbol(target) === t;
      });
      if (alias) return alias.name;
    }
    return checker.typeToString(t, node, ts.TypeFormatFlags.NoTruncation);
  };
  if (type.isUnion()) {
    const members = type.types.map((member) => family(member, checker));
    if (members.every((member) => member?.kind === "Effect")) {
      const args = [0, 1, 2].map((index) => [...new Set(members.flatMap((member) => member?.args[index] ? [print(member.args[index]!)] : []))].sort().join(" | ") || "never");
      return `import("effect/Effect").Effect<${args.join(", ")}>`;
    }
  }
  const detected = family(type, checker);
  if (detected) return `import("effect/${detected.kind}").${detected.kind}<${detected.args.map(print).join(", ")}>`;
  return print(type);
}

// Compare only literal data, never evaluate user code. Canonical keys make
// differently quoted object literals equivalent without treating calls as equal.
function literalData(node: ts.Node): unknown {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literalData(node.expression);
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return [node.kind, node.text];
  if (ts.isIdentifier(node) && node.text === "undefined") return ["undefined"];
  if (ts.isPrefixUnaryExpression(node)) return [node.operator, literalData(node.operand)];
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(literalData);
    return items.every(item => item !== undefined) ? ["array", items] : undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return [node.kind];
  if (ts.isObjectLiteralExpression(node)) {
    const fields: Array<readonly [string, unknown]> = [];
    for (const field of node.properties) {
      if (!ts.isPropertyAssignment(field) || !field.name || ts.isComputedPropertyName(field.name)) return undefined;
      const value = literalData(field.initializer);
      if (value === undefined) return undefined;
      fields.push([field.name.getText().replace(/^["']|["']$/g, ""), value]);
    }
    return fields.sort(([a], [b]) => a.localeCompare(b, "en"));
  }
  return undefined;
}

function equivalentSuccessValues(body: ts.ConciseBody, api: MutableFunction["api"]): ReadonlyArray<string> {
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === api("Effect", "succeed") && node.arguments[0]) {
      const value = literalData(node.arguments[0]);
      if (value !== undefined) values.push(JSON.stringify(value));
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return values;
}

function isEquivalentSuccess(text: string, values: ReadonlyArray<string>): boolean {
  const source = ts.createSourceFile("literal.ts", `(${text})`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return false;
  const value = literalData(statement.expression);
  return value !== undefined && values.includes(JSON.stringify(value));
}

function synthesisReason(type: ts.Type, checker: ts.TypeChecker, node: ts.Node): string {
  if (type.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess)) return "generic return cannot be synthesized";
  const valueType = family(type, checker)?.args[0] ?? type;
  // Protocol properties are implementation details, not fields a caller can supply.
  const field = valueType.getProperties().find(field => /^[$\w]+$/.test(field.name)
    && !(field.flags & ts.SymbolFlags.Optional) && !valuesOf(checker.getTypeOfSymbolAtLocation(field, node), checker, node).length);
  const symbol = valueType.aliasSymbol ?? valueType.getSymbol();
  const name = symbol && !symbol.name.startsWith("__") ? symbol.name
    : valueType.isUnion() ? "union" : valueType.flags & ts.TypeFlags.Object || valueType.isIntersection() ? "object" : checker.typeToString(valueType, node);
  return field ? `return not synthesizable (field ${field.name})` : `return not synthesizable (type ${name})`;
}

function valueKey(text: string): string {
  const source = ts.createSourceFile("value.ts", `(${text})`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  const data = statement && ts.isExpressionStatement(statement) ? literalData(statement.expression) : undefined;
  return data === undefined ? text : JSON.stringify(data);
}

/** Finite literal sets are exhaustive up to eight; open/recursive shapes use six representatives.
 * Undefined is retained separately, so optional returns keep their absence path. */
function boundedValues(type: ts.Type, checker: ts.TypeChecker, node: ts.Node): { values: Value[]; omitted: number; issues: string[] } {
  const issues = new Set<string>();
  return { ...boundCandidates(valuesOf(type, checker, node, new Set(), 0, issues), [type], node), issues: [...issues] };
}

function smallFinite(type: ts.Type): boolean {
  const members = type.isUnion() ? type.types : [type];
  return members.length <= 4 && members.every(member => member.isLiteral()
    || !!(member.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
}

function boundCandidates(candidates: ReadonlyArray<Value>, types: ReadonlyArray<ts.Type>, node: ts.Node): { values: Value[]; omitted: number } {
  const unique = [...new Map(candidates.map(value => [valueKey(value.text), value])).values()];
  const members = types.flatMap(type => type.isUnion() ? type.types : [type]);
  const finite = members.length <= 8 && members.every(member => member.isLiteral()
    || !!(member.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
  if (finite || unique.length <= 6) return { values: unique, omitted: 0 };
  const absence = unique.find(value => value.text === "undefined");
  const defined = unique.filter(value => value !== absence);
  const preferred = ["null", '\"\"', "0", "false", "[]", "({  })"].flatMap(text => {
    const candidate = defined.find(value => valueKey(value.text) === valueKey(text));
    return candidate ? [candidate] : [];
  });
  const original = returnedDiscriminants(node);
  const priority = defined.filter(candidate => {
    const source = ts.createSourceFile("value.ts", `(${candidate.text})`, ts.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    return statement && ts.isExpressionStatement(statement) && objectDiscriminants(statement.expression).some(key => original.has(key));
  });
  const selected = [...new Set([...priority, ...preferred, ...defined])].slice(0, 6);
  if (absence) selected.push(absence);
  return { values: selected, omitted: unique.length - selected.length };
}

function objectDiscriminants(node: ts.Node): string[] {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  if (!ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap(field => {
    if (!ts.isPropertyAssignment(field) || ts.isComputedPropertyName(field.name)) return [];
    let value = field.initializer;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
    return ts.isStringLiteral(value) || ts.isNumericLiteral(value)
      ? [JSON.stringify([field.name.getText().replace(/^["']|["']$/g, ""), value.text])] : [];
  });
}

function returnedDiscriminants(node: ts.Node): Set<string> {
  if (!isFunction(node) || !node.body) return new Set();
  const result = new Set(objectDiscriminants(node.body));
  const visit = (child: ts.Node): void => {
    if (isFunction(child)) return;
    if (ts.isReturnStatement(child) && child.expression) for (const key of objectDiscriminants(child.expression)) result.add(key);
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  return result;
}

function shapeNotices(shape: ReturnShape, type: ts.Type, checker: ts.TypeChecker, node: ts.Node): string[] {
  const notices: string[] = [...(shape.synthesisIssues ?? [])];
  const valueType = family(type, checker)?.args[0] ?? type;
  if ("values" in shape && shape.values.some(value => new TextEncoder().encode(value.text).byteLength > 2048)) notices.push("synthesized value exceeds 2048 bytes");
  const omitted = shape.omittedValues ?? 0;
  if (omitted) notices.push(`${omitted} more values not generated (representative cap)`);
  if ("errors" in shape) for (const error of shape.errors) {
    if (error.reason !== undefined) notices.push(`cannot construct ${error.tag}: ${error.reason}`);
    if (new TextEncoder().encode(error.text).byteLength > 2048) notices.push(`cannot construct ${error.tag}: synthesized value exceeds 2048 bytes`);
  }
  if ("values" in shape && !shape.values.length && !(valueType.flags & ts.TypeFlags.Never) && shape.kind !== "Void") {
    notices.push(synthesisReason(type, checker, node));
  }
  return notices;
}

/** Bounded synthesis: cycles or unavailable required fields produce no fabricated value. */
function valuesOf(type: ts.Type, checker: ts.TypeChecker, location: ts.Node, ancestors: ReadonlySet<ts.Type> = new Set(), depth = 0, issues = new Set<string>()): Value[] {
  if (depth > 4) { issues.add("synthesis depth limit (4) reached"); return []; }
  if (ancestors.has(type) || type.flags & ts.TypeFlags.Never) return [];
  const values = synthesizeValues(type, checker, location, ancestors, depth, issues);
  const bounded = values.filter(value => new TextEncoder().encode(value.text).byteLength <= 2048);
  if (bounded.length !== values.length) issues.add("synthesized value exceeds 2048 bytes");
  return bounded;
}

function synthesizeValues(type: ts.Type, checker: ts.TypeChecker, location: ts.Node, ancestors: ReadonlySet<ts.Type>, depth: number, issues: Set<string>): Value[] {
  const descend = (inner: ts.Type): Value[] => valuesOf(inner, checker, location, new Set([...ancestors, type]), depth + 1, issues);
  const value = (text: string): Value => ({ text, synthetic: false });
  const detected = family(type, checker);
  if (detected && (detected.kind === "Option" || detected.kind === "Effect")) {
    const api = imports(location.getSourceFile());
    const inner = detected.args[0];
    const values = inner ? descend(inner) : [];
    const wrap = api(detected.kind, detected.kind === "Option" ? "some" : "succeed");
    const none = detected.kind === "Option" ? api("Option", "none") : undefined;
    return [
      ...(none ? [value(`${none}()`)] : []),
      ...(wrap ? values.map((v) => ({ text: `${wrap}(${v.text})`, synthetic: v.synthetic })) : []),
    ];
  }
  if (type.isIntersection()) {
    // Primitive brands need a cast. Structural intersections synthesize their required fields below.
    const primitive = type.types.find(member => member.flags & (ts.TypeFlags.String | ts.TypeFlags.Number));
    const brand = type.types.some(member => member.getProperties().some(prop => prop.name.includes("Brand")));
    if (primitive && brand) return descend(primitive).map(v => ({ ...v, text: `(${v.text} as ${returnTypeText(type, checker, location)})` }));
  }
  const symbol = type.getSymbol();
  if ((symbol?.name === "ReadonlySet" || symbol?.name === "Set" || symbol?.name === "ReadonlyMap" || symbol?.name === "Map")
    && symbol.declarations?.some(d => /\/lib\.es.*\.d\.ts$/.test(d.getSourceFile().fileName))) {
    return [value(symbol.name.endsWith("Set") ? "new Set()" : "new Map()")];
  }
  if (type.isUnion()) {
    const members = [...type.types];
    // The checker can intern scalar unions in different orders across selections.
    const scalar = members.every(member => member.isLiteral() || !!(member.flags & (ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    if (scalar) {
      members.sort((a, b) => a.isNumberLiteral() && b.isNumberLiteral() ? a.value - b.value : checker.typeToString(a).localeCompare(checker.typeToString(b), "en"));
    }
    const values = members.flatMap(member => descend(member));
    return scalar ? values : values.map(value => [valueKey(value.text), value] as const)
      .sort(([a, left], [b, right]) => a.localeCompare(b, "en")
        || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0))
      .map(([, value]) => value);
  }
  if (type.isStringLiteral()) return [value(JSON.stringify(type.value))];
  if (type.isNumberLiteral()) return [value(String(type.value))];
  if (type.flags & ts.TypeFlags.BooleanLiteral) return [value(checker.typeToString(type))];
  if (type.flags & ts.TypeFlags.Boolean) return [value("true"), value("false")];
  if (type.flags & ts.TypeFlags.String) return [value('""'), value('"xyzzy"')];
  if (type.flags & ts.TypeFlags.Number) return [value("0"), value("1"), value("-1")];
  if (type.flags & ts.TypeFlags.BigInt) return [value("0n"), value("1n")];
  if (type.flags & ts.TypeFlags.Null) return [value("null")];
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return [value("undefined")];
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return [value("undefined")];
  if (checker.isTupleType(type)) {
    const elements = checker.getTypeArguments(type as ts.TypeReference).map((t) => descend(t)[0]);
    return elements.every((v) => v !== undefined) ? [value(`[${elements.map((v) => v.text).join(", ")}]`)] : [];
  }
  if (checker.isArrayType(type) || checker.isArrayLikeType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    const elements = element ? descend(element) : [];
    return [value("[]"), ...elements.map((v) => ({ text: `[${v.text}]`, synthetic: v.synthetic }))];
  }
  if ((type.flags & ts.TypeFlags.Object || type.isIntersection()) && !type.getCallSignatures().length && !type.getConstructSignatures().length) {
    const fields: Array<{ name: string; values: Value[] }> = [];
    for (const prop of [...type.getProperties()].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (prop.flags & ts.SymbolFlags.Optional) continue;
      if (!/^[$\w]+$/.test(prop.name)) return [];
      const values = descend(checker.getTypeOfSymbolAtLocation(prop, location));
      if (!values.length) return [];
      fields.push({ name: prop.name, values });
    }
    const literalFields = fields.filter(field => {
      const prop = type.getProperty(field.name);
      if (!prop) return false;
      const t = checker.getTypeOfSymbolAtLocation(prop, location);
      return (t.isUnion() ? t.types : [t]).every(member => member.isLiteral() || !!(member.flags & ts.TypeFlags.BooleanLiteral));
    });
    const render = (changed?: typeof fields[number], replacement?: Value): Value | undefined => {
      const parts: string[] = [];
      let bytes = 6; // ({ ... }) delimiters
      for (const field of fields) {
        const v = (field === changed ? replacement! : field.values[0]!).text;
        const part = `${JSON.stringify(field.name)}: ${literalFields.includes(field) ? `(${v} as const)` : v}`;
        bytes += new TextEncoder().encode(part).byteLength + (parts.length ? 2 : 0);
        if (bytes > 2048) { issues.add("synthesized value exceeds 2048 bytes"); return undefined; }
        parts.push(part);
      }
      return value(`({ ${parts.join(", ")} })`);
    };
    const first = render();
    if (!first) return []; // Do not expand a wide object into thousands of oversized variants.
    const anonymous = !type.aliasSymbol && (!type.getSymbol() || ["__type", "__object"].includes(type.getSymbol()!.name));
    return [first, ...(anonymous ? literalFields.flatMap(field => field.values.slice(1).map(v => render(field, v))).filter(value => value !== undefined) : [])];
  }
  return [];
}
