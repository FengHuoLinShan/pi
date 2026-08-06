import {
	type Context,
	calculateContextEstimationMarginTokens,
	createModels,
	estimateContextTokens,
	estimateTextTokens,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import {
	guardToolResultContext,
	TOOL_RESULT_TEXT_MAX_BYTES,
	TOOL_RESULT_TEXT_TOTAL_MAX_TOKENS,
} from "../../src/harness/tool-result-context-guard.ts";

const SAFE_REQUEST_BYTES = 128 * 1024;
let providerCount = 0;

function toolResults(context: Context): ToolResultMessage[] {
	return context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function toolResultText(message: ToolResultMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function assistantText(message: Awaited<ReturnType<AgentHarness["prompt"]>>): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

describe("AgentHarness tool-result context reliability", () => {
	it("bounds a multi-megabyte custom result before every model request and recovers on a later prompt", async () => {
		const models = createModels();
		const registration = fauxProvider({
			provider: `tool-result-guard-${++providerCount}`,
			models: [{ id: "small-context", contextWindow: 32_768, maxTokens: 4_096 }],
		});
		models.setProvider(registration.provider);
		const oversized = `BEGIN:${"🙂".repeat(800_000)}:PRIVATE_TAIL`;
		const seenRequestBytes: number[] = [];
		const seenToolText: string[] = [];
		const seenImageCounts: number[] = [];
		const inspectRequest = (context: Context, successText: string) => {
			const requestBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
			seenRequestBytes.push(requestBytes);
			const result = toolResults(context).at(-1);
			if (result) {
				seenToolText.push(toolResultText(result));
				seenImageCounts.push(result.content.filter((block) => block.type === "image").length);
			}
			return fauxAssistantMessage(successText);
		};
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("oversized", {}, { id: "oversized-call" }), {
					stopReason: "toolUse",
				}),
			(context) => inspectRequest(context, "first recovered"),
			(context) => inspectRequest(context, "later recovered"),
		]);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [
				{
					name: "oversized",
					label: "Oversized",
					description: "Return oversized text and an image",
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [
								{ type: "text" as const, text: oversized },
								{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
							],
							details: { source: "custom" },
						};
					},
				},
			],
		});

		const first = await harness.prompt("run the tool");
		const later = await harness.prompt("respond again");

		expect(assistantText(first)).toBe("first recovered");
		expect(assistantText(later)).toBe("later recovered");
		expect(seenRequestBytes).toHaveLength(2);
		expect(seenRequestBytes.every((bytes) => bytes <= SAFE_REQUEST_BYTES)).toBe(true);
		expect(seenToolText).toHaveLength(2);
		expect(seenToolText.every((text) => Buffer.byteLength(text, "utf8") <= TOOL_RESULT_TEXT_MAX_BYTES)).toBe(true);
		expect(seenToolText.every((text) => text.includes("Tool result truncated before model request"))).toBe(true);
		expect(seenToolText.every((text) => text.includes("Re-run the tool with narrower"))).toBe(true);
		expect(seenToolText.every((text) => !text.includes("PRIVATE_TAIL"))).toBe(true);
		expect(seenToolText.every((text) => Buffer.from(text, "utf8").toString("utf8") === text)).toBe(true);
		expect(seenImageCounts).toEqual([1, 1]);
	});

	it("projects oversized canonical tool text before compaction and recovers afterward", async () => {
		const models = createModels();
		const registration = fauxProvider({
			provider: `tool-result-compaction-${++providerCount}`,
			models: [{ id: "compaction-context", contextWindow: 32_768, maxTokens: 4_096 }],
		});
		models.setProvider(registration.provider);
		const session = new Session(new InMemorySessionStorage());
		const oversized = `VISIBLE_HEAD:${"x".repeat(300_000)}:PRIVATE_TAIL`;
		let summarizerPrompt = "";
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("oversized", {}, { id: "compact-call" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("tool turn complete"),
			(context) => {
				const message = context.messages[0];
				summarizerPrompt =
					message?.role === "user" && Array.isArray(message.content)
						? toolResultText({
								role: "toolResult",
								toolCallId: "summary",
								toolName: "summary",
								content: message.content.filter((block) => block.type === "text"),
								details: {},
								isError: false,
								timestamp: 0,
							})
						: "";
				return fauxAssistantMessage("compacted summary");
			},
			() => fauxAssistantMessage("later response"),
		]);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [
				{
					name: "oversized",
					label: "Oversized",
					description: "Return oversized text",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text" as const, text: oversized }], details: {} };
					},
				},
			],
		});

		await harness.prompt("run then compact");
		const storedBefore = (await session.getBranch()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		await harness.compact();
		const later = await harness.prompt("continue after compaction");

		expect(summarizerPrompt).toContain("Tool result truncated before model request");
		expect(summarizerPrompt).not.toContain("PRIVATE_TAIL");
		expect(storedBefore).toMatchObject({
			type: "message",
			message: { content: [{ text: expect.stringContaining("PRIVATE_TAIL") }] },
		});
		expect(assistantText(later)).toBe("later response");
	});

	it("keeps several oversized results within the cumulative text-token cap", () => {
		const registration = fauxProvider({
			provider: `tool-result-total-${++providerCount}`,
			models: [{ id: "total-context", contextWindow: 128_000, maxTokens: 4_096 }],
		});
		const oversizedText = "x".repeat(200_000);
		const context: Context = {
			messages: Array.from({ length: 3 }, (_, index) => ({
				role: "toolResult" as const,
				toolCallId: `call-${index}`,
				toolName: "oversized",
				content: [{ type: "text" as const, text: oversizedText }],
				details: {},
				isError: false,
				timestamp: index,
			})),
		};

		const guarded = guardToolResultContext(context, registration.getModel());
		const guardedResults = toolResults(guarded);
		const totalTextTokens = guardedResults.reduce(
			(total, result) => total + estimateTextTokens(toolResultText(result)),
			0,
		);

		expect(totalTextTokens).toBeLessThanOrEqual(TOOL_RESULT_TEXT_TOTAL_MAX_TOKENS);
		expect(guardedResults.every((result) => toolResultText(result).includes("Re-run"))).toBe(true);
	});

	it("preserves a large model output reservation", () => {
		const registration = fauxProvider({
			provider: `tool-result-output-reserve-${++providerCount}`,
			models: [{ id: "large-output", contextWindow: 128_000, maxTokens: 64_000 }],
		});
		const model = registration.getModel();
		const context: Context = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "n".repeat(200_000) }], timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "large-output-call",
					toolName: "oversized",
					content: [{ type: "text", text: "t".repeat(300_000) }],
					details: {},
					isError: false,
					timestamp: 2,
				},
			],
		};

		const guarded = guardToolResultContext(context, model, model.maxTokens);
		const inputTokens = estimateContextTokens(guarded, { model }).tokens;

		expect(
			inputTokens + calculateContextEstimationMarginTokens(model.contextWindow) + model.maxTokens,
		).toBeLessThanOrEqual(model.contextWindow);
	});

	it("uses the request maxTokens override at the final provider boundary", async () => {
		const models = createModels();
		const registration = fauxProvider({
			provider: `tool-result-request-reserve-${++providerCount}`,
			models: [{ id: "request-output", contextWindow: 18_000, maxTokens: 16_000 }],
		});
		models.setProvider(registration.provider);
		const model = registration.getModel();
		let preModelContext: Context | undefined;
		let providerContext: Context | undefined;
		let providerMaxTokens: number | undefined;
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("oversized", {}, { id: "request-call" }), { stopReason: "toolUse" }),
			(context, options) => {
				providerContext = context;
				providerMaxTokens = options?.maxTokens;
				return fauxAssistantMessage("reserved");
			},
		]);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model,
			streamOptions: { maxTokens: 2_000 },
			shouldStopBeforeModelRequest: ({ context }) => {
				if (toolResults(context).length > 0) preModelContext = context;
				return false;
			},
			tools: [
				{
					name: "oversized",
					label: "Oversized",
					description: "Return oversized text",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text" as const, text: "x".repeat(300_000) }], details: {} };
					},
				},
			],
		});
		harness.on("before_provider_request", () => ({ streamOptions: { maxTokens: 8_000 } }));

		await harness.prompt("run with an output reservation");

		expect(preModelContext).toBeDefined();
		const preModelInputTokens = estimateContextTokens(preModelContext!, { model }).tokens;
		expect(
			preModelInputTokens + calculateContextEstimationMarginTokens(model.contextWindow) + 2_000,
		).toBeLessThanOrEqual(model.contextWindow);
		expect(providerMaxTokens).toBe(8_000);
		expect(providerContext).toBeDefined();
		const providerToolText = toolResultText(toolResults(providerContext!)[0]!);
		expect(providerToolText.match(/Tool result truncated before model request/g)).toHaveLength(1);
		const inputTokens = estimateContextTokens(providerContext!, { model }).tokens;
		expect(inputTokens + calculateContextEstimationMarginTokens(model.contextWindow) + 8_000).toBeLessThanOrEqual(
			model.contextWindow,
		);
	});

	it("fails closed when no input budget remains for an actionable notice", () => {
		const registration = fauxProvider({
			provider: `tool-result-zero-budget-${++providerCount}`,
			models: [{ id: "zero-input", contextWindow: 8_000, maxTokens: 7_000 }],
		});
		const context: Context = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "n".repeat(8_000) }], timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "zero-call",
					toolName: "oversized",
					content: [{ type: "text", text: "x".repeat(100_000) }],
					details: {},
					isError: false,
					timestamp: 2,
				},
			],
		};

		expect(() => guardToolResultContext(context, registration.getModel(), 7_000)).toThrow(
			/cannot safely include tool-result text/i,
		);
	});

	it("fits deterministic notices for multiple results inside remaining input budget", () => {
		const registration = fauxProvider({
			provider: `tool-result-notices-${++providerCount}`,
			models: [{ id: "notice-budget", contextWindow: 4_000, maxTokens: 1_000 }],
		});
		const model = registration.getModel();
		const context: Context = {
			messages: Array.from({ length: 3 }, (_, index) => ({
				role: "toolResult" as const,
				toolCallId: `notice-${index}`,
				toolName: "oversized",
				content: [{ type: "text" as const, text: "x".repeat(100_000) }],
				details: {},
				isError: false,
				timestamp: index,
			})),
		};

		const guarded = guardToolResultContext(context, model, 1_000);
		const results = toolResults(guarded);
		const inputTokens = estimateContextTokens(guarded, { model }).tokens;

		expect(results).toHaveLength(3);
		expect(results.every((result) => toolResultText(result).includes("Re-run"))).toBe(true);
		expect(inputTokens + calculateContextEstimationMarginTokens(model.contextWindow) + 1_000).toBeLessThanOrEqual(
			model.contextWindow,
		);
	});

	it("leaves ordinary tool text, details, and images unchanged", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `tool-result-small-${++providerCount}` });
		models.setProvider(registration.provider);
		let observed: ToolResultMessage | undefined;
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("small", {}, { id: "small-call" }), { stopReason: "toolUse" }),
			(context) => {
				observed = toolResults(context).at(-1);
				return fauxAssistantMessage("done");
			},
		]);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [
				{
					name: "small",
					label: "Small",
					description: "Return a small result",
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [
								{ type: "text" as const, text: "small output" },
								{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
							],
							details: { stable: true },
						};
					},
				},
			],
		});

		await harness.prompt("run the small tool");

		expect(observed).toMatchObject({
			content: [
				{ type: "text", text: "small output" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			details: { stable: true },
		});
	});
});
