import { describe, expect, it, vi } from "vitest";
import {
	compareReplayBranches,
	createReplayBranch,
	executeReplayBranch,
	type ReplayBranchModelStep,
	verifyReplayBranch,
} from "../../src/harness/observability/forkable-replay.ts";
import { createTraceBundle, type TraceBundleSource } from "../../src/harness/observability/trace-bundle.ts";
import { RUNTIME_EVENT_VERSION, type RuntimeEventEnvelope } from "../../src/harness/runtime-events/types.ts";

function source(): TraceBundleSource {
	const canonicalEvents: RuntimeEventEnvelope[] = [
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-1",
			sequence: 1,
			timestamp: "2026-07-19T00:00:01.000Z",
			sessionId: "session-1",
			event: { type: "operation_started", operationId: "operation-1", kind: "turn" },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-2",
			sequence: 2,
			timestamp: "2026-07-19T00:00:02.000Z",
			sessionId: "session-1",
			event: { type: "turn_started", turnId: "turn-1", operationId: "operation-1", consumedQueueItemIds: [] },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-3",
			sequence: 3,
			timestamp: "2026-07-19T00:00:03.000Z",
			sessionId: "session-1",
			event: {
				type: "provider_request_started",
				requestId: "request-1",
				turnId: "turn-1",
				provider: "provider-a",
				modelId: "model-a",
			},
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-4",
			sequence: 4,
			timestamp: "2026-07-19T00:00:04.000Z",
			sessionId: "session-1",
			event: { type: "provider_request_finished", requestId: "request-1" },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-5",
			sequence: 5,
			timestamp: "2026-07-19T00:00:05.000Z",
			sessionId: "session-1",
			event: {
				type: "tool_call_started",
				toolCallId: "tool-1",
				turnId: "turn-1",
				toolName: "read",
				retrySafe: true,
			},
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-6",
			sequence: 6,
			timestamp: "2026-07-19T00:00:06.000Z",
			sessionId: "session-1",
			event: { type: "tool_call_finished", toolCallId: "tool-1" },
		},
	];
	return {
		sessionId: "session-1",
		canonicalEvents,
		effectiveConfig: { provider: "provider-a", modelId: "model-a" },
		modelExchanges: [
			{
				sequence: 3,
				requestId: "request-1",
				provider: "provider-a",
				modelId: "model-a",
				input: { prompt: "solve" },
				output: { text: "original" },
			},
		],
		toolExchanges: [
			{
				sequence: 5,
				toolCallId: "tool-1",
				toolName: "read",
				input: { path: "README.md" },
				result: { content: "original" },
				isError: false,
			},
		],
	};
}

async function exactBundle() {
	return await createTraceBundle(source(), {
		createId: () => "bundle-1",
		now: () => new Date("2026-07-19T00:00:00.000Z"),
		contentCapture: { include: () => true },
	});
}

