import { describe, expect, it } from "vitest";
import { LocalVerifiedWorkRuntime } from "../src/core/verified-work-runtime.ts";
import { createWorkGraph, type WorkGraph } from "../src/core/work-graph.ts";

class MemoryGraphStore {
	graph: WorkGraph;

	constructor(graph: WorkGraph) {
		this.graph = graph;
	}

	get(graphId: string): WorkGraph | undefined {
		return this.graph.id === graphId ? this.graph : undefined;
	}

	save(graph: WorkGraph, expectedRevision: number): void {
		if (this.graph.revision !== expectedRevision) throw new Error("revision conflict");
		this.graph = graph;
	}
}

function clock(): () => string {
	let tick = 0;
	return () => new Date(Date.parse("2026-07-30T00:00:00.000Z") + tick++ * 1_000).toISOString();
}

describe("local verified work runtime", () => {
	it("runs parallel reads before a mutation and its verification dependency", async () => {
		const store = new MemoryGraphStore(
			createWorkGraph({
				id: "verified-local",
				objective: "Inspect, implement, and verify",
				now: "2026-07-30T00:00:00.000Z",
				nodes: [
					{ id: "read-a", kind: "task", policy: "parallel-read", description: "Inspect A" },
					{ id: "read-b", kind: "task", policy: "parallel-read", description: "Inspect B" },
					{
						id: "write",
						kind: "task",
						policy: "isolated-mutation",
						description: "Implement",
						dependsOn: ["read-a", "read-b"],
					},
					{
						id: "verify",
						kind: "verification",
						policy: "verification",
						description: "Verify",
						dependsOn: ["write"],
					},
				],
			}),
		);
		const activeReads = new Set<string>();
		let releaseReads: (() => void) | undefined;
		const bothReadsStarted = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		let maximumActiveReads = 0;
		const runtime = new LocalVerifiedWorkRuntime(store, {
			now: clock(),
			execute: async (node, context) => {
				if (node.policy === "parallel-read") {
					activeReads.add(node.id);
					maximumActiveReads = Math.max(maximumActiveReads, activeReads.size);
					if (activeReads.size === 2) releaseReads?.();
					await bothReadsStarted;
					activeReads.delete(node.id);
				}
				if (node.id === "write") {
					await context.acquireLease({ id: "write-src", resource: "src", mode: "write" });
					await context.recordProgress({ summary: "Patch prepared" });
				}
				return {
					status: "succeeded",
					summary: `${node.id} complete`,
					evidence:
						node.id === "verify"
							? [{ id: "verify-report", kind: "test", summary: "Targeted checks passed" }]
							: undefined,
				};
			},
		});

		const report = await runtime.run("verified-local");

		expect(report.status).toBe("passed");
		expect(maximumActiveReads).toBe(2);
		expect(report.attempts.map((attempt) => attempt.nodeId)).toEqual(["read-a", "read-b", "write", "verify"]);
		expect(store.graph.nodes.every((node) => node.status === "succeeded")).toBe(true);
		expect(store.graph.leases).toEqual([]);
		expect(store.graph.nodes.find((node) => node.id === "verify")?.evidence).toEqual([
			{ id: "verify-report", kind: "test", summary: "Targeted checks passed" },
		]);
	});

	it("recovers interrupted work before retrying it", async () => {
		const initial = createWorkGraph({
			id: "recover-local",
			objective: "Recover",
			now: "2026-07-30T00:00:00.000Z",
			nodes: [
				{
					id: "work",
					kind: "task",
					policy: "inline",
					description: "Resume work",
					initialStatus: "running",
				},
			],
		});
		const store = new MemoryGraphStore(initial);
		const runtime = new LocalVerifiedWorkRuntime(store, {
			now: clock(),
			execute: async () => ({ status: "succeeded", summary: "Recovered work completed" }),
		});

		const report = await runtime.run("recover-local");

		expect(report).toMatchObject({
			status: "passed",
			recoveredNodeIds: ["work"],
			attempts: [{ nodeId: "work", attempt: 2, status: "succeeded" }],
		});
		expect(store.graph.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ nodeId: "work", from: "running", to: "ready" }),
				expect.objectContaining({ nodeId: "work", from: "ready", to: "running" }),
			]),
		);
	});

	it("does not report or execute recovery when startup recovery is disabled", async () => {
		const store = new MemoryGraphStore(
			createWorkGraph({
				id: "recovery-disabled",
				objective: "Leave externally owned work alone",
				now: "2026-07-30T00:00:00.000Z",
				nodes: [
					{
						id: "work",
						kind: "task",
						policy: "inline",
						description: "Already running elsewhere",
						initialStatus: "running",
					},
				],
			}),
		);
		let executed = false;
		const runtime = new LocalVerifiedWorkRuntime(store, {
			recoverOnStart: false,
			now: clock(),
			execute: async () => {
				executed = true;
				return { status: "succeeded", summary: "must not run" };
			},
		});

		const report = await runtime.run("recovery-disabled");

		expect(report).toMatchObject({ status: "stalled", recoveredNodeIds: [], attempts: [] });
		expect(executed).toBe(false);
		expect(store.graph.nodes[0]?.status).toBe("running");
	});

	it("blocks on an exhausted budget without running dependent work", async () => {
		const store = new MemoryGraphStore(
			createWorkGraph({
				id: "budget-local",
				objective: "Bound work",
				now: "2026-07-30T00:00:00.000Z",
				nodes: [
					{
						id: "bounded",
						kind: "task",
						policy: "inline",
						description: "Use one token",
						budget: { unit: "token", limit: 1 },
					},
					{
						id: "dependent",
						kind: "verification",
						policy: "verification",
						description: "Must not run",
						dependsOn: ["bounded"],
					},
				],
			}),
		);
		const runtime = new LocalVerifiedWorkRuntime(store, {
			now: clock(),
			execute: async (_node, context) => {
				await context.consumeBudget("token", 2);
				return { status: "succeeded", summary: "unreachable" };
			},
		});

		const report = await runtime.run("budget-local");

		expect(report.status).toBe("blocked");
		expect(report.attempts).toEqual([
			expect.objectContaining({ nodeId: "bounded", status: "blocked", summary: expect.stringContaining("budget") }),
		]);
		expect(store.graph.nodes.find((node) => node.id === "dependent")?.status).toBe("pending");
	});
});
