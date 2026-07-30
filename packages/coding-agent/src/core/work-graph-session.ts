import type { SessionEntry } from "./session-manager.ts";
import { parseWorkGraph, type WorkGraph } from "./work-graph.ts";

export const WORK_GRAPH_ENTRY_TYPE = "work-graph-state-v1";

export type WorkGraphEntryAppender = (customType: string, data: unknown) => void;

export function findWorkGraph(entries: readonly SessionEntry[], graphId: string): WorkGraph | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== WORK_GRAPH_ENTRY_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data) || !("id" in data)) continue;
		if (typeof data.id !== "string" || data.id !== graphId) continue;
		const graph = parseWorkGraph(entry.data);
		if (!graph) throw new Error(`Persisted work graph ${graphId} is invalid`);
		return graph;
	}
	return undefined;
}

export class SessionWorkGraphStore {
	private readonly readEntries: () => readonly SessionEntry[];
	private readonly appendEntry: WorkGraphEntryAppender;

	constructor(readEntries: () => readonly SessionEntry[], appendEntry: WorkGraphEntryAppender) {
		this.readEntries = readEntries;
		this.appendEntry = appendEntry;
	}

	get(graphId: string): WorkGraph | undefined {
		return findWorkGraph(this.readEntries(), graphId);
	}

	create(graph: WorkGraph): void {
		if (graph.revision !== 0) throw new Error("A new persisted work graph must start at revision 0");
		if (this.get(graph.id)) throw new Error(`Work graph already exists: ${graph.id}`);
		this.appendEntry(WORK_GRAPH_ENTRY_TYPE, graph);
	}

	save(graph: WorkGraph, expectedRevision: number): void {
		const current = this.get(graph.id);
		if (!current) throw new Error(`Work graph does not exist: ${graph.id}`);
		if (current.revision !== expectedRevision) {
			throw new Error(
				`Work graph ${graph.id} revision conflict: expected ${expectedRevision}, found ${current.revision}`,
			);
		}
		if (graph.revision <= current.revision) {
			throw new Error(`Work graph ${graph.id} revision must advance beyond ${current.revision}`);
		}
		this.appendEntry(WORK_GRAPH_ENTRY_TYPE, graph);
	}
}
