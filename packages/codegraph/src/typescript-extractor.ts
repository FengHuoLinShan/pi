import { relative, resolve, sep } from "node:path";
import type {
	CodeGraphExtractedEdge,
	CodeGraphExtractedNode,
	CodeGraphExtraction,
	CodeGraphSourceRange,
} from "@earendil-works/pi-coding-agent";
import ts from "typescript";

export const TYPESCRIPT_CODE_GRAPH_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;
const SUPPORTED_EXTENSIONS = new Set<string>(TYPESCRIPT_CODE_GRAPH_EXTENSIONS);

export interface TypeScriptProgramExtraction {
	extractions: Map<string, CodeGraphExtraction>;
	diagnostics: string[];
}

interface SourceExtractionState {
	filePath: string;
	fileNodeId: string;
	nodes: Map<string, CodeGraphExtractedNode>;
	edges: CodeGraphExtractedEdge[];
	edgeIds: Set<string>;
}

function portablePath(path: string): string {
	return path.split(sep).join("/");
}

export function toWorkspaceRelativePath(workspaceRoot: string, fileName: string): string | undefined {
	const path = portablePath(relative(resolve(workspaceRoot), resolve(fileName)));
	if (path === "" || path === ".." || path.startsWith("../") || path.startsWith("/")) return undefined;
	return path;
}

export function isSupportedTypeScriptFile(fileName: string): boolean {
	if (fileName.endsWith(".d.ts") || fileName.endsWith(".d.mts") || fileName.endsWith(".d.cts")) return false;
	const dot = fileName.lastIndexOf(".");
	return dot >= 0 && SUPPORTED_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

function sourceRange(sourceFile: ts.SourceFile, node: ts.Node): CodeGraphSourceRange {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
	const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
	return {
		start: { line: start.line + 1, column: start.character },
		end: { line: end.line + 1, column: end.character },
	};
}

function namedDeclarationName(node: ts.Node): ts.DeclarationName | undefined {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isEnumDeclaration(node) ||
		ts.isVariableDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isMethodSignature(node) ||
		ts.isPropertyDeclaration(node) ||
		ts.isPropertySignature(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isModuleDeclaration(node)
	) {
		return node.name;
	}
	return undefined;
}

function declarationKind(node: ts.Node): string | undefined {
	if (ts.isFunctionDeclaration(node)) return "function";
	if (ts.isClassDeclaration(node)) return "class";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isTypeAliasDeclaration(node)) return "type";
	if (ts.isEnumDeclaration(node)) return "enum";
	if (ts.isVariableDeclaration(node)) return "variable";
	if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
	if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return "accessor";
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (ts.isModuleDeclaration(node)) return "namespace";
	return undefined;
}

function declarationName(node: ts.Node, name: ts.DeclarationName | undefined): string | undefined {
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function identityPart(value: string): string {
	return `${value.length}:${value}`;
}

function hasStaticModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)
	);
}

function declarationIdentityName(node: ts.Node, name: string): string {
	return hasStaticModifier(node) ? `static:${name}` : name;
}

function isFunctionBodyBlock(node: ts.Block): boolean {
	return ts.isFunctionLike(node.parent) && "body" in node.parent && node.parent.body === node;
}

function hasNamedInitializerOwner(node: ts.FunctionExpression | ts.ArrowFunction | ts.ClassExpression): boolean {
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) {
		return parent.initializer === node && declarationName(parent, namedDeclarationName(parent)) !== undefined;
	}
	return false;
}

function structuralOrdinal(node: ts.Node): number {
	let ordinal = 0;
	let found = false;
	node.parent?.forEachChild((child) => {
		if (found || child.kind !== node.kind) return;
		if (child === node) {
			found = true;
			return;
		}
		ordinal++;
	});
	return ordinal;
}

function anonymousIdentity(node: ts.Node): string {
	return `@${ts.SyntaxKind[node.kind]}:${structuralOrdinal(node)}`;
}

function lexicalScopeSegment(node: ts.Node): string | undefined {
	const kind = declarationKind(node);
	const name = declarationName(node, namedDeclarationName(node));
	if (kind && name) return `${kind}:${declarationIdentityName(node, name)}`;
	if (ts.isFunctionExpression(node) && node.name) return `function:${node.name.text}`;
	if (ts.isClassExpression(node) && node.name) return `class:${node.name.text}`;
	if (
		(ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node)) &&
		!hasNamedInitializerOwner(node)
	) {
		return anonymousIdentity(node);
	}
	if (ts.isBlock(node) && !isFunctionBodyBlock(node)) {
		return anonymousIdentity(node);
	}
	return undefined;
}

