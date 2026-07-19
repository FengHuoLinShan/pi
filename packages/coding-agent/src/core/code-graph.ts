import { createHash } from "node:crypto";
import { posix } from "node:path";

export type CodeGraphFileRevision = `sha256:${string}`;
export type CodeGraphDirection = "forward" | "reverse";
export type CodeGraphAttributeValue = string | number | boolean | null;

export interface CodeGraphSourcePosition {
	line: number;
	column: number;
}

export interface CodeGraphSourceRange {
	start: CodeGraphSourcePosition;
	end: CodeGraphSourcePosition;
}

export interface CodeGraphNode {
	id: string;
	kind: string;
	name: string;
	filePath: string;
	range?: CodeGraphSourceRange;
	attributes?: Readonly<Record<string, CodeGraphAttributeValue>>;
}

export interface CodeGraphEdge {
	id: string;
	kind: string;
	from: string;
	to: string;
	/** File whose extractor owns this edge. */
	filePath: string;
	attributes?: Readonly<Record<string, CodeGraphAttributeValue>>;
}

export type CodeGraphExtractedNode = Omit<CodeGraphNode, "filePath">;
export type CodeGraphExtractedEdge = Omit<CodeGraphEdge, "filePath">;

export interface CodeGraphExtraction {
	nodes: readonly CodeGraphExtractedNode[];
	edges: readonly CodeGraphExtractedEdge[];
}

/**
 * Language-specific parsing belongs behind this interface. The graph never
 * reads files, starts watchers, or chooses a parser.
 */
export interface CodeGraphExtractor<TInput> {
	extract(
		input: TInput,
		file: { path: string; revision: CodeGraphFileRevision },
	): CodeGraphExtraction | Promise<CodeGraphExtraction>;
}

export interface CodeGraphFileUpdate {
	path: string;
	/** Revision currently expected in the graph. Null means the file must be new. */
	previousRevision: CodeGraphFileRevision | null;
	revision: CodeGraphFileRevision;
	extraction: CodeGraphExtraction;
}

export interface CodeGraphFileRemoval {
	path: string;
	/** Revision that must still be current before removal. */
	previousRevision: CodeGraphFileRevision;
}

export interface CodeGraphFileRecord {
	path: string;
	revision: CodeGraphFileRevision;
}

export interface CodeGraphSnapshot {
	version: 1;
	generation: number;
	files: CodeGraphFileRecord[];
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
}

export interface CodeGraphUpdateResult {
	generation: number;
	path: string;
	revision: CodeGraphFileRevision | null;
	nodeIds: string[];
	edgeIds: string[];
}

export interface CodeGraphPath {
	/** Traversal order. Reverse paths intentionally oppose stored edge direction. */
	nodeIds: string[];
	/** Original edge ids, aligned with adjacent node pairs. */
	edgeIds: string[];
}

export interface CodeGraphQueryOptions {
	maxDepth?: number;
	maxPaths?: number;
	edgeKinds?: readonly string[];
}

export interface CodeGraphQueryResult {
	paths: CodeGraphPath[];
	/** True when more paths existed than maxPaths allowed. */
	truncated: boolean;
}

export class CodeGraphError extends Error {
	readonly code: "invalid_update" | "invalid_snapshot" | "stale_update" | "invalid_query";

	constructor(
		code: "invalid_update" | "invalid_snapshot" | "stale_update" | "invalid_query",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "CodeGraphError";
		this.code = code;
	}
}

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_PATHS = 1_000;
const MAX_QUERY_DEPTH = 64;
const MAX_QUERY_PATHS = 10_000;

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonEmptyString(value: unknown, label: string, code: CodeGraphError["code"]): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new CodeGraphError(code, `${label} must be a non-empty string`);
	}
}

