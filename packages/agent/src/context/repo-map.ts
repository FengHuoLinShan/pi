import { type CompiledContext, type ContextFragment, compileContext } from "./context-compiler.ts";

/** Caller-provided symbol metadata. No parser or filesystem is implied. */
export interface RepoMapSymbol {
	name: string;
	kind?: string;
	signature?: string;
	line?: number;
	endLine?: number;
	exported?: boolean;
	summary?: string;
}

/** Caller-provided facts for one repository file. */
export interface RepoMapFile {
	path: string;
	language?: string;
	hash?: string;
	summary?: string;
	imports?: readonly string[];
	symbols?: readonly RepoMapSymbol[];
	/** Higher-priority files are admitted first. Defaults to zero. */
	priority?: number;
	/** Optional cap for this file's rendered map fragment. */
	maxTokens?: number;
	/** Evidence ids that support the supplied file facts. */
	evidenceIds?: readonly string[];
}

export interface RepoMapRequest {
	root?: string;
	tokenBudget: number;
	reserveTokens?: number;
	files: readonly RepoMapFile[];
}

export interface CompiledRepoMapFile {
	path: string;
	truncated: boolean;
	estimatedTokens: number;
	evidenceIds: string[];
}

/** Serializable repository map built only from facts supplied by the caller. */
export interface RepoMapSummary {
	revision: 1;
	root?: string;
	text: string;
	estimatedTokens: number;
	files: CompiledRepoMapFile[];
	omittedFiles: string[];
	compiledContext: CompiledContext;
}

export type RepoMapErrorCode = "invalid_argument" | "duplicate_file";

export class RepoMapError extends Error {
	public code: RepoMapErrorCode;
	public path?: string;

	constructor(code: RepoMapErrorCode, message: string, path?: string) {
		super(message);
		this.name = "RepoMapError";
		this.code = code;
		this.path = path;
	}
}

/** Build a deterministic, budgeted repository map without reading the filesystem. */
export function buildRepoMap(request: RepoMapRequest): RepoMapSummary {
	const normalizedFiles = normalizeFiles(request.files);
	const fragments: ContextFragment[] = normalizedFiles.map((file) => ({
		id: fileFragmentId(file.path),
		kind: "repo_map_file",
		content: renderRepoMapFile(file),
		priority: file.priority ?? 0,
		order: 0,
		minTokens: 8,
		maxTokens: file.maxTokens,
		truncation: "head",
		evidenceIds: file.evidenceIds,
	}));

	if (request.root !== undefined) assertSingleLineNonEmpty(request.root, "Repository root");
	fragments.push({
		id: "repo-map:header",
		kind: "repo_map",
		content: `repository: ${request.root ?? "."}\nfiles supplied: ${normalizedFiles.length}`,
		priority: Number.MAX_SAFE_INTEGER,
		order: -1,
		required: true,
		minTokens: 1,
		truncation: "head",
	});

	const compiledContext = compileContext({
		tokenBudget: request.tokenBudget,
		reserveTokens: request.reserveTokens,
		fragments,
	});
	const filesById = new Map(normalizedFiles.map((file) => [fileFragmentId(file.path), file]));
	const files = compiledContext.fragments.flatMap((fragment): CompiledRepoMapFile[] => {
		const file = filesById.get(fragment.id);
		if (!file) return [];
		return [
			{
				path: file.path,
				truncated: fragment.truncated,
				estimatedTokens: fragment.estimatedTokens,
				evidenceIds: [...fragment.evidenceIds],
			},
		];
	});
	const omittedFiles = compiledContext.omitted
		.flatMap((omitted): string[] => {
			const file = filesById.get(omitted.id);
			return file ? [file.path] : [];
		})
		.sort(compareStrings);

	return {
		revision: 1,
		root: request.root,
		text: compiledContext.text,
		estimatedTokens: compiledContext.estimatedTokens,
		files,
		omittedFiles,
		compiledContext,
	};
}

