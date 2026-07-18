/** Opaque content digest supplied and refreshed by the application. */
export interface EvidenceHash {
	algorithm: string;
	value: string;
}

/** Stable identity of the evidence source. */
export interface EvidenceSource {
	/** Application-defined source kind, such as `file`, `url`, `artifact`, or `tool`. */
	kind: string;
	/** Stable source identifier. For files this is normally a workspace-relative path. */
	id: string;
}

/** Optional structured location within an evidence source. */
export interface EvidenceLocation {
	path?: string;
	uri?: string;
	lineStart?: number;
	lineEnd?: number;
	symbol?: string;
	anchor?: string;
}

/** Tool invocation that produced or observed evidence. */
export interface EvidenceToolCall {
	id: string;
	name: string;
	argumentsHash?: EvidenceHash;
	resultHash?: EvidenceHash;
}

/** One claim bound to a versioned source and optional tool invocation. */
export interface EvidenceRecord {
	id: string;
	source: EvidenceSource;
	location?: EvidenceLocation;
	hash: EvidenceHash;
	claim: string;
	toolCall?: EvidenceToolCall;
	/** Caller-supplied observation time in milliseconds since Unix epoch. */
	observedAt: number;
}

export interface EvidenceLedgerSnapshot {
	revision: 1;
	records: EvidenceRecord[];
}

/** Current digest for a source location, supplied by the application during freshness checks. */
export interface EvidenceCurrentVersion {
	source: EvidenceSource;
	location?: EvidenceLocation;
	hash: EvidenceHash;
}

export type EvidenceFreshnessStatus = "fresh" | "stale" | "missing";

export interface EvidenceFreshness {
	evidenceId: string;
	status: EvidenceFreshnessStatus;
	recordedHash: EvidenceHash;
	currentHash?: EvidenceHash;
}

/** Serializable citation suitable for logs, prompts, or application rendering. */
export interface EvidenceCitation {
	evidenceId: string;
	label: string;
	text: string;
	source: EvidenceSource;
	location?: EvidenceLocation;
	hash: EvidenceHash;
	toolCall?: EvidenceToolCall;
}

export type EvidenceLedgerErrorCode = "invalid_record" | "duplicate_id" | "not_found" | "conflicting_version";

export class EvidenceLedgerError extends Error {
	public code: EvidenceLedgerErrorCode;
	public evidenceId?: string;

	constructor(code: EvidenceLedgerErrorCode, message: string, evidenceId?: string) {
		super(message);
		this.name = "EvidenceLedgerError";
		this.code = code;
		this.evidenceId = evidenceId;
	}
}

/** In-memory ledger with an explicit, versioned snapshot boundary. */
export class EvidenceLedger {
	private readonly records = new Map<string, EvidenceRecord>();

	constructor(snapshot?: EvidenceLedgerSnapshot) {
		if (!snapshot) return;
		if (snapshot.revision !== 1) {
			throw new EvidenceLedgerError("invalid_record", `Unsupported evidence ledger revision: ${snapshot.revision}`);
		}
		for (const record of snapshot.records) this.append(record);
	}

	/** Append idempotently. Reusing an id for different evidence is rejected. */
	append(record: EvidenceRecord): void {
		const normalized = normalizeRecord(record);
		const existing = this.records.get(normalized.id);
		if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
			throw new EvidenceLedgerError(
				"duplicate_id",
				`Evidence id already exists with different contents: ${normalized.id}`,
				normalized.id,
			);
		}
		this.records.set(normalized.id, normalized);
	}

	get(id: string): EvidenceRecord | undefined {
		const record = this.records.get(id);
		return record ? structuredClone(record) : undefined;
	}

	list(): EvidenceRecord[] {
		return structuredClone([...this.records.values()].sort((left, right) => compareStrings(left.id, right.id)));
	}

	snapshot(): EvidenceLedgerSnapshot {
		return { revision: 1, records: this.list() };
	}

	citation(id: string): EvidenceCitation {
		const record = this.records.get(id);
		if (!record) throw new EvidenceLedgerError("not_found", `Evidence not found: ${id}`, id);
		return createEvidenceCitation(record);
	}

	/** Citations are de-duplicated and returned in evidence-id order. */
	citations(ids: readonly string[]): EvidenceCitation[] {
		return [...new Set(ids)].sort(compareStrings).map((id) => this.citation(id));
	}

	/** Compare recorded hashes with caller-supplied current source versions. */
	checkFreshness(currentVersions: readonly EvidenceCurrentVersion[]): EvidenceFreshness[] {
		const currentByLocation = new Map<string, EvidenceHash>();
		for (const version of currentVersions) {
			const normalized = normalizeCurrentVersion(version);
			const key = evidenceLocationKey(normalized.source, normalized.location);
			const existing = currentByLocation.get(key);
			if (existing && !hashesEqual(existing, normalized.hash)) {
				throw new EvidenceLedgerError(
					"conflicting_version",
					`Conflicting current hashes for evidence location ${key}`,
				);
			}
			currentByLocation.set(key, normalized.hash);
		}

		return this.list().map((record): EvidenceFreshness => {
			const currentHash = currentByLocation.get(evidenceLocationKey(record.source, record.location));
			if (!currentHash) {
				return { evidenceId: record.id, status: "missing", recordedHash: record.hash };
			}
			return {
				evidenceId: record.id,
				status: hashesEqual(record.hash, currentHash) ? "fresh" : "stale",
				recordedHash: record.hash,
				currentHash: structuredClone(currentHash),
			};
		});
	}
}