describe("forkable replay", () => {
	it("forks at an explicit event boundary without executing external work", async () => {
		const bundle = await exactBundle();
		const branch = await createReplayBranch(bundle, {
			branchId: "branch-original",
			forkBeforeSequence: 3,
		});

		expect(await verifyReplayBranch(branch)).toBe(true);
		expect(branch.manifest).toMatchObject({
			branchId: "branch-original",
			forkBeforeSequence: 3,
			prefixEventCount: 2,
			sourceBundleId: "bundle-1",
		});
		expect(branch.stateAtFork.lastSequence).toBe(2);
		expect(branch.stateAtFork.turns["turn-1"]?.status).toBe("active");
		expect(branch.steps.map((step) => [step.kind, step.sequence, step.responseSource])).toEqual([
			["model", 3, "recorded"],
			["tool", 5, "recorded"],
		]);

		const execution = await executeReplayBranch(branch);
		expect(execution.status).toBe("complete");
		expect(execution.items.map((item) => item.responseSource)).toEqual(["recorded", "recorded"]);
	});

	it("uses explicit overrides and requires an adapter after invocation changes", async () => {
		const bundle = await exactBundle();
		const branch = await createReplayBranch(bundle, {
			branchId: "branch-alternate",
			forkBeforeSequence: 3,
			effectiveConfig: { value: { provider: "provider-b", modelId: "model-b" } },
			overrides: [
				{
					kind: "model",
					requestId: "request-1",
					provider: "provider-b",
					modelId: "model-b",
					input: { value: { prompt: "alternate" } },
					response: { source: "adapter" },
				},
				{
					kind: "tool",
					toolCallId: "tool-1",
					response: { source: "override", value: { content: "alternate" }, isError: false },
				},
			],
		});
		const invokeModel = vi.fn(async (_step: Readonly<ReplayBranchModelStep>) => ({ text: "alternate" }));
		const invokeTool = vi.fn(async () => ({ result: { content: "unused" }, isError: false }));

		const withoutAdapter = await executeReplayBranch(branch);
		expect(withoutAdapter.status).toBe("blocked");
		expect(withoutAdapter.items.map((item) => item.status)).toEqual(["blocked", "resolved"]);

		const execution = await executeReplayBranch(branch, { invokeModel, invokeTool });
		expect(execution.status).toBe("complete");
		expect(invokeModel).toHaveBeenCalledOnce();
		expect(invokeModel.mock.calls[0]?.[0]).toMatchObject({ provider: "provider-b", modelId: "model-b" });
		expect(invokeTool).not.toHaveBeenCalled();
		expect(execution.items.map((item) => item.responseSource)).toEqual(["adapter", "override"]);
	});

	it("compares branch outcomes by hash without raw-content comparison output", async () => {
		const bundle = await exactBundle();
		const original = await executeReplayBranch(
			await createReplayBranch(bundle, { branchId: "original", forkBeforeSequence: 3 }),
		);
		const alternate = await executeReplayBranch(
			await createReplayBranch(bundle, {
				branchId: "alternate",
				forkBeforeSequence: 3,
				overrides: [
					{
						kind: "model",
						requestId: "request-1",
						response: { source: "override", value: { text: "different secret" } },
					},
				],
			}),
		);

		const comparison = compareReplayBranches(original, alternate);
		expect(comparison.equivalent).toBe(false);
		expect(comparison.differences).toEqual([
			expect.objectContaining({ kind: "model", id: "request-1", status: "different" }),
			expect.objectContaining({ kind: "tool", id: "tool-1", status: "same" }),
		]);
		expect(JSON.stringify(comparison)).not.toContain("different secret");
	});

	it("rejects redacted inputs without an explicit override", async () => {
		const redacted = await createTraceBundle(source(), { createId: () => "bundle-redacted" });
		await expect(createReplayBranch(redacted, { branchId: "blocked", forkBeforeSequence: 3 })).rejects.toMatchObject({
			code: "content_unavailable",
		});

		const branch = await createReplayBranch(redacted, {
			branchId: "overridden",
			forkBeforeSequence: 3,
			overrides: [
				{
					kind: "model",
					requestId: "request-1",
					input: { value: { prompt: "replacement" } },
					response: { source: "override", value: { text: "replacement" } },
				},
				{
					kind: "tool",
					toolCallId: "tool-1",
					input: { value: { path: "README.md" } },
					response: { source: "override", value: { content: "replacement" }, isError: false },
				},
			],
		});
		expect((await executeReplayBranch(branch)).status).toBe("complete");
	});

	it("rejects out-of-branch overrides and tampered definitions", async () => {
		const bundle = await exactBundle();
		await expect(
			createReplayBranch(bundle, {
				branchId: "bad",
				forkBeforeSequence: 5,
				overrides: [{ kind: "model", requestId: "request-1", response: { source: "adapter" } }],
			}),
		).rejects.toMatchObject({ code: "override_not_found" });

		const branch = await createReplayBranch(bundle, { branchId: "tampered", forkBeforeSequence: 3 });
		branch.steps[0]!.input = { prompt: "tampered" };
		expect(await verifyReplayBranch(branch)).toBe(false);
		await expect(executeReplayBranch(branch)).rejects.toMatchObject({ code: "invalid_branch" });
	});

	it("rejects forks that split an invocation from its terminal event", async () => {
		const bundle = await exactBundle();
		await expect(
			createReplayBranch(bundle, { branchId: "split-model", forkBeforeSequence: 4 }),
		).rejects.toMatchObject({ code: "invalid_branch", message: expect.stringContaining("split model request") });
		await expect(createReplayBranch(bundle, { branchId: "split-tool", forkBeforeSequence: 6 })).rejects.toMatchObject(
			{ code: "invalid_branch", message: expect.stringContaining("split tool call") },
		);
	});

	it("requires exchanges to pair with canonical invocation start events", async () => {
		const mismatchedSource = source();
		mismatchedSource.modelExchanges = [{ ...mismatchedSource.modelExchanges![0]!, sequence: 2 }];
		const mismatched = await createTraceBundle(mismatchedSource, {
			contentCapture: { include: () => true },
		});
		await expect(
			createReplayBranch(mismatched, { branchId: "mismatched", forkBeforeSequence: 1 }),
		).rejects.toMatchObject({
			code: "invalid_bundle",
			message: expect.stringContaining("not paired with its canonical start event"),
		});

		const incompleteSource = source();
		incompleteSource.toolExchanges = [];
		const incomplete = await createTraceBundle(incompleteSource, { contentCapture: { include: () => true } });
		await expect(
			createReplayBranch(incomplete, { branchId: "missing", forkBeforeSequence: 3 }),
		).rejects.toMatchObject({
			code: "content_unavailable",
			message: expect.stringContaining("no exchange recording"),
		});
	});

	it("rejects malformed options and override discriminants with structured errors", async () => {
		const bundle = await exactBundle();
		await expect(
			createReplayBranch(bundle, null as unknown as Parameters<typeof createReplayBranch>[1]),
		).rejects.toMatchObject({ code: "invalid_branch" });
		await expect(
			createReplayBranch(bundle, {
				branchId: "bad-kind",
				forkBeforeSequence: 3,
				overrides: [
					{
						kind: "network",
						toolCallId: "tool-1",
					} as unknown as NonNullable<Parameters<typeof createReplayBranch>[1]["overrides"]>[number],
				],
			}),
		).rejects.toMatchObject({ code: "invalid_branch", message: expect.stringContaining("kind") });
	});

	it("stops waiting for an adapter when execution is aborted", async () => {
		const bundle = await exactBundle();
		const branch = await createReplayBranch(bundle, {
			branchId: "abort",
			forkBeforeSequence: 3,
			overrides: [{ kind: "model", requestId: "request-1", response: { source: "adapter" } }],
		});
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = executeReplayBranch(
			branch,
			{
				invokeModel: async () => {
					markStarted?.();
					return await new Promise(() => undefined);
				},
				invokeTool: async () => ({ result: undefined, isError: false }),
			},
			{ signal: controller.signal },
		);
		await started;
		controller.abort();

		const execution = await pending;
		expect(execution.status).toBe("blocked");
		expect(execution.items[0]).toMatchObject({ kind: "model", status: "blocked" });
	});
});
