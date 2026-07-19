import { fauxProvider, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentRunBudget,
	StreamFn,
} from "../src/types.ts";

const context: AgentContext = {
	systemPrompt: "",
	messages: [],
	tools: [],
};

const prompt: AgentMessage = {
	role: "user",
	content: "hello",
	timestamp: 0,
};

function createConfig(runBudget: AgentRunBudget): AgentLoopConfig {
	return {
		model: fauxProvider().getModel(),
		convertToLlm: (messages) =>
			messages.filter(
				(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			) as Message[],
		runBudget,
	};
}

const invalidBudgets: Array<{ name: string; runBudget: AgentRunBudget; message: string }> = [
	{
		name: "negative maxSteps",
		runBudget: { maxSteps: -1 },
		message: "Agent run budget maxSteps must be a non-negative safe integer",
	},
	{
		name: "fractional maxSteps",
		runBudget: { maxSteps: 1.5 },
		message: "Agent run budget maxSteps must be a non-negative safe integer",
	},
	{
		name: "unsafe maxSteps",
		runBudget: { maxSteps: Number.MAX_SAFE_INTEGER + 1 },
		message: "Agent run budget maxSteps must be a non-negative safe integer",
	},
	{
		name: "non-finite maxModelCalls",
		runBudget: { maxModelCalls: Number.NaN },
		message: "Agent run budget maxModelCalls must be a non-negative safe integer",
	},
	{
		name: "non-finite maxToolCalls",
		runBudget: { maxToolCalls: Number.POSITIVE_INFINITY },
		message: "Agent run budget maxToolCalls must be a non-negative safe integer",
	},
	{
		name: "negative maxWallTimeMs",
		runBudget: { maxWallTimeMs: -1 },
		message: "Agent run budget maxWallTimeMs must be a finite non-negative number",
	},
	{
		name: "non-finite maxWallTimeMs",
		runBudget: { maxWallTimeMs: Number.NaN },
		message: "Agent run budget maxWallTimeMs must be a finite non-negative number",
	},
	{
		name: "negative maxModelTokens",
		runBudget: { maxModelTokens: -1 },
		message: "Agent run budget maxModelTokens must be a finite non-negative number",
	},
	{
		name: "non-finite maxModelTokens",
		runBudget: { maxModelTokens: Number.POSITIVE_INFINITY },
		message: "Agent run budget maxModelTokens must be a finite non-negative number",
	},
	{
		name: "negative maxCost",
		runBudget: { maxCost: -1 },
		message: "Agent run budget maxCost must be a finite non-negative number",
	},
	{
		name: "non-finite maxCost",
		runBudget: { maxCost: Number.NaN },
		message: "Agent run budget maxCost must be a finite non-negative number",
	},
	{
		name: "negative deadline",
		runBudget: { deadline: -1 },
		message: "Agent run budget deadline must be a finite non-negative number",
	},
	{
		name: "non-finite deadline",
		runBudget: { deadline: Number.POSITIVE_INFINITY },
		message: "Agent run budget deadline must be a finite non-negative number",
	},
];

describe("agent loop run budget validation", () => {
	it.each(invalidBudgets)("rejects $name before emitting events", async ({ runBudget, message }) => {
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		const streamFn: StreamFn = () => {
			providerCalls++;
			throw new Error("provider should not be called");
		};

		await expect(
			runAgentLoop(
				[prompt],
				context,
				createConfig(runBudget),
				(event) => {
					events.push(event);
				},
				undefined,
				streamFn,
			),
		).rejects.toThrow(message);

		expect(events).toEqual([]);
		expect(providerCalls).toBe(0);
	});

	it("keeps zero as a valid immediate limit", async () => {
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		const streamFn: StreamFn = () => {
			providerCalls++;
			throw new Error("provider should not be called");
		};

		await expect(
			runAgentLoop(
				[prompt],
				context,
				createConfig({ maxSteps: 0 }),
				(event) => {
					events.push(event);
				},
				undefined,
				streamFn,
			),
		).resolves.toEqual([prompt]);

		expect(events.some((event) => event.type === "agent_termination")).toBe(true);
		expect(providerCalls).toBe(0);
	});
});