function declarationQualifiedName(node: ts.Node, sourceFile: ts.SourceFile, name: string | undefined): string {
	const segments: string[] = [];
	for (let current = node.parent; current && current !== sourceFile; current = current.parent) {
		const segment = lexicalScopeSegment(current);
		if (segment) segments.push(segment);
	}
	segments.reverse();
	segments.push(name ? declarationIdentityName(node, name) : anonymousIdentity(node));
	return segments.map(identityPart).join("/");
}

function declarationSymbolLocation(
	checker: ts.TypeChecker,
	node: ts.Node,
	name: ts.DeclarationName | undefined,
): ts.Symbol | undefined {
	if (name) return checker.getSymbolAtLocation(name);
	return checker.getSymbolAtLocation(node);
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
	if (!symbol) return undefined;
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
	try {
		return checker.getAliasedSymbol(symbol);
	} catch {
		return symbol;
	}
}

function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
	);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
	const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
	if (!diagnostic.file || diagnostic.start === undefined) return message;
	const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
	return `${portablePath(diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`;
}

function moduleTarget(
	program: ts.Program,
	workspaceRoot: string,
	sourceFile: ts.SourceFile,
	specifier: string,
): string {
	const resolved = ts.resolveModuleName(
		specifier,
		sourceFile.fileName,
		program.getCompilerOptions(),
		ts.sys,
	).resolvedModule;
	if (resolved) {
		const path = toWorkspaceRelativePath(workspaceRoot, resolved.resolvedFileName);
		if (path && isSupportedTypeScriptFile(path)) return `file:${path}`;
	}
	return `module:${specifier}`;
}

function isDeclarationName(node: ts.Identifier): boolean {
	return namedDeclarationName(node.parent) === node;
}

function isImportOrExportSyntax(node: ts.Node): boolean {
	for (let current: ts.Node | undefined = node; current; current = current.parent) {
		if (
			ts.isImportDeclaration(current) ||
			ts.isImportEqualsDeclaration(current) ||
			ts.isExportDeclaration(current) ||
			ts.isExportAssignment(current)
		) {
			return true;
		}
		if (ts.isStatement(current)) return false;
	}
	return false;
}

function shouldRecordReference(node: ts.Identifier): boolean {
	if (isDeclarationName(node) || isImportOrExportSyntax(node)) return false;
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
	if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
	if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
	return true;
}

/**
 * Extract a cross-file graph from one TypeScript Program. Declaration identity
 * is scanned globally so references in selected files resolve correctly, while
 * nodes and relationships are materialized only for `selectedFilePaths`.
 */
