import { describe, expect, it } from "vitest";
import {
	type MineReplayEvalOptions,
	mineReplayEval,
	runMinedReplayEval,
	verifyMinedReplayEvalFixture,
} from "../../src/evals/trace-mining.ts";
import { createTraceBundle, type TraceBundleSource } from "../../src/harness/observability/trace-bundle.ts";
import { RUNTIME_EVENT_VERSION, type RuntimeEventEnvelope } from "../../src/harness/runtime-events/types.ts";

function source(toolError: boolean, metrics: Record<string, number> = {}): TraceBundleSource {
	const canonicalEvents: RuntimeEventEnvelope[] = [
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-1",
			sequence: 1,
			timestamp: "2026-07-30T00:00:01.000Z",
			sessionId: "session-1",
			event: { type: "operation_started", operationId: "operation-1", kind: "turn" },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-2",
			sequence: 2,
			timestamp: "2026-07-30T00:00:02.000Z",
			sessionId: "session-1",
			event: { type: "turn_started", turnId: "turn-1", operationId: "operation-1", consumedQueueItemIds: [] },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-3",
			sequence: 3,
			timestamp: "2026-07-30T00:00:03.000Z",
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
			timestamp: "2026-07-30T00:00:04.000Z",
			sessionId: "session-1",
			event: { type: "provider_request_finished", requestId: "request-1" },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-5",
			sequence: 5,
			timestamp: "2026-07-30T00:00:05.000Z",
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
			timestamp: "2026-07-30T00:00:06.000Z",
			sessionId: "session-1",
			event: { type: "tool_call_finished", toolCallId: "tool-1" },
		},
	];
	return {
		sessionId: "session-1",
		canonicalEvents,
		modelExchanges: [
			{
				sequence: 3,
				requestId: "request-1",
				provider: "provider-a",
				modelId: "model-a",
				input: { prompt: "inspect the file" },
				output: { text: "read it" },
			},
		],
		toolExchanges: [
			{
				sequence: 5,
				toolCallId: "tool-1",
				toolName: "read",
				input: { path: "secret.txt" },
				result: { content: "original secret" },
				isError: toolError,
			},
		],
		metrics,
	};
}

async function exactBundle(toolError = true, metrics: Record<string, number> = {}) {
	return await createTraceBundle(source(toolError, metrics), {
		createId: () => "bundle-1",
		now: () => new Date("2026-07-30T00:00:00.000Z"),
		contentCapture: { include: () => true },
	});
}

describe("trace replay eval mining", () => {
	it("requires a second explicit content opt-in and a failed or costly candidate", async () => {
		const failed = await exactBundle();
		await expect(
			mineReplayEval(failed, {
				id: "read-regression",
				allowCapturedContent: false,
				adapterKinds: ["tool"],
			}),
		).rejects.toMatchObject({ code: "content_not_allowed" });

		const successful = await exactBundle(false);
		await expect(
			mineReplayEval(successful, {
				id: "not-a-candidate",
				allowCapturedContent: true,
				adapterKinds: ["tool"],
			}),
		).rejects.toMatchObject({ code: "not_candidate" });

		await expect(
			mineReplayEval(failed, {
				id: "invalid-expectation",
				allowCapturedContent: true,
				expectation: "unexpected",
			} as unknown as MineReplayEvalOptions),
		).rejects.toMatchObject({ code: "invalid_options" });
	});

	it("mines the minimal critical suffix and evaluates it without result content in the fixture baseline or report", async () => {
		const fixture = await mineReplayEval(await exactBundle(), {
			id: "read-regression",
			description: "Keep the observed read failure stable until fixed.",
			allowCapturedContent: true,
			adapterKinds: ["tool"],
		});

		expect(fixture).toMatchObject({
			criticalSequence: 5,
			reasons: [{ kind: "tool-error", sequence: 5, id: "tool-1" }],
			expectation: "equivalent",
			baseline: {
				status: "complete",
				items: [expect.objectContaining({ id: "tool-1", resultHash: expect.any(String), isError: true })],
			},
		});
		expect(fixture.candidateBranch.steps).toEqual([
			expect.objectContaining({
				kind: "tool",
				toolCallId: "tool-1",
				sequence: 5,
				responseSource: undefined,
			}),
		]);
		expect(JSON.stringify(fixture.baseline)).not.toContain("original secret");
		expect(await verifyMinedReplayEvalFixture(fixture)).toBe(true);

		const same = await runMinedReplayEval(fixture, {
			invokeModel: async () => ({ text: "unused" }),
			invokeTool: async () => ({ result: { content: "original secret" }, isError: true }),
		});
		expect(same).toMatchObject({ passed: true, comparison: { equivalent: true } });

		const changed = await runMinedReplayEval(fixture, {
			invokeModel: async () => ({ text: "unused" }),
			invokeTool: async () => ({ result: { content: "different secret" }, isError: false }),
		});
		expect(changed).toMatchObject({ passed: false, comparison: { equivalent: false } });
		expect(JSON.stringify(changed)).not.toContain("different secret");
	});

	it("mines costly runs from explicit metric thresholds and detects fixture tampering", async () => {
		const fixture = await mineReplayEval(await exactBundle(false, { modelTokens: 5_000 }), {
			id: "cost-regression",
			allowCapturedContent: true,
			adapterKinds: ["tool"],
			metricThresholds: { modelTokens: 1_000 },
		});
		expect(fixture).toMatchObject({
			criticalSequence: 5,
			reasons: [
				{
					kind: "metric-threshold",
					id: "modelTokens",
					value: 5_000,
					threshold: 1_000,
				},
			],
		});

		fixture.candidateBranch.steps[0]!.input = { path: "tampered.txt" };
		expect(await verifyMinedReplayEvalFixture(fixture)).toBe(false);
		await expect(
			runMinedReplayEval(fixture, {
				invokeModel: async () => undefined,
				invokeTool: async () => ({ result: undefined, isError: false }),
			}),
		).rejects.toMatchObject({ code: "invalid_fixture" });
	});

	it("distinguishes malformed trace structure from unavailable captured content", async () => {
		const malformedSource = source(true);
		const malformedBundle = await createTraceBundle(
			{
				...malformedSource,
				toolExchanges: malformedSource.toolExchanges?.map((exchange) => ({ ...exchange, sequence: 3 })),
			},
			{
				createId: () => "bundle-malformed",
				now: () => new Date("2026-07-30T00:00:00.000Z"),
				contentCapture: { include: () => true },
			},
		);

		await expect(
			mineReplayEval(malformedBundle, {
				id: "malformed-trace",
				allowCapturedContent: true,
				adapterKinds: ["tool"],
			}),
		).rejects.toMatchObject({ code: "invalid_bundle" });
	});
});