function normalizeFilePath(path: string, code: CodeGraphError["code"]): string {
	assertNonEmptyString(path, "File path", code);
	const portable = path.replaceAll("\\", "/");
	const normalized = posix.normalize(portable).replace(/^\.\//, "").replace(/\/$/, "");
	if (
		portable.includes("\0") ||
		normalized === "" ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("/") ||
		/^[a-zA-Z]:\//.test(normalized) ||
		normalized.startsWith("../")
	) {
		throw new CodeGraphError(code, `File path must be workspace-relative: ${path}`);
	}
	return normalized;
}

function assertRevision(
	value: unknown,
	label: string,
	code: CodeGraphError["code"],
): asserts value is CodeGraphFileRevision {
	if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
		throw new CodeGraphError(code, `${label} must be a lowercase SHA-256 revision`);
	}
}

function cloneAttributes(
	value: unknown,
	label: string,
	code: CodeGraphError["code"],
): Readonly<Record<string, CodeGraphAttributeValue>> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodeGraphError(code, `${label} must be an object of scalar values`);
	}
	const result: Record<string, CodeGraphAttributeValue> = {};
	for (const [key, attribute] of Object.entries(value).sort(([left], [right]) => compareStrings(left, right))) {
		if (
			attribute !== null &&
			typeof attribute !== "string" &&
			typeof attribute !== "boolean" &&
			!(typeof attribute === "number" && Number.isFinite(attribute))
		) {
			throw new CodeGraphError(code, `${label}.${key} must be a finite scalar value`);
		}
		// defineProperty treats "__proto__" as data instead of invoking Object.prototype's setter.
		Object.defineProperty(result, key, {
			value: attribute,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return result;
}

function clonePosition(value: unknown, label: string, code: CodeGraphError["code"]): CodeGraphSourcePosition {
	if (typeof value !== "object" || value === null) {
		throw new CodeGraphError(code, `${label} must be a source position`);
	}
	const position = value as Partial<CodeGraphSourcePosition>;
	if (!Number.isSafeInteger(position.line) || (position.line ?? 0) < 1) {
		throw new CodeGraphError(code, `${label}.line must be a positive integer`);
	}
	if (!Number.isSafeInteger(position.column) || (position.column ?? -1) < 0) {
		throw new CodeGraphError(code, `${label}.column must be a non-negative integer`);
	}
	return { line: position.line as number, column: position.column as number };
}

function cloneRange(value: unknown, label: string, code: CodeGraphError["code"]): CodeGraphSourceRange | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null) {
		throw new CodeGraphError(code, `${label} must be a source range`);
	}
	const range = value as Partial<CodeGraphSourceRange>;
	const start = clonePosition(range.start, `${label}.start`, code);
	const end = clonePosition(range.end, `${label}.end`, code);
	if (end.line < start.line || (end.line === start.line && end.column < start.column)) {
		throw new CodeGraphError(code, `${label}.end must not precede its start`);
	}
	return { start, end };
}

function cloneNode(value: unknown, filePath: string, code: CodeGraphError["code"]): CodeGraphNode {
	if (typeof value !== "object" || value === null) {
		throw new CodeGraphError(code, "Code graph node must be an object");
	}
	const node = value as Partial<CodeGraphNode>;
	assertNonEmptyString(node.id, "Node id", code);
	assertNonEmptyString(node.kind, `Node ${node.id} kind`, code);
	assertNonEmptyString(node.name, `Node ${node.id} name`, code);
	return {
		id: node.id,
		kind: node.kind,
		name: node.name,
		filePath,
		range: cloneRange(node.range, `Node ${node.id} range`, code),
		attributes: cloneAttributes(node.attributes, `Node ${node.id} attributes`, code),
	};
}

function cloneEdge(value: unknown, filePath: string, code: CodeGraphError["code"]): CodeGraphEdge {
	if (typeof value !== "object" || value === null) {
		throw new CodeGraphError(code, "Code graph edge must be an object");
	}
	const edge = value as Partial<CodeGraphEdge>;
	assertNonEmptyString(edge.id, "Edge id", code);
	assertNonEmptyString(edge.kind, `Edge ${edge.id} kind`, code);
	assertNonEmptyString(edge.from, `Edge ${edge.id} from`, code);
	assertNonEmptyString(edge.to, `Edge ${edge.id} to`, code);
	return {
		id: edge.id,
		kind: edge.kind,
		from: edge.from,
		to: edge.to,
		filePath,
		attributes: cloneAttributes(edge.attributes, `Edge ${edge.id} attributes`, code),
	};
}

