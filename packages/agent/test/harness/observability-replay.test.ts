import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createDeterministicToolReplay,
	getReplayCapabilities,
	replayLive,
	replayModelInputs,
	replayState,
	replayUi,
} from "../../src/harness/observability/replay.ts";
import {
	HarnessTelemetryCollector,
	type HarnessTelemetryRecord,
	InMemoryHarnessTelemetrySink,
} from "../../src/harness/observability/telemetry.ts";
import {
	createTraceBundle,
	type TraceBundleSource,
	verifyTraceBundle,
} from "../../src/harness/observability/trace-bundle.ts";
import { createRuntimeRecoveryState, reduceRuntimeEvent } from "../../src/harness/runtime-events/reducer.ts";
import {
	RUNTIME_EVENT_VERSION,
	type RuntimeEvent,
	type RuntimeEventEnvelope,
} from "../../src/harness/runtime-events/types.ts";

function idFactory(): () => string {
	let value = 0;
	return () => `id-${++value}`;
}

function clock(): () => number {
	let value = 1000;
	return () => value++;
}

function envelope(sequence: number, event: RuntimeEvent): RuntimeEventEnvelope {
	return {
		version: RUNTIME_EVENT_VERSION,
		eventId: `event-${sequence}`,
		sequence,
		timestamp: `2026-07-19T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		sessionId: "private-session-id",
		event,
	};
}

function runtimeEvents(): RuntimeEventEnvelope[] {
	const events: RuntimeEventEnvelope[] = [
		envelope(1, {
			type: "queue_enqueued",
			queueItemId: "queue-1",
			queue: "next_turn",
			message: { role: "user", content: "PRIVATE PROMPT" },
		}),
		envelope(2, { type: "operation_started", operationId: "operation-1", kind: "turn" }),
		envelope(3, {
			type: "turn_started",
			turnId: "turn-1",
			operationId: "operation-1",
			consumedQueueItemIds: ["queue-1"],
		}),
		envelope(4, {
			type: "provider_request_started",
			requestId: "request-1",
			turnId: "turn-1",
			provider: "deepseek",
			modelId: "v4-flash",
		}),
		envelope(5, { type: "provider_request_finished", requestId: "request-1" }),
		envelope(6, { type: "turn_finished", turnId: "turn-1" }),
		envelope(7, { type: "operation_finished", operationId: "operation-1" }),
	];
	let state = createRuntimeRecoveryState("private-session-id");
	for (const event of events) state = reduceRuntimeEvent(state, event);
	events.push(envelope(8, { type: "checkpoint", throughSequence: 7, state }));
	return events;
}

function traceSource(): TraceBundleSource {
	return {
		sessionId: "private-session-id",
		canonicalEvents: runtimeEvents(),
		effectiveConfig: {
			provider: "deepseek",
			modelId: "v4-flash",
			apiKey: "CONFIG SECRET",
			workspacePath: "/Users/alice/private-repo",
		},
		providerMetadata: [{ provider: "deepseek", modelId: "v4-flash", api: "openai-completions" }],
		schemaHashes: { read: "schema-hash" },
		policyDecisions: [
			{
				decisionId: "decision-1",
				toolName: "write",
				effect: "workspace_write",
				outcome: "allow",
				reason: "USER PRIVATE POLICY REASON",
			},
		],
		workspace: { revision: "abc123", diff: "PRIVATE SOURCE DIFF" },
		modelExchanges: [
			{
				sequence: 4,
				requestId: "request-1",
				provider: "deepseek",
				modelId: "v4-flash",
				input: { prompt: "MODEL INPUT SECRET" },
				output: { text: "MODEL OUTPUT SECRET" },
			},
		],
		toolExchanges: [
			{
				sequence: 5,
				toolCallId: "tool-1",
				toolName: "read",
				input: { path: "/private/file" },
				result: { content: "TOOL RESULT SECRET" },
				isError: false,
			},
		],
		artifacts: [
			{
				artifactId: "artifact-1",
				mimeType: "text/plain",
				sensitivity: "sensitive",
				size: 16,
				checksum: "artifact-hash",
				content: "ARTIFACT SECRET",
			},
		],
		metrics: { turn_wall_time_ms: 42 },
	};
}

describe("privacy-safe harness telemetry", () => {
	it("emits causal spans and low-cardinality metrics without content", () => {
		const sink = new InMemoryHarnessTelemetrySink();
		const collector = new HarnessTelemetryCollector(sink, { createId: idFactory(), now: clock() });
		const registration = fauxProvider({ provider: "telemetry-faux" });
		const model = registration.getModel();
		const assistant = fauxAssistantMessage("ASSISTANT PRIVATE CONTENT");

		collector.record({ type: "agent_start" });
		collector.record({ type: "turn_start" });
		collector.record({
			type: "before_provider_request",
			model,
			sessionId: "SESSION PRIVATE VALUE",
			streamOptions: { headers: { authorization: "BEARER SECRET" } },
		});
		collector.record({ type: "before_provider_payload", model, payload: { prompt: "MODEL PRIVATE CONTENT" } });
		collector.record({
			type: "tool_execution_start",
			toolCallId: "tool-call-1",
			toolName: "read",
			args: { path: "/private/path" },
		});
		collector.record({
			type: "tool_execution_end",
			toolCallId: "tool-call-1",
			toolName: "read",
			result: { content: "TOOL PRIVATE CONTENT" },
			isError: false,
		});
		collector.record({ type: "message_end", message: assistant });
		collector.record({ type: "turn_end", message: assistant, toolResults: [] });
		collector.record({ type: "agent_end", messages: [assistant] });

		const serialized = JSON.stringify(sink.records);
		for (const secret of [
			"ASSISTANT PRIVATE CONTENT",
			"SESSION PRIVATE VALUE",
			"BEARER SECRET",
			"MODEL PRIVATE CONTENT",
			"/private/path",
			"TOOL PRIVATE CONTENT",
		]) {
			expect(serialized).not.toContain(secret);
		}
		const starts = sink.records.filter((record) => record.type === "span_start");
		const turn = starts.find((record) => record.name === "pi.agent.turn");
		const provider = starts.find((record) => record.name === "pi.provider.request");
		const tool = starts.find((record) => record.name === "pi.agent.tool_call");
		expect(provider?.parentSpanId).toBe(turn?.spanId);
		expect(tool?.parentSpanId).toBe(turn?.spanId);
		for (const metric of sink.records.filter((record) => record.type === "metric")) {
			expect(Object.keys(metric.dimensions)).not.toContain("sessionId");
			expect(Object.keys(metric.dimensions)).not.toContain("traceId");
		}
	});

	it("isolates synchronous and asynchronous sink failures", async () => {
		const failingRecords: HarnessTelemetryRecord[] = [];
		const collector = new HarnessTelemetryCollector(
			{
				emit(record) {
					failingRecords.push(record);
					if (failingRecords.length === 1) throw new Error("sync sink failure");
					return Promise.reject(new Error("async sink failure"));
				},
			},
			{ createId: idFactory(), now: clock() },
		);
		expect(() => collector.record({ type: "agent_start" })).not.toThrow();
		expect(() => collector.record({ type: "turn_start" })).not.toThrow();
		await Promise.resolve();
	});

	it("marks budget and loop terminations as failed runs", () => {
		const sink = new InMemoryHarnessTelemetrySink();
		const collector = new HarnessTelemetryCollector(sink, { createId: idFactory(), now: clock() });
		collector.record({ type: "agent_start" });
		collector.record({
			type: "agent_termination",
			termination: {
				status: "budget_exhausted",
				reason: "max_steps",
				limit: 1,
				observed: 1,
				partialResult: true,
			},
			usage: { steps: 1, modelCalls: 1, toolCalls: 0, modelTokens: 10, cost: 0, elapsedMs: 5 },
		});
		collector.record({ type: "agent_end", messages: [] });
		expect(
			[...sink.records].reverse().find((record) => record.type === "span_end" && record.name === "pi.agent.run"),
		).toMatchObject({
			status: "error",
		});
	});
});

describe("trace bundle and replay levels", () => {
	it("redacts content by default while preserving UI and state replay", async () => {
		const bundle = await createTraceBundle(traceSource(), {
			createId: () => "bundle-1",
			now: () => new Date("2026-07-19T00:00:00.000Z"),
		});
		expect(await verifyTraceBundle(bundle)).toBe(true);
		expect(bundle.manifest.sessionId).not.toBe("private-session-id");
		const serialized = JSON.stringify(bundle);
		for (const secret of [
			"private-session-id",
			"PRIVATE PROMPT",
			"CONFIG SECRET",
			"/Users/alice/private-repo",
			"USER PRIVATE POLICY REASON",
			"PRIVATE SOURCE DIFF",
			"MODEL INPUT SECRET",
			"MODEL OUTPUT SECRET",
			"/private/file",
			"TOOL RESULT SECRET",
			"ARTIFACT SECRET",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(bundle.redactionReport.redactedValues).toBeGreaterThan(0);
		expect(getReplayCapabilities(bundle)).toContainEqual({
			level: "model_input",
			available: false,
			reason: "Exact model inputs were not captured",
		});
		const timeline = await replayUi(bundle);
		expect(timeline.find((item) => item.kind === "provider_request_started")).toMatchObject({
			parentId: "turn-1",
			attributes: { provider: "deepseek", model: "v4-flash" },
		});
		const state = await replayState(bundle);
		expect(state.sessionId).toBe(bundle.manifest.sessionId);
		expect(state.operations["operation-1"]?.status).toBe("finished");
		expect(state.queueItems["queue-1"]?.message).toMatchObject({ capture: "redacted" });
		await expect(replayModelInputs(bundle)).rejects.toMatchObject({ code: "level_unavailable" });
	});

	it("supports explicit exact model, deterministic tool, and live replay", async () => {
		const bundle = await createTraceBundle(traceSource(), {
			contentCapture: {
				include: (kind) =>
					kind === "model_input" || kind === "model_output" || kind === "tool_input" || kind === "tool_result",
			},
		});
		expect(bundle.manifest.replay).toMatchObject({ model_input: true, deterministic_tool: true, live: true });
		expect(await replayModelInputs(bundle)).toEqual([
			{
				sequence: 4,
				requestId: "request-1",
				provider: "deepseek",
				modelId: "v4-flash",
				input: { prompt: "MODEL INPUT SECRET" },
			},
		]);

		const tools = await createDeterministicToolReplay(bundle);
		await expect(
			tools.invoke({ toolCallId: "tool-1", toolName: "read", input: { path: "/private/file" } }),
		).resolves.toEqual({ result: { content: "TOOL RESULT SECRET" }, isError: false, recorded: true });
		await expect(
			tools.invoke({ toolCallId: "tool-1", toolName: "read", input: { path: "/different" } }),
		).rejects.toMatchObject({ code: "input_mismatch" });

		const live = await replayLive(bundle, {
			invokeModel: async () => ({ text: "DIFFERENT OUTPUT" }),
			invokeTool: async () => ({ content: "TOOL RESULT SECRET" }),
		});
		expect(live).toEqual([
			expect.objectContaining({ kind: "model", id: "request-1", status: "different" }),
			expect.objectContaining({ kind: "tool", id: "tool-1", status: "match" }),
		]);
	});

	it("rejects a tampered bundle before replay", async () => {
		const bundle = await createTraceBundle(traceSource());
		bundle.metrics.turn_wall_time_ms = 99;
		expect(await verifyTraceBundle(bundle)).toBe(false);
		await expect(replayUi(bundle)).rejects.toMatchObject({ code: "invalid_bundle" });
	});

	it("does not advertise content-dependent replay without recordings", async () => {
		const bundle = await createTraceBundle({
			sessionId: "empty-session",
			canonicalEvents: [],
		});
		expect(bundle.manifest.replay).toEqual({
			ui: true,
			state: true,
			model_input: false,
			deterministic_tool: false,
			live: false,
		});
	});
});
