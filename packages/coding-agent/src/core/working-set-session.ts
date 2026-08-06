import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type CurrentWorkingSetSource,
	type PreparedWorkingSet,
	type PrepareWorkingSetRequest,
	parseWorkingSetSnapshot,
	RevisionAwareWorkingSet,
	type WorkingSetSnapshot,
} from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "./session-manager.ts";
import { captureFilePathSnapshot, revalidateFilePathSnapshot } from "./tools/file-transaction.ts";
import type { WorkspaceView } from "./workspace-view.ts";

export const WORKING_SET_ENTRY_TYPE = "working-set-state-v1";

export type WorkingSetEntryAppender = (customType: string, data: unknown) => void;
export type WorkingSetSourceResolver = (
	workspace: WorkspaceView,
	paths: readonly string[],
	signal?: AbortSignal,
) => Promise<readonly CurrentWorkingSetSource[]>;

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export const localWorkingSetSourceResolver: WorkingSetSourceResolver = async (workspace, paths, signal) => {
	if (workspace.execution.target !== "host") {
		if (paths.length === 0) return [];
		throw new Error("Boundary-backed working sets require a host-provided source resolver");
	}
	const root = await realpath(workspace.logicalRoot);
	const result: CurrentWorkingSetSource[] = [];
	for (const path of paths) {
		signal?.throwIfAborted();
		const candidate = resolve(root, path);
		const snapshot = await captureFilePathSnapshot(candidate, path, [root], realpath, true);
		let content: Buffer;
		try {
			content = await readFile(snapshot.targetPath);
		} catch (error) {
			if (isMissingFileError(error)) continue;
			throw error;
		}
		await revalidateFilePathSnapshot(snapshot, path, [root], realpath);
		result.push({
			path,
			revision: `sha256:${createHash("sha256").update(content).digest("hex")}`,
		});
	}
	return result;
};

function workspaceRevision(workspace: WorkspaceView, sources: readonly CurrentWorkingSetSource[]): string {
	if (workspace.revision) return `${workspace.revision.kind}:${workspace.revision.value}`;
	const content = [...sources]
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		.map((source) => `${source.path}\0${source.revision}`)
		.join("\n");
	return `host-sources:sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function prepareWorkspaceWorkingSet(
	snapshot: WorkingSetSnapshot,
	workspace: WorkspaceView,
	request: Omit<PrepareWorkingSetRequest, "currentSources" | "workspaceRevision">,
	options: { resolver?: WorkingSetSourceResolver; signal?: AbortSignal } = {},
): Promise<PreparedWorkingSet> {
	const paths = [...new Set(snapshot.entries.flatMap((entry) => entry.sources.map((source) => source.path)))].sort();
	const resolver = options.resolver ?? localWorkingSetSourceResolver;
	const currentSources = await resolver(workspace, paths, options.signal);
	return new RevisionAwareWorkingSet(snapshot).prepare({
		...request,
		currentSources,
		workspaceRevision: workspaceRevision(workspace, currentSources),
	});
}

export function findWorkingSet(entries: readonly SessionEntry[], workingSetId: string): WorkingSetSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== WORKING_SET_ENTRY_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data) || !("id" in data)) continue;
		if (typeof data.id !== "string" || data.id !== workingSetId) continue;
		const snapshot = parseWorkingSetSnapshot(data);
		if (!snapshot) throw new Error(`Persisted working set ${workingSetId} is invalid`);
		return snapshot;
	}
	return undefined;
}

export class SessionWorkingSetStore {
	private readonly readEntries: () => readonly SessionEntry[];
	private readonly appendEntry: WorkingSetEntryAppender;

	constructor(readEntries: () => readonly SessionEntry[], appendEntry: WorkingSetEntryAppender) {
		this.readEntries = readEntries;
		this.appendEntry = appendEntry;
	}

	get(workingSetId: string): WorkingSetSnapshot | undefined {
		return findWorkingSet(this.readEntries(), workingSetId);
	}

	create(snapshot: WorkingSetSnapshot): void {
		if (snapshot.revision !== 0) throw new Error("A new persisted working set must start at revision 0");
		if (this.get(snapshot.id)) throw new Error(`Working set already exists: ${snapshot.id}`);
		this.appendEntry(WORKING_SET_ENTRY_TYPE, snapshot);
	}

	save(snapshot: WorkingSetSnapshot, expectedRevision: number): void {
		const current = this.get(snapshot.id);
		if (!current) throw new Error(`Working set does not exist: ${snapshot.id}`);
		if (current.revision !== expectedRevision) {
			throw new Error(
				`Working set ${snapshot.id} revision conflict: expected ${expectedRevision}, found ${current.revision}`,
			);
		}
		if (snapshot.revision <= current.revision) {
			throw new Error(`Working set ${snapshot.id} revision must advance beyond ${current.revision}`);
		}
		this.appendEntry(WORKING_SET_ENTRY_TYPE, snapshot);
	}
}