function normalizeFiles(files: readonly RepoMapFile[]): RepoMapFile[] {
	const paths = new Set<string>();
	return [...files]
		.map((file): RepoMapFile => {
			assertSingleLineNonEmpty(file.path, "Repository file path");
			if (paths.has(file.path)) {
				throw new RepoMapError("duplicate_file", `Duplicate repository file path: ${file.path}`, file.path);
			}
			paths.add(file.path);
			if (file.priority !== undefined && !Number.isFinite(file.priority)) {
				throw new RepoMapError(
					"invalid_argument",
					`Repository file ${file.path} priority must be finite`,
					file.path,
				);
			}
			if (file.maxTokens !== undefined && (!Number.isInteger(file.maxTokens) || file.maxTokens <= 0)) {
				throw new RepoMapError(
					"invalid_argument",
					`Repository file ${file.path} maximum tokens must be a positive integer`,
					file.path,
				);
			}
			if (file.language !== undefined)
				assertSingleLineNonEmpty(file.language, `Repository file ${file.path} language`);
			if (file.hash !== undefined) assertSingleLineNonEmpty(file.hash, `Repository file ${file.path} hash`);
			const imports = [...new Set(file.imports ?? [])].map((imported) => {
				assertSingleLineNonEmpty(imported, `Repository file ${file.path} import`);
				return imported;
			});
			const symbols = [...(file.symbols ?? [])].map((symbol) => normalizeSymbol(symbol, file.path));
			const evidenceIds = [...new Set(file.evidenceIds ?? [])];
			for (const evidenceId of evidenceIds) {
				assertSingleLineNonEmpty(evidenceId, `Repository file ${file.path} evidence id`);
			}
			return {
				...file,
				imports: imports.sort(compareStrings),
				symbols: symbols.sort(compareSymbols),
				evidenceIds: evidenceIds.sort(compareStrings),
			};
		})
		.sort((left, right) => compareStrings(left.path, right.path));
}

function renderRepoMapFile(file: RepoMapFile): string {
	const lines = [`file: ${file.path}`];
	if (file.language) lines.push(`language: ${file.language}`);
	if (file.hash) lines.push(`hash: ${file.hash}`);
	if (file.summary) lines.push(`summary: ${singleLine(file.summary)}`);
	if (file.imports && file.imports.length > 0) {
		lines.push("imports:");
		for (const imported of file.imports) lines.push(`  - ${singleLine(imported)}`);
	}
	if (file.symbols && file.symbols.length > 0) {
		lines.push("symbols:");
		for (const symbol of file.symbols) lines.push(`  - ${renderSymbol(symbol)}`);
	}
	return lines.join("\n");
}

function renderSymbol(symbol: RepoMapSymbol): string {
	const fields: string[] = [];
	if (symbol.exported) fields.push("export");
	if (symbol.kind) fields.push(singleLine(symbol.kind));
	fields.push(symbol.name);
	if (symbol.line !== undefined) fields.push(`@${symbol.line}${symbol.endLine ? `-${symbol.endLine}` : ""}`);
	if (symbol.signature) fields.push(`:: ${singleLine(symbol.signature)}`);
	if (symbol.summary) fields.push(`-- ${singleLine(symbol.summary)}`);
	return fields.join(" ");
}

function normalizeSymbol(symbol: RepoMapSymbol, path: string): RepoMapSymbol {
	assertSingleLineNonEmpty(symbol.name, `Repository file ${path} symbol name`);
	if (symbol.line !== undefined && (!Number.isInteger(symbol.line) || symbol.line <= 0)) {
		throw new RepoMapError(
			"invalid_argument",
			`Repository symbol ${symbol.name} line must be a positive integer`,
			path,
		);
	}
	if (
		symbol.endLine !== undefined &&
		(symbol.line === undefined || !Number.isInteger(symbol.endLine) || symbol.endLine < symbol.line)
	) {
		throw new RepoMapError(
			"invalid_argument",
			`Repository symbol ${symbol.name} end line must be at or after its start line`,
			path,
		);
	}
	if (symbol.kind !== undefined) assertSingleLineNonEmpty(symbol.kind, `Repository symbol ${symbol.name} kind`);
	return {
		...symbol,
		signature: symbol.signature === undefined ? undefined : singleLine(symbol.signature),
		summary: symbol.summary === undefined ? undefined : singleLine(symbol.summary),
	};
}

function compareSymbols(left: RepoMapSymbol, right: RepoMapSymbol): number {
	return (
		(left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
		compareStrings(left.name, right.name) ||
		compareStrings(left.signature ?? "", right.signature ?? "")
	);
}

function fileFragmentId(path: string): string {
	return `repo-map:file:${path}`;
}

function singleLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function assertSingleLineNonEmpty(value: string, label: string): void {
	if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
		throw new RepoMapError("invalid_argument", `${label} must be a non-empty single-line string`);
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