function copyNode(node: CodeGraphNode): CodeGraphNode {
	return cloneNode(node, node.filePath, "invalid_snapshot");
}

function copyEdge(edge: CodeGraphEdge): CodeGraphEdge {
	return cloneEdge(edge, edge.filePath, "invalid_snapshot");
}

function assertUniqueIds(values: readonly { id: string }[], label: string, code: CodeGraphError["code"]): void {
	const ids = new Set<string>();
	for (const value of values) {
		if (ids.has(value.id)) throw new CodeGraphError(code, `Duplicate ${label} id: ${value.id}`);
		ids.add(value.id);
	}
}

function readQueryOptions(options: CodeGraphQueryOptions | undefined): {
	maxDepth: number;
	maxPaths: number;
	edgeKinds?: Set<string>;
} {
	if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
		throw new CodeGraphError("invalid_query", "Query options must be an object");
	}
	const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxPaths = options?.maxPaths ?? DEFAULT_MAX_PATHS;
	if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
		throw new CodeGraphError("invalid_query", "maxDepth must be a positive integer");
	}
	if (maxDepth > MAX_QUERY_DEPTH) {
		throw new CodeGraphError("invalid_query", `maxDepth must not exceed ${MAX_QUERY_DEPTH}`);
	}
	if (!Number.isSafeInteger(maxPaths) || maxPaths < 1) {
		throw new CodeGraphError("invalid_query", "maxPaths must be a positive integer");
	}
	if (maxPaths > MAX_QUERY_PATHS) {
		throw new CodeGraphError("invalid_query", `maxPaths must not exceed ${MAX_QUERY_PATHS}`);
	}
	const edgeKinds = options?.edgeKinds;
	if (edgeKinds !== undefined && !Array.isArray(edgeKinds)) {
		throw new CodeGraphError("invalid_query", "edgeKinds must be an array");
	}
	if (edgeKinds?.some((kind) => typeof kind !== "string" || kind.trim() === "")) {
		throw new CodeGraphError("invalid_query", "edgeKinds must contain only non-empty strings");
	}
	return { maxDepth, maxPaths, edgeKinds: edgeKinds ? new Set(edgeKinds) : undefined };
}

