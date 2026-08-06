import { basename, dirname, extname } from "node:path";
import type {
	CodeGraphExtractedEdge,
	CodeGraphExtractedNode,
	CodeGraphExtraction,
	CodeGraphSourceRange,
} from "@earendil-works/pi-coding-agent";

export const SOURCE_LANGUAGE_EXTENSIONS = [".py", ".go", ".rs"] as const;
export const SOURCE_LANGUAGE_ADAPTER_VERSION = "python-hybrid@5;go-hybrid@5;rust-hybrid@5";

export interface SourceLanguageFile {
	readonly path: string;
	readonly content: string;
}

export interface SourceLanguageProject {
	readonly files: readonly SourceLanguageFile[];
	readonly goModulePath?: string;
}

export interface SourceLanguageAdapterDescriptor {
	id: string;
	language: string;
	precision: "hybrid";
	extensions: readonly string[];
}

export interface SourceLanguageAdapter extends SourceLanguageAdapterDescriptor {
	version: string;
	extract(file: SourceLanguageFile, project: SourceLanguageProject): CodeGraphExtraction;
}

interface ExtractionBuilder {
	file: SourceLanguageFile;
	fileNodeId: string;
	nodes: Map<string, CodeGraphExtractedNode>;
	edges: Map<string, CodeGraphExtractedEdge>;
}

interface DeclarationMatch {
	kind: string;
	name: string;
	column: number;
	qualifiedName?: string;
}

const SOURCE_EXTENSION_SET = new Set<string>(SOURCE_LANGUAGE_EXTENSIONS);
const KNOWN_PATHS_CACHE = new WeakMap<SourceLanguageProject, Map<string, Set<string>>>();

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRange(line: number, column: number, length: number): CodeGraphSourceRange {
	return {
		start: { line, column },
		end: { line, column: column + length },
	};
}

function createBuilder(file: SourceLanguageFile, adapter: SourceLanguageAdapterDescriptor): ExtractionBuilder {
	const fileNodeId = `file:${file.path}`;
	return {
		file,
		fileNodeId,
		nodes: new Map([
			[
				fileNodeId,
				{
					id: fileNodeId,
					kind: "file",
					name: file.path,
					attributes: {
						adapter: adapter.id,
						language: adapter.language,
						precision: adapter.precision,
					},
				},
			],
		]),
		edges: new Map(),
	};
}

function declarationId(filePath: string, match: DeclarationMatch): string {
	return `symbol:${filePath}:${match.kind}:${match.qualifiedName ?? match.name}`;
}

function addDeclaration(builder: ExtractionBuilder, match: DeclarationMatch, line: number): string {
	const id = declarationId(builder.file.path, match);
	if (builder.nodes.has(id)) return id;
	builder.nodes.set(id, {
		id,
		kind: match.kind,
		name: match.name,
		range: sourceRange(line, match.column, match.name.length),
		attributes: {
			precision: "structural",
			...(match.qualifiedName ? { qualifiedName: match.qualifiedName } : {}),
		},
	});
	return id;
}

function addImport(
	builder: ExtractionBuilder,
	language: string,
	specifier: string,
	targets: readonly string[],
	line: number,
	column: number,
	evidence = specifier,
): void {
	const resolvedTargets = targets.length > 0 ? targets : [`external:${language}:${specifier}`];
	for (const target of resolvedTargets) {
		const id = `edge:${builder.file.path}:imports:${language}:${specifier}:${target}`;
		if (builder.edges.has(id)) continue;
		builder.edges.set(id, {
			id,
			kind: "imports",
			from: builder.fileNodeId,
			to: target,
			range: sourceRange(line, column, evidence.length),
			attributes: {
				confidence: targets.length > 0 ? 1 : 0,
				precision: "structural",
				specifier,
			},
		});
	}
}

function addSemanticEdge(
	builder: ExtractionBuilder,
	kind: string,
	from: string,
	to: string,
	line: number,
	column: number,
	evidence: string,
	confidence: number,
): void {
	const id = `edge:${builder.file.path}:${kind}:${from}:${to}:${line}:${column}`;
	if (builder.edges.has(id)) return;
	builder.edges.set(id, {
		id,
		kind,
		from,
		to,
		range: sourceRange(line, column, evidence.length),
		attributes: { confidence, precision: "conservative-semantic" },
	});
}

function finish(builder: ExtractionBuilder): CodeGraphExtraction {
	return {
		nodes: [...builder.nodes.values()].sort((left, right) => compareStrings(left.id, right.id)),
		edges: [...builder.edges.values()].sort((left, right) => compareStrings(left.id, right.id)),
	};
}

function knownPaths(project: SourceLanguageProject, extension: string): Set<string> {
	let byExtension = KNOWN_PATHS_CACHE.get(project);
	if (!byExtension) {
		byExtension = new Map();
		KNOWN_PATHS_CACHE.set(project, byExtension);
	}
	let paths = byExtension.get(extension);
	if (!paths) {
		paths = new Set(project.files.filter((file) => extname(file.path) === extension).map((file) => file.path));
		byExtension.set(extension, paths);
	}
	return paths;
}

function firstExisting(candidates: readonly string[], paths: ReadonlySet<string>): string[] {
	const path = candidates.find((candidate) => paths.has(candidate));
	return path ? [`file:${path}`] : [];
}

function pythonModuleCandidates(base: readonly string[], moduleName: string): string[] {
	const moduleParts = moduleName ? moduleName.split(".").filter(Boolean) : [];
	const modulePath = [...base, ...moduleParts].join("/");
	if (!modulePath) return [];
	return [`${modulePath}.py`, `${modulePath}/__init__.py`];
}

function resolvePythonImport(
	filePath: string,
	specifier: string,
	paths: ReadonlySet<string>,
	importedNames: readonly string[] = [],
): string[] {
	const dotMatch = specifier.match(/^\.+/);
	let base: string[];
	let moduleName: string;
	if (dotMatch) {
		const levels = dotMatch[0].length;
		base = dirname(filePath) === "." ? [] : dirname(filePath).split("/");
		base.splice(Math.max(0, base.length - (levels - 1)));
		moduleName = specifier.slice(levels);
	} else {
		base = [];
		moduleName = specifier;
	}
	const targets = firstExisting(pythonModuleCandidates(base, moduleName), paths);
	const moduleTarget = targets[0];
	if (
		importedNames.length > 0 &&
		(!moduleTarget || moduleTarget === "file:__init__.py" || moduleTarget.endsWith("/__init__.py"))
	) {
		const moduleBase = [...base, ...moduleName.split(".").filter(Boolean)];
		for (const name of importedNames) {
			targets.push(...firstExisting(pythonModuleCandidates(moduleBase, name), paths));
		}
	}
	return [...new Set(targets)];
}

interface PythonDeclaration extends DeclarationMatch {
	filePath: string;
	line: number;
	indent: number;
	endLine: number;
	bases: readonly string[];
	parameters: readonly string[];
}

interface PythonBinding {
	original?: string;
	targets: readonly string[];
	line: number;
}

function indentation(line: string): number {
	return (line.match(/^\s*/)?.[0] ?? "").replaceAll("\t", "    ").length;
}