/** Create a stable plain-text citation from an evidence record. */
export function createEvidenceCitation(record: EvidenceRecord): EvidenceCitation {
	const normalized = normalizeRecord(record);
	const label = `E:${normalized.id}`;
	const location = renderEvidenceLocation(normalized.source, normalized.location);
	const tool = normalized.toolCall ? ` via ${normalized.toolCall.name}#${normalized.toolCall.id}` : "";
	const text = `[${escapeCitation(label)} ${escapeCitation(location)} @ ${escapeCitation(`${normalized.hash.algorithm}:${normalized.hash.value}`)}${escapeCitation(tool)}]`;
	return {
		evidenceId: normalized.id,
		label,
		text,
		source: normalized.source,
		location: normalized.location,
		hash: normalized.hash,
		toolCall: normalized.toolCall,
	};
}

/** Stable key used to match a record with a refreshed source digest. */
export function evidenceLocationKey(source: EvidenceSource, location?: EvidenceLocation): string {
	const normalizedSource = normalizeSource(source);
	const normalizedLocation = location ? normalizeLocation(location) : undefined;
	return JSON.stringify({ source: normalizedSource, location: normalizedLocation ?? null });
}

function normalizeRecord(record: EvidenceRecord): EvidenceRecord {
	assertNonEmpty(record.id, "Evidence id", record.id);
	assertNonEmpty(record.claim, `Evidence ${record.id} claim`, record.id);
	if (!Number.isFinite(record.observedAt) || record.observedAt < 0) {
		throw new EvidenceLedgerError(
			"invalid_record",
			`Evidence ${record.id} observation time must be non-negative`,
			record.id,
		);
	}
	return {
		id: record.id,
		source: normalizeSource(record.source, record.id),
		location: record.location ? normalizeLocation(record.location, record.id) : undefined,
		hash: normalizeHash(record.hash, record.id),
		claim: record.claim,
		toolCall: record.toolCall ? normalizeToolCall(record.toolCall, record.id) : undefined,
		observedAt: record.observedAt,
	};
}

function normalizeCurrentVersion(version: EvidenceCurrentVersion): EvidenceCurrentVersion {
	return {
		source: normalizeSource(version.source),
		location: version.location ? normalizeLocation(version.location) : undefined,
		hash: normalizeHash(version.hash),
	};
}

function normalizeSource(source: EvidenceSource, evidenceId?: string): EvidenceSource {
	assertNonEmpty(source.kind, "Evidence source kind", evidenceId);
	assertNonEmpty(source.id, "Evidence source id", evidenceId);
	return { kind: source.kind, id: source.id };
}

function normalizeLocation(location: EvidenceLocation, evidenceId?: string): EvidenceLocation {
	const normalized: EvidenceLocation = {
		path: location.path,
		uri: location.uri,
		lineStart: location.lineStart,
		lineEnd: location.lineEnd,
		symbol: location.symbol,
		anchor: location.anchor,
	};
	if (Object.values(normalized).every((value) => value === undefined)) {
		throw new EvidenceLedgerError("invalid_record", "Evidence location must not be empty", evidenceId);
	}
	for (const [label, value] of [
		["path", normalized.path],
		["URI", normalized.uri],
		["symbol", normalized.symbol],
		["anchor", normalized.anchor],
	] as const) {
		if (value !== undefined) assertNonEmpty(value, `Evidence location ${label}`, evidenceId);
	}
	if (normalized.lineStart !== undefined && (!Number.isInteger(normalized.lineStart) || normalized.lineStart <= 0)) {
		throw new EvidenceLedgerError("invalid_record", "Evidence start line must be a positive integer", evidenceId);
	}
	if (normalized.lineEnd !== undefined) {
		if (
			normalized.lineStart === undefined ||
			!Number.isInteger(normalized.lineEnd) ||
			normalized.lineEnd < normalized.lineStart
		) {
			throw new EvidenceLedgerError(
				"invalid_record",
				"Evidence end line must be at or after its start line",
				evidenceId,
			);
		}
	}
	return normalized;
}

function normalizeHash(hash: EvidenceHash, evidenceId?: string): EvidenceHash {
	assertNonEmpty(hash.algorithm, "Evidence hash algorithm", evidenceId);
	assertNonEmpty(hash.value, "Evidence hash value", evidenceId);
	return { algorithm: hash.algorithm, value: hash.value };
}

function normalizeToolCall(toolCall: EvidenceToolCall, evidenceId?: string): EvidenceToolCall {
	assertNonEmpty(toolCall.id, "Evidence tool call id", evidenceId);
	assertNonEmpty(toolCall.name, "Evidence tool call name", evidenceId);
	return {
		id: toolCall.id,
		name: toolCall.name,
		argumentsHash: toolCall.argumentsHash ? normalizeHash(toolCall.argumentsHash, evidenceId) : undefined,
		resultHash: toolCall.resultHash ? normalizeHash(toolCall.resultHash, evidenceId) : undefined,
	};
}

function renderEvidenceLocation(source: EvidenceSource, location?: EvidenceLocation): string {
	let rendered = `${source.kind}:${source.id}`;
	if (!location) return rendered;
	if (location.path) rendered += ` path=${location.path}`;
	if (location.uri) rendered += ` uri=${location.uri}`;
	if (location.symbol) rendered += ` symbol=${location.symbol}`;
	if (location.lineStart !== undefined) {
		rendered += `:${location.lineStart}${location.lineEnd !== undefined ? `-${location.lineEnd}` : ""}`;
	}
	if (location.anchor) rendered += `#${location.anchor}`;
	return rendered;
}

function hashesEqual(left: EvidenceHash, right: EvidenceHash): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

function escapeCitation(value: string): string {
	return value.replace(/[\r\n]+/g, " ").replace(/]/g, "\\]");
}

function assertNonEmpty(value: string, label: string, evidenceId?: string): void {
	if (value.trim().length === 0)
		throw new EvidenceLedgerError("invalid_record", `${label} must not be empty`, evidenceId);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
