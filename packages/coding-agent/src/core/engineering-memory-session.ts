import {
	type CurrentWorkingSetSource,
	type EngineeringMemoryHistory,
	type EngineeringMemorySnapshot,
	type PreparedWorkingSet,
	parseEngineeringMemorySnapshot,
	RevisionedEngineeringMemory,
} from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "./session-manager.ts";
import {
	localWorkingSetSourceResolver,
	prepareWorkspaceWorkingSet,
	type WorkingSetEntryAppender,
	type WorkingSetSourceResolver,
} from "./working-set-session.ts";
import type { WorkspaceView } from "./workspace-view.ts";

export const ENGINEERING_MEMORY_ENTRY_TYPE = "engineering-memory-state-v1";

export interface PreparedWorkspaceEngineeringMemory {
	readonly history: EngineeringMemoryHistory;
	readonly workingSet: PreparedWorkingSet;
}

export async function resolveWorkspaceMemorySources(
	workspace: WorkspaceView,
	paths: readonly string[],
	options: { resolver?: WorkingSetSourceResolver; signal?: AbortSignal } = {},
): Promise<readonly CurrentWorkingSetSource[]> {
	return (options.resolver ?? localWorkingSetSourceResolver)(workspace, paths, options.signal);
}

export async function prepareWorkspaceEngineeringMemory(
	snapshot: EngineeringMemorySnapshot,
	workspace: WorkspaceView,
	request: { task: string; tokenBudget: number; reserveTokens?: number; maxEntries?: number },
	options: { resolver?: WorkingSetSourceResolver; signal?: AbortSignal } = {},
): Promise<PreparedWorkspaceEngineeringMemory> {
	const memory = new RevisionedEngineeringMemory(snapshot);
	const workingSet = await prepareWorkspaceWorkingSet(memory.workingSetSnapshot(), workspace, request, options);
	return { history: memory.history(), workingSet };
}

export function findEngineeringMemory(
	entries: readonly SessionEntry[],
	memoryId: string,
): EngineeringMemorySnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== ENGINEERING_MEMORY_ENTRY_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data) || !("id" in data)) continue;
		if (typeof data.id !== "string" || data.id !== memoryId) continue;
		const snapshot = parseEngineeringMemorySnapshot(data);
		if (!snapshot) throw new Error(`Persisted engineering memory ${memoryId} is invalid`);
		return snapshot;
	}
	return undefined;
}

export class SessionEngineeringMemoryStore {
	private readonly readEntries: () => readonly SessionEntry[];
	private readonly appendEntry: WorkingSetEntryAppender;

	constructor(readEntries: () => readonly SessionEntry[], appendEntry: WorkingSetEntryAppender) {
		this.readEntries = readEntries;
		this.appendEntry = appendEntry;
	}

	get(memoryId: string): EngineeringMemorySnapshot | undefined {
		return findEngineeringMemory(this.readEntries(), memoryId);
	}

	create(snapshot: EngineeringMemorySnapshot): void {
		if (snapshot.revision !== 0) throw new Error("A new persisted engineering memory must start at revision 0");
		if (this.get(snapshot.id)) throw new Error(`Engineering memory already exists: ${snapshot.id}`);
		this.appendEntry(ENGINEERING_MEMORY_ENTRY_TYPE, snapshot);
	}

	save(snapshot: EngineeringMemorySnapshot, expectedRevision: number): void {
		const current = this.get(snapshot.id);
		if (!current) throw new Error(`Engineering memory does not exist: ${snapshot.id}`);
		if (current.revision !== expectedRevision) {
			throw new Error(
				`Engineering memory ${snapshot.id} revision conflict: expected ${expectedRevision}, found ${current.revision}`,
			);
		}
		if (snapshot.revision <= current.revision) {
			throw new Error(`Engineering memory ${snapshot.id} revision must advance beyond ${current.revision}`);
		}
		this.appendEntry(ENGINEERING_MEMORY_ENTRY_TYPE, snapshot);
	}
}
