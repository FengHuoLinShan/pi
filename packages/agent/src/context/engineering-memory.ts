import { portableSha256Hex } from "./portable-sha256.ts";
import {
	type CurrentWorkingSetSource,
	createWorkingSet,
	type PreparedWorkingSet,
	type PrepareWorkingSetRequest,
	RevisionAwareWorkingSet,
	type WorkingSetEntry,
	type WorkingSetEntryKind,
	type WorkingSetSnapshot,
	type WorkingSetSource,
} from "./working-set.ts";

export const ENGINEERING_MEMORY_VERSION = 1 as const;

const MAX_RECORDS = 2_048;
const MAX_RELATIONS = 64;
const MAX_TEXT = 32 * 1_024;
const RECORD_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SNAPSHOT_FIELDS = ["version", "id", "revision", "records"] as const;
const RECORD_INPUT_FIELDS = [
	"kind",
	"content",
	"priority",
	"required",
	"tags",
	"sources",
	"evidenceIds",
	"createdAt",
	"replaces",
	"rationale",
	"alternatives",
	"outcome",
] as const;
const RECORD_FIELDS = ["id", ...RECORD_INPUT_FIELDS] as const;

export type EngineeringMemoryKind = WorkingSetEntryKind;
export type EngineeringAttemptOutcome = "succeeded" | "failed" | "inconclusive";

export interface EngineeringMemoryRecord extends WorkingSetEntry {
	readonly id: string;
	readonly replaces: readonly string[];
	readonly rationale?: string;
	readonly alternatives: readonly string[];
	readonly outcome?: EngineeringAttemptOutcome;
}

export interface EngineeringMemoryRecordInput {
	readonly kind: EngineeringMemoryKind;
	readonly content: string;
	readonly priority?: number;
	readonly required?: boolean;
	readonly tags?: readonly string[];
	readonly sources?: readonly WorkingSetSource[];
	readonly evidenceIds?: readonly string[];
	readonly createdAt: string;
	readonly replaces?: readonly string[];
	readonly rationale?: string;
	readonly alternatives?: readonly string[];
	readonly outcome?: EngineeringAttemptOutcome;
}

export interface EngineeringMemorySnapshot {
	readonly version: typeof ENGINEERING_MEMORY_VERSION;
	readonly id: string;
	readonly revision: number;
	readonly records: readonly EngineeringMemoryRecord[];
}

export interface EngineeringMemoryHistory {
	readonly memoryId: string;
	readonly memoryRevision: number;
	readonly activeRecordIds: readonly string[];
	readonly supersededRecordIds: readonly string[];
	readonly replacementChains: readonly (readonly string[])[];
}

export interface PreparedEngineeringMemory {
	readonly history: EngineeringMemoryHistory;
	readonly workingSet: PreparedWorkingSet;
}

export class EngineeringMemoryError extends Error {
	readonly code: "invalid_snapshot" | "invalid_record" | "invalid_replacement";

	constructor(code: "invalid_snapshot" | "invalid_record" | "invalid_replacement", message: string) {
		super(message);
		this.name = "EngineeringMemoryError";
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

function normalizeBoundedText(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT) {
		throw new EngineeringMemoryError("invalid_record", `${label} must be non-empty and bounded`);
	}
	return value;
}

function normalizeStringList(value: unknown, label: string, idOnly = false): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_RELATIONS) {
		throw new EngineeringMemoryError("invalid_record", `${label} must be a bounded array`);
	}
	const result: string[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new EngineeringMemoryError("invalid_record", `${label} must be dense`);
		const item = value[index];
		if (
			typeof item !== "string" ||
			item.trim() === "" ||
			item.length > MAX_TEXT ||
			/[\r\n]/.test(item) ||
			(idOnly && !RECORD_ID_PATTERN.test(item))
		) {
			throw new EngineeringMemoryError("invalid_record", `${label} contains an invalid value`);
		}
		result.push(item);
	}
	return [...new Set(result)].sort(compareStrings);
}

