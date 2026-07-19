import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn, ToolAttemptOutcome } from "../src/types.ts";

const schema = Type.Object({ value: Type.String() });

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function streamFromFaux(faux: FauxProviderHandle): StreamFn {
	return (model, context, options) => faux.provider.streamSimple(model, context, options);
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function toolEndEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: "tool_execution_end" }>> {
	return events.filter(
		(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
	);
}

describe("tool attempt outcomes", () => {
	it("keeps the public outcome taxonomy closed and complete", () => {
		const exhaustive = {
			not_executed_missing_tool: true,
			not_executed_preparation_error: true,
			not_executed_before_hook_error: true,
			not_executed_blocked: true,
			not_executed_aborted_before_body: true,
			not_executed_truncated: true,
			not_executed_budget: true,
			not_executed_deadline: true,
			not_executed_loop: true,
			body_success: true,
			body_error: true,
			after_hook_error: true,
		} satisfies Record<ToolAttemptOutcome, true>;

		expect(Object.keys(exhaustive)).toHaveLength(12);
	});

	it("classifies preparation, hooks, and body paths without parsing error text", async () => {
		const executed: string[] = [];
		const echoTool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo value",
			parameters: schema,
			async execute(toolCallId, params) {
				executed.push(toolCallId);
				if (toolCallId === "body-error") throw new Error("body failed");
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		const preparationErrorTool: AgentTool<typeof schema> = {
			name: "prepare-error",
			label: "Prepare error",
			description: "Fails while preparing arguments",
			parameters: schema,
			prepareArguments() {
				throw new Error("preparation failed");
			},
			async execute() {
				throw new Error("body must not execute");
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("missing", { value: "x" }, { id: "missing" }),
					fauxToolCall("echo", {}, { id: "invalid" }),
					fauxToolCall("prepare-error", { value: "x" }, { id: "prepare-error" }),
					fauxToolCall("echo", { value: "x" }, { id: "before-error" }),
					fauxToolCall("echo", { value: "x" }, { id: "before-result-error" }),
					fauxToolCall("echo", { value: "x" }, { id: "before-unstringifiable-error" }),
					fauxToolCall("echo", { value: "x" }, { id: "blocked" }),
					fauxToolCall("echo", { value: "x" }, { id: "body-success" }),
					fauxToolCall("echo", { value: "x" }, { id: "body-error" }),
					fauxToolCall("echo", { value: "x" }, { id: "after-error" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[userMessage("start")],
			{ systemPrompt: "", messages: [], tools: [echoTool, preparationErrorTool] },
			{
				model: faux.getModel(),
				convertToLlm,
				toolExecution: "sequential",
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id === "before-error") throw new Error("before hook failed");
					if (toolCall.id === "before-result-error") {
						return new Proxy(
							{ block: false },
							{
								get() {
									throw new Error("before hook result getter failed");
								},
							},
						);
					}
					if (toolCall.id === "before-unstringifiable-error") throw Object.create(null);
					if (toolCall.id === "blocked") return { block: true, reason: "private policy reason" };
					return undefined;
				},
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "after-error") throw new Error("after hook failed");
					return undefined;
				},
			},
			undefined,
			streamFromFaux(faux),
		);
		for await (const event of stream) events.push(event);

		expect(toolEndEvents(events).map((event) => [event.toolCallId, event.attemptOutcome, event.isError])).toEqual([
			["missing", "not_executed_missing_tool", true],
			["invalid", "not_executed_preparation_error", true],
			["prepare-error", "not_executed_preparation_error", true],
			["before-error", "not_executed_before_hook_error", true],
			["before-result-error", "not_executed_before_hook_error", true],
			["before-unstringifiable-error", "not_executed_before_hook_error", true],
			["blocked", "not_executed_blocked", true],
			["body-success", "body_success", false],
			["body-error", "body_error", true],
			["after-error", "after_hook_error", true],
		]);
		expect(executed).toEqual(["body-success", "body-error", "after-error"]);
	});

	it("keeps body provenance when after hooks override isError and gives thrown after hooks precedence", async () => {
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo value",
			parameters: schema,
			async execute(toolCallId, params) {
				if (toolCallId !== "body-success-marked-error") throw new Error("body failed");
				return { content: [{ type: "text", text: params.value }], details: {} };
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "x" }, { id: "body-success-marked-error" }),
					fauxToolCall("echo", { value: "x" }, { id: "body-error-recovered" }),
					fauxToolCall("echo", { value: "x" }, { id: "body-error-after-error" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[userMessage("start")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: faux.getModel(),
				convertToLlm,
				toolExecution: "sequential",
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "body-success-marked-error") return { isError: true };
					if (toolCall.id === "body-error-recovered") return { isError: false };
					throw new Error("after hook failed");
				},
			},
			undefined,
			streamFromFaux(faux),
		);
		for await (const event of stream) events.push(event);

		expect(toolEndEvents(events).map((event) => [event.toolCallId, event.attemptOutcome, event.isError])).toEqual([
			["body-success-marked-error", "body_success", true],
			["body-error-recovered", "body_error", false],
			["body-error-after-error", "after_hook_error", true],
		]);
	});

	it("still emits a classified end when an asynchronous tool update listener rejects", async () => {
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo value",
			parameters: schema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				onUpdate?.({ content: [], details: {} });
				return { content: [], details: {} };
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "update-error" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const events: AgentEvent[] = [];
		await runAgentLoop(
			[userMessage("start")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: faux.getModel(), convertToLlm },
			async (event) => {
				if (event.type === "tool_execution_update") throw Object.create(null);
				events.push(event);
			},
			undefined,
			streamFromFaux(faux),
		);

		expect(toolEndEvents(events)).toMatchObject([
			{ toolCallId: "update-error", attemptOutcome: "body_error", isError: true },
		]);
	});

	it("does not invoke parallel tool bodies when preflight aborts the batch", async () => {
		const controller = new AbortController();
		const executed: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo value",
			parameters: schema,
			async execute(toolCallId) {
				executed.push(toolCallId);
				return { content: [], details: {} };
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "first" }, { id: "call-1" }),
					fauxToolCall("echo", { value: "second" }, { id: "call-2" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[userMessage("start")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: faux.getModel(),
				convertToLlm,
				toolExecution: "parallel",
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id === "call-2") controller.abort();
					return undefined;
				},
			},
			controller.signal,
			streamFromFaux(faux),
		);
		for await (const event of stream) events.push(event);

		const outcomes = toolEndEvents(events)
			.map((event) => [event.toolCallId, event.attemptOutcome] as const)
			.sort(([left], [right]) => left.localeCompare(right));
		expect(executed).toEqual([]);
		expect(outcomes).toEqual([
			["call-1", "not_executed_aborted_before_body"],
			["call-2", "not_executed_aborted_before_body"],
		]);
	});

	it("maps a deadline reached during a signal-ignoring provider response before tool execution", async () => {
		const executed: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo value",
			parameters: schema,
			async execute(toolCallId) {
				executed.push(toolCallId);
				return { content: [], details: {} };
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			async () => {
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				return fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "deadline" }), {
					stopReason: "toolUse",
				});
			},
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[userMessage("start")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: faux.getModel(),
				convertToLlm,
				runBudget: { deadline: Date.now() + 50 },
			},
			undefined,
			(model, context, options) => faux.provider.streamSimple(model, context, { ...options, signal: undefined }),
		);
		for await (const event of stream) events.push(event);

		expect(executed).toEqual([]);
		expect(toolEndEvents(events)).toMatchObject([
			{ toolCallId: "deadline", attemptOutcome: "not_executed_deadline", isError: true },
		]);
		expect(events.find((event) => event.type === "agent_termination")).toMatchObject({
			termination: { status: "deadline_exceeded" },
		});
	});

	it("keeps attemptOutcome optional for legacy tool_execution_end events", () => {
		const legacyEvent: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "legacy",
			toolName: "echo",
			result: { content: [], details: {} },
			isError: false,
		};

		expect(legacyEvent.attemptOutcome).toBeUndefined();
	});
});
