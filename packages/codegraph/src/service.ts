import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
	buildCodeImpactMap,
	type CodeGraphEdge,
	CodeGraphError,
	type CodeGraphExtraction,
	type CodeGraphNode,
	type CodeGraphPath,
	type CodeGraphQueryOptions,
	type CodeGraphQueryResult,
	type CodeGraphSnapshot,
	type CodeImpactMap,
	computeCodeGraphFileRevision,
	getAgentDir,
	IncrementalCodeGraph,
} from "@earendil-works/pi-coding-agent";
import ts from "typescript";
import {
	extractSourceLanguageFile,
	isSupportedSourceLanguageFile,
	parseGoModulePath,
	SOURCE_LANGUAGE_ADAPTER_DESCRIPTORS,
	SOURCE_LANGUAGE_ADAPTER_VERSION,
	SOURCE_LANGUAGE_EXTENSIONS,
	type SourceLanguageFile,
	type SourceLanguageProject,
} from "./language-adapters.ts";
import {
	extractTypeScriptProgram,
	isSupportedTypeScriptFile,
	TYPESCRIPT_CODE_GRAPH_EXTENSIONS,
	toWorkspaceRelativePath,
} from "./typescript-extractor.ts";

const CACHE_VERSION = 1;
const CACHE_FILE_NAME = "index.json";
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_COUNT = 800;
const LOCK_RETRY_MS = 25;
const PARSER_VERSION = `${ts.version};${SOURCE_LANGUAGE_ADAPTER_VERSION}`;
const SOURCE_EXCLUDES = [
	"**/node_modules/**",
	"**/.git/**",
	"**/dist/**",
	"**/build/**",
	"**/.next/**",
	"**/coverage/**",
	"**/vendor/**",
] as const;

export type TypeScriptCodeGraphState = "idle" | "stale" | "indexing" | "ready" | "degraded" | "failed" | "disposed";

export interface TypeScriptCodeGraphOptions {
	workspaceRoot: string;
	cacheDir?: string;
	tsconfigPath?: string;
}

export interface TypeScriptCodeGraphStatus {
	state: TypeScriptCodeGraphState;
	workspaceRoot: string;
	cachePath: string;
	configPath?: string;
	generation: number;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	dirty: boolean;
	cacheRestored: boolean;
	adapters: TypeScriptCodeGraphAdapterStatus[];
	diagnostics: string[];
}

export interface TypeScriptCodeGraphAdapterStatus {
	id: string;
	language: string;
	precision: "semantic" | "hybrid" | "structural";
	fileCount: number;
}

export interface TypeScriptCodeGraphSyncResult {
	updated: boolean;
	forced: boolean;
	durationMs: number;
	status: TypeScriptCodeGraphStatus;
}

export interface CodeGraphSearchOptions {
	limit?: number;
	kinds?: readonly string[];
}

export interface CodeGraphSymbolMatch {
	node: CodeGraphNode;
	score: number;
	location: string;
}

export interface CodeGraphUnresolvedNode {
	id: string;
	unresolved: true;
}

export interface CodeGraphResolvedPath {
	nodes: Array<CodeGraphNode | CodeGraphUnresolvedNode>;
	edges: CodeGraphEdge[];
}

export interface CodeGraphResolvedQueryResult {
	paths: CodeGraphResolvedPath[];
	truncated: boolean;
}

interface ProgramConfiguration {
	rootNames: string[];
	options: ts.CompilerOptions;
	projectReferences?: readonly ts.ProjectReference[];
	configPath?: string;
	fingerprint: string;
	diagnostics: string[];
}

interface CodeGraphCachePayload {
	version: 1;
	parserVersion: string;
	configFingerprint: string;
	graph: CodeGraphSnapshot;
}

function portablePath(path: string): string {
	return path.split(sep).join("/");
}

function isPathInside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isSupportedCodeGraphFile(fileName: string): boolean {
	return isSupportedTypeScriptFile(fileName) || isSupportedSourceLanguageFile(fileName);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
	const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
	if (!diagnostic.file || diagnostic.start === undefined) return message;
	const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
	return `${portablePath(diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`;
}

function workspaceHash(workspaceRoot: string): string {
	return createHash("sha256").update(workspaceRoot).digest("hex");
}