function stripPythonStringsAndComments(source: string): string {
	let result = "";
	let index = 0;
	let quote: "'" | '"' | "'''" | '"""' | undefined;
	while (index < source.length) {
		const current = source[index]!;
		if (quote) {
			if (current === "\\" && index + 1 < source.length) {
				const escaped = source[index + 1]!;
				result += escaped === "\n" ? " \n" : "  ";
				index += 2;
				continue;
			}
			if (source.startsWith(quote, index)) {
				result += " ".repeat(quote.length);
				index += quote.length;
				quote = undefined;
				continue;
			}
			result += current === "\n" ? "\n" : " ";
			index++;
			continue;
		}
		if (current === "#") {
			while (index < source.length && source[index] !== "\n") {
				result += " ";
				index++;
			}
			continue;
		}
		if (source.startsWith("'''", index) || source.startsWith('"""', index)) {
			quote = source.slice(index, index + 3) as "'''" | '"""';
			result += "   ";
			index += 3;
			continue;
		}
		if (current === "'" || current === '"') quote = current;
		result += quote ? " " : current;
		index++;
	}
	return result;
}

function collectPythonDeclarations(file: SourceLanguageFile): PythonDeclaration[] {
	const lines = stripPythonStringsAndComments(file.content).split(/\r?\n/);
	const declarations: PythonDeclaration[] = [];
	const stack: number[] = [];
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") continue;
		const indent = indentation(line);
		while (stack.length > 0 && declarations[stack.at(-1)!]!.indent >= indent) {
			declarations[stack.pop()!]!.endLine = index + 1;
		}
		const match = /^(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)(?:\s*\(([^)]*)\))?/.exec(line.trimStart());
		if (!match) continue;
		const scopes = stack.map((position) => declarations[position]!.name);
		const name = match[2]!;
		const kind = match[1] === "def" ? "function" : "class";
		const declaration: PythonDeclaration = {
			filePath: file.path,
			kind,
			name,
			qualifiedName: scopes.length > 0 ? [...scopes, name].join(".") : undefined,
			column: line.indexOf(name),
			line: index + 1,
			indent,
			endLine: lines.length + 1,
			bases:
				kind === "class"
					? (match[3] ?? "")
							.split(",")
							.map((base) => base.trim().split("[")[0]!)
							.filter((base) => /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(base))
					: [],
			parameters:
				kind === "function"
					? (match[3] ?? "")
							.split(",")
							.map(
								(parameter) =>
									parameter
										.trim()
										.replace(/^[*/]+/, "")
										.split(/[:=]/, 1)[0]!,
							)
							.filter((parameter) => /^[A-Za-z_]\w*$/.test(parameter))
					: [],
		};
		declarations.push(declaration);
		stack.push(declarations.length - 1);
	}
	return declarations;
}

interface PythonProjectAnalysis {
	declarations: readonly PythonDeclaration[];
	byFile: ReadonlyMap<string, readonly PythonDeclaration[]>;
}

const PYTHON_PROJECT_ANALYSES = new WeakMap<SourceLanguageProject, PythonProjectAnalysis>();

function pythonProjectAnalysis(project: SourceLanguageProject): PythonProjectAnalysis {
	const cached = PYTHON_PROJECT_ANALYSES.get(project);
	if (cached) return cached;
	const declarations = project.files
		.filter((candidate) => extname(candidate.path) === ".py")
		.flatMap(collectPythonDeclarations);
	const byFile = new Map<string, PythonDeclaration[]>();
	for (const declaration of declarations) {
		const values = byFile.get(declaration.filePath) ?? [];
		values.push(declaration);
		byFile.set(declaration.filePath, values);
	}
	const analysis = { declarations, byFile };
	PYTHON_PROJECT_ANALYSES.set(project, analysis);
	return analysis;
}

