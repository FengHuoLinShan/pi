import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkingSet, RevisionAwareWorkingSet, type WorkingSetEntry } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { prepareWorkspaceWorkingSet, SessionWorkingSetStore } from "../src/core/working-set-session.ts";
import { createWorkspaceView } from "../src/core/workspace-view.ts";

const temporaryDirectories: string[] = [];
const CREATED_AT = "2026-07-30T00:00:00.000Z";

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function revision(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function entry(value: Partial<WorkingSetEntry> & Pick<WorkingSetEntry, "id" | "kind" | "content">): WorkingSetEntry {
	return {
		priority: 0,
		required: false,
		tags: [],
		sources: [],
		evidenceIds: [],
		createdAt: CREATED_AT,
		...value,
	};
}

describe("workspace working set adapter", () => {
	it("rehashes logical-workspace sources and fails closed after a file changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-working-set-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "worker.ts"), "export const worker = 1;\n");
		const workingSet = new RevisionAwareWorkingSet(createWorkingSet("goal-1"));
		workingSet.append(
			entry({
				id: "worker-fact",
				kind: "fact",
				content: "worker is currently initialized to one",
				required: true,
				sources: [
					{
						path: "worker.ts",
						revision: revision("export const worker = 1;\n"),
						symbol: "worker",
					},
				],
			}),
		);

		const fresh = await prepareWorkspaceWorkingSet(workingSet.snapshot(), createWorkspaceView(root), {
			task: "change worker",
			tokenBudget: 200,
		});
		expect(fresh).toMatchObject({
			status: "ready",
			workspaceRevision: expect.stringMatching(/^host-sources:sha256:[0-9a-f]{64}$/),
			freshness: [{ entryId: "worker-fact", status: "fresh", paths: [] }],
		});

		await writeFile(join(root, "worker.ts"), "export const worker = 2;\n");
		const stale = await prepareWorkspaceWorkingSet(workingSet.snapshot(), createWorkspaceView(root), {
			task: "change worker",
			tokenBudget: 200,
		});
		expect(stale).toMatchObject({
			status: "blocked",
			freshness: [{ entryId: "worker-fact", status: "stale", paths: ["worker.ts"] }],
		});
		expect(stale.compiledContext.text).not.toContain("initialized to one");
	});

	it("persists append-only snapshots with optimistic session revisions", () => {
		const sessionManager = SessionManager.inMemory();
		const store = new SessionWorkingSetStore(
			() => sessionManager.getBranch(),
			(customType, data) => sessionManager.appendCustomEntry(customType, data),
		);
		const initial = createWorkingSet("goal-2");
		store.create(initial);
		const workingSet = new RevisionAwareWorkingSet(initial);
		workingSet.append(
			entry({
				id: "decision",
				kind: "decision",
				content: "Keep the public API stable.",
			}),
		);
		const updated = workingSet.snapshot();
		store.save(updated, 0);

		expect(store.get("goal-2")).toEqual(updated);
		expect(() => store.save(updated, 0)).toThrow("revision conflict");
	});
});