function defaultCacheDir(workspaceRoot: string): string {
	return join(getAgentDir(), "cache", "codegraph-v1", workspaceHash(workspaceRoot));
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

async function readSourceLanguageProject(workspaceRoot: string): Promise<SourceLanguageProject> {
	const paths = ts.sys
		.readDirectory(workspaceRoot, [...SOURCE_LANGUAGE_EXTENSIONS], [...SOURCE_EXCLUDES], ["**/*"])
		.map((path) => resolve(path))
		.sort(compareStrings);
	const files: SourceLanguageFile[] = [];
	for (const path of paths) {
		const workspacePath = toWorkspaceRelativePath(workspaceRoot, path);
		if (!workspacePath || !isSupportedSourceLanguageFile(workspacePath)) continue;
		files.push({ path: workspacePath, content: await readFile(path, "utf8") });
	}
	return {
		files,
		goModulePath: parseGoModulePath(await readOptionalFile(join(workspaceRoot, "go.mod"))),
	};
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) signal.throwIfAborted();
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withCacheLock<T>(cachePath: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${cachePath}.lock`;
	const ownerPath = join(lockPath, "owner");
	const owner = `${process.pid}:${randomUUID()}`;
	for (let attempt = 0; attempt <= LOCK_RETRY_COUNT; attempt++) {
		try {
			await mkdir(lockPath);
			await writeFile(ownerPath, owner, { encoding: "utf8", mode: 0o600 });
			const heartbeat = setInterval(
				() => {
					const now = new Date();
					void utimes(lockPath, now, now).catch(() => undefined);
				},
				Math.floor(LOCK_STALE_MS / 3),
			);
			try {
				return await operation();
			} finally {
				clearInterval(heartbeat);
				const currentOwner = await readFile(ownerPath, "utf8").catch(() => undefined);
				if (currentOwner === owner) await rm(lockPath, { recursive: true, force: true });
			}
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "EEXIST") throw error;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
					const observedOwner = await readFile(ownerPath, "utf8").catch(() => undefined);
					const latestStat = await stat(lockPath).catch(() => undefined);
					const latestOwner = await readFile(ownerPath, "utf8").catch(() => undefined);
					if (latestStat && Date.now() - latestStat.mtimeMs > LOCK_STALE_MS && observedOwner === latestOwner) {
						await rm(lockPath, { recursive: true, force: true });
						continue;
					}
				}
			} catch (statError) {
				const statCode = statError instanceof Error && "code" in statError ? statError.code : undefined;
				if (statCode === "ENOENT") continue;
				throw statError;
			}
			if (attempt === LOCK_RETRY_COUNT) throw new Error(`Timed out waiting for code graph cache lock: ${lockPath}`);
			await sleep(LOCK_RETRY_MS);
		}
	}
	throw new Error(`Unable to acquire code graph cache lock: ${lockPath}`);
}

function readConfiguration(workspaceRoot: string, requestedPath: string | undefined): ProgramConfiguration {
	let configPath: string | undefined;
	if (requestedPath) {
		const unresolvedConfigPath = resolve(workspaceRoot, requestedPath);
		if (!ts.sys.fileExists(unresolvedConfigPath)) {
			throw new Error(`TypeScript configuration does not exist: ${unresolvedConfigPath}`);
		}
		configPath = realpathSync(unresolvedConfigPath);
		if (!isPathInside(workspaceRoot, configPath)) {
			throw new Error(`TypeScript configuration must be inside the workspace: ${requestedPath}`);
		}
	} else {
		configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json");
		configPath ??= ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "jsconfig.json");
		if (configPath) {
			configPath = realpathSync(configPath);
			if (!isPathInside(workspaceRoot, configPath)) {
				throw new Error(`TypeScript configuration must be inside the workspace: ${configPath}`);
			}
		}
	}

	if (!configPath) {
		const rootNames = ts.sys
			.readDirectory(workspaceRoot, [...TYPESCRIPT_CODE_GRAPH_EXTENSIONS], [...SOURCE_EXCLUDES], ["**/*"])
			.filter(isSupportedTypeScriptFile)
			.map((fileName) => resolve(fileName))
			.sort(compareStrings);
		const options: ts.CompilerOptions = {
			allowJs: true,
			checkJs: false,
			jsx: ts.JsxEmit.Preserve,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ES2022,
		};
		const fingerprint = createHash("sha256")
			.update(JSON.stringify({ parserVersion: PARSER_VERSION, options }))
			.digest("hex");
		return { rootNames, options, fingerprint, diagnostics: [] };
	}

	const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
	if (readResult.error) throw new Error(formatDiagnostic(readResult.error));
	const parsed = ts.parseJsonConfigFileContent(
		readResult.config,
		ts.sys,
		dirname(configPath),
		{ noEmit: true },
		configPath,
	);
	const rootNames = parsed.fileNames
		.filter((fileName) => toWorkspaceRelativePath(workspaceRoot, fileName) !== undefined)
		.filter(isSupportedTypeScriptFile)
		.sort(compareStrings);
	const diagnostics = parsed.errors.slice(0, 100).map(formatDiagnostic);
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				parserVersion: PARSER_VERSION,
				configPath: portablePath(relative(workspaceRoot, configPath)),
				config: readResult.config,
				options: parsed.options,
				projectReferences: parsed.projectReferences,
			}),
		)
		.digest("hex");
	return {
		rootNames,
		options: { ...parsed.options, noEmit: true },
		projectReferences: parsed.projectReferences,
		configPath,
		fingerprint,
		diagnostics,
	};
}

function isCachePayload(value: unknown): value is CodeGraphCachePayload {
	if (typeof value !== "object" || value === null) return false;
	const payload = value as Partial<CodeGraphCachePayload>;
	return (
		payload.version === CACHE_VERSION &&
		payload.parserVersion === PARSER_VERSION &&
		typeof payload.configFingerprint === "string" &&
		typeof payload.graph === "object" &&
		payload.graph !== null
	);
}

function scoreNode(node: CodeGraphNode, query: string): number {
	const normalizedName = node.name.toLowerCase();
	const normalizedPath = node.filePath.toLowerCase();
	if (normalizedName === query) return 100;
	if (normalizedName.startsWith(query)) return 80;
	if (normalizedName.includes(query)) return 60;
	const terms = query.split(/\s+/).filter(Boolean);
	if (terms.length > 1 && terms.every((term) => normalizedName.includes(term) || normalizedPath.includes(term)))
		return 50;
	if (normalizedPath.includes(query)) return 40;
	if (node.kind.toLowerCase().includes(query)) return 20;
	return 0;
}

function locationForNode(node: CodeGraphNode): string {
	return node.range ? `${node.filePath}:${node.range.start.line}:${node.range.start.column + 1}` : node.filePath;
}

function expandAffectedFiles(
	snapshot: CodeGraphSnapshot,
	directlyChanged: ReadonlySet<string>,
	addedFiles: ReadonlySet<string>,
): Set<string> {
	const affected = new Set(directlyChanged);
	if (addedFiles.size > 0) {
		for (const edge of snapshot.edges) {
			if (edge.kind === "imports" || edge.kind === "re_exports") affected.add(edge.filePath);
		}
	}
	const nodeOwners = new Map(snapshot.nodes.map((node) => [node.id, node.filePath]));
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const edge of snapshot.edges) {
			const targetOwner = nodeOwners.get(edge.to);
			if (targetOwner && affected.has(targetOwner) && !affected.has(edge.filePath)) {
				affected.add(edge.filePath);
				expanded = true;
			}
		}
	}
	return affected;
}

function expandGoPackageFiles(
	knownFiles: Iterable<string>,
	directlyChanged: ReadonlySet<string>,
	affected: Set<string>,
): void {
	const changedDirectories = new Set(
		[...directlyChanged]
			.filter((path) => extname(path).toLowerCase() === ".go")
			.map((path) => (dirname(path) === "." ? "" : dirname(path))),
	);
	if (changedDirectories.size === 0) return;
	for (const path of knownFiles) {
		if (extname(path).toLowerCase() !== ".go") continue;
		const directory = dirname(path) === "." ? "" : dirname(path);
		if (changedDirectories.has(directory)) affected.add(path);
	}
}

export class TypeScriptCodeGraph {
	readonly workspaceRoot: string;
	readonly cacheDir: string;
	readonly cachePath: string;
	private readonly requestedConfigPath: string | undefined;
	private graph = new IncrementalCodeGraph();
	private program: ts.Program | undefined;
	private configFingerprint: string | undefined;
	private configPath: string | undefined;
	private state: TypeScriptCodeGraphState = "idle";
	private dirty = true;
	private invalidateAll = false;
	private invalidationVersion = 0;
	private cacheRestored = false;
	private diagnostics: string[] = [];
	private syncPromise: Promise<TypeScriptCodeGraphSyncResult> | undefined;
	private disposing = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: TypeScriptCodeGraphOptions) {
		if (!options.workspaceRoot.trim()) throw new Error("workspaceRoot must be a non-empty path");
		this.workspaceRoot = realpathSync(resolve(options.workspaceRoot));
		this.cacheDir = resolve(options.cacheDir ?? defaultCacheDir(this.workspaceRoot));
		this.cachePath = join(this.cacheDir, CACHE_FILE_NAME);
		this.requestedConfigPath = options.tsconfigPath;
	}

	async restoreCache(): Promise<boolean> {
		this.assertUsable();
		try {
			const value = JSON.parse(await readFile(this.cachePath, "utf8")) as unknown;
			if (!isCachePayload(value)) return false;
			this.graph = IncrementalCodeGraph.restore(value.graph);
			this.configFingerprint = value.configFingerprint;
			this.cacheRestored = true;
			this.state = "stale";
			return true;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") this.diagnostics = [`Ignored invalid code graph cache: ${String(error)}`];
			return false;
		}
	}

	status(): TypeScriptCodeGraphStatus {
		const counts = this.graph.getCounts();
		const files = this.graph.snapshot().files;
		return {
			state: this.state,
			workspaceRoot: this.workspaceRoot,
			cachePath: this.cachePath,
			configPath: this.configPath,
			generation: this.graph.getGeneration(),
			...counts,
			dirty: this.dirty,
			cacheRestored: this.cacheRestored,
			adapters: [
				{
					id: "typescript-compiler",
					language: "typescript/javascript",
					precision: "semantic",
					fileCount: files.filter((file) => isSupportedTypeScriptFile(file.path)).length,
				},
				...SOURCE_LANGUAGE_ADAPTER_DESCRIPTORS.map((adapter) => ({
					id: adapter.id,
					language: adapter.language,
					precision: adapter.precision,
					fileCount: files.filter((file) => adapter.extensions.some((extension) => file.path.endsWith(extension)))
						.length,
				})),
			],
			diagnostics: [...this.diagnostics],
		};
	}

	markDirty(paths?: readonly string[]): void {
		this.assertUsable();
		this.dirty = true;
		this.invalidationVersion++;
		if (!paths || paths.some((path) => !isSupportedCodeGraphFile(path))) this.invalidateAll = true;
	}

	async sync(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<TypeScriptCodeGraphSyncResult> {
		this.assertUsable();
		if (this.syncPromise && !options.force) return this.syncPromise;
		const previous = this.syncPromise;
		const pending = previous
			? previous.catch(() => undefined).then(() => this.performSync(options))
			: this.performSync(options);
		this.syncPromise = pending;
		try {
			return await pending;
		} finally {
			if (this.syncPromise === pending) this.syncPromise = undefined;
		}
	}

	search(query: string, options: CodeGraphSearchOptions = {}): CodeGraphSymbolMatch[] {
		this.assertQueryable();
		const normalized = query.trim().toLowerCase();
		if (!normalized) throw new CodeGraphError("invalid_query", "Search query must be non-empty");
		const limit = options.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new CodeGraphError("invalid_query", "Search limit must be an integer from 1 to 100");
		}
		const kinds = options.kinds ? new Set(options.kinds) : undefined;
		return this.graph
			.listNodes()
			.filter((node) => !kinds || kinds.has(node.kind))
			.map((node) => ({ node, score: scoreNode(node, normalized), location: locationForNode(node) }))
			.filter((match) => match.score > 0)
			.sort((left, right) => right.score - left.score || compareStrings(left.node.id, right.node.id))
			.slice(0, limit);
	}

	dependencies(nodeId: string, options?: CodeGraphQueryOptions): CodeGraphResolvedQueryResult {
		this.assertQueryable();
		return this.resolveQuery(this.graph.findForwardDependencies(nodeId, options));
	}

	dependents(nodeId: string, options?: CodeGraphQueryOptions): CodeGraphResolvedQueryResult {
		this.assertQueryable();
		return this.resolveQuery(this.graph.findReverseDependencies(nodeId, options));
	}

	impact(nodeIds: readonly string[], options?: CodeGraphQueryOptions): CodeGraphResolvedQueryResult {
		this.assertQueryable();
		return this.resolveQuery(this.graph.findImpactPaths(nodeIds, options));
	}

	impactMap(paths: readonly string[], options?: CodeGraphQueryOptions): CodeImpactMap {
		this.assertQueryable();
		return buildCodeImpactMap(this.graph.snapshot(), paths, options);
	}

	snapshot(): CodeGraphSnapshot {
		this.assertQueryable();
		return this.graph.snapshot();
	}

	nodeIdsForFile(path: string): string[] {
		this.assertQueryable();
		const absolutePath = isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path);
		const relativePath = portablePath(relative(this.workspaceRoot, absolutePath));
		const normalized = posix.normalize(relativePath).replace(/^\.\//, "");
		if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
			throw new CodeGraphError("invalid_query", `File must be inside the workspace: ${path}`);
		}
		return this.graph
			.listNodes()
			.filter((node) => node.filePath === normalized)
			.map((node) => node.id)
			.sort(compareStrings);
	}

	getNode(nodeId: string): CodeGraphNode | undefined {
		this.assertQueryable();
		return this.graph.getNode(nodeId);
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		if (this.state === "disposed") return;
		this.disposing = true;
		const pendingSync = this.syncPromise;
		this.disposePromise = (async () => {
			if (pendingSync) await pendingSync.catch(() => undefined);
			this.program = undefined;
			this.state = "disposed";
		})();
		return this.disposePromise;
	}

	private async performSync(options: {
		force?: boolean;
		signal?: AbortSignal;
	}): Promise<TypeScriptCodeGraphSyncResult> {
		const startedAt = performance.now();
		const previousState = this.state;
		const invalidationVersion = this.invalidationVersion;
		const invalidateAll = this.invalidateAll;
		this.state = "indexing";
		try {
			assertNotAborted(options.signal);
			const configuration = readConfiguration(this.workspaceRoot, this.requestedConfigPath);
			const program = ts.createProgram({
				rootNames: configuration.rootNames,
				options: configuration.options,
				projectReferences: configuration.projectReferences,
				oldProgram: this.program,
			});
			const sourceLanguageProject = await readSourceLanguageProject(this.workspaceRoot);
			const configFingerprint = createHash("sha256")
				.update(
					JSON.stringify({
						typescript: configuration.fingerprint,
						sourceAdapters: SOURCE_LANGUAGE_ADAPTER_VERSION,
						goModulePath: sourceLanguageProject.goModulePath,
					}),
				)
				.digest("hex");
			assertNotAborted(options.signal);
			const typeScriptSourceFiles = program
				.getSourceFiles()
				.map((sourceFile) => ({
					sourceFile,
					filePath: toWorkspaceRelativePath(this.workspaceRoot, sourceFile.fileName),
				}))
				.filter(
					(value): value is { sourceFile: ts.SourceFile; filePath: string } =>
						value.filePath !== undefined && isSupportedTypeScriptFile(value.filePath),
				)
				.sort((left, right) => compareStrings(left.filePath, right.filePath));
			const revisions = new Map<string, ReturnType<typeof computeCodeGraphFileRevision>>();
			for (const { sourceFile, filePath } of typeScriptSourceFiles) {
				revisions.set(filePath, computeCodeGraphFileRevision(sourceFile.text));
			}
			for (const file of sourceLanguageProject.files) {
				revisions.set(file.path, computeCodeGraphFileRevision(file.content));
			}
			const previousSnapshot = this.graph.snapshot();
			const cachedRevisions = new Map(previousSnapshot.files.map((file) => [file.path, file.revision]));
			const configurationChanged = configFingerprint !== this.configFingerprint;
			const directlyChanged = new Set<string>();
			const addedFiles = new Set<string>();
			for (const [filePath, revision] of revisions) {
				if (cachedRevisions.get(filePath) !== revision) {
					directlyChanged.add(filePath);
					if (!cachedRevisions.has(filePath)) addedFiles.add(filePath);
				}
			}
			for (const filePath of cachedRevisions.keys()) {
				if (!revisions.has(filePath)) directlyChanged.add(filePath);
			}
			const reindexAll = (options.force ?? false) || configurationChanged || invalidateAll;
			const affected = reindexAll
				? new Set([...cachedRevisions.keys(), ...revisions.keys()])
				: expandAffectedFiles(previousSnapshot, directlyChanged, addedFiles);
			if (!reindexAll) {
				expandGoPackageFiles(new Set([...cachedRevisions.keys(), ...revisions.keys()]), directlyChanged, affected);
			}
			const needsCommit = reindexAll || affected.size > 0;
			let updated = false;
			let diagnostics = [...configuration.diagnostics];
			if (needsCommit) {
				const currentAffected = new Set([...affected].filter((filePath) => revisions.has(filePath)));
				const typeScriptAffected = new Set([...currentAffected].filter(isSupportedTypeScriptFile));
				const typeScriptExtraction = extractTypeScriptProgram(program, this.workspaceRoot, typeScriptAffected);
				const extractions = new Map<string, CodeGraphExtraction>(typeScriptExtraction.extractions);
				diagnostics = [...diagnostics, ...typeScriptExtraction.diagnostics].slice(0, 100);
				for (const file of sourceLanguageProject.files) {
					if (!currentAffected.has(file.path)) continue;
					const extraction = extractSourceLanguageFile(file, sourceLanguageProject);
					if (extraction) extractions.set(file.path, extraction);
				}
				const removals = [...affected].filter((path) => !revisions.has(path)).sort(compareStrings);
				const upserts = [...currentAffected].sort(compareStrings).map((filePath) => {
					const revision = revisions.get(filePath);
					const fileExtraction = extractions.get(filePath);
					if (!revision || !fileExtraction) {
						throw new Error(`Code graph extractor omitted affected file: ${filePath}`);
					}
					return { filePath, revision, fileExtraction };
				});
				assertNotAborted(options.signal);
				const stagedGraph = IncrementalCodeGraph.restore(previousSnapshot);
				for (const filePath of removals) {
					const previousRevision = stagedGraph.getFileRevision(filePath);
					if (previousRevision) stagedGraph.removeFile({ path: filePath, previousRevision });
				}
				for (const { filePath, revision, fileExtraction } of upserts) {
					stagedGraph.upsertFile({
						path: filePath,
						previousRevision: stagedGraph.getFileRevision(filePath) ?? null,
						revision,
						extraction: fileExtraction,
					});
				}
				await this.persistCache(stagedGraph, configFingerprint);
				this.graph = stagedGraph;
				this.configFingerprint = configFingerprint;
				updated = true;
			} else {
				diagnostics = [
					...diagnostics,
					...program.getSyntacticDiagnostics().slice(0, 100).map(formatDiagnostic),
				].slice(0, 100);
			}
			this.program = program;
			this.configPath = configuration.configPath;
			this.diagnostics = diagnostics;
			if (this.invalidationVersion === invalidationVersion) {
				this.dirty = false;
				this.invalidateAll = false;
			}
			this.state = diagnostics.length > 0 ? "degraded" : "ready";
			return {
				updated,
				forced: options.force ?? false,
				durationMs: performance.now() - startedAt,
				status: this.status(),
			};
		} catch (error) {
			this.state = previousState === "disposed" ? "disposed" : "failed";
			this.diagnostics = [`Code graph synchronization failed: ${String(error)}`];
			throw error;
		}
	}

	private async persistCache(graph: IncrementalCodeGraph, configFingerprint: string): Promise<void> {
		await mkdir(this.cacheDir, { recursive: true });
		const payload: CodeGraphCachePayload = {
			version: CACHE_VERSION,
			parserVersion: PARSER_VERSION,
			configFingerprint,
			graph: graph.snapshot(),
		};
		await withCacheLock(this.cachePath, async () => {
			const temporaryPath = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
			try {
				await writeFile(temporaryPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
				await rename(temporaryPath, this.cachePath);
			} finally {
				await unlink(temporaryPath).catch(() => undefined);
			}
		});
	}

	private resolveQuery(result: CodeGraphQueryResult): CodeGraphResolvedQueryResult {
		return { paths: result.paths.map((path) => this.resolvePath(path)), truncated: result.truncated };
	}

	private resolvePath(path: CodeGraphPath): CodeGraphResolvedPath {
		return {
			nodes: path.nodeIds.map((id) => this.graph.getNode(id) ?? { id, unresolved: true }),
			edges: path.edgeIds.map((id) => {
				const edge = this.graph.getEdge(id);
				if (!edge) throw new CodeGraphError("invalid_snapshot", `Query path references missing edge: ${id}`);
				return edge;
			}),
		};
	}

	private assertQueryable(): void {
		this.assertUsable();
		if (this.state === "idle" || this.state === "stale" || this.state === "indexing" || this.state === "failed") {
			throw new CodeGraphError("invalid_query", "Code graph must be synchronized before querying");
		}
	}

	private assertUsable(): void {
		if (this.state === "disposed" || this.disposing) throw new Error("Code graph has been disposed");
	}
}

export async function openTypeScriptCodeGraph(options: TypeScriptCodeGraphOptions): Promise<TypeScriptCodeGraph> {
	const graph = new TypeScriptCodeGraph(options);
	await graph.restoreCache();
	return graph;
}