function uniquePythonDeclaration(
	declarations: readonly PythonDeclaration[],
	name: string,
	targets?: readonly string[],
	kind?: string,
	qualifiedName?: string,
): PythonDeclaration | undefined {
	const targetPaths = targets?.map((target) => target.replace(/^file:/, ""));
	const matches = declarations.filter(
		(declaration) =>
			declaration.name === name &&
			(!targetPaths || targetPaths.includes(declaration.filePath)) &&
			(!kind || declaration.kind === kind) &&
			(qualifiedName === undefined || (declaration.qualifiedName ?? declaration.name) === qualifiedName),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function pythonBindings(file: SourceLanguageFile, paths: ReadonlySet<string>): Map<string, PythonBinding> {
	const bindings = new Map<string, PythonBinding>();
	for (const [index, line] of stripPythonStringsAndComments(file.content).split(/\r?\n/).entries()) {
		if (/^\s/.test(line)) continue;
		const directImport = /^import\s+(.+)$/.exec(line);
		if (directImport) {
			for (const item of directImport[1]!.split(",")) {
				const [specifier, explicitAlias] = item.trim().split(/\s+as\s+/);
				if (!specifier || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(specifier)) continue;
				if (!explicitAlias && specifier.includes(".")) continue;
				const alias = explicitAlias ?? specifier.split(".")[0]!;
				bindings.set(alias, { targets: resolvePythonImport(file.path, specifier, paths), line: index + 1 });
			}
			continue;
		}
		const fromImport = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
		if (!fromImport) continue;
		for (const item of fromImport[2]!.split(",")) {
			const [original, explicitAlias] = item.trim().split(/\s+as\s+/);
			if (!original || !/^[A-Za-z_]\w*$/.test(original)) continue;
			bindings.set(explicitAlias ?? original, {
				original,
				targets: resolvePythonImport(file.path, fromImport[1]!, paths, [original]),
				line: index + 1,
			});
		}
	}
	return bindings;
}

function pythonBindingIsShadowed(
	name: string,
	binding: PythonBinding,
	lines: readonly string[],
	beforeLine = Number.POSITIVE_INFINITY,
): boolean {
	for (let lineNumber = binding.line + 1; lineNumber < beforeLine && lineNumber <= lines.length; lineNumber++) {
		const line = lines[lineNumber - 1]!;
		if (line.trim() === "" || indentation(line) !== 0) continue;
		const matches = [
			/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
			/^(?:async\s+)?for\s+([A-Za-z_]\w*)\s+in\b/,
			/^(?:async\s+)?with\b.*\bas\s+([A-Za-z_]\w*)/,
			/^([A-Za-z_]\w*)\s*(?::[^=]+)?=/,
			/^del\s+([A-Za-z_]\w*)\b/,
		];
		if (matches.some((pattern) => pattern.exec(line)?.[1] === name)) return true;
	}
	return false;
}

function pythonShadowedNames(
	declaration: PythonDeclaration,
	lines: readonly string[],
	beforeLine: number,
): Set<string> {
	const names = new Set(declaration.parameters);
	for (let lineNumber = declaration.line + 1; lineNumber < beforeLine; lineNumber++) {
		const line = lines[lineNumber - 1]!;
		if (line.trim() === "" || indentation(line) <= declaration.indent) continue;
		const patterns = [
			/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
			/^\s*(?:async\s+)?for\s+([A-Za-z_]\w*)\s+in\b/,
			/^\s*(?:async\s+)?with\b.*\bas\s+([A-Za-z_]\w*)/,
			/^\s*except\b.*\bas\s+([A-Za-z_]\w*)/,
			/^\s*([A-Za-z_]\w*)\s*(?::[^=]+)?=/,
		];
		for (const pattern of patterns) {
			const match = pattern.exec(line);
			if (match) names.add(match[1]!);
		}
	}
	return names;
}

const PYTHON_ADAPTER: SourceLanguageAdapter = {
	id: "python-hybrid",
	language: "python",
	precision: "hybrid",
	extensions: [".py"],
	version: "5",
	extract(file, project) {
		const builder = createBuilder(file, PYTHON_ADAPTER);
		const paths = knownPaths(project, ".py");
		const analysis = pythonProjectAnalysis(project);
		const projectDeclarations = analysis.declarations;
		const declarations = analysis.byFile.get(file.path) ?? [];
		for (const declaration of declarations) {
			addDeclaration(builder, declaration, declaration.line);
		}
		const sanitizedLines = stripPythonStringsAndComments(file.content).split(/\r?\n/);
		for (const [index, line] of sanitizedLines.entries()) {
			if (/^\s/.test(line) || line.startsWith("#")) continue;

			const directImport = /^import\s+(.+?)(?:\s+#.*)?$/.exec(line);
			if (directImport) {
				for (const item of directImport[1].split(",")) {
					const specifier = item.trim().split(/\s+as\s+/)[0];
					if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(specifier)) continue;
					addImport(
						builder,
						"python",
						specifier,
						resolvePythonImport(file.path, specifier, paths),
						index + 1,
						line.indexOf(specifier),
					);
				}
				continue;
			}

			const fromImport = /^from\s+([.\w]+)\s+import\s+(.+?)(?:\s+#.*)?$/.exec(line);
			if (!fromImport) continue;
			const importedNames = fromImport[2]
				.split(",")
				.map((name) => name.trim().split(/\s+as\s+/)[0])
				.filter((name) => /^[A-Za-z_]\w*$/.test(name));
			addImport(
				builder,
				"python",
				fromImport[1],
				resolvePythonImport(file.path, fromImport[1], paths, importedNames),
				index + 1,
				line.indexOf(fromImport[1]),
			);
		}
		const bindings = pythonBindings(file, paths);
		const visibleBinding = (name: string, beforeLine?: number): PythonBinding | undefined => {
			const binding = bindings.get(name);
			return binding && !pythonBindingIsShadowed(name, binding, sanitizedLines, beforeLine) ? binding : undefined;
		};
		for (const declaration of declarations.filter((candidate) => candidate.kind === "class")) {
			for (const base of declaration.bases) {
				const [qualifier, member] = base.includes(".") ? base.split(".", 2) : [undefined, base];
				const binding = visibleBinding(qualifier ?? member!, declaration.line);
				if (qualifier && !binding) continue;
				const targetName = qualifier ? member! : (binding?.original ?? member!);
				const sourceName = declaration.qualifiedName ?? declaration.name;
				const parentName = sourceName.includes(".") ? sourceName.slice(0, sourceName.lastIndexOf(".")) : undefined;
				const target =
					uniquePythonDeclaration(
						projectDeclarations,
						targetName,
						binding?.targets ?? [`file:${file.path}`],
						"class",
						targetName,
					) ??
					(!binding && parentName
						? uniquePythonDeclaration(
								projectDeclarations,
								targetName,
								[`file:${file.path}`],
								"class",
								`${parentName}.${targetName}`,
							)
						: undefined);
				if (!target) continue;
				addSemanticEdge(
					builder,
					"extends",
					declarationId(file.path, declaration),
					declarationId(target.filePath, target),
					declaration.line,
					declaration.column,
					base,
					0.95,
				);
			}
		}
		const callPattern = /(?<![.\w])([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(/g;
		const ignoredCalls = new Set(["if", "for", "while", "return", "yield", "super", "print"]);
		for (const [index, line] of sanitizedLines.entries()) {
			const lineNumber = index + 1;
			const declarationOnLine = declarations.find((declaration) => declaration.line === lineNumber);
			const activeSource = declarations
				.filter(
					(declaration) =>
						declaration.kind === "function" &&
						declaration.line < lineNumber &&
						lineNumber < declaration.endLine &&
						declaration.indent < indentation(line),
				)
				.sort((left, right) => right.indent - left.indent)[0];
			const source = declarationOnLine?.kind === "function" ? declarationOnLine : activeSource;
			if (!source) continue;
			const bodyOffset = declarationOnLine ? line.indexOf(":") + 1 : 0;
			if (declarationOnLine && bodyOffset === 0) continue;
			const callSource = line.slice(bodyOffset);
			const shadowedNames = pythonShadowedNames(source, sanitizedLines, lineNumber);
			for (const match of callSource.matchAll(callPattern)) {
				const qualifier = match[2] ? match[1] : undefined;
				const calledName = match[2] ?? match[1]!;
				if (ignoredCalls.has(calledName)) continue;
				if (shadowedNames.has(qualifier ?? calledName) && qualifier !== "self" && qualifier !== "cls") {
					continue;
				}
				const binding = visibleBinding(qualifier ?? calledName);
				let target: PythonDeclaration | undefined;
				if (qualifier) {
					if (binding) {
						target = uniquePythonDeclaration(
							projectDeclarations,
							calledName,
							binding.targets,
							undefined,
							calledName,
						);
					} else if (qualifier === "self" || qualifier === "cls") {
						const sourceName = source.qualifiedName ?? source.name;
						const className = sourceName.includes(".")
							? sourceName.slice(0, sourceName.lastIndexOf("."))
							: undefined;
						if (className) {
							target = uniquePythonDeclaration(
								projectDeclarations,
								calledName,
								[`file:${file.path}`],
								"function",
								`${className}.${calledName}`,
							);
						}
					}
				} else if (binding) {
					target = uniquePythonDeclaration(
						projectDeclarations,
						binding.original ?? calledName,
						binding.targets,
						undefined,
						binding.original ?? calledName,
					);
				} else {
					const sourceName = source.qualifiedName ?? source.name;
					target =
						uniquePythonDeclaration(
							projectDeclarations,
							calledName,
							[`file:${file.path}`],
							undefined,
							calledName,
						) ??
						uniquePythonDeclaration(
							projectDeclarations,
							calledName,
							[`file:${file.path}`],
							undefined,
							`${sourceName}.${calledName}`,
						);
				}
				if (!target) continue;
				addSemanticEdge(
					builder,
					"calls",
					declarationId(file.path, source),
					declarationId(target.filePath, target),
					lineNumber,
					bodyOffset + match.index!,
					match[0],
					binding ? 0.95 : 0.85,
				);
			}
		}
		return finish(builder);
	},
};

function characterLiteralLength(source: string, index: number): number {
	const match =
		/^'(?:\\(?:u\{[0-9A-Fa-f_]+\}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2}|[0-7]{3}|[^\r\n])|[^'\\\r\n])'/u.exec(
			source.slice(index),
		);
	return match?.[0].length ?? 0;
}

function sanitizeCLikeSource(source: string, maskStrings: boolean, maskContinuedStrings: boolean): string {
	let result = "";
	let index = 0;
	let blockComment = false;
	let quote: '"' | "`" | undefined;
	let rawStringTerminator: string | undefined;
	let stringContinued = false;
	while (index < source.length) {
		const current = source[index];
		const next = source[index + 1];
		if (blockComment) {
			if (current === "*" && next === "/") {
				result += "  ";
				index += 2;
				blockComment = false;
				continue;
			}
			result += current === "\n" ? "\n" : " ";
			index++;
			continue;
		}
		if (rawStringTerminator) {
			if (source.startsWith(rawStringTerminator, index)) {
				result +=
					maskStrings || (maskContinuedStrings && stringContinued)
						? " ".repeat(rawStringTerminator.length)
						: rawStringTerminator;
				index += rawStringTerminator.length;
				rawStringTerminator = undefined;
				stringContinued = false;
				continue;
			}
			result += current === "\n" ? "\n" : maskStrings || (maskContinuedStrings && stringContinued) ? " " : current;
			if (current === "\n") stringContinued = true;
			index++;
			continue;
		}
		if (quote) {
			result += current === "\n" ? "\n" : maskStrings || (maskContinuedStrings && stringContinued) ? " " : current;
			if (current === "\n") stringContinued = true;
			if (current === "\\" && quote !== "`" && index + 1 < source.length) {
				const escaped = source[index + 1];
				result +=
					escaped === "\n" ? "\n" : maskStrings || (maskContinuedStrings && stringContinued) ? " " : escaped;
				if (escaped === "\n") stringContinued = true;
				index += 2;
				continue;
			}
			if (current === quote) {
				quote = undefined;
				stringContinued = false;
			}
			index++;
			continue;
		}
		if (current === "/" && next === "*") {
			result += "  ";
			index += 2;
			blockComment = true;
			continue;
		}
		if (current === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") {
				result += " ";
				index++;
			}
			continue;
		}
		if (current === "'") {
			const length = characterLiteralLength(source, index);
			if (length > 0) {
				result += maskStrings ? " ".repeat(length) : source.slice(index, index + length);
				index += length;
				continue;
			}
		}
		const rawPrefixLength = current === "r" ? 1 : (current === "b" || current === "c") && next === "r" ? 2 : 0;
		if (rawPrefixLength > 0 && (index === 0 || !/[A-Za-z0-9_]/.test(source[index - 1]))) {
			let openingEnd = index + rawPrefixLength;
			while (source[openingEnd] === "#") openingEnd++;
			if (source[openingEnd] === '"') {
				const hashes = source.slice(index + rawPrefixLength, openingEnd);
				result += maskStrings ? " ".repeat(openingEnd + 1 - index) : source.slice(index, openingEnd + 1);
				index = openingEnd + 1;
				rawStringTerminator = `"${hashes}`;
				stringContinued = false;
				continue;
			}
		}
		if (current === '"' || current === "`") {
			quote = current;
			stringContinued = false;
			result += maskStrings ? " " : current;
			index++;
			continue;
		}
		result += current;
		index++;
	}
	return result;
}

function stripCLikeComments(source: string): string {
	return sanitizeCLikeSource(source, false, true);
}

function stripCLikeStringsAndComments(source: string): string {
	return sanitizeCLikeSource(source, true, false);
}

function goDeclaration(line: string): DeclarationMatch | undefined {
	const method = /^func\s+\(\s*[A-Za-z_]\w*\s+\*?([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/.exec(line);
	if (method) {
		return {
			kind: "method",
			name: method[2]!,
			qualifiedName: `${method[1]}.${method[2]}`,
			column: line.indexOf(method[2]!),
		};
	}
	const match = /^(func|type|const|var)\s+([A-Za-z_]\w*)/.exec(line);
	if (!match) return undefined;
	const kind = match[1] === "func" ? "function" : match[1] === "type" ? "type" : match[1];
	return { kind, name: match[2], column: line.indexOf(match[2]) };
}

function resolveGoImport(specifier: string, project: SourceLanguageProject): string[] {
	if (!project.goModulePath) return [];
	if (specifier !== project.goModulePath && !specifier.startsWith(`${project.goModulePath}/`)) return [];
	const packagePath = specifier.slice(project.goModulePath.length).replace(/^\//, "");
	return (goProjectAnalysis(project).nonTestFilesByPackagePath.get(packagePath) ?? []).map((path) => `file:${path}`);
}

interface GoImport {
	specifier: string;
	explicitAlias?: string;
	line: number;
	column: number;
}

interface GoDeclaration extends DeclarationMatch {
	filePath: string;
	line: number;
	testFile: boolean;
	packageName?: string;
	packageKey?: string;
}

function collectGoImports(source: string): GoImport[] {
	const imports: GoImport[] = [];
	const lines = source.split(/\r?\n/);
	let inBlock = false;
	for (const [index, line] of lines.entries()) {
		if (!inBlock) {
			const direct = /^\s*import\s+(?:([._A-Za-z]\w*)\s+)?["`]([^"`]+)["`]/.exec(line);
			if (direct) {
				imports.push({
					specifier: direct[2]!,
					...(direct[1] ? { explicitAlias: direct[1] } : {}),
					line: index + 1,
					column: line.indexOf(direct[2]!),
				});
				continue;
			}
			if (/^\s*import\s*\(/.test(line)) inBlock = true;
			continue;
		}
		if (/^\s*\)/.test(line)) {
			inBlock = false;
			continue;
		}
		const entry = /^\s*(?:([._A-Za-z]\w*)\s+)?["`]([^"`]+)["`]/.exec(line);
		if (entry) {
			imports.push({
				specifier: entry[2]!,
				...(entry[1] ? { explicitAlias: entry[1] } : {}),
				line: index + 1,
				column: line.indexOf(entry[2]!),
			});
		}
	}
	return imports;
}

function goPackageName(file: SourceLanguageFile): string | undefined {
	return /^\s*package\s+([A-Za-z_]\w*)\b/m.exec(stripCLikeStringsAndComments(file.content))?.[1];
}

function goPackageKey(file: SourceLanguageFile): string | undefined {
	const packageName = goPackageName(file);
	if (!packageName) return undefined;
	const packagePath = dirname(file.path) === "." ? "" : dirname(file.path);
	return `${packagePath}\0${packageName}`;
}

function collectGoDeclarations(file: SourceLanguageFile): GoDeclaration[] {
	const declarations: GoDeclaration[] = [];
	const source = stripCLikeStringsAndComments(file.content);
	const packageName = goPackageName(file);
	const packagePath = dirname(file.path) === "." ? "" : dirname(file.path);
	const packageKey = packageName ? `${packagePath}\0${packageName}` : undefined;
	let braceDepth = 0;
	for (const [index, line] of source.split(/\r?\n/).entries()) {
		const declaration = braceDepth === 0 ? goDeclaration(line.trimStart()) : undefined;
		if (declaration) {
			declarations.push({
				...declaration,
				column: line.indexOf(declaration.name),
				filePath: file.path,
				line: index + 1,
				testFile: file.path.endsWith("_test.go"),
				...(packageName ? { packageName } : {}),
				...(packageKey ? { packageKey } : {}),
			});
		}
		braceDepth += [...line].filter((character) => character === "{").length;
		braceDepth -= [...line].filter((character) => character === "}").length;
	}
	return declarations;
}

interface GoProjectAnalysis {
	declarations: readonly GoDeclaration[];
	byFile: ReadonlyMap<string, readonly GoDeclaration[]>;
	filesByPath: ReadonlyMap<string, SourceLanguageFile>;
	packageKeysByFile: ReadonlyMap<string, string>;
	nonTestFilesByPackagePath: ReadonlyMap<string, readonly string[]>;
}

const GO_PROJECT_ANALYSES = new WeakMap<SourceLanguageProject, GoProjectAnalysis>();

function goProjectAnalysis(project: SourceLanguageProject): GoProjectAnalysis {
	const cached = GO_PROJECT_ANALYSES.get(project);
	if (cached) return cached;
	const goFiles = project.files.filter((candidate) => extname(candidate.path) === ".go");
	const declarations = goFiles.flatMap(collectGoDeclarations);
	const byFile = new Map<string, GoDeclaration[]>();
	for (const declaration of declarations) {
		const values = byFile.get(declaration.filePath) ?? [];
		values.push(declaration);
		byFile.set(declaration.filePath, values);
	}
	const packageKeysByFile = new Map<string, string>();
	const filesByPath = new Map(goFiles.map((goFile) => [goFile.path, goFile]));
	const nonTestFilesByPackagePath = new Map<string, string[]>();
	for (const goFile of goFiles) {
		const packageKey = goPackageKey(goFile);
		if (packageKey) packageKeysByFile.set(goFile.path, packageKey);
		if (goFile.path.endsWith("_test.go")) continue;
		const packagePath = dirname(goFile.path) === "." ? "" : dirname(goFile.path);
		const values = nonTestFilesByPackagePath.get(packagePath) ?? [];
		values.push(goFile.path);
		nonTestFilesByPackagePath.set(packagePath, values);
	}
	for (const values of nonTestFilesByPackagePath.values()) values.sort(compareStrings);
	const analysis = { declarations, byFile, filesByPath, packageKeysByFile, nonTestFilesByPackagePath };
	GO_PROJECT_ANALYSES.set(project, analysis);
	return analysis;
}

function uniqueGoDeclaration(
	declarations: readonly GoDeclaration[],
	name: string,
	packageKeys: readonly string[],
	kinds?: readonly string[],
	includeTestFiles = true,
): GoDeclaration | undefined {
	const matches = declarations.filter(
		(declaration) =>
			declaration.name === name &&
			declaration.packageKey !== undefined &&
			packageKeys.includes(declaration.packageKey) &&
			(includeTestFiles || !declaration.testFile) &&
			(!kinds || kinds.includes(declaration.kind)),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function goFunctionBindingNames(signature: string): Set<string> {
	const names = new Set<string>();
	const groups: string[] = [];
	let depth = 0;
	let start = -1;
	for (let index = 0; index < signature.length; index++) {
		const character = signature[index]!;
		if (character === "(") {
			if (depth === 0) start = index + 1;
			depth++;
		} else if (character === ")" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) groups.push(signature.slice(start, index));
		}
	}
	for (const group of groups) {
		const entries = group.split(",").map((entry) => entry.trim());
		let pendingNames: string[] = [];
		for (const entry of entries) {
			const identifiers = [...entry.matchAll(/\b[A-Za-z_]\w*\b/g)].map((match) => match[0]);
			if (identifiers.length >= 2) {
				if (!/\s/.test(entry)) {
					pendingNames = [];
					continue;
				}
				for (const pending of pendingNames) names.add(pending);
				pendingNames = [];
				names.add(identifiers[0]!);
			} else if (identifiers.length === 1) {
				pendingNames.push(identifiers[0]!);
			}
		}
	}
	return names;
}

interface ScopedShadow {
	name: string;
	depth: number;
	line: number;
	column: number;
}

function braceDepthAt(source: string, beforeColumn: number, initialDepth: number): number {
	let depth = initialDepth;
	for (let index = 0; index < beforeColumn; index++) {
		if (source[index] === "{") depth++;
		else if (source[index] === "}") depth--;
	}
	return depth;
}

const GO_ADAPTER: SourceLanguageAdapter = {
	id: "go-hybrid",
	language: "go",
	precision: "hybrid",
	extensions: [".go"],
	version: "5",
	extract(file, project) {
		const builder = createBuilder(file, GO_ADAPTER);
		const source = stripCLikeStringsAndComments(file.content);
		const analysis = goProjectAnalysis(project);
		const projectDeclarations = analysis.declarations;
		const declarations = analysis.byFile.get(file.path) ?? [];
		const includeTestFiles = file.path.endsWith("_test.go");
		for (const declaration of declarations) addDeclaration(builder, declaration, declaration.line);
		const imports = collectGoImports(stripCLikeComments(file.content));
		for (const entry of imports) {
			addImport(builder, "go", entry.specifier, resolveGoImport(entry.specifier, project), entry.line, entry.column);
		}
		const packageKey = analysis.packageKeysByFile.get(file.path);
		for (const method of declarations.filter((declaration) => declaration.kind === "method")) {
			const receiver = method.qualifiedName?.split(".")[0];
			if (!receiver || !packageKey) continue;
			const target = uniqueGoDeclaration(projectDeclarations, receiver, [packageKey], ["type"], includeTestFiles);
			if (target) {
				addSemanticEdge(
					builder,
					"defined_on",
					declarationId(file.path, method),
					declarationId(target.filePath, target),
					method.line,
					method.column,
					receiver,
					1,
				);
			}
		}
		const importPackages = new Map<string, string[]>();
		for (const entry of imports) {
			if (entry.explicitAlias === "_" || entry.explicitAlias === ".") continue;
			const targets = resolveGoImport(entry.specifier, project)
				.map((target) => analysis.filesByPath.get(target.replace(/^file:/, "")))
				.filter((target): target is SourceLanguageFile => target !== undefined);
			const packageKeys = [...new Set(targets.map(goPackageKey).filter((key): key is string => key !== undefined))];
			const packageNames = [
				...new Set(targets.map(goPackageName).filter((name): name is string => name !== undefined)),
			];
			const alias = entry.explicitAlias ?? (packageNames.length === 1 ? packageNames[0] : undefined);
			if (alias && packageKeys.length > 0) importPackages.set(alias, packageKeys);
		}
		const callPattern = /(?<![.\w])([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(/g;
		const ignoredCalls = new Set(["if", "for", "switch", "select", "go", "defer", "make", "new", "len", "cap"]);
		let currentFunction: GoDeclaration | undefined;
		let functionDepth = 0;
		let braceDepth = 0;
		let functionBindings = new Set<string>();
		let scopedShadows: ScopedShadow[] = [];
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			scopedShadows = scopedShadows.filter((entry) => entry.depth <= braceDepth);
			const declaration = declarations.find(
				(candidate) =>
					candidate.line === index + 1 && (candidate.kind === "function" || candidate.kind === "method"),
			);
			if (declaration) {
				currentFunction = declaration;
				functionDepth = braceDepth;
				functionBindings = goFunctionBindingNames(
					line.slice(0, line.indexOf("{") >= 0 ? line.indexOf("{") : line.length),
				);
				scopedShadows = [];
			}
			const body = declaration && line.includes("{") ? line.slice(line.indexOf("{") + 1) : line;
			const bodyDepth = declaration && line.includes("{") ? braceDepth + 1 : braceDepth;
			if (currentFunction) {
				for (const binding of body.matchAll(/\b(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|=(?!=))/g)) {
					scopedShadows.push({
						name: binding[1]!,
						depth: braceDepthAt(body, binding.index!, bodyDepth),
						line: index + 1,
						column: binding.index!,
					});
				}
				for (const binding of body.matchAll(/\b(?:var|const|type)\s+([A-Za-z_]\w*)/g)) {
					scopedShadows.push({
						name: binding[1]!,
						depth: braceDepthAt(body, binding.index!, bodyDepth),
						line: index + 1,
						column: binding.index!,
					});
				}
				for (const match of body.matchAll(callPattern)) {
					const qualifier = match[2] ? match[1] : undefined;
					const calledName = match[2] ?? match[1]!;
					if (ignoredCalls.has(calledName)) continue;
					const shadowedName = qualifier ?? calledName;
					const callDepth = braceDepthAt(body, match.index!, bodyDepth);
					if (
						functionBindings.has(shadowedName) ||
						scopedShadows.some(
							(entry) =>
								entry.name === shadowedName &&
								entry.depth <= callDepth &&
								(entry.line < index + 1 || entry.column < match.index!),
						)
					) {
						continue;
					}
					const target = qualifier
						? uniqueGoDeclaration(projectDeclarations, calledName, importPackages.get(qualifier) ?? [])
						: packageKey
							? uniqueGoDeclaration(
									projectDeclarations,
									calledName,
									[packageKey],
									["function"],
									includeTestFiles,
								)
							: undefined;
					if (!target) continue;
					addSemanticEdge(
						builder,
						"calls",
						declarationId(file.path, currentFunction),
						declarationId(target.filePath, target),
						index + 1,
						line.indexOf(match[0]),
						match[0],
						qualifier ? 0.95 : 0.9,
					);
				}
			}
			braceDepth += [...line].filter((character) => character === "{").length;
			braceDepth -= [...line].filter((character) => character === "}").length;
			if (currentFunction && braceDepth <= functionDepth) currentFunction = undefined;
		}
		return finish(builder);
	},
};

function rustDeclaration(line: string): DeclarationMatch | undefined {
	const visibility = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;
	const functionMatch = new RegExp(
		`^${visibility}(?:(?:async|unsafe|const)\\s+)*(?:extern\\s+"[^"]+"\\s+)?fn\\s+([A-Za-z_]\\w*)`,
	).exec(line);
	if (functionMatch) return { kind: "function", name: functionMatch[1], column: line.indexOf(functionMatch[1]) };
	const declarationMatch = new RegExp(
		`^${visibility}(struct|enum|trait|type|const|static|union|mod)\\s+([A-Za-z_]\\w*)`,
	).exec(line);
	if (!declarationMatch) return undefined;
	return {
		kind: declarationMatch[1] === "mod" ? "module" : declarationMatch[1],
		name: declarationMatch[2],
		column: line.indexOf(declarationMatch[2]),
	};
}

function rustCrateRoot(filePath: string, paths: ReadonlySet<string>): string {
	const candidates = [...paths]
		.filter((path) => basename(path) === "lib.rs" || basename(path) === "main.rs")
		.map((path) => (dirname(path) === "." ? "" : dirname(path)))
		.filter(
			(path) =>
				path === "" ||
				filePath === `${path}/lib.rs` ||
				filePath === `${path}/main.rs` ||
				filePath.startsWith(`${path}/`),
		)
		.sort((left, right) => right.length - left.length || compareStrings(left, right));
	return candidates[0] ?? (dirname(filePath) === "." ? "" : dirname(filePath));
}

function rustModuleBase(filePath: string): string {
	const directory = dirname(filePath) === "." ? "" : dirname(filePath);
	const fileName = basename(filePath);
	if (fileName === "lib.rs" || fileName === "main.rs" || fileName === "mod.rs") return directory;
	const stem = fileName.slice(0, -extname(fileName).length);
	return [directory, stem].filter(Boolean).join("/");
}

function rustModuleCandidates(base: string, segments: readonly string[]): string[] {
	const path = [base, ...segments].filter(Boolean).join("/");
	return path ? [`${path}.rs`, `${path}/mod.rs`] : [];
}

function resolveRustModule(filePath: string, specifier: string, paths: ReadonlySet<string>): string[] {
	const segments = specifier.replace(/\{.*$/, "").split("::").filter(Boolean);
	if (segments.length === 0) return [];
	let base: string;
	if (segments[0] === "crate") {
		segments.shift();
		base = rustCrateRoot(filePath, paths);
	} else if (segments[0] === "self") {
		segments.shift();
		base = rustModuleBase(filePath);
	} else if (segments[0] === "super") {
		base = rustModuleBase(filePath);
		while (segments[0] === "super") {
			segments.shift();
			base = dirname(base) === "." ? "" : dirname(base);
		}
	} else {
		return [];
	}
	for (let length = segments.length; length > 0; length--) {
		const resolved = firstExisting(rustModuleCandidates(base, segments.slice(0, length)), paths);
		if (resolved.length > 0) return resolved;
	}
	return [];
}

interface RustDeclaration extends DeclarationMatch {
	filePath: string;
	line: number;
	implType?: string;
}

interface RustImplementation {
	line: number;
	column: number;
	typeName: string;
	traitName?: string;
	traitSpecifier?: string;
}

function maskRustMacroInvocations(source: string): string {
	const characters = source.split("");
	const pattern = /\b(?:macro_rules\s*!\s*[A-Za-z_]\w*|[A-Za-z_]\w*\s*!)\s*([([{])/g;
	const closing = new Map([
		["(", ")"],
		["[", "]"],
		["{", "}"],
	]);
	let match = pattern.exec(source);
	while (match) {
		const openingIndex = match.index! + match[0].lastIndexOf(match[1]!);
		const stack = [closing.get(match[1]!)!];
		let end = openingIndex + 1;
		while (end < source.length && stack.length > 0) {
			const character = source[end]!;
			const nestedClosing = closing.get(character);
			if (nestedClosing) stack.push(nestedClosing);
			else if (character === stack.at(-1)) stack.pop();
			end++;
		}
		if (stack.length === 0) {
			for (let index = match.index!; index < end; index++) {
				if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
			}
			pattern.lastIndex = end;
		}
		match = pattern.exec(source);
	}
	return characters.join("");
}

function rustImplBodyStartsOnLine(line: string): boolean {
	const opening = line.lastIndexOf("{");
	if (opening < 0) return false;
	return opening > Math.max(line.lastIndexOf(">"), line.lastIndexOf(")"), line.lastIndexOf("]"));
}

function collectRustDeclarations(file: SourceLanguageFile): {
	declarations: RustDeclaration[];
	implementations: RustImplementation[];
} {
	const declarations: RustDeclaration[] = [];
	const implementations: RustImplementation[] = [];
	const source = maskRustMacroInvocations(stripCLikeStringsAndComments(file.content));
	let braceDepth = 0;
	let activeImpl: { typeName: string; depth: number; opened: boolean } | undefined;
	for (const [index, line] of source.split(/\r?\n/).entries()) {
		const trimmed = line.trimStart();
		const impl = /^(?:unsafe\s+)?impl(?:<[^>]+>\s*)?\s*(?:(.+?)\s+for\s+)?([A-Za-z_]\w*)/.exec(trimmed);
		if (impl) {
			const traitSpecifier = impl[1]?.trim();
			const traitName = traitSpecifier?.split("::").at(-1);
			const typeName = impl[2]!;
			implementations.push({
				line: index + 1,
				column: line.indexOf(typeName),
				typeName,
				...(traitName ? { traitName } : {}),
				...(traitSpecifier ? { traitSpecifier } : {}),
			});
			activeImpl = { typeName, depth: braceDepth, opened: rustImplBodyStartsOnLine(line) };
		}
		const declaration = rustDeclaration(trimmed);
		const directImpl = activeImpl?.opened && braceDepth === activeImpl.depth + 1 ? activeImpl : undefined;
		if (declaration && (braceDepth === 0 || directImpl)) {
			declarations.push({
				...declaration,
				kind: directImpl && declaration.kind === "function" ? "method" : declaration.kind,
				qualifiedName:
					directImpl && declaration.kind === "function"
						? `${directImpl.typeName}.${declaration.name}`
						: declaration.qualifiedName,
				column: line.indexOf(declaration.name),
				filePath: file.path,
				line: index + 1,
				...(directImpl ? { implType: directImpl.typeName } : {}),
			});
		}
		braceDepth += [...line].filter((character) => character === "{").length;
		braceDepth -= [...line].filter((character) => character === "}").length;
		if (activeImpl && !activeImpl.opened && braceDepth > activeImpl.depth) activeImpl.opened = true;
		if (activeImpl?.opened && braceDepth <= activeImpl.depth) activeImpl = undefined;
	}
	return { declarations, implementations };
}

interface RustProjectAnalysis {
	declarations: readonly RustDeclaration[];
	byFile: ReadonlyMap<
		string,
		{ declarations: readonly RustDeclaration[]; implementations: readonly RustImplementation[] }
	>;
}

const RUST_PROJECT_ANALYSES = new WeakMap<SourceLanguageProject, RustProjectAnalysis>();

function rustProjectAnalysis(project: SourceLanguageProject): RustProjectAnalysis {
	const cached = RUST_PROJECT_ANALYSES.get(project);
	if (cached) return cached;
	const byFile = new Map<
		string,
		{ declarations: readonly RustDeclaration[]; implementations: readonly RustImplementation[] }
	>();
	const declarations: RustDeclaration[] = [];
	for (const file of project.files) {
		if (extname(file.path) !== ".rs") continue;
		const extraction = collectRustDeclarations(file);
		byFile.set(file.path, extraction);
		declarations.push(...extraction.declarations);
	}
	const analysis = { declarations, byFile };
	RUST_PROJECT_ANALYSES.set(project, analysis);
	return analysis;
}

function uniqueRustDeclaration(
	declarations: readonly RustDeclaration[],
	name: string,
	targets?: readonly string[],
	kinds?: readonly string[],
	qualifiedName?: string,
): RustDeclaration | undefined {
	const targetPaths = targets?.map((target) => target.replace(/^file:/, ""));
	const matches = declarations.filter(
		(declaration) =>
			declaration.name === name &&
			(!targetPaths || targetPaths.includes(declaration.filePath)) &&
			(!kinds || kinds.includes(declaration.kind)) &&
			(qualifiedName === undefined || (declaration.qualifiedName ?? declaration.name) === qualifiedName),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function rustBindings(file: SourceLanguageFile, paths: ReadonlySet<string>): Map<string, PythonBinding> {
	const bindings = new Map<string, PythonBinding>();
	for (const [index, line] of stripCLikeComments(file.content).split(/\r?\n/).entries()) {
		const use = /^(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/.exec(line.trimStart());
		if (!use || use[1]!.includes("{") || use[1]!.includes("*")) continue;
		const [specifier, explicitAlias] = use[1]!.trim().split(/\s+as\s+/);
		const original = specifier?.split("::").at(-1);
		if (!specifier || !original || !/^[A-Za-z_]\w*$/.test(original)) continue;
		bindings.set(explicitAlias ?? original, {
			original,
			targets: resolveRustModule(file.path, specifier, paths),
			line: index + 1,
		});
	}
	return bindings;
}

function rustFunctionBindingNames(signature: string): Set<string> {
	const names = new Set<string>();
	for (const match of signature.matchAll(/\b(?:mut\s+)?([A-Za-z_]\w*)\s*:/g)) names.add(match[1]!);
	if (/\(\s*(?:&\s*(?:mut\s+)?)?self\b/.test(signature)) names.add("self");
	return names;
}

const RUST_ADAPTER: SourceLanguageAdapter = {
	id: "rust-hybrid",
	language: "rust",
	precision: "hybrid",
	extensions: [".rs"],
	version: "5",
	extract(file, project) {
		const builder = createBuilder(file, RUST_ADAPTER);
		const paths = knownPaths(project, ".rs");
		const source = maskRustMacroInvocations(stripCLikeStringsAndComments(file.content));
		const analysis = rustProjectAnalysis(project);
		const current = analysis.byFile.get(file.path);
		if (!current) throw new Error(`Rust project analysis omitted source file: ${file.path}`);
		const projectDeclarations = analysis.declarations;
		const bindings = rustBindings(file, paths);
		for (const declaration of current.declarations) addDeclaration(builder, declaration, declaration.line);
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (/^\s/.test(line)) continue;

			const module = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(line);
			if (module) {
				addImport(
					builder,
					"rust",
					`self::${module[1]}`,
					firstExisting(rustModuleCandidates(rustModuleBase(file.path), [module[1]]), paths),
					index + 1,
					line.indexOf(module[1]),
					module[1],
				);
			}

			const use = /^(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/.exec(line);
			if (!use) continue;
			addImport(
				builder,
				"rust",
				use[1].trim(),
				resolveRustModule(file.path, use[1].trim(), paths),
				index + 1,
				line.indexOf(use[1]),
			);
		}
		for (const implementation of current.implementations) {
			const typeBinding = bindings.get(implementation.typeName);
			const typeTarget = uniqueRustDeclaration(
				projectDeclarations,
				typeBinding?.original ?? implementation.typeName,
				typeBinding?.targets ?? [`file:${file.path}`],
				["struct", "enum", "union", "type"],
			);
			if (!implementation.traitName || !typeTarget) continue;
			const traitBinding = bindings.get(implementation.traitName);
			const explicitlyResolvedTraitTargets = implementation.traitSpecifier
				? resolveRustModule(file.path, implementation.traitSpecifier, paths)
				: [];
			const traitTarget = uniqueRustDeclaration(
				projectDeclarations,
				traitBinding?.original ?? implementation.traitName,
				traitBinding?.targets ??
					(explicitlyResolvedTraitTargets.length > 0 ? explicitlyResolvedTraitTargets : [`file:${file.path}`]),
				["trait"],
			);
			if (!traitTarget) continue;
			let implementationSourceId = declarationId(typeTarget.filePath, typeTarget);
			if (typeTarget.filePath !== file.path) {
				implementationSourceId = addDeclaration(
					builder,
					{
						kind: "implementation",
						name: implementation.typeName,
						qualifiedName: `${implementation.traitSpecifier ?? implementation.traitName}:for:${implementation.typeName}`,
						column: implementation.column,
					},
					implementation.line,
				);
				addSemanticEdge(
					builder,
					"defined_on",
					implementationSourceId,
					declarationId(typeTarget.filePath, typeTarget),
					implementation.line,
					implementation.column,
					implementation.typeName,
					0.95,
				);
			}
			addSemanticEdge(
				builder,
				"implements",
				implementationSourceId,
				declarationId(traitTarget.filePath, traitTarget),
				implementation.line,
				implementation.column,
				implementation.traitName,
				0.9,
			);
		}
		for (const method of current.declarations.filter((declaration) => declaration.kind === "method")) {
			const typeBinding = method.implType ? bindings.get(method.implType) : undefined;
			const target = method.implType
				? uniqueRustDeclaration(
						projectDeclarations,
						typeBinding?.original ?? method.implType,
						typeBinding?.targets ?? [`file:${file.path}`],
						["struct", "enum", "union", "type"],
					)
				: undefined;
			if (target) {
				addSemanticEdge(
					builder,
					"defined_on",
					declarationId(file.path, method),
					declarationId(target.filePath, target),
					method.line,
					method.column,
					method.implType!,
					1,
				);
			}
		}
		const callPattern = /(?<![.\w])([A-Za-z_]\w*)(?:::([A-Za-z_]\w*))?\s*\(/g;
		const ignoredCalls = new Set(["if", "for", "while", "loop", "match", "Some", "Ok", "Err"]);
		let currentFunction: RustDeclaration | undefined;
		let functionDepth = 0;
		let braceDepth = 0;
		let functionBindings = new Set<string>();
		let scopedShadows: ScopedShadow[] = [];
		let ignoredNestedFunctionDepth: number | undefined;
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			scopedShadows = scopedShadows.filter((entry) => entry.depth <= braceDepth);
			const declaration = current.declarations.find(
				(candidate) =>
					candidate.line === index + 1 && (candidate.kind === "function" || candidate.kind === "method"),
			);
			if (declaration) {
				currentFunction = declaration;
				functionDepth = braceDepth;
				functionBindings = rustFunctionBindingNames(
					line.slice(0, line.indexOf("{") >= 0 ? line.indexOf("{") : line.length),
				);
				scopedShadows = [];
			}
			const nestedFunction =
				!declaration && currentFunction && rustDeclaration(line.trimStart())?.kind === "function";
			if (nestedFunction && ignoredNestedFunctionDepth === undefined) {
				ignoredNestedFunctionDepth = braceDepth;
			}
			const body = declaration && line.includes("{") ? line.slice(line.indexOf("{") + 1) : line;
			const bodyDepth = declaration && line.includes("{") ? braceDepth + 1 : braceDepth;
			if (currentFunction && ignoredNestedFunctionDepth === undefined) {
				for (const binding of body.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)/g)) {
					scopedShadows.push({
						name: binding[1]!,
						depth: braceDepthAt(body, binding.index!, bodyDepth),
						line: index + 1,
						column: binding.index!,
					});
				}
				for (const match of body.matchAll(callPattern)) {
					const qualifier = match[2] ? match[1] : undefined;
					const calledName = match[2] ?? match[1]!;
					if (ignoredCalls.has(calledName)) continue;
					const shadowedName = qualifier ?? calledName;
					const callDepth = braceDepthAt(body, match.index!, bodyDepth);
					if (
						functionBindings.has(shadowedName) ||
						scopedShadows.some(
							(entry) =>
								entry.name === shadowedName &&
								entry.depth <= callDepth &&
								(entry.line < index + 1 || entry.column < match.index!),
						)
					) {
						continue;
					}
					const binding = bindings.get(qualifier ?? calledName);
					const localType = qualifier
						? uniqueRustDeclaration(
								projectDeclarations,
								qualifier,
								[`file:${file.path}`],
								["struct", "enum", "union", "type"],
							)
						: undefined;
					const target = qualifier
						? binding
							? uniqueRustDeclaration(projectDeclarations, calledName, binding.targets, ["method", "function"])
							: localType
								? uniqueRustDeclaration(
										projectDeclarations,
										calledName,
										[`file:${file.path}`],
										["method"],
										`${localType.name}.${calledName}`,
									)
								: undefined
						: uniqueRustDeclaration(
								projectDeclarations,
								binding?.original ?? calledName,
								binding?.targets ?? [`file:${file.path}`],
								["function"],
							);
					if (!target) continue;
					addSemanticEdge(
						builder,
						"calls",
						declarationId(file.path, currentFunction),
						declarationId(target.filePath, target),
						index + 1,
						line.indexOf(match[0]),
						match[0],
						binding ? 0.9 : 0.85,
					);
				}
			}
			braceDepth += [...line].filter((character) => character === "{").length;
			braceDepth -= [...line].filter((character) => character === "}").length;
			if (ignoredNestedFunctionDepth !== undefined && braceDepth <= ignoredNestedFunctionDepth) {
				ignoredNestedFunctionDepth = undefined;
			}
			if (currentFunction && braceDepth <= functionDepth) currentFunction = undefined;
		}
		return finish(builder);
	},
};

export const SOURCE_LANGUAGE_ADAPTERS: readonly SourceLanguageAdapter[] = [PYTHON_ADAPTER, GO_ADAPTER, RUST_ADAPTER];

export const SOURCE_LANGUAGE_ADAPTER_DESCRIPTORS: readonly SourceLanguageAdapterDescriptor[] =
	SOURCE_LANGUAGE_ADAPTERS.map(({ id, language, precision, extensions }) => ({
		id,
		language,
		precision,
		extensions,
	}));

export function isSupportedSourceLanguageFile(filePath: string): boolean {
	return SOURCE_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

export function sourceLanguageAdapterFor(filePath: string): SourceLanguageAdapter | undefined {
	const extension = extname(filePath).toLowerCase();
	return SOURCE_LANGUAGE_ADAPTERS.find((adapter) => adapter.extensions.includes(extension));
}

export function extractSourceLanguageFile(
	file: SourceLanguageFile,
	project: SourceLanguageProject,
): CodeGraphExtraction | undefined {
	return sourceLanguageAdapterFor(file.path)?.extract(file, project);
}

export function parseGoModulePath(content: string | undefined): string | undefined {
	if (!content) return undefined;
	const match = /^\s*module\s+(\S+)\s*(?:\/\/.*)?$/m.exec(content);
	return match?.[1];
}
