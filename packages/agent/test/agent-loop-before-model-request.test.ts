import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("agent loop before-model-request guard", () => {
	it("inspects every final provider context and can stop before a later request", async () => {
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "hello" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must not be requested"),
		]);
		const executed: string[] = [];
		const parameters = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof parameters, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a value",
			parameters,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		const inspectedRoles: string[][] = [];
		const transformedContexts: Message[][] = [];
		const config: AgentLoopConfig = {
			model: faux.getModel(),
			convertToLlm,
			transformContext: async (messages) => messages.slice(),
			transformModelRequestContext: (context) => {
				const transformed = {
					...context,
					messages: context.messages.map((message) => ({ ...message })),
				};
				transformedContexts.push(transformed.messages);
				return transformed;
			},
			shouldStopBeforeModelRequest: ({ context }) => {
				inspectedRoles.push(context.messages.map((message) => message.role));
				return inspectedRoles.length === 2;
			},
		};
		const events: AgentEvent[] = [];
		const prompt: AgentMessage = { role: "user", content: "start", timestamp: Date.now() };

		const stream = agentLoop(
			[prompt],
			{ systemPrompt: "system", messages: [], tools: [tool] },
			config,
			undefined,
			(model, context, options) => faux.provider.streamSimple(model, context, options),
		);
		for await (const event of stream) events.push(event);

		expect(inspectedRoles).toEqual([["user"], ["user", "assistant", "toolResult"]]);
		expect(transformedContexts).toHaveLength(2);
		expect(executed).toEqual(["hello"]);
		expect(faux.state.callCount).toBe(1);
		expect(events.at(-1)).toMatchObject({ type: "agent_end" });
		const assistant = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		)?.message;
		expect(assistant).toMatchObject({ requestContextEstimate: { version: 1 } });
	});
});
