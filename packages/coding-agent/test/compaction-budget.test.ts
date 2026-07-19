import type { Context } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	estimateFixedPrefixTokens,
	evaluateContextBudget,
	trimContextToBudget,
	validateCompactionTokenSettings,
} from "../src/core/compaction/index.ts";

const model = { api: "openai-responses", provider: "openai", id: "test", contextWindow: 3_000 } as const;

describe("compaction context budgets", () => {
	it("counts the system prompt, tool definitions, and messages without usage data", () => {
		const context: Context = {
			systemPrompt: "s".repeat(40),
			messages: [{ role: "user", content: "u".repeat(40), timestamp: 1 }],
			tools: [
				{
					name: "tool",
					description: "d".repeat(40),
					parameters: { type: "object", properties: {} },
				},
			],
		};

		const prefixTokens = estimateFixedPrefixTokens(context);
		const contextWindow = prefixTokens + 8;
		const evaluation = evaluateContextBudget(
			context,
			{ api: "openai-responses", provider: "openai", id: "test", contextWindow },
			5,
		);

		expect(prefixTokens).toBeGreaterThan(10);
		expect(evaluation.estimatedTokens).toBeGreaterThan(prefixTokens);
		expect(evaluation).toMatchObject({
			safeInputTokens: contextWindow - 5 - Math.ceil(contextWindow * 0.02),
			overBudget: true,
		});
		expect(evaluation.overBudgetBy).toBeGreaterThan(0);
	});

	it.each([
		[{ reserveTokens: 0, keepRecentTokens: 1 }, "reserveTokens"],
		[{ reserveTokens: 1.5, keepRecentTokens: 1 }, "reserveTokens"],
		[{ reserveTokens: 1, keepRecentTokens: -1 }, "keepRecentTokens"],
		[{ reserveTokens: 100, keepRecentTokens: 1 }, "smaller than the model context window"],
	] as const)("rejects invalid token settings %#", (settings, expectedMessage) => {
		expect(() => validateCompactionTokenSettings(settings, 100)).toThrow(expectedMessage);
	});

	it("rejects invalid model windows instead of returning NaN budgets", () => {
		expect(() =>
			evaluateContextBudget(
				{ messages: [] },
				{ api: "openai-responses", provider: "openai", id: "test", contextWindow: Number.NaN },
				5,
			),
		).toThrow("positive context window");
	});

	it("trims request clones from old to new without changing canonical content", () => {
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "old",
					toolName: "read",
					content: [{ type: "text", text: `old-head-${"a".repeat(8_000)}-old-tail` }],
					isError: false,
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "new",
					toolName: "read",
					content: [{ type: "text", text: `new-head-${"b".repeat(8_000)}-new-tail` }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const original = structuredClone(context);

		const result = trimContextToBudget(context, model, 100);

		expect(result.evaluation.overBudget).toBe(false);
		expect(result.stats.toolResultTextBlocks).toBe(1);
		expect(result.context.messages[0]).toMatchObject({
			content: [{ text: expect.stringContaining("tool result truncated") }],
		});
		expect(result.context.messages[1]).toEqual(context.messages[1]);
		expect(context).toEqual(original);
	});

	it("removes tool-result images before trimming text and protects signatures", () => {
		const text = "x".repeat(6_000);
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "image",
					toolName: "view",
					content: [
						{ type: "text", text, textSignature: "signed-text" },
						{ type: "image", data: "base64", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "secret".repeat(1_000), thinkingSignature: "signed" }],
					api: "openai-responses",
					provider: "openai",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			],
		};

		const result = trimContextToBudget(context, { ...model, contextWindow: 4_300 }, 100);

		expect(result.stats.toolResultImages).toBe(1);
		expect(result.stats.toolResultTextBlocks).toBe(0);
		expect(result.context.messages[0]).toMatchObject({ content: [{ text }, { type: "text" }] });
		expect(result.context.messages[1]).toEqual(context.messages[1]);
	});

	it("trims unsigned plaintext thinking while preserving assistant text", () => {
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: `thinking-head-${"t".repeat(5_000)}-thinking-tail` },
						{ type: "text", text: "protected assistant answer" },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		};
		const result = trimContextToBudget(context, { ...model, contextWindow: 1_000 }, 100);
		const assistant = result.context.messages[0];

		expect(result.evaluation.overBudget).toBe(false);
		expect(result.stats.thinkingBlocks).toBe(1);
		expect(assistant).toMatchObject({
			content: [
				{ thinking: expect.stringContaining("plaintext thinking truncated") },
				{ text: "protected assistant answer" },
			],
		});
		expect(context.messages[0]).not.toEqual(assistant);
	});

	it("fails closed when protected user content alone exceeds the budget", () => {
		const context: Context = {
			messages: [{ role: "user", content: "中".repeat(4_000), timestamp: 1 }],
		};

		const result = trimContextToBudget(context, model, 100);

		expect(result.evaluation.overBudget).toBe(true);
		expect(result.stats.trimmedBlocks).toBe(0);
		expect(result.protectedTokens).toBe(result.evaluation.estimatedTokens);
		expect(result.context).toEqual(context);
	});
});