function normalizeCoreEntry(input: EngineeringMemoryRecordInput, id: string): WorkingSetEntry {
	const validator = new RevisionAwareWorkingSet(createWorkingSet("engineering-memory-validation"));
	validator.append({
		id,
		kind: input.kind,
		content: input.content,
		priority: input.priority ?? 0,
		required: input.required ?? false,
		tags: [...(input.tags ?? [])],
		sources: [...(input.sources ?? [])],
		evidenceIds: [...(input.evidenceIds ?? [])],
		createdAt: input.createdAt,
	});
	return validator.snapshot().entries[0]!;
}

function recordIdentity(value: Omit<EngineeringMemoryRecord, "id" | "createdAt">): string {
	return `sha256:${portableSha256Hex(JSON.stringify(value))}`;
}

function normalizeRecordInput(input: EngineeringMemoryRecordInput): EngineeringMemoryRecord {
	if (!isRecord(input))
		throw new EngineeringMemoryError("invalid_record", "Engineering memory record must be an object");
	const unknown = Object.keys(input).find(
		(key) => !RECORD_INPUT_FIELDS.includes(key as (typeof RECORD_INPUT_FIELDS)[number]),
	);
	if (unknown) throw new EngineeringMemoryError("invalid_record", `Unknown engineering memory field: ${unknown}`);
	const placeholderId = `sha256:${"0".repeat(64)}`;
	let core: WorkingSetEntry;
	try {
		core = normalizeCoreEntry(input, placeholderId);
	} catch (error) {
		throw new EngineeringMemoryError(
			"invalid_record",
			error instanceof Error ? error.message : "Engineering memory record is invalid",
		);
	}
	const replaces = normalizeStringList(input.replaces, "Engineering memory replacements", true);
	const alternatives = normalizeStringList(input.alternatives, "Engineering memory alternatives");
	const rationale = normalizeBoundedText(input.rationale, "Engineering memory rationale");
	if (input.outcome !== undefined && !["succeeded", "failed", "inconclusive"].includes(input.outcome)) {
		throw new EngineeringMemoryError("invalid_record", "Engineering memory attempt outcome is invalid");
	}
	if (input.outcome !== undefined && core.kind !== "attempt") {
		throw new EngineeringMemoryError("invalid_record", "Only attempt records may have an outcome");
	}
	if ((rationale !== undefined || alternatives.length > 0) && core.kind !== "decision") {
		throw new EngineeringMemoryError("invalid_record", "Only decision records may have rationale or alternatives");
	}
	if (core.kind === "fact" && core.sources.length === 0) {
		throw new EngineeringMemoryError("invalid_record", "Fact records require at least one revisioned source");
	}
	const semantic = {
		kind: core.kind,
		content: core.content,
		priority: core.priority,
		required: core.required,
		tags: core.tags,
		sources: core.sources,
		evidenceIds: core.evidenceIds,
		replaces,
		...(rationale ? { rationale } : {}),
		alternatives,
		...(input.outcome ? { outcome: input.outcome } : {}),
	};
	return {
		id: recordIdentity(semantic),
		...semantic,
		createdAt: core.createdAt,
	};
}

function recordToInput(record: EngineeringMemoryRecord): EngineeringMemoryRecordInput {
	return {
		kind: record.kind,
		content: record.content,
		priority: record.priority,
		required: record.required,
		tags: record.tags,
		sources: record.sources,
		evidenceIds: record.evidenceIds,
		createdAt: record.createdAt,
		replaces: record.replaces,
		...(record.rationale ? { rationale: record.rationale } : {}),
		alternatives: record.alternatives,
		...(record.outcome ? { outcome: record.outcome } : {}),
	};
}

export function createEngineeringMemory(id: string): EngineeringMemorySnapshot {
	const workingSet = createWorkingSet(id);
	return { version: ENGINEERING_MEMORY_VERSION, id: workingSet.id, revision: 0, records: [] };
}

