import { type CompiledContext, type ContextFragment, compileContext } from "./context-compiler.ts";

export const WORKING_SET_VERSION = 1 as const;

const MAX_ENTRIES = 1_024;
const MAX_ENTRY_CONTENT = 32 * 1_024;
const MAX_ENTRY_METADATA = 64;
const MAX_METADATA_LENGTH = 4 * 1_024;
const MAX_ID_LENGTH = 160;
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type WorkingSetEntryKind = "objective" | "fact" | "decision" | "attempt" | "evidence";
export type WorkingSetFreshnessStatus = "fresh" | "stale" | "missing";
export type PreparedWorkingSetStatus = "ready" | "blocked";

export interface WorkingSetSource {
	readonly path: string;
	readonly revision: string;
	readonly symbol?: string;
}

export interface WorkingSetEntry {
	readonly id: string;
	readonly kind: WorkingSetEntryKind;
	readonly content: string;
	readonly priority: number;
	readonly required: boolean;
	readonly tags: readonly string[];
	readonly sources: readonly WorkingSetSource[];
	readonly evidenceIds: readonly string[];
	readonly createdAt: string;
}

export interface WorkingSetSnapshot {
	readonly version: typeof WORKING_SET_VERSION;
	readonly id: string;
	readonly revision: number;
	readonly entries: readonly WorkingSetEntry[];
}

export interface CurrentWorkingSetSource {
	readonly path: string;
	readonly revision: string;
}

export interface WorkingSetFreshness {
	readonly entryId: string;
	readonly status: WorkingSetFreshnessStatus;
	readonly paths: readonly string[];
}

export interface PrepareWorkingSetRequest {
	readonly task: string;
	readonly workspaceRevision: string;
	readonly currentSources: readonly CurrentWorkingSetSource[];
	readonly tokenBudget: number;
	readonly reserveTokens?: number;
	readonly maxEntries?: number;
}

export interface PreparedWorkingSet {
	readonly version: 1;
	readonly workingSetId: string;
	readonly workingSetRevision: number;
	readonly workspaceRevision: string;
	readonly status: PreparedWorkingSetStatus;
	readonly compiledContext: CompiledContext;
	readonly selectedEntryIds: readonly string[];
	readonly omittedEntryIds: readonly string[];
	readonly freshness: readonly WorkingSetFreshness[];
}

export class WorkingSetError extends Error {
	readonly code: "invalid_snapshot" | "invalid_entry" | "duplicate_id" | "invalid_request";

	constructor(code: "invalid_snapshot" | "invalid_entry" | "duplicate_id" | "invalid_request", message: string) {
		super(message);
		this.name = "WorkingSetError";
		this.code = code;
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_METADATA_LENGTH && Number.isFinite(Date.parse(value));
}

function isRevision(value: unknown): value is string {
	return typeof value === "string" && REVISION_PATTERN.test(value);
}

function isKind(value: unknown): value is WorkingSetEntryKind {
	return (
		value === "objective" || value === "fact" || value === "decision" || value === "attempt" || value === "evidence"
	);
}

function normalizePath(
	value: unknown,
	label: string,
	code: "invalid_entry" | "invalid_request" = "invalid_entry",
): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.length > MAX_METADATA_LENGTH ||
		value.includes("\0") ||
		/[\r\n]/.test(value)
	) {
		throw new WorkingSetError(code, `${label} must be a bounded, non-empty single-line path`);
	}
	const portable = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
	if (
		portable === "." ||
		portable === ".." ||
		portable.startsWith("/") ||
		portable.split("/").some((segment) => segment === "." || segment === "..") ||
		/^[A-Za-z]:\//.test(portable)
	) {
		throw new WorkingSetError(code, `${label} must be workspace-relative without dot segments`);
	}
	return portable;
}

function normalizeStringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_ENTRY_METADATA) {
		throw new WorkingSetError("invalid_entry", `${label} must be a bounded array`);
	}
	const result: string[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new WorkingSetError("invalid_entry", `${label} must not contain sparse entries`);
		const item = value[index];
		if (typeof item !== "string" || item.trim() === "" || item.length > MAX_METADATA_LENGTH || /[\r\n]/.test(item)) {
			throw new WorkingSetError("invalid_entry", `${label} must contain bounded, non-empty single-line strings`);
		}
		result.push(item);
	}
	return [...new Set(result)].sort(compareStrings);
}

