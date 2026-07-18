import type { SessionMetadata, SessionStorage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

/**
 * Presents coding-agent's append-only SessionManager as the generic AgentHarness storage contract.
 * Entries retain their ids and parent links, so the existing JSONL file remains the sole source of truth.
 */
export class AgentHarnessSessionStorageAdapter implements SessionStorage {
	private readonly manager: SessionManager;

	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	async getMetadata(): Promise<SessionMetadata> {
		return {
			id: this.manager.getSessionId(),
			createdAt: this.manager.getHeader()?.timestamp ?? new Date(0).toISOString(),
		};
	}

	async getLeafId(): Promise<string | null> {
		return this.manager.getLeafId();
	}

	async setLeafId(leafId: string | null): Promise<void> {
		this.manager.appendLeafChange(leafId);
	}

	async createEntryId(): Promise<string> {
		let id = uuidv7();
		while (this.manager.getEntry(id)) id = uuidv7();
		return id;
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		this.manager.appendEntry(entry as SessionEntry);
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.manager.getEntry(id) as SessionTreeEntry | undefined;
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.manager
			.getEntries()
			.filter((entry): entry is Extract<SessionEntry, { type: TType }> => entry.type === type) as Array<
			Extract<SessionTreeEntry, { type: TType }>
		>;
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.manager.getLabel(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		return this.manager.getBranch(leafId) as SessionTreeEntry[];
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return this.manager.getEntries() as SessionTreeEntry[];
	}
}
