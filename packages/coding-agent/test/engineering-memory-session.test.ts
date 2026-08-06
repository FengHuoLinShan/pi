import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineeringMemory, RevisionedEngineeringMemory } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	prepareWorkspaceEngineeringMemory,
	resolveWorkspaceMemorySources,
	SessionEngineeringMemoryStore,
} from "../src/core/engineering-memory-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createWorkspaceView } from "../src/core/workspace-view.ts";

const temporaryDirectories: string[] = [];
const CREATED_AT = "2026-07-30T00:00:00.000Z";

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("workspace engineering memory adapter", () => {
	it("resolves current source revisions and persists optimistic memory snapshots", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-engineering-memory-"));
		temporaryDirectories.push(root);
		const content = "export const worker = 1;\n";
		await writeFile(join(root, "worker.ts"), content);
		const workspace = createWorkspaceView(root);
		const sources = await resolveWorkspaceMemorySources(workspace, ["worker.ts"]);
		expect(sources).toEqual([
			{
				path: "worker.ts",
				revision: `sha256:${createHash("sha256").update(content).digest("hex")}`,
			},
		]);

		const memory = new RevisionedEngineeringMemory(createEngineeringMemory("goal-memory"));
		memory.append({
			kind: "fact",
			content: "worker is initialized to one",
			required: true,
			sources,
			createdAt: CREATED_AT,
		});
		const prepared = await prepareWorkspaceEngineeringMemory(memory.snapshot(), workspace, {
			task: "change worker",
			tokenBudget: 200,
		});
		expect(prepared.workingSet.status).toBe("ready");

		const sessionManager = SessionManager.inMemory();
		const store = new SessionEngineeringMemoryStore(
			() => sessionManager.getBranch(),
			(customType, data) => sessionManager.appendCustomEntry(customType, data),
		);
		const initial = createEngineeringMemory("persisted-memory");
		store.create(initial);
		const persisted = new RevisionedEngineeringMemory(initial);
		persisted.append({
			kind: "decision",
			content: "Keep the public API stable.",
			rationale: "Existing callers depend on it.",
			createdAt: CREATED_AT,
		});
		store.save(persisted.snapshot(), 0);
		expect(store.get("persisted-memory")).toEqual(persisted.snapshot());
		expect(() => store.save(persisted.snapshot(), 0)).toThrow(/revision conflict/);
	});
});