function normalizeSources(value: unknown): WorkingSetSource[] {
	if (!Array.isArray(value) || value.length > MAX_ENTRY_METADATA) {
		throw new WorkingSetError("invalid_entry", "Working set entry sources must be a bounded array");
	}
	const result: WorkingSetSource[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) {
			throw new WorkingSetError("invalid_entry", "Working set entry sources must not contain sparse entries");
		}
		const source = value[index];
		if (!isRecord(source))
			throw new WorkingSetError("invalid_entry", `Working set source ${index} must be an object`);
		const unknownKey = Object.keys(source).find((key) => !["path", "revision", "symbol"].includes(key));
		if (unknownKey) {
			throw new WorkingSetError("invalid_entry", `Unknown working set source field: ${unknownKey}`);
		}
		const path = normalizePath(source.path, `Working set source ${index} path`);
		if (!isRevision(source.revision)) {
			throw new WorkingSetError("invalid_entry", `Working set source ${path} revision must be lowercase SHA-256`);
		}
		if (
			source.symbol !== undefined &&
			(typeof source.symbol !== "string" ||
				source.symbol.trim() === "" ||
				source.symbol.length > MAX_METADATA_LENGTH ||
				/[\r\n]/.test(source.symbol))
		) {
			throw new WorkingSetError(
				"invalid_entry",
				`Working set source ${path} symbol must be bounded and single-line`,
			);
		}
		result.push({
			path,
			revision: source.revision,
			...(source.symbol === undefined ? {} : { symbol: source.symbol }),
		});
	}
	result.sort(
		(left, right) => compareStrings(left.path, right.path) || compareStrings(left.symbol ?? "", right.symbol ?? ""),
	);
	const keys = result.map((source) => `${source.path}\0${source.symbol ?? ""}`);
	if (new Set(keys).size !== keys.length) {
		throw new WorkingSetError("invalid_entry", "Working set entry sources must be unique");
	}
	const revisionByPath = new Map<string, string>();
	for (const source of result) {
		const existing = revisionByPath.get(source.path);
		if (existing !== undefined && existing !== source.revision) {
			throw new WorkingSetError(
				"invalid_entry",
				`Working set source ${source.path} must use one revision across all symbols`,
			);
		}
		revisionByPath.set(source.path, source.revision);
	}
	return result;
}

function normalizeEntry(value: unknown): WorkingSetEntry {
	if (!isRecord(value)) throw new WorkingSetError("invalid_entry", "Working set entry must be an object");
	const unknownKey = Object.keys(value).find(
		(key) =>
			!["id", "kind", "content", "priority", "required", "tags", "sources", "evidenceIds", "createdAt"].includes(
				key,
			),
	);
	if (unknownKey) throw new WorkingSetError("invalid_entry", `Unknown working set entry field: ${unknownKey}`);
	if (!isId(value.id)) throw new WorkingSetError("invalid_entry", "Working set entry id must be portable");
	if (!isKind(value.kind)) throw new WorkingSetError("invalid_entry", `Working set entry ${value.id} kind is invalid`);
	if (typeof value.content !== "string" || value.content.trim() === "" || value.content.length > MAX_ENTRY_CONTENT) {
		throw new WorkingSetError("invalid_entry", `Working set entry ${value.id} content must be non-empty and bounded`);
	}
	if (typeof value.priority !== "number" || !Number.isFinite(value.priority)) {
		throw new WorkingSetError("invalid_entry", `Working set entry ${value.id} priority must be finite`);
	}
	if (typeof value.required !== "boolean") {
		throw new WorkingSetError("invalid_entry", `Working set entry ${value.id} required must be boolean`);
	}
	if (!isTimestamp(value.createdAt)) {
		throw new WorkingSetError("invalid_entry", `Working set entry ${value.id} creation time is invalid`);
	}
	return {
		id: value.id,
		kind: value.kind,
		content: value.content,
		priority: value.priority,
		required: value.required,
		tags: normalizeStringList(value.tags, `Working set entry ${value.id} tags`),
		sources: normalizeSources(value.sources),
		evidenceIds: normalizeStringList(value.evidenceIds, `Working set entry ${value.id} evidence ids`),
		createdAt: value.createdAt,
	};
}

export function parseWorkingSetSnapshot(value: unknown): WorkingSetSnapshot | undefined {
	try {
		if (!isRecord(value)) return undefined;
		const unknownKey = Object.keys(value).find((key) => !["version", "id", "revision", "entries"].includes(key));
		if (
			unknownKey ||
			value.version !== WORKING_SET_VERSION ||
			!isId(value.id) ||
			!Number.isSafeInteger(value.revision) ||
			(value.revision as number) < 0 ||
			!Array.isArray(value.entries) ||
			value.entries.length > MAX_ENTRIES ||
			value.revision !== value.entries.length
		) {
			return undefined;
		}
		for (let index = 0; index < value.entries.length; index++) {
			if (!(index in value.entries)) return undefined;
		}
		const entries = value.entries.map(normalizeEntry);
		if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return undefined;
		return {
			version: WORKING_SET_VERSION,
			id: value.id,
			revision: value.revision as number,
			entries,
		};
	} catch {
		return undefined;
	}
}

