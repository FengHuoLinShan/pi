import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	acquireWorkLease,
	consumeWorkNodeBudget,
	createWorkGraph,
	getReadyWorkNodes,
	parseWorkGraph,
	recoverWorkGraph,
	reopenWorkNode,
	transitionWorkNode,
	WorkGraphBudgetError,
	WorkGraphConflictError,
} from "../src/core/work-graph.ts";
import { SessionWorkGraphStore, WORK_GRAPH_ENTRY_TYPE } from "../src/core/work-graph-session.ts";

const START = "2026-07-30T00:00:00.000Z";

describe("durable work graph", () => {
	it("advances dependency nodes and can reopen a completed branch after verification fails", () => {
		let graph = createWorkGraph({
			id: "goal-1",
			objective: "Implement and verify",
			now: START,
			nodes: [
				{
					id: "work",
					kind: "task",
					policy: "inline",
					description: "Implement",
					initialStatus: "running",
				},
				{
					id: "verify",
					kind: "verification",
					policy: "verification",
					description: "Run checks",
					dependsOn: ["work"],
				},
				{
					id: "complete",
					kind: "objective",
					policy: "inline",
					description: "Accept result",
					dependsOn: ["verify"],
				},
			],
		});

		graph = transitionWorkNode(graph, "work", "succeeded", {
			summary: "implementation complete",
			now: "2026-07-30T00:01:00.000Z",
		});
		expect(getReadyWorkNodes(graph).map((node) => node.id)).toEqual(["verify"]);
		graph = transitionWorkNode(graph, "verify", "running", { now: "2026-07-30T00:02:00.000Z" });
		graph = transitionWorkNode(graph, "verify", "failed", {
			summary: "targeted test failed",
			evidence: [{ id: "test-report", kind: "test", summary: "One assertion failed" }],
			now: "2026-07-30T00:03:00.000Z",
		});
		graph = reopenWorkNode(graph, "work", {
			summary: "repair failed verification",
			now: "2026-07-30T00:04:00.000Z",
		});

		expect(graph.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "work", status: "ready", lastSummary: "repair failed verification" }),
				expect.objectContaining({
					id: "verify",
					status: "pending",
					evidence: [{ id: "test-report", kind: "test", summary: "One assertion failed" }],
				}),
				expect.objectContaining({ id: "complete", status: "pending" }),
			]),
		);
		expect(graph.events.some((event) => event.nodeId === "verify" && event.to === "failed")).toBe(true);
		expect(parseWorkGraph(graph)).toEqual(graph);
	});

	it("enforces node budgets and conflicting mutation leases, then recovers interrupted nodes", () => {
		let graph = createWorkGraph({
			id: "parallel-work",
			objective: "Coordinate parallel work",
			now: START,
			nodes: [
				{
					id: "reader",
					kind: "task",
					policy: "parallel-read",
					description: "Inspect source",
					initialStatus: "running",
					budget: { unit: "turn", limit: 2 },
				},
				{
					id: "writer",
					kind: "task",
					policy: "isolated-mutation",
					description: "Modify source",
					initialStatus: "running",
				},
			],
		});
		graph = acquireWorkLease(graph, "reader", {
			id: "read-src",
			resource: "packages/coding-agent/src",
			mode: "read",
			now: "2026-07-30T00:01:00.000Z",
		});
		expect(
			parseWorkGraph({
				...graph,
				leases: graph.leases.map((lease) => ({ ...lease, resource: "packages/coding-agent/src/core/.." })),
			}),
		).toBeUndefined();
		expect(
			parseWorkGraph({
				...graph,
				leases: [
					...graph.leases,
					{
						id: "write-src",
						resource: "packages/coding-agent/src",
						mode: "write",
						holderNodeId: "writer",
						acquiredAt: "2026-07-30T00:01:01.000Z",
					},
				],
			}),
		).toBeUndefined();
		expect(() =>
			acquireWorkLease(graph, "writer", {
				id: "write-core",
				resource: "packages/coding-agent/src/core/..",
				mode: "write",
				now: "2026-07-30T00:01:01.000Z",
			}),
		).toThrow(WorkGraphConflictError);

		graph = consumeWorkNodeBudget(graph, "reader", "turn", 2, "2026-07-30T00:02:00.000Z");
		graph = consumeWorkNodeBudget(graph, "reader", "turn", 1, "2026-07-30T00:03:00.000Z");
		expect(graph.nodes.find((node) => node.id === "reader")).toMatchObject({
			status: "blocked",
			budget: { unit: "turn", limit: 2, used: 2 },
		});
		expect(graph.leases).toHaveLength(0);

		graph = recoverWorkGraph(graph, "2026-07-30T00:04:00.000Z");
		expect(graph.nodes.find((node) => node.id === "writer")).toMatchObject({
			status: "ready",
			lastSummary: "Recovered after an interrupted runtime",
		});
	});

	it("charges an initial running attempt against the node budget", () => {
		let graph = createWorkGraph({
			id: "attempt-budget",
			objective: "Bound retries",
			now: START,
			nodes: [
				{
					id: "task",
					kind: "task",
					policy: "inline",
					description: "Try once",
					initialStatus: "running",
					budget: { unit: "attempt", limit: 1 },
				},
			],
		});
		expect(graph.nodes[0]).toMatchObject({
			attempts: 1,
			budget: { unit: "attempt", limit: 1, used: 1 },
		});
		graph = transitionWorkNode(graph, "task", "failed", { now: "2026-07-30T00:01:00.000Z" });
		graph = reopenWorkNode(graph, "task", { now: "2026-07-30T00:02:00.000Z" });
		expect(() => transitionWorkNode(graph, "task", "running", { now: "2026-07-30T00:03:00.000Z" })).toThrow(
			WorkGraphBudgetError,
		);
	});

	it("persists revisions optimistically and rejects corrupted latest state", () => {
		const sessionManager = SessionManager.inMemory();
		const store = new SessionWorkGraphStore(
			() => sessionManager.getBranch(),
			(customType, data) => sessionManager.appendCustomEntry(customType, data),
		);
		const initial = createWorkGraph({
			id: "persisted",
			objective: "Persist graph",
			now: START,
			nodes: [
				{
					id: "task",
					kind: "task",
					policy: "inline",
					description: "Do work",
					initialStatus: "running",
				},
			],
		});
		store.create(initial);
		const completed = transitionWorkNode(initial, "task", "succeeded", {
			now: "2026-07-30T00:01:00.000Z",
		});
		store.save(completed, 0);
		expect(store.get("persisted")).toEqual(completed);
		expect(() => store.save(completed, 0)).toThrow("revision conflict");

		sessionManager.appendCustomEntry(WORK_GRAPH_ENTRY_TYPE, {
			...completed,
			nodes: [{ broken: true }],
		});
		expect(() => store.get("persisted")).toThrow("Persisted work graph persisted is invalid");
	});
});