export function computeCodeGraphFileRevision(content: string | Buffer | Uint8Array): CodeGraphFileRevision {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** In-memory, language-neutral graph with file-revision atomicity. */
export class IncrementalCodeGraph {
	private generation = 0;
	private readonly files = new Map<string, CodeGraphFileRevision>();
	private readonly nodes = new Map<string, CodeGraphNode>();
	private readonly edges = new Map<string, CodeGraphEdge>();

	static restore(value: unknown): IncrementalCodeGraph {
		if (typeof value !== "object" || value === null) {
			throw new CodeGraphError("invalid_snapshot", "Code graph snapshot must be an object");
		}
		const snapshot = value as Partial<CodeGraphSnapshot>;
		if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.generation) || (snapshot.generation ?? -1) < 0) {
			throw new CodeGraphError("invalid_snapshot", "Unsupported or invalid code graph snapshot header");
		}
		if (!Array.isArray(snapshot.files) || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
			throw new CodeGraphError("invalid_snapshot", "Code graph snapshot files, nodes, and edges must be arrays");
		}

		const graph = new IncrementalCodeGraph();
		for (const value of snapshot.files) {
			if (typeof value !== "object" || value === null) {
				throw new CodeGraphError("invalid_snapshot", "Code graph file record must be an object");
			}
			const file = value as Partial<CodeGraphFileRecord>;
			const path = normalizeFilePath(file.path as string, "invalid_snapshot");
			assertRevision(file.revision, `Revision for ${path}`, "invalid_snapshot");
			if (graph.files.has(path)) throw new CodeGraphError("invalid_snapshot", `Duplicate file record: ${path}`);
			graph.files.set(path, file.revision);
		}

		for (const value of snapshot.nodes) {
			if (typeof value !== "object" || value === null) {
				throw new CodeGraphError("invalid_snapshot", "Code graph node must be an object");
			}
			const path = normalizeFilePath((value as Partial<CodeGraphNode>).filePath as string, "invalid_snapshot");
			if (!graph.files.has(path))
				throw new CodeGraphError("invalid_snapshot", `Node references unknown file: ${path}`);
			const node = cloneNode(value, path, "invalid_snapshot");
			if (graph.nodes.has(node.id)) throw new CodeGraphError("invalid_snapshot", `Duplicate node id: ${node.id}`);
			graph.nodes.set(node.id, node);
		}

		for (const value of snapshot.edges) {
			if (typeof value !== "object" || value === null) {
				throw new CodeGraphError("invalid_snapshot", "Code graph edge must be an object");
			}
			const path = normalizeFilePath((value as Partial<CodeGraphEdge>).filePath as string, "invalid_snapshot");
			if (!graph.files.has(path))
				throw new CodeGraphError("invalid_snapshot", `Edge references unknown file: ${path}`);
			const edge = cloneEdge(value, path, "invalid_snapshot");
			const source = graph.nodes.get(edge.from);
			if (!source || source.filePath !== path) {
				throw new CodeGraphError("invalid_snapshot", `Edge ${edge.id} must be owned by its source node's file`);
			}
			if (graph.edges.has(edge.id)) throw new CodeGraphError("invalid_snapshot", `Duplicate edge id: ${edge.id}`);
			graph.edges.set(edge.id, edge);
		}

		graph.generation = snapshot.generation as number;
		return graph;
	}

	static fromJSON(json: string): IncrementalCodeGraph {
		try {
			return IncrementalCodeGraph.restore(JSON.parse(json) as unknown);
		} catch (error) {
			if (error instanceof CodeGraphError) throw error;
			throw new CodeGraphError("invalid_snapshot", "Code graph snapshot is not valid JSON", { cause: error });
		}
	}

	getGeneration(): number {
		return this.generation;
	}

	getFileRevision(path: string): CodeGraphFileRevision | undefined {
		return this.files.get(normalizeFilePath(path, "invalid_query"));
	}

	getNode(id: string): CodeGraphNode | undefined {
		const node = this.nodes.get(id);
		return node ? copyNode(node) : undefined;
	}

	getEdge(id: string): CodeGraphEdge | undefined {
		const edge = this.edges.get(id);
		return edge ? copyEdge(edge) : undefined;
	}

	async extractAndUpsert<TInput>(
		file: Omit<CodeGraphFileUpdate, "extraction">,
		input: TInput,
		extractor: CodeGraphExtractor<TInput>,
	): Promise<CodeGraphUpdateResult> {
		if (typeof file !== "object" || file === null) {
			throw new CodeGraphError("invalid_update", "Code graph extraction file must be an object");
		}
		if (typeof extractor !== "object" || extractor === null || typeof extractor.extract !== "function") {
			throw new CodeGraphError("invalid_update", "Code graph extractor must provide an extract function");
		}
		const path = normalizeFilePath(file.path, "invalid_update");
		assertRevision(file.revision, `Revision for ${path}`, "invalid_update");
		if (file.previousRevision !== null) {
			assertRevision(file.previousRevision, `Previous revision for ${path}`, "invalid_update");
		}
		const currentRevision = this.files.get(path) ?? null;
		if (currentRevision !== file.previousRevision) {
			throw new CodeGraphError(
				"stale_update",
				`Stale code graph update for ${path}: expected ${file.previousRevision ?? "missing"}, found ${currentRevision ?? "missing"}`,
			);
		}
		const extraction = await extractor.extract(input, { path, revision: file.revision });
		// upsertFile repeats the revision precondition so an asynchronous extractor
		// cannot overwrite a newer graph update.
		return this.upsertFile({ ...file, path, extraction });
	}

	upsertFile(update: CodeGraphFileUpdate): CodeGraphUpdateResult {
		if (typeof update !== "object" || update === null) {
			throw new CodeGraphError("invalid_update", "Code graph update must be an object");
		}
		const path = normalizeFilePath(update.path, "invalid_update");
		assertRevision(update.revision, `Revision for ${path}`, "invalid_update");
		if (update.previousRevision !== null) {
			assertRevision(update.previousRevision, `Previous revision for ${path}`, "invalid_update");
		}
		if (typeof update.extraction !== "object" || update.extraction === null) {
			throw new CodeGraphError("invalid_update", "Code graph extraction must be an object");
		}
		if (!Array.isArray(update.extraction.nodes) || !Array.isArray(update.extraction.edges)) {
			throw new CodeGraphError("invalid_update", "Code graph extraction nodes and edges must be arrays");
		}

		const currentRevision = this.files.get(path) ?? null;
		if (currentRevision !== update.previousRevision) {
			throw new CodeGraphError(
				"stale_update",
				`Stale code graph update for ${path}: expected ${update.previousRevision ?? "missing"}, found ${currentRevision ?? "missing"}`,
			);
		}

		const nodes = update.extraction.nodes.map((node) => cloneNode(node, path, "invalid_update"));
		const edges = update.extraction.edges.map((edge) => cloneEdge(edge, path, "invalid_update"));
		assertUniqueIds(nodes, "node", "invalid_update");
		assertUniqueIds(edges, "edge", "invalid_update");
		const ownedNodeIds = new Set(nodes.map((node) => node.id));
		for (const edge of edges) {
			if (!ownedNodeIds.has(edge.from)) {
				throw new CodeGraphError("invalid_update", `Edge ${edge.id} source must be a node extracted from ${path}`);
			}
		}

		for (const node of nodes) {
			const existing = this.nodes.get(node.id);
			if (existing && existing.filePath !== path) {
				throw new CodeGraphError("invalid_update", `Node id ${node.id} is already owned by ${existing.filePath}`);
			}
		}
		for (const edge of edges) {
			const existing = this.edges.get(edge.id);
			if (existing && existing.filePath !== path) {
				throw new CodeGraphError("invalid_update", `Edge id ${edge.id} is already owned by ${existing.filePath}`);
			}
		}

		this.assertGenerationCanAdvance();
		this.removeOwnedRecords(path);
		this.files.set(path, update.revision);
		for (const node of nodes) this.nodes.set(node.id, node);
		for (const edge of edges) this.edges.set(edge.id, edge);
		this.generation++;
		return {
			generation: this.generation,
			path,
			revision: update.revision,
			nodeIds: nodes.map((node) => node.id).sort(compareStrings),
			edgeIds: edges.map((edge) => edge.id).sort(compareStrings),
		};
	}

	removeFile(removal: CodeGraphFileRemoval): CodeGraphUpdateResult {
		if (typeof removal !== "object" || removal === null) {
			throw new CodeGraphError("invalid_update", "Code graph removal must be an object");
		}
		const path = normalizeFilePath(removal.path, "invalid_update");
		assertRevision(removal.previousRevision, `Previous revision for ${path}`, "invalid_update");
		const currentRevision = this.files.get(path);
		if (currentRevision !== removal.previousRevision) {
			throw new CodeGraphError(
				"stale_update",
				`Stale code graph removal for ${path}: expected ${removal.previousRevision}, found ${currentRevision ?? "missing"}`,
			);
		}
		const nodeIds = [...this.nodes.values()]
			.filter((node) => node.filePath === path)
			.map((node) => node.id)
			.sort(compareStrings);
		const edgeIds = [...this.edges.values()]
			.filter((edge) => edge.filePath === path)
			.map((edge) => edge.id)
			.sort(compareStrings);
		this.assertGenerationCanAdvance();
		this.removeOwnedRecords(path);
		this.files.delete(path);
		this.generation++;
		return { generation: this.generation, path, revision: null, nodeIds, edgeIds };
	}

	snapshot(): CodeGraphSnapshot {
		return {
			version: 1,
			generation: this.generation,
			files: [...this.files.entries()]
				.sort(([left], [right]) => compareStrings(left, right))
				.map(([path, revision]) => ({ path, revision })),
			nodes: [...this.nodes.values()].sort((left, right) => compareStrings(left.id, right.id)).map(copyNode),
			edges: [...this.edges.values()].sort((left, right) => compareStrings(left.id, right.id)).map(copyEdge),
		};
	}

	toJSON(): string {
		return JSON.stringify(this.snapshot());
	}

	findForwardDependencies(nodeId: string, options?: CodeGraphQueryOptions): CodeGraphQueryResult {
		return this.findPaths([nodeId], "forward", options);
	}

	findReverseDependencies(nodeId: string, options?: CodeGraphQueryOptions): CodeGraphQueryResult {
		return this.findPaths([nodeId], "reverse", options);
	}

	findImpactPaths(changedNodeIds: readonly string[], options?: CodeGraphQueryOptions): CodeGraphQueryResult {
		if (!Array.isArray(changedNodeIds) || changedNodeIds.length === 0) {
			throw new CodeGraphError("invalid_query", "At least one changed node id is required");
		}
		return this.findPaths(changedNodeIds, "reverse", options);
	}

	private removeOwnedRecords(path: string): void {
		for (const [id, node] of this.nodes) {
			if (node.filePath === path) this.nodes.delete(id);
		}
		for (const [id, edge] of this.edges) {
			if (edge.filePath === path) this.edges.delete(id);
		}
	}

	private assertGenerationCanAdvance(): void {
		if (this.generation >= Number.MAX_SAFE_INTEGER) {
			throw new CodeGraphError("invalid_update", "Code graph generation cannot advance safely");
		}
	}

	private findPaths(
		originIds: readonly string[],
		direction: CodeGraphDirection,
		options: CodeGraphQueryOptions | undefined,
	): CodeGraphQueryResult {
		const { maxDepth, maxPaths, edgeKinds } = readQueryOptions(options);
		const origins = [...new Set(originIds)];
		for (const id of origins) assertNonEmptyString(id, "Origin node id", "invalid_query");
		origins.sort(compareStrings);
		const edges = [...this.edges.values()]
			.filter((edge) => edgeKinds === undefined || edgeKinds.has(edge.kind))
			.sort((left, right) => compareStrings(left.id, right.id));
		const byEndpoint = new Map<string, CodeGraphEdge[]>();
		for (const edge of edges) {
			const endpoint = direction === "forward" ? edge.from : edge.to;
			const values = byEndpoint.get(endpoint) ?? [];
			values.push(edge);
			byEndpoint.set(endpoint, values);
		}

		const queue: CodeGraphPath[] = origins.map((id) => ({ nodeIds: [id], edgeIds: [] }));
		const paths: CodeGraphPath[] = [];
		let truncated = false;
		while (queue.length > 0) {
			const path = queue.shift() as CodeGraphPath;
			if (path.edgeIds.length >= maxDepth) continue;
			const endpoint = path.nodeIds[path.nodeIds.length - 1];
			for (const edge of byEndpoint.get(endpoint) ?? []) {
				const nextId = direction === "forward" ? edge.to : edge.from;
				if (path.nodeIds.includes(nextId)) continue;
				if (paths.length >= maxPaths) {
					truncated = true;
					return { paths, truncated };
				}
				const nextPath = {
					nodeIds: [...path.nodeIds, nextId],
					edgeIds: [...path.edgeIds, edge.id],
				};
				paths.push(nextPath);
				queue.push(nextPath);
			}
		}
		return { paths, truncated };
	}
}