export function createWorkingSet(id: string): WorkingSetSnapshot {
	if (!isId(id)) throw new WorkingSetError("invalid_snapshot", "Working set id must be portable");
	return { version: WORKING_SET_VERSION, id, revision: 0, entries: [] };
}

function terms(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.split(/[^\p{L}\p{N}_-]+/u)
			.filter((term) => term.length >= 2),
	);
}

function kindWeight(kind: WorkingSetEntryKind): number {
	switch (kind) {
		case "objective":
			return 10_000;
		case "decision":
			return 5_000;
		case "evidence":
			return 3_000;
		case "fact":
			return 2_000;
		case "attempt":
			return 1_000;
	}
}

function relevance(entry: WorkingSetEntry, taskTerms: ReadonlySet<string>): number {
	if (taskTerms.size === 0) return 0;
	const contentTerms = terms(
		[entry.content, ...entry.tags, ...entry.sources.flatMap((source) => [source.path, source.symbol ?? ""])].join(
			" ",
		),
	);
	let score = 0;
	for (const term of taskTerms) {
		if (contentTerms.has(term)) score += 100;
		else if ([...contentTerms].some((candidate) => candidate.includes(term) || term.includes(candidate))) score += 20;
	}
	return score;
}

function entryScore(entry: WorkingSetEntry, taskTerms: ReadonlySet<string>): number {
	const score = kindWeight(entry.kind) + entry.priority + relevance(entry, taskTerms);
	return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, score));
}

function renderEntry(entry: WorkingSetEntry): string {
	const lines = [`kind: ${entry.kind}`];
	if (entry.tags.length > 0) lines.push(`tags: ${entry.tags.join(", ")}`);
	if (entry.sources.length > 0) {
		lines.push("sources:");
		for (const source of entry.sources) {
			lines.push(`- ${source.path}@${source.revision}${source.symbol ? ` symbol=${source.symbol}` : ""}`);
		}
	}
	lines.push("", entry.content);
	return lines.join("\n");
}

function freshnessForEntry(entry: WorkingSetEntry, currentByPath: ReadonlyMap<string, string>): WorkingSetFreshness {
	const missing = [
		...new Set(entry.sources.filter((source) => !currentByPath.has(source.path)).map((source) => source.path)),
	];
	if (missing.length > 0) return { entryId: entry.id, status: "missing", paths: missing };
	const stale = [
		...new Set(
			entry.sources
				.filter((source) => currentByPath.get(source.path) !== source.revision)
				.map((source) => source.path),
		),
	];
	return {
		entryId: entry.id,
		status: stale.length > 0 ? "stale" : "fresh",
		paths: stale,
	};
}

function currentSourceMap(sources: readonly CurrentWorkingSetSource[]): Map<string, string> {
	if (!Array.isArray(sources) || sources.length > MAX_ENTRIES * MAX_ENTRY_METADATA) {
		throw new WorkingSetError("invalid_request", "Current working set sources must be a bounded array");
	}
	const result = new Map<string, string>();
	for (const source of sources) {
		if (!isRecord(source)) {
			throw new WorkingSetError("invalid_request", "Current working set source must be an object");
		}
		const unknownKey = Object.keys(source).find((key) => !["path", "revision"].includes(key));
		if (unknownKey) {
			throw new WorkingSetError("invalid_request", `Unknown current working set source field: ${unknownKey}`);
		}
		const path = normalizePath(source.path, "Current working set source path", "invalid_request");
		if (!isRevision(source.revision)) {
			throw new WorkingSetError("invalid_request", `Current source ${path} revision must be lowercase SHA-256`);
		}
		const existing = result.get(path);
		if (existing && existing !== source.revision) {
			throw new WorkingSetError("invalid_request", `Current source ${path} has conflicting revisions`);
		}
		result.set(path, source.revision);
	}
	return result;
}

export class RevisionAwareWorkingSet {
	private readonly id: string;
	private revision: number;
	private readonly entries = new Map<string, WorkingSetEntry>();

	constructor(snapshot: WorkingSetSnapshot) {
		const normalized = parseWorkingSetSnapshot(snapshot);
		if (!normalized) throw new WorkingSetError("invalid_snapshot", "Working set snapshot is invalid");
		this.id = normalized.id;
		this.revision = normalized.revision;
		for (const entry of normalized.entries) this.entries.set(entry.id, entry);
	}

