import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { estimateContextTokens, estimateTextTokens } from "../src/utils/estimate.ts";

function createUsage(inputTokens: number): Usage {
	return {
		input: inputTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: inputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	modelId: string,
	heuristicInputTokens: number | undefined,
	actualInputTokens: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: modelId,
		requestContextEstimate: heuristicInputTokens === undefined ? undefined : { version: 1, heuristicInputTokens },
		usage: createUsage(actualInputTokens),
		stopReason: "stop",
		timestamp: 100,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it("uses conservative code-point weights for mixed text", () => {
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(estimateTextTokens("中文")).toBe(2);
		expect(estimateTextTokens("a中🙂b")).toBe(3);
	});

	it("counts the complete context including framing, tools, images, and signatures", () => {
		const context: Context = {
			systemPrompt: "系统",
			tools: [{ name: "lookup", description: "查询", parameters: Type.Object({ q: Type.String() }) }],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hello", textSignature: "text-signature" },
						{ type: "image", data: "ignored", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				{
					...createAssistant("test-model", undefined, 0),
					content: [
						{ type: "thinking", thinking: "reason", thinkingSignature: "thinking-signature" },
						{
							type: "toolCall",
							id: "call-1",
							name: "lookup",
							arguments: { q: "中文" },
							thoughtSignature: "thought-signature",
						},
					],
				},
			],
		};

		const estimate = estimateContextTokens(context, { model });

		expect(estimate.tokens).toBe(estimate.rawTokens);
		expect(estimate.breakdown.systemPrompt).toBe(2);
		expect(estimate.breakdown.tools).toBeGreaterThan(8);
		expect(estimate.breakdown.images).toBe(1200);
		expect(estimate.breakdown.messageFraming).toBe(8);
		expect(estimate.breakdown.contentFraming).toBe(4);
	});

	it("calibrates upward from the latest same-model request estimate", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				createAssistant("test-model", 100, 150),
				{ role: "user", content: "next", timestamp: 2 },
			],
		};

		const estimate = estimateContextTokens(context, { model });

		expect(estimate.calibrationFactor).toBe(1.5);
		expect(estimate.source).toBe("calibrated");
		expect(estimate.tokens).toBe(Math.ceil(estimate.rawTokens * 1.5));
		expect(estimate.lastUsageIndex).toBe(1);
	});

	it("does not calibrate downward, across models, or for old sessions", () => {
		const oldSession: Context = { messages: [createAssistant("test-model", undefined, 500)] };
		const lowerUsage: Context = { messages: [createAssistant("test-model", 100, 80)] };
		const otherModel: Context = { messages: [createAssistant("other-model", 100, 200)] };

		expect(estimateContextTokens(oldSession, { model }).calibrationFactor).toBe(1);
		expect(estimateContextTokens(lowerUsage, { model }).calibrationFactor).toBe(1);
		expect(estimateContextTokens(otherModel, { model }).calibrationFactor).toBe(1);
	});

	it("uses the unified estimate and percentage margin for max-token clamping", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [{ role: "user", content: "x".repeat(4_000), timestamp: 1 }],
		};
		const estimate = estimateContextTokens(context, { model });

		expect(buildBaseOptions(model, context).maxTokens).toBe(Math.min(8_000, 10_000 - estimate.tokens - 200));
	});
});
