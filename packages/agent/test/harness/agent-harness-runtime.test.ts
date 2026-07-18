import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness, restoreAgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { SessionRuntimeEventStore } from "../../src/harness/runtime-events/event-store.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { calculateTool } from "../utils/calculate.ts";
import { getCurrentTimeTool } from "../utils/get-current-time.ts";

function userText(messages: Array<{ role: string; content: unknown }>): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) return [];
		return message.content.flatMap((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
			return "text" in part && typeof part.text === "string" ? [part.text] : [];
		});
	});
}

describe("AgentHarness durable runtime integration", () => {
	it("persists message replacements before committed observers run", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: "runtime-message-persist" });
		registration.setResponses([() => fauxAssistantMessage("original")]);
		models.setProvider(registration.provider);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const observedAssistantText: string[] = [];
		harness.on("before_message_persist", (event) => {
			if (event.message.role !== "assistant") return undefined;
			return { message: { ...event.message, content: [{ type: "text", text: "replacement" }] } };
		});
		harness.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const first = event.message.content[0];
			if (first?.type === "text") observedAssistantText.push(first.text);
		});

		await harness.promptMessages([{ role: "user", content: "prepared", timestamp: 1 }]);

		const persisted = (await session.getEntries()).flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message.content[0]] : [],
		);
		expect(persisted).toEqual([{ type: "text", text: "replacement" }]);
		expect(observedAssistantText).toEqual(["replacement"]);
	});

	it("continues from an application-projected context as a retry operation", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: "runtime-continue" });
		let requestText: string[] = [];
		registration.setResponses([
			(context) => {
				requestText = userText(context.messages);
				return fauxAssistantMessage("continued");
			},
		]);
		models.setProvider(registration.provider);
		const session = new Session(new InMemorySessionStorage());
		const runtimeEvents = await SessionRuntimeEventStore.open(session);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			runtimeEvents,
			model: registration.getModel(),
		});
		const projected = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "retry input" }],
				timestamp: 1,
			},
		];

		await harness.continue(projected);

		expect(requestText).toEqual(["retry input"]);
		expect(Object.values(runtimeEvents.getState().operations).map((operation) => operation.kind)).toEqual(["retry"]);
	});

	it("journals a complete turn through the production harness", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: "runtime-complete" });
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		models.setProvider(registration.provider);
		const session = new Session(new InMemorySessionStorage());
		const runtimeEvents = await SessionRuntimeEventStore.open(session);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			runtimeEvents,
			model: registration.getModel(),
		});

		await harness.prompt("hello");

		const state = runtimeEvents.getState();
		expect(Object.values(state.operations).map((operation) => operation.status)).toEqual(["finished"]);
		expect(Object.values(state.turns).map((turn) => turn.status)).toEqual(["finished"]);
		expect(Object.values(state.providerRequests).map((request) => request.status)).toEqual(["finished"]);
	});

	it("journals provider failures without marking the request or run successful", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: "runtime-provider-failure" });
		registration.setResponses([
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
		]);
		models.setProvider(registration.provider);
		const session = new Session(new InMemorySessionStorage());
		const runtimeEvents = await SessionRuntimeEventStore.open(session);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			runtimeEvents,
			model: registration.getModel(),
		});

		await harness.prompt("fail");

		const state = runtimeEvents.getState();
		expect(Object.values(state.providerRequests)).toEqual([
			expect.objectContaining({ status: "failed", interruptionReason: "provider exploded" }),
		]);
		expect(Object.values(state.turns).map((turn) => turn.status)).toEqual(["interrupted"]);
		expect(Object.values(state.operations).map((operation) => operation.status)).toEqual(["interrupted"]);
	});

	it("supports host-side prequeueing and selective queue clearing", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: "runtime-host-queue" });
		models.setProvider(registration.provider);
		const session = new Session(new InMemorySessionStorage());
		const runtimeEvents = await SessionRuntimeEventStore.open(session);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			runtimeEvents,
			model: registration.getModel(),
		});
		const steering = { role: "user" as const, content: "steer later", timestamp: 1 };
		const followUp = { role: "user" as const, content: "follow up later", timestamp: 2 };

		await harness.queueSteeringMessage(steering);
		await harness.queueFollowUpMessage(followUp);
		await harness.clearSteeringQueue();

		expect(harness.getQueueSnapshot()).toEqual({ steer: [], followUp: [followUp], nextTurn: [] });
		expect(
			Object.values(runtimeEvents.getState().queueItems)
				.map((item) => item.status)
				.sort(),
		).toEqual(["discarded", "queued"]);
	});

	it("recovers interrupted work, pending writes, queues, and session-selected state", async () => {
		const models = createModels();
		const fallback = fauxProvider({ provider: "runtime-fallback" });
		const restored = fauxProvider({ provider: "runtime-restored" });
		let requestText: string[] = [];
		restored.setResponses([
			(context) => {
				requestText = userText(context.messages);
				return fauxAssistantMessage("restored");
			},
		]);
		models.setProvider(fallback.provider);
		models.setProvider(restored.provider);
		const storage = new InMemorySessionStorage();
		const session = new Session(storage);
		const runtimeEvents = await SessionRuntimeEventStore.open(session);
		const queuedMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "queued before crash" }],
			timestamp: Date.now(),
		};
		await runtimeEvents.append({
			type: "queue_enqueued",
			queueItemId: "queue-1",
			queue: "next_turn",
			message: queuedMessage,
		});
		const pendingWrites = [
			{
				pendingWriteId: "write-model",
				targetEntryId: await storage.createEntryId(),
				write: {
					type: "model_change" as const,
					provider: restored.getModel().provider,
					modelId: restored.getModel().id,
				},
			},
			{
				pendingWriteId: "write-thinking",
				targetEntryId: await storage.createEntryId(),
				write: { type: "thinking_level_change" as const, thinkingLevel: "high" },
			},
			{
				pendingWriteId: "write-tools",
				targetEntryId: await storage.createEntryId(),
				write: { type: "active_tools_change" as const, activeToolNames: [calculateTool.name] },
			},
		];
		for (const pending of pendingWrites) {
			await runtimeEvents.append({ type: "pending_write_enqueued", ...pending });
		}
		await runtimeEvents.append({ type: "operation_started", operationId: "operation-1", kind: "turn" });
		await runtimeEvents.append({
			type: "turn_started",
			turnId: "turn-1",
			operationId: "operation-1",
			consumedQueueItemIds: [],
		});
		await runtimeEvents.append({
			type: "provider_request_started",
			requestId: "request-1",
			turnId: "turn-1",
			provider: fallback.getModel().provider,
			modelId: fallback.getModel().id,
		});

		const result = await restoreAgentHarness(
			{
				models,
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				runtimeEvents,
				model: fallback.getModel(),
				thinkingLevel: "low",
				tools: [calculateTool, getCurrentTimeTool],
			},
			{ recoveryId: "recovery-1", reason: "process restart" },
		);

		expect(result.recovery.plan.preservedQueueItemIds).toEqual(["queue-1"]);
		expect(result.harness.getModel()).toEqual(restored.getModel());
		expect(result.harness.getThinkingLevel()).toBe("high");
		expect(result.harness.getActiveTools().map((tool) => tool.name)).toEqual([calculateTool.name]);
		expect(Object.values(runtimeEvents.getState().pendingWrites).map((write) => write.status)).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		expect(runtimeEvents.getState().providerRequests["request-1"]?.status).toBe("interrupted");

		await result.harness.prompt("after restart");

		expect(requestText).toEqual(["queued before crash", "after restart"]);
		expect(runtimeEvents.getState().queueItems["queue-1"]?.status).toBe("consumed");
	});

	it("fails closed when a persisted model cannot be resolved", async () => {
		const models = createModels();
		const fallback = fauxProvider({ provider: "runtime-model-fallback" });
		models.setProvider(fallback.provider);
		const session = new Session(new InMemorySessionStorage());
		await session.appendModelChange("missing-provider", "missing-model");

		await expect(
			restoreAgentHarness({
				models,
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				model: fallback.getModel(),
			}),
		).rejects.toMatchObject({ code: "invalid_state" });
	});

	it("restores an explicitly supplied current model that is not in the registry", async () => {
		const models = createModels();
		const explicit = fauxProvider({ provider: "runtime-explicit-model" });
		const session = new Session(new InMemorySessionStorage());
		await session.appendModelChange(explicit.getModel().provider, explicit.getModel().id);

		const result = await restoreAgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: explicit.getModel(),
		});

		expect(result.harness.getModel()).toEqual(explicit.getModel());
	});
});
