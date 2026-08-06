import { describe, expect, it } from "vitest";
import {
	createEngineeringMemory,
	parseEngineeringMemorySnapshot,
	RevisionedEngineeringMemory,
} from "../../src/context/engineering-memory.ts";
import { portableSha256Hex } from "../../src/context/portable-sha256.ts";

const A_REVISION = `sha256:${"a".repeat(64)}`;
const B_REVISION = `sha256:${"b".repeat(64)}`;
const CREATED_AT = "2026-07-30T00:00:00.000Z";

describe("revisioned engineering memory", () => {
	it("uses a browser-safe SHA-256 implementation for semantic record ids", () => {
		expect(portableSha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(portableSha256Hex("工程记忆")).toHaveLength(64);
	});

	it("supersedes facts and decisions without erasing their reviewable history", () => {
		const memory = new RevisionedEngineeringMemory(createEngineeringMemory("goal-memory"));
		const oldFact = memory.append({
			kind: "fact",
			content: "The worker retries twice.",
			sources: [{ path: "src/worker.ts", revision: A_REVISION, symbol: "runWorker" }],
			createdAt: CREATED_AT,
		});
		const currentFact = memory.append({
			kind: "fact",
			content: "The worker retries three times.",
			sources: [{ path: "src/worker.ts", revision: B_REVISION, symbol: "runWorker" }],
			replaces: [oldFact.id],
			createdAt: CREATED_AT,
		});
		const oldDecision = memory.append({
			kind: "decision",
			content: "Use a global retry counter.",
			rationale: "It is simple.",
			alternatives: ["Per-job counter"],
			createdAt: CREATED_AT,
		});
		const currentDecision = memory.append({
			kind: "decision",
			content: "Use a per-job retry counter.",
			rationale: "Concurrent jobs must not share state.",
			alternatives: ["Global counter"],
			replaces: [oldDecision.id],
			createdAt: CREATED_AT,
		});

		expect(memory.activeRecords().map((record) => record.id)).toEqual([currentFact.id, currentDecision.id]);
		expect(memory.history()).toMatchObject({
			memoryRevision: 4,
			activeRecordIds: expect.arrayContaining([currentFact.id, currentDecision.id]),
			supersededRecordIds: expect.arrayContaining([oldFact.id, oldDecision.id]),
			replacementChains: expect.arrayContaining([
				[oldFact.id, currentFact.id],
				[oldDecision.id, currentDecision.id],
			]),
		});
		expect(memory.snapshot().records).toHaveLength(4);
	});

	it("compiles only active fresh records and blocks on a required stale fact", () => {
		const memory = new RevisionedEngineeringMemory(createEngineeringMemory("freshness"));
		memory.append({
			kind: "objective",
			content: "Repair retry ordering.",
			required: true,
			createdAt: CREATED_AT,
		});
		memory.append({
			kind: "fact",
			content: "The handler calls runWorker.",
			required: true,
			sources: [{ path: "src/worker.ts", revision: A_REVISION }],
			createdAt: CREATED_AT,
		});
		const prepared = memory.prepare({
			task: "repair worker",
			workspaceRevision: "workspace-2",
			currentSources: [{ path: "src/worker.ts", revision: B_REVISION }],
			tokenBudget: 300,
		});

		expect(prepared.workingSet.status).toBe("blocked");
		expect(prepared.workingSet.compiledContext.text).toContain("Repair retry ordering");
		expect(prepared.workingSet.compiledContext.text).not.toContain("handler calls runWorker");
		expect(prepared.workingSet.freshness).toContainEqual({
			entryId: expect.stringMatching(/^sha256:/),
			status: "stale",
			paths: ["src/worker.ts"],
		});
	});

	it("uses semantic content ids, validates replacement chains, and round-trips snapshots", () => {
		const memory = new RevisionedEngineeringMemory(createEngineeringMemory("validation"));
		const attempt = memory.append({
			kind: "attempt",
			content: "Raised the timeout.",
			outcome: "failed",
			createdAt: CREATED_AT,
		});
		const duplicate = memory.append({
			kind: "attempt",
			content: "Raised the timeout.",
			outcome: "failed",
			createdAt: "2026-07-30T01:00:00.000Z",
		});
		expect(duplicate.id).toBe(attempt.id);
		expect(memory.snapshot().revision).toBe(1);
		expect(parseEngineeringMemorySnapshot(JSON.parse(JSON.stringify(memory.snapshot())))).toEqual(memory.snapshot());
		expect(() =>
			memory.append({
				kind: "decision",
				content: "Treat the attempt as a decision.",
				replaces: [attempt.id],
				createdAt: CREATED_AT,
			}),
		).toThrow(/does not match/);
		expect(() =>
			memory.append({
				kind: "fact",
				content: "Ungrounded fact.",
				createdAt: CREATED_AT,
			}),
		).toThrow(/revisioned source/);
	});

	it("rejects unverified fields in persisted snapshots", () => {
		const memory = new RevisionedEngineeringMemory(createEngineeringMemory("strict-snapshot"));
		memory.append({
			kind: "decision",
			content: "Keep the snapshot canonical.",
			createdAt: CREATED_AT,
		});
		const snapshot = structuredClone(memory.snapshot()) as unknown as {
			records: Array<Record<string, unknown>>;
		};
		snapshot.records[0]!.unverified = "content outside the semantic record id";

		expect(parseEngineeringMemorySnapshot(snapshot)).toBeUndefined();
		expect(() => new RevisionedEngineeringMemory(snapshot as never)).toThrowError(
			expect.objectContaining({ code: "invalid_snapshot" }),
		);
	});
});