export function extractTypeScriptProgram(
	program: ts.Program,
	workspaceRoot: string,
	selectedFilePaths?: ReadonlySet<string>,
): TypeScriptProgramExtraction {
	const checker = program.getTypeChecker();
	const sourceFiles = program
		.getSourceFiles()
		.map((sourceFile) => ({ sourceFile, filePath: toWorkspaceRelativePath(workspaceRoot, sourceFile.fileName) }))
		.filter(
			(value): value is { sourceFile: ts.SourceFile; filePath: string } =>
				value.filePath !== undefined && isSupportedTypeScriptFile(value.filePath),
		)
		.sort((left, right) => left.filePath.localeCompare(right.filePath));
	const states = new Map<ts.SourceFile, SourceExtractionState>();
	const declarationIds = new Map<ts.Node, string>();
	const symbolIds = new Map<ts.Symbol, string>();

	for (const { sourceFile, filePath } of sourceFiles) {
		const selected = selectedFilePaths === undefined || selectedFilePaths.has(filePath);
		const fileNodeId = `file:${filePath}`;
		const state: SourceExtractionState | undefined = selected
			? {
					filePath,
					fileNodeId,
					nodes: new Map([
						[
							fileNodeId,
							{
								id: fileNodeId,
								kind: "file",
								name: filePath,
								attributes: {
									language: sourceFile.languageVariant === ts.LanguageVariant.JSX ? "tsx/jsx" : "ts/js",
								},
							},
						],
					]),
					edges: [],
					edgeIds: new Set(),
				}
			: undefined;
		if (state) states.set(sourceFile, state);

		const visitDeclarations = (node: ts.Node): void => {
			const kind = declarationKind(node);
			const nameNode = namedDeclarationName(node);
			const name = declarationName(node, nameNode);
			if (kind) {
				const qualifiedName = declarationQualifiedName(node, sourceFile, name);
				const id = `symbol:${filePath}:${kind}:${qualifiedName}`;
				declarationIds.set(node, id);
				if (state && !state.nodes.has(id)) {
					state.nodes.set(id, {
						id,
						kind,
						name: name ?? `<anonymous ${kind}>`,
						range: sourceRange(sourceFile, nameNode ?? node),
						attributes: { exported: hasExportModifier(node) },
					});
				}
				const symbol = canonicalSymbol(checker, declarationSymbolLocation(checker, node, nameNode));
				if (symbol && !symbolIds.has(symbol)) symbolIds.set(symbol, id);
			}
			ts.forEachChild(node, visitDeclarations);
		};
		visitDeclarations(sourceFile);
	}

	const resolveSymbolId = (node: ts.Node): string | undefined => {
		const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node));
		if (!symbol) return undefined;
		const known = symbolIds.get(symbol);
		if (known) return known;
		for (const declaration of symbol.declarations ?? []) {
			const declarationId = declarationIds.get(declaration);
			if (declarationId) return declarationId;
		}
		return undefined;
	};

	for (const { sourceFile } of sourceFiles) {
		const state = states.get(sourceFile);
		if (!state) continue;
		const edgeOccurrences = new Map<string, number>();
		const addEdge = (
			kind: string,
			from: string,
			to: string | undefined,
			evidence: ts.Node,
			confidence: number,
		): void => {
			if (!to || from === to) return;
			const identity = `${kind}:${identityPart(from)}:${identityPart(to)}`;
			const occurrence = edgeOccurrences.get(identity) ?? 0;
			edgeOccurrences.set(identity, occurrence + 1);
			const id = `edge:${state.filePath}:${identity}:${occurrence}`;
			if (state.edgeIds.has(id)) return;
			state.edgeIds.add(id);
			state.edges.push({
				id,
				kind,
				from,
				to,
				range: sourceRange(sourceFile, evidence),
				attributes: { confidence },
			});
		};
		const owningNodeId = (node: ts.Node): string => {
			for (let current: ts.Node | undefined = node; current && current !== sourceFile; current = current.parent) {
				const declarationId = declarationIds.get(current);
				if (declarationId) return declarationId;
			}
			return state.fileNodeId;
		};

		const visitRelationships = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
				addEdge(
					"imports",
					state.fileNodeId,
					moduleTarget(program, workspaceRoot, sourceFile, node.moduleSpecifier.text),
					node.moduleSpecifier,
					1,
				);
			}
			if (ts.isExportDeclaration(node)) {
				if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
					addEdge(
						"re_exports",
						state.fileNodeId,
						moduleTarget(program, workspaceRoot, sourceFile, node.moduleSpecifier.text),
						node.moduleSpecifier,
						1,
					);
				} else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
					for (const element of node.exportClause.elements) {
						const localName = element.propertyName ?? element.name;
						addEdge("exports", state.fileNodeId, resolveSymbolId(localName), localName, 1);
					}
				}
			}
			if (ts.isExportAssignment(node)) {
				addEdge("exports", state.fileNodeId, resolveSymbolId(node.expression), node.expression, 1);
			}
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				const expression = node.expression;
				if (
					ts.isCallExpression(node) &&
					node.expression.kind === ts.SyntaxKind.ImportKeyword &&
					node.arguments.length === 1 &&
					ts.isStringLiteralLike(node.arguments[0])
				) {
					const specifier = node.arguments[0];
					addEdge(
						"imports",
						owningNodeId(node),
						moduleTarget(program, workspaceRoot, sourceFile, specifier.text),
						specifier,
						1,
					);
				} else if (
					ts.isCallExpression(node) &&
					ts.isIdentifier(expression) &&
					expression.text === "require" &&
					node.arguments.length === 1 &&
					ts.isStringLiteralLike(node.arguments[0])
				) {
					const specifier = node.arguments[0];
					addEdge(
						"imports",
						owningNodeId(node),
						moduleTarget(program, workspaceRoot, sourceFile, specifier.text),
						specifier,
						1,
					);
				} else {
					addEdge("calls", owningNodeId(node), resolveSymbolId(expression), expression, 0.95);
				}
			}
			if (ts.isHeritageClause(node)) {
				const owner = owningNodeId(node.parent);
				const kind = node.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
				for (const type of node.types) addEdge(kind, owner, resolveSymbolId(type.expression), type.expression, 1);
			}
			if (ts.isIdentifier(node) && shouldRecordReference(node)) {
				const parent = node.parent;
				const callTarget =
					(ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node;
				if (!callTarget) addEdge("references", owningNodeId(node), resolveSymbolId(node), node, 0.9);
			}
			ts.forEachChild(node, visitRelationships);
		};
		visitRelationships(sourceFile);
		state.edges.sort((left, right) => left.id.localeCompare(right.id));
	}

	return {
		extractions: new Map(
			sourceFiles.flatMap(({ sourceFile, filePath }) => {
				const state = states.get(sourceFile);
				if (!state) return [];
				return [
					[
						filePath,
						{
							nodes: [...state.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
							edges: state.edges,
						},
					] as const,
				];
			}),
		),
		diagnostics: program.getSyntacticDiagnostics().slice(0, 100).map(formatDiagnostic),
	};
}