export function parseEngineeringMemorySnapshot(value: unknown): EngineeringMemorySnapshot | undefined {
	try {
		if (!isRecord(value)) return undefined;
		const unknown = Object.keys(value).find(
			(key) => !SNAPSHOT_FIELDS.includes(key as (typeof SNAPSHOT_FIELDS)[number]),
		);
		if (
			unknown ||
			value.version !== ENGINEERING_MEMORY_VERSION ||
			typeof value.id !== "string" ||
			!Number.isSafeInteger(value.revision) ||
			(value.revision as number) < 0 ||
			!Array.isArray(value.records) ||
			value.records.length > MAX_RECORDS ||
			value.revision !== value.records.length
		) {
			return undefined;
		}
		createWorkingSet(value.id);
		for (let index = 0; index < value.records.length; index++) {
			if (!(index in value.records)) return undefined;
		}
		const memory = new RevisionedEngineeringMemory(createEngineeringMemory(value.id));
		for (const raw of value.records) {
			if (
				!isRecord(raw) ||
				typeof raw.id !== "string" ||
				Object.keys(raw).some((key) => !RECORD_FIELDS.includes(key as (typeof RECORD_FIELDS)[number]))
			) {
				return undefined;
			}
			const record = normalizeRecordInput(recordToInput(raw as unknown as EngineeringMemoryRecord));
			if (record.id !== raw.id) return undefined;
			memory.append(recordToInput(record));
		}
		const snapshot = memory.snapshot();
		return snapshot.revision === value.revision ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

export class RevisionedEngineeringMemory {
	private readonly id: string;
	private revision: number;
	private readonly records = new Map<string, EngineeringMemoryRecord>();
	private readonly superseded = new Set<string>();

	constructor(snapshot: EngineeringMemorySnapshot) {
		if (
			!isRecord(snapshot) ||
			Object.keys(snapshot).some((key) => !SNAPSHOT_FIELDS.includes(key as (typeof SNAPSHOT_FIELDS)[number])) ||
			snapshot.version !== ENGINEERING_MEMORY_VERSION ||
			!Array.isArray(snapshot.records) ||
			snapshot.revision !== snapshot.records.length ||
			snapshot.records.length > MAX_RECORDS
		) {
			throw new EngineeringMemoryError("invalid_snapshot", "Engineering memory snapshot is invalid");
		}
		createWorkingSet(snapshot.id);
		this.id = snapshot.id;
		this.revision = 0;
		for (let index = 0; index < snapshot.records.length; index++) {
			if (!(index in snapshot.records)) {
				throw new EngineeringMemoryError("invalid_snapshot", "Engineering memory records must be dense");
			}
			const record = snapshot.records[index]!;
			if (
				!isRecord(record) ||
				Object.keys(record).some((key) => !RECORD_FIELDS.includes(key as (typeof RECORD_FIELDS)[number]))
			) {
				throw new EngineeringMemoryError("invalid_snapshot", "Engineering memory record is invalid");
			}
			const normalizedRecord = record as unknown as EngineeringMemoryRecord;
			const appended = this.append(recordToInput(normalizedRecord));
			if (appended.id !== normalizedRecord.id) {
				throw new EngineeringMemoryError(
					"invalid_snapshot",
					`Engineering memory record id is invalid: ${normalizedRecord.id}`,
				);
			}
		}
		if (this.revision !== snapshot.revision) {
			throw new EngineeringMemoryError("invalid_snapshot", "Engineering memory revision is invalid");
		}
	}

	append(input: EngineeringMemoryRecordInput): EngineeringMemoryRecord {
		const record = normalizeRecordInput(input);
		const existing = this.records.get(record.id);
		if (existing) return structuredClone(existing);
		if (this.records.size >= MAX_RECORDS) {
			throw new EngineeringMemoryError("invalid_record", `Engineering memory exceeds ${MAX_RECORDS} records`);
		}
		for (const replacedId of record.replaces) {
			const replaced = this.records.get(replacedId);
			if (!replaced) {
				throw new EngineeringMemoryError("invalid_replacement", `Replacement target does not exist: ${replacedId}`);
			}
			if (this.superseded.has(replacedId)) {
				throw new EngineeringMemoryError("invalid_replacement", `Replacement target is not active: ${replacedId}`);
			}
			if (replaced.kind !== record.kind) {
				throw new EngineeringMemoryError(
					"invalid_replacement",
					`Replacement kind ${record.kind} does not match ${replaced.kind}`,
				);
			}
		}
		if (this.revision >= Number.MAX_SAFE_INTEGER) {
			throw new EngineeringMemoryError("invalid_snapshot", "Engineering memory revision cannot advance safely");
		}
		this.records.set(record.id, record);
		for (const replacedId of record.replaces) this.superseded.add(replacedId);
		this.revision++;
		return structuredClone(record);
	}

	activeRecords(): EngineeringMemoryRecord[] {
		return structuredClone([...this.records.values()].filter((record) => !this.superseded.has(record.id)));
	}

	history(): EngineeringMemoryHistory {
		const activeRecordIds = this.activeRecords()
			.map((record) => record.id)
			.sort(compareStrings);
		const supersededRecordIds = [...this.superseded].sort(compareStrings);
		const replacementByTarget = new Map<string, string>();
		for (const record of this.records.values()) {
			for (const replacedId of record.replaces) replacementByTarget.set(replacedId, record.id);
		}
		const roots = [...this.records.keys()].filter(
			(id) => ![...replacementByTarget.values()].some((replacementId) => replacementId === id),
		);
		const replacementChains = roots
			.map((root) => {
				const chain = [root];
				let current = root;
				while (replacementByTarget.has(current)) {
					current = replacementByTarget.get(current)!;
					chain.push(current);
				}
				return chain;
			})
			.filter((chain) => chain.length > 1)
			.sort((left, right) => compareStrings(left[0]!, right[0]!));
		return {
			memoryId: this.id,
			memoryRevision: this.revision,
			activeRecordIds,
			supersededRecordIds,
			replacementChains,
		};
	}

	workingSetSnapshot(): WorkingSetSnapshot {
		const entries = this.activeRecords().map(
			(record): WorkingSetEntry => ({
				id: record.id,
				kind: record.kind,
				content: [
					record.content,
					...(record.rationale ? [`Rationale: ${record.rationale}`] : []),
					...(record.alternatives.length > 0 ? [`Alternatives: ${record.alternatives.join("; ")}`] : []),
					...(record.outcome ? [`Outcome: ${record.outcome}`] : []),
				].join("\n"),
				priority: record.priority,
				required: record.required,
				tags: record.tags,
				sources: record.sources,
				evidenceIds: record.evidenceIds,
				createdAt: record.createdAt,
			}),
		);
		return {
			version: 1,
			id: this.id,
			revision: entries.length,
			entries,
		};
	}

	prepare(request: PrepareWorkingSetRequest): PreparedEngineeringMemory {
		const workingSet = new RevisionAwareWorkingSet(this.workingSetSnapshot()).prepare(request);
		return { history: this.history(), workingSet };
	}

	snapshot(): EngineeringMemorySnapshot {
		return {
			version: ENGINEERING_MEMORY_VERSION,
			id: this.id,
			revision: this.revision,
			records: structuredClone([...this.records.values()]),
		};
	}
}

export function prepareEngineeringMemory(
	snapshot: EngineeringMemorySnapshot,
	request: Omit<PrepareWorkingSetRequest, "currentSources"> & {
		readonly currentSources: readonly CurrentWorkingSetSource[];
	},
): PreparedEngineeringMemory {
	return new RevisionedEngineeringMemory(snapshot).prepare(request);
}
