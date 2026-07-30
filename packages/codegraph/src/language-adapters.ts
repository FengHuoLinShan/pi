import { basename, dirname, extname } from "node:path";
import type {
	CodeGraphExtractedEdge,
	CodeGraphExtractedNode,
	CodeGraphExtraction,
	CodeGraphSourceRange,
} from "@earendil-works/pi-coding-agent";

export const SOURCE_LANGUAGE_EXTENSIONS = [".py", ".go", ".rs"] as const;
export const SOURCE_LANGUAGE_ADAPTER_VERSION = "python-structural@2;go-structural@2;rust-structural@2";

export interface SourceLanguageFile {
	path: string;
	content: string;
}

export interface SourceLanguageProject {
	files: readonly SourceLanguageFile[];
	goModulePath?: string;
}

export interface SourceLanguageAdapterDescriptor {
	id: string;
	language: string;
	precision: "structural";
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
}

const SOURCE_EXTENSION_SET = new Set<string>(SOURCE_LANGUAGE_EXTENSIONS);

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

function addDeclaration(builder: ExtractionBuilder, match: DeclarationMatch, line: number): void {
	const id = `symbol:${builder.file.path}:${match.kind}:${match.name}`;
	if (builder.nodes.has(id)) return;
	builder.nodes.set(id, {
		id,
		kind: match.kind,
		name: match.name,
		range: sourceRange(line, match.column, match.name.length),
		attributes: { precision: "structural" },
	});
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

function finish(builder: ExtractionBuilder): CodeGraphExtraction {
	return {
		nodes: [...builder.nodes.values()].sort((left, right) => compareStrings(left.id, right.id)),
		edges: [...builder.edges.values()].sort((left, right) => compareStrings(left.id, right.id)),
	};
}

function knownPaths(project: SourceLanguageProject, extension: string): Set<string> {
	return new Set(project.files.filter((file) => extname(file.path) === extension).map((file) => file.path));
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

function pythonDeclaration(line: string): DeclarationMatch | undefined {
	const match = /^(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/.exec(line);
	if (!match) return undefined;
	return {
		kind: match[1] === "def" ? "function" : "class",
		name: match[2],
		column: line.indexOf(match[2]),
	};
}

const PYTHON_ADAPTER: SourceLanguageAdapter = {
	id: "python-structural",
	language: "python",
	precision: "structural",
	extensions: [".py"],
	version: "2",
	extract(file, project) {
		const builder = createBuilder(file, PYTHON_ADAPTER);
		const paths = knownPaths(project, ".py");
		for (const [index, line] of file.content.split(/\r?\n/).entries()) {
			if (/^\s/.test(line) || line.startsWith("#")) continue;
			const declaration = pythonDeclaration(line);
			if (declaration) addDeclaration(builder, declaration, index + 1);

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
		return finish(builder);
	},
};

function stripCLikeComments(source: string): string {
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
				result += stringContinued ? " ".repeat(rawStringTerminator.length) : rawStringTerminator;
				index += rawStringTerminator.length;
				rawStringTerminator = undefined;
				stringContinued = false;
				continue;
			}
			result += current === "\n" ? "\n" : stringContinued ? " " : current;
			if (current === "\n") stringContinued = true;
			index++;
			continue;
		}
		if (quote) {
			result += current === "\n" ? "\n" : stringContinued ? " " : current;
			if (current === "\n") stringContinued = true;
			if (current === "\\" && quote !== "`" && index + 1 < source.length) {
				const escaped = source[index + 1];
				result += escaped === "\n" ? "\n" : stringContinued ? " " : escaped;
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
		const rawPrefixLength = current === "r" ? 1 : (current === "b" || current === "c") && next === "r" ? 2 : 0;
		if (rawPrefixLength > 0 && (index === 0 || !/[A-Za-z0-9_]/.test(source[index - 1]))) {
			let openingEnd = index + rawPrefixLength;
			while (source[openingEnd] === "#") openingEnd++;
			if (source[openingEnd] === '"') {
				const hashes = source.slice(index + rawPrefixLength, openingEnd);
				result += source.slice(index, openingEnd + 1);
				index = openingEnd + 1;
				rawStringTerminator = `"${hashes}`;
				stringContinued = false;
				continue;
			}
		}
		if (current === '"' || current === "`") {
			quote = current;
			stringContinued = false;
		}
		result += current;
		index++;
	}
	return result;
}

function goDeclaration(line: string): DeclarationMatch | undefined {
	const method = /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/.exec(line);
	if (method) return { kind: "method", name: method[1], column: line.indexOf(method[1]) };
	const match = /^(func|type|const|var)\s+([A-Za-z_]\w*)/.exec(line);
	if (!match) return undefined;
	const kind = match[1] === "func" ? "function" : match[1] === "type" ? "type" : match[1];
	return { kind, name: match[2], column: line.indexOf(match[2]) };
}

function resolveGoImport(specifier: string, project: SourceLanguageProject): string[] {
	if (!project.goModulePath) return [];
	if (specifier !== project.goModulePath && !specifier.startsWith(`${project.goModulePath}/`)) return [];
	const packagePath = specifier.slice(project.goModulePath.length).replace(/^\//, "");
	return project.files
		.map((file) => file.path)
		.filter(
			(path) =>
				extname(path) === ".go" &&
				!path.endsWith("_test.go") &&
				(dirname(path) === "." ? "" : dirname(path)) === packagePath,
		)
		.sort(compareStrings)
		.map((path) => `file:${path}`);
}

function collectGoImports(source: string): Array<{ specifier: string; line: number; column: number }> {
	const imports: Array<{ specifier: string; line: number; column: number }> = [];
	const lines = source.split(/\r?\n/);
	let inBlock = false;
	for (const [index, line] of lines.entries()) {
		if (!inBlock) {
			const direct = /^import\s+(?:[._A-Za-z]\w*\s+)?["`]([^"`]+)["`]/.exec(line);
			if (direct) {
				imports.push({ specifier: direct[1], line: index + 1, column: line.indexOf(direct[1]) });
				continue;
			}
			if (/^import\s*\(/.test(line)) inBlock = true;
			continue;
		}
		if (/^\s*\)/.test(line)) {
			inBlock = false;
			continue;
		}
		const entry = /^\s*(?:[._A-Za-z]\w*\s+)?["`]([^"`]+)["`]/.exec(line);
		if (entry) imports.push({ specifier: entry[1], line: index + 1, column: line.indexOf(entry[1]) });
	}
	return imports;
}

const GO_ADAPTER: SourceLanguageAdapter = {
	id: "go-structural",
	language: "go",
	precision: "structural",
	extensions: [".go"],
	version: "2",
	extract(file, project) {
		const builder = createBuilder(file, GO_ADAPTER);
		const source = stripCLikeComments(file.content);
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (/^\s/.test(line)) continue;
			const declaration = goDeclaration(line);
			if (declaration) addDeclaration(builder, declaration, index + 1);
		}
		for (const entry of collectGoImports(source)) {
			addImport(builder, "go", entry.specifier, resolveGoImport(entry.specifier, project), entry.line, entry.column);
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

const RUST_ADAPTER: SourceLanguageAdapter = {
	id: "rust-structural",
	language: "rust",
	precision: "structural",
	extensions: [".rs"],
	version: "2",
	extract(file, project) {
		const builder = createBuilder(file, RUST_ADAPTER);
		const paths = knownPaths(project, ".rs");
		const source = stripCLikeComments(file.content);
		for (const [index, line] of source.split(/\r?\n/).entries()) {
			if (/^\s/.test(line)) continue;
			const declaration = rustDeclaration(line);
			if (declaration) addDeclaration(builder, declaration, index + 1);

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