	append(entry: WorkingSetEntry): void {
		const normalized = normalizeEntry(entry);
		const existing = this.entries.get(normalized.id);
		if (existing) {
			if (JSON.stringify(existing) === JSON.stringify(normalized)) return;
			throw new WorkingSetError("duplicate_id", `Working set entry id already exists: ${normalized.id}`);
		}
		if (this.entries.size >= MAX_ENTRIES) {
			throw new WorkingSetError("invalid_entry", `Working set exceeds ${MAX_ENTRIES} entries`);
		}
		if (this.revision >= Number.MAX_SAFE_INTEGER) {
			throw new WorkingSetError("invalid_snapshot", "Working set revision cannot advance safely");
		}
		this.entries.set(normalized.id, normalized);
		this.revision++;
	}

	snapshot(): WorkingSetSnapshot {
		return {
			version: WORKING_SET_VERSION,
			id: this.id,
			revision: this.revision,
			entries: structuredClone([...this.entries.values()].sort((left, right) => compareStrings(left.id, right.id))),
		};
	}

	prepare(request: PrepareWorkingSetRequest): PreparedWorkingSet {
		if (!isRecord(request)) {
			throw new WorkingSetError("invalid_request", "Working set preparation request must be an object");
		}
		if (typeof request.task !== "string" || request.task.trim() === "" || request.task.length > MAX_ENTRY_CONTENT) {
			throw new WorkingSetError("invalid_request", "Working set task must be non-empty and bounded");
		}
		if (
			typeof request.workspaceRevision !== "string" ||
			request.workspaceRevision.trim() === "" ||
			request.workspaceRevision.length > MAX_METADATA_LENGTH ||
			/[\r\n]/.test(request.workspaceRevision)
		) {
			throw new WorkingSetError(
				"invalid_request",
				"Working set workspace revision must be bounded, non-empty, and single-line",
			);
		}
		const maxEntries = request.maxEntries ?? 64;
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) {
			throw new WorkingSetError("invalid_request", `Working set maxEntries must be between 1 and ${MAX_ENTRIES}`);
		}
		const currentByPath = currentSourceMap(request.currentSources);
		const taskTerms = terms(request.task);
		const freshness = [...this.entries.values()]
			.map((entry) => freshnessForEntry(entry, currentByPath))
			.sort((left, right) => compareStrings(left.entryId, right.entryId));
		const freshnessById = new Map(freshness.map((entry) => [entry.entryId, entry.status]));
		const freshEntries = [...this.entries.values()]
			.filter((entry) => freshnessById.get(entry.id) === "fresh")
			.sort(
				(left, right) =>
					Number(right.required) - Number(left.required) ||
					entryScore(right, taskTerms) - entryScore(left, taskTerms) ||
					compareStrings(left.id, right.id),
			);
		const required = freshEntries.filter((entry) => entry.required);
		if (required.length > maxEntries) {
			throw new WorkingSetError(
				"invalid_request",
				`Working set has ${required.length} fresh required entries, exceeding maxEntries ${maxEntries}`,
			);
		}
		const optional = freshEntries
			.filter((entry) => !entry.required)
			.slice(0, Math.max(0, maxEntries - required.length));
		const admitted = [...required, ...optional];
		const fragments: ContextFragment[] = [
			{
				id: "working-set:task",
				kind: "working_set_task",
				content: request.task,
				priority: Number.MAX_SAFE_INTEGER,
				order: -1,
				required: true,
				truncation: "head",
			},
			...admitted.map(
				(entry): ContextFragment => ({
					id: `working-set:${entry.id}`,
					kind: `working_set_${entry.kind}`,
					content: renderEntry(entry),
					priority: entryScore(entry, taskTerms),
					order: entry.kind === "objective" ? 0 : 1,
					required: entry.required,
					minTokens: 8,
					truncation: "head",
					evidenceIds: entry.evidenceIds,
				}),
			),
		];
		const compiledContext = compileContext({
			tokenBudget: request.tokenBudget,
			reserveTokens: request.reserveTokens,
			fragments,
		});
		const selectedEntryIds = compiledContext.fragments
			.filter((fragment) => fragment.id.startsWith("working-set:") && fragment.id !== "working-set:task")
			.map((fragment) => fragment.id.slice("working-set:".length));
		const selected = new Set(selectedEntryIds);
		const omittedEntryIds = [...this.entries.keys()].filter((id) => !selected.has(id)).sort(compareStrings);
		const blocked = [...this.entries.values()].some(
			(entry) => entry.required && freshnessById.get(entry.id) !== "fresh",
		);
		return {
			version: 1,
			workingSetId: this.id,
			workingSetRevision: this.revision,
			workspaceRevision: request.workspaceRevision,
			status: blocked ? "blocked" : "ready",
			compiledContext,
			selectedEntryIds,
			omittedEntryIds,
			freshness,
		};
	}
}
