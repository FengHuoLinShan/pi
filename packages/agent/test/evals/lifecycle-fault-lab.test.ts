import { describe, expect, it } from "vitest";
import {
	createCoreRuntimeLifecycleFaultScenario,
	RUNTIME_LIFECYCLE_FAULT_LAB_VERSION,
	type RuntimeLifecycleFaultScenario,
	runRuntimeLifecycleFaultLab,
	verifyRuntimeRecoveryPlan,
} from "../../src/evals/lifecycle-fault-lab.ts";
import type { RuntimeRecoveryState } from "../../src/harness/runtime-events/types.ts";

describe("runtime lifecycle fault lab", () => {
	it("recovers every core runtime boundary from before-persist and after-persist faults", async () => {
		const scenario = createCoreRuntimeLifecycleFaultScenario();
		const running = runRuntimeLifecycleFaultLab(scenario);
		(scenario as unknown as { id: string; steps: RuntimeLifecycleFaultScenario["steps"] }).id = "mutated";
		(scenario as unknown as { steps: RuntimeLifecycleFaultScenario["steps"] }).steps = [];
		const report = await running;

		expect(report.passed).toBe(true);
		expect(report.scenarioId).toBe("core-runtime-boundaries");
		expect(report.happyPath.passed).toBe(true);
		expect(report.cases).toHaveLength(createCoreRuntimeLifecycleFaultScenario().steps.length * 2);
		expect(report.cases.every((entry) => entry.faultTriggered && entry.appendRejected)).toBe(true);
		expect(report.cases.every((entry) => entry.violations.length === 0)).toBe(true);
	});

	it("only exposes interrupted retry-safe tool calls for host-driven retry", async () => {
		const scenario = createCoreRuntimeLifecycleFaultScenario();
		const report = await runRuntimeLifecycleFaultLab(scenario);
		const safeToolFault = report.cases.find(
			(entry) => entry.fault.stepIndex === 8 && entry.fault.phase === "after-persist",
		);
		const unsafeToolFault = report.cases.find(
			(entry) => entry.fault.stepIndex === 10 && entry.fault.phase === "after-persist",
		);

		expect(safeToolFault).toMatchObject({ retryableToolCallCount: 1, passed: true });
		expect(unsafeToolFault).toMatchObject({ retryableToolCallCount: 0, passed: true });
	});

	it("keeps message and pending-write bodies out of reports", async () => {
		const scenario: RuntimeLifecycleFaultScenario = {
			version: RUNTIME_LIFECYCLE_FAULT_LAB_VERSION,
			id: "privacy-boundary",
			steps: [
				{
					kind: "event",
					event: {
						type: "queue_enqueued",
						queueItemId: "queue-secret",
						queue: "follow_up",
						message: { content: "message-secret-value" },
					},
				},
				{
					kind: "event",
					event: {
						type: "pending_write_enqueued",
						pendingWriteId: "write-secret",
						targetEntryId: "entry-secret",
						write: { content: "write-secret-value" },
					},
				},
			],
		};

		const serialized = JSON.stringify(await runRuntimeLifecycleFaultLab(scenario));
		expect(serialized).not.toContain("message-secret-value");
		expect(serialized).not.toContain("write-secret-value");
		expect(serialized).not.toContain("queue-secret");
		expect(serialized).not.toContain("write-secret");
	});

	it("rejects scenarios whose happy path violates runtime causality", async () => {
		const scenario: RuntimeLifecycleFaultScenario = {
			version: RUNTIME_LIFECYCLE_FAULT_LAB_VERSION,
			id: "invalid-causality",
			steps: [
				{
					kind: "event",
					event: { type: "operation_finished", operationId: "missing-operation" },
				},
			],
		};

		await expect(runRuntimeLifecycleFaultLab(scenario)).rejects.toMatchObject({ code: "happy_path_failed" });
	});

	it("fails privacy-safely when a recovery plan omits durable host-owned work", () => {
		const state: RuntimeRecoveryState = {
			version: 1,
			sessionId: "session",
			lastSequence: 3,
			queueItems: {
				"queue-secret-id": {
					queueItemId: "queue-secret-id",
					queue: "follow_up",
					message: "queue-secret-body",
					status: "queued",
					enqueuedSequence: 1,
				},
			},
			pendingWrites: {
				"write-secret-id": {
					pendingWriteId: "write-secret-id",
					targetEntryId: "entry-secret-id",
					write: "write-secret-body",
					status: "pending",
					enqueuedSequence: 2,
				},
			},
			operations: {},
			turns: {},
			providerRequests: {},
			toolCalls: {
				"tool-secret-id": {
					toolCallId: "tool-secret-id",
					turnId: "turn-secret-id",
					toolName: "read-secret-name",
					retrySafe: true,
					status: "active",
					startedSequence: 3,
				},
			},
		};

		const violations = verifyRuntimeRecoveryPlan(state, {
			events: [],
			preservedQueueItemIds: [],
			pendingWriteIds: [],
			retryableToolCallIds: [],
		});
		expect(violations).toHaveLength(3);
		expect(JSON.stringify(violations)).not.toMatch(/secret/);
	});
});
