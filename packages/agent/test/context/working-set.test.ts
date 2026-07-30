import { describe, expect, it } from "vitest";
import {
	createWorkingSet,
	parseWorkingSetSnapshot,
	RevisionAwareWorkingSet,
	type WorkingSetEntry,
} from "../../src/context/working-set.ts";

const A_REVISION = `sha256:${"a".repeat(64)}`;
const B_REVISION = `sha256:${"b".repeat(64)}`;
const CREATED_AT = "2026-07-30T00:00:00.000Z";

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

describe("revision-aware working set", () => {
	it("retrieves objectives, decisions, symbol facts, failed attempts, and evidence within a token budget", () => {
		const workingSet = new RevisionAwareWorkingSet(createWorkingSet("goal-1"));
		workingSet.append(
			entry({
				id: "objective",
				kind: "objective",
				content: "Repair the worker retry loop without changing its public API.",
				required: true,
			}),
		);
		workingSet.append(
			entry({
				id: "worker-fact",
				kind: "fact",
				content: "runWorker retries transient jobs through scheduleRetry.",
				tags: ["worker", "retry"],
				sources: [{ path: "src/worker.ts", revision: A_REVISION, symbol: "runWorker" }],
			}),
		);
		workingSet.append(
			entry({
				id: "decision",
				kind: "decision",
				content: "Keep the queue wire format unchanged.",
				required: true,
			}),
		);
		workingSet.append(
			entry({
				id: "failed-attempt",
				kind: "attempt",
				content: "Increasing the global timeout did not fix retry ordering.",
				tags: ["retry"],
			}),
		);
		workingSet.append(
			entry({
				id: "verification",
				kind: "evidence",
				content: "The targeted worker regression currently fails.",
				evidenceIds: ["worker-test-report"],
			}),
		);

		const prepared = workingSet.prepare({
			task: "repair worker retry ordering",
			workspaceRevision: "overlay-base-1",
			currentSources: [{ path: "src/worker.ts", revision: A_REVISION }],
			tokenBudget: 500,
			maxEntries: 5,
		});

		expect(prepared.status).toBe("ready");
		expect(prepared.selectedEntryIds).toEqual(
			expect.arrayContaining(["objective", "decision", "verification", "worker-fact", "failed-attempt"]),
		);
		expect(prepared.selectedEntryIds).toHaveLength(5);
		expect(prepared.compiledContext.text).toContain("runWorker");
		expect(prepared.compiledContext.text).toContain("Increasing the global timeout");
		expect(
			prepared.compiledContext.fragments.find((fragment) => fragment.id === "working-set:verification")?.evidenceIds,
		).toEqual(["worker-test-report"]);
	});

	it("fails closed and excludes required facts when their source revision is stale or missing", () => {
		const workingSet = new RevisionAwareWorkingSet(createWorkingSet("goal-2"));
		workingSet.append(
			entry({
				id: "required-fact",
				kind: "fact",
				content: "The public handler delegates to runWorker.",
				required: true,
				sources: [{ path: "src/worker.ts", revision: A_REVISION, symbol: "handler" }],
			}),
		);
		workingSet.append(
			entry({
				id: "decision",
				kind: "decision",
				content: "Preserve the handler signature.",
			}),
		);

		const stale = workingSet.prepare({
			task: "change the worker",
			workspaceRevision: "host-2",
			currentSources: [{ path: "src/worker.ts", revision: B_REVISION }],
			tokenBudget: 200,
		});
		expect(stale).toMatchObject({
			status: "blocked",
			freshness: expect.arrayContaining([{ entryId: "required-fact", status: "stale", paths: ["src/worker.ts"] }]),
		});
		expect(stale.selectedEntryIds).not.toContain("required-fact");
		expect(stale.compiledContext.text).not.toContain("delegates to runWorker");

		const missing = workingSet.prepare({
			task: "change the worker",
			workspaceRevision: "host-3",
			currentSources: [],
			tokenBudget: 200,
		});
		expect(missing.freshness).toContainEqual({
			entryId: "required-fact",
			status: "missing",
			paths: ["src/worker.ts"],
		});
	});

	it("round-trips append-only snapshots and rejects conflicting entry reuse", () => {
		const workingSet = new RevisionAwareWorkingSet(createWorkingSet("goal-3"));
		const decision = entry({
			id: "decision",
			kind: "decision",
			content: "Use revision-addressed facts.",
		});
		workingSet.append(decision);
		workingSet.append(decision);
		expect(workingSet.snapshot().revision).toBe(1);

		const restored = new RevisionAwareWorkingSet(JSON.parse(JSON.stringify(workingSet.snapshot())));
		expect(restored.snapshot()).toEqual(workingSet.snapshot());
		expect(() => restored.append({ ...decision, content: "Conflicting decision." })).toThrow(
			"Working set entry id already exists",
		);
	});

	it("rejects path traversal, conflicting source revisions, and inconsistent append-only revisions", () => {
		const workingSet = new RevisionAwareWorkingSet(createWorkingSet("goal-4"));
		expect(() =>
			workingSet.append(
				entry({
					id: "escaping-fact",
					kind: "fact",
					content: "This source is outside the workspace.",
					sources: [{ path: "src/../../outside.ts", revision: A_REVISION }],
				}),
			),
		).toThrow("without dot segments");
		expect(() =>
			workingSet.append(
				entry({
					id: "conflicting-fact",
					kind: "fact",
					content: "These symbols cannot both be fresh.",
					sources: [
						{ path: "src/worker.ts", revision: A_REVISION, symbol: "runWorker" },
						{ path: "src/worker.ts", revision: B_REVISION, symbol: "scheduleRetry" },
					],
				}),
			),
		).toThrow("must use one revision");

		const snapshot = createWorkingSet("goal-5");
		expect(
			parseWorkingSetSnapshot({
				...snapshot,
				revision: 1,
			}),
		).toBeUndefined();
	});

	it("fails rather than exceeding maxEntries with fresh required context", () => {
		const workingSet = new RevisionAwareWorkingSet(createWorkingSet("goal-6"));
		workingSet.append(
			entry({
				id: "objective",
				kind: "objective",
				content: "Repair the worker.",
				required: true,
			}),
		);
		workingSet.append(
			entry({
				id: "decision",
				kind: "decision",
				content: "Keep the API stable.",
				required: true,
			}),
		);

		expect(() =>
			workingSet.prepare({
				task: "repair worker",
				workspaceRevision: "host-1",
				currentSources: [],
				tokenBudget: 200,
				maxEntries: 1,
			}),
		).toThrow("exceeding maxEntries 1");
	});
});
