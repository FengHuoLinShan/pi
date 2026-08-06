import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateContextBudget } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness, totalTokens = 100, turnCount = 1, contentChars = 0): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	for (let index = 0; index < turnCount; index++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [
				{
					type: "text",
					text: contentChars > 0 ? `user-${index}-${"u".repeat(contentChars)}` : "message to compact",
				},
			],
			timestamp: now - (turnCount - index) * 1000,
		});
		const assistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens,
			timestamp: now - (turnCount - index) * 1000 + 500,
		});
		assistant.content = [
			{
				type: "text",
				text: contentChars > 0 ? `assistant-${index}-${"a".repeat(contentChars)}` : "assistant response to compact",
			},
		];
		harness.sessionManager.appendMessage(assistant);
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const settings = harness.settingsManager.getCompactionSettings();
		const estimatedTokensAfter = evaluateContextBudget(
			{
				systemPrompt: harness.session.agent.state.systemPrompt,
				messages: await harness.session.agent.convertToLlm(harness.session.messages),
				tools: harness.session.agent.state.tools,
			},
			harness.getModel(),
			settings.reserveTokens,
		).estimatedTokens;

		expect(result.summary).toBe("summary from extension");
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("projects oversized canonical tool text before summarization and recovers afterward", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 2 } },
			models: [{ id: "faux-1", contextWindow: 32_768, maxTokens: 4_096 }],
		});
		harnesses.push(harness);
		const now = Date.now();
		const oversized = `VISIBLE_HEAD:${"x".repeat(300_000)}:PRIVATE_TAIL`;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "run the tool" }],
			timestamp: now,
		});
		harness.sessionManager.appendMessage({
			...createAssistant(harness, { stopReason: "toolUse", timestamp: now + 1 }),
			content: [fauxToolCall("oversized", {}, { id: "compact-tool" })],
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "compact-tool",
			toolName: "oversized",
			content: [{ type: "text", text: oversized }],
			details: {},
			isError: false,
			timestamp: now + 2,
		});
		harness.sessionManager.appendMessage({
			...createAssistant(harness, { stopReason: "stop", timestamp: now + 3 }),
			content: [{ type: "text", text: "tool complete" }],
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "k" }],
			timestamp: now + 4,
		});
		harness.sessionManager.appendMessage({
			...createAssistant(harness, { stopReason: "stop", timestamp: now + 5 }),
			content: [{ type: "text", text: "a" }],
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const storedToolResult = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		let summarizerPrompt = "";
		harness.setResponses([
			(context) => {
				const message = context.messages[0];
				summarizerPrompt =
					message?.role === "user" && Array.isArray(message.content)
						? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
						: "";
				return fauxAssistantMessage("safe compacted summary");
			},
			fauxAssistantMessage("later response"),
		]);

		await harness.session.compact();
		await harness.session.prompt("continue after compaction");

		expect(summarizerPrompt).toContain("Tool result truncated before model request");
		expect(summarizerPrompt).not.toContain("PRIVATE_TAIL");
		expect(storedToolResult).toMatchObject({
			type: "message",
			message: { content: [{ text: expect.stringContaining("PRIVATE_TAIL") }] },
		});
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "later response"),
			),
		).toBe(true);
	});

	it("regenerates once with a tighter retained-history target when the first result is too large", async () => {
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 10_000 } },
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		seedCompactableSession(harness, 100, 30, 1000);
		harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 100, keepRecentTokens: 10_000 } });
		harness.setResponses([
			fauxAssistantMessage("x".repeat(4000)),
			fauxAssistantMessage("first prefix"),
			fauxAssistantMessage("short checkpoint"),
		]);

		const result = await harness.session.compact();

		expect(harness.faux.state.callCount).toBe(3);
		expect(result.summary).toContain("short checkpoint");
		expect(result.budget).toMatchObject({
			attempts: 2,
			configuredKeepRecentTokens: 10_000,
		});
		expect(result.budget?.effectiveKeepRecentTokens).toBeLessThan(10_000);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(result.budget?.safeInputTokens ?? 0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("rejects an over-budget result after exactly two generation attempts", async () => {
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 10_000 } },
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		seedCompactableSession(harness, 100, 30, 1000);
		harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 100, keepRecentTokens: 10_000 } });
		harness.setResponses([
			fauxAssistantMessage("x".repeat(4000)),
			fauxAssistantMessage("first prefix"),
			fauxAssistantMessage("y".repeat(40_000)),
		]);

		await expect(harness.session.compact()).rejects.toThrow("Compaction still exceeds the safe input budget");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("compacts and resumes when the final provider-ready request exceeds budget", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		seedCompactableSession(harness, 2200, 1, 8_000);
		harness.setResponses([fauxAssistantMessage("short checkpoint"), fauxAssistantMessage("final answer")]);

		await harness.session.prompt("new prompt that must survive proactive compaction");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: true,
			result: { budget: { attempts: 1 } },
		});
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "final answer"),
			),
		).toBe(true);
	});

	it("trims only the provider projection when an oversized tool turn has no valid pre-request cut", async () => {
		const parameters = Type.Object({});
		const tool = {
			name: "large_result",
			label: "Large result",
			description: "Return a large reproducible result",
			parameters,
			async execute() {
				return {
					content: [{ type: "text" as const, text: `original-head-${"x".repeat(32_000)}-original-tail` }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [tool],
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 6_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const recoveredAnswer = createAssistant(harness, { stopReason: "stop" });
		recoveredAnswer.content = [{ type: "text", text: "recovered answer" }];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}, { id: "call-large" }), { stopReason: "toolUse" }),
			recoveredAnswer,
			fauxAssistantMessage("post-response checkpoint"),
		]);

		await harness.session.prompt("run the large result tool");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("context_trim").at(-1)).toMatchObject({
			succeeded: true,
			toolResultTextBlocks: 1,
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const storedToolResult = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(storedToolResult).toMatchObject({
			type: "message",
			message: {
				content: [{ text: expect.stringContaining("original-tail") }],
			},
		});
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "recovered answer"),
			),
		).toBe(true);
	});

	it("recovers a pressured incomplete tool turn after an earlier compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 6_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "already summarized user" }],
			timestamp: now - 5,
		});
		harness.sessionManager.appendMessage({
			...createAssistant(harness, { stopReason: "stop", timestamp: now - 4 }),
			content: [{ type: "text", text: "already summarized assistant" }],
		});
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction("earlier checkpoint", firstKeptEntryId, 100, undefined, false);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "run poisoned legacy tool" }],
			timestamp: now - 3,
		});
		harness.sessionManager.appendMessage({
			...createAssistant(harness, { stopReason: "toolUse", timestamp: now - 2 }),
			content: [fauxToolCall("legacy_tool", {}, { id: "legacy-call" })],
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "legacy-call",
			toolName: "legacy_tool",
			content: [{ type: "text", text: `VISIBLE_HEAD:${"x".repeat(300_000)}:PRIVATE_TAIL` }],
			details: {},
			isError: false,
			timestamp: now - 1,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const storedToolResult = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		const entryCountBeforeRecovery = harness.sessionManager.getEntries().length;

		await expect(harness.session.compact()).rejects.toThrow(
			"Recent tool output exceeds safe request limits but cannot be compacted until the tool turn is complete. Send a follow-up prompt to recover with a bounded projection.",
		);

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getEntries()).toHaveLength(entryCountBeforeRecovery);
		expect(storedToolResult).toMatchObject({
			type: "message",
			message: { content: [{ text: expect.stringContaining("PRIVATE_TAIL") }] },
		});

		let summarizerPrompt = "";
		let finalProviderContext = "";
		harness.setResponses([
			(context) => {
				summarizerPrompt = JSON.stringify(context.messages);
				return fauxAssistantMessage("recovery checkpoint");
			},
			(context) => {
				finalProviderContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("recovered final answer");
			},
		]);

		await harness.session.prompt("continue after poisoned tool turn");

		expect(harness.faux.state.callCount).toBe(2);
		expect(summarizerPrompt).toContain("Tool result truncated before model request");
		expect(summarizerPrompt).not.toContain("PRIVATE_TAIL");
		expect(finalProviderContext).not.toContain("PRIVATE_TAIL");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(storedToolResult).toMatchObject({
			type: "message",
			message: { content: [{ text: expect.stringContaining("PRIVATE_TAIL") }] },
		});
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "recovered final answer"),
			),
		).toBe(true);
	});

	it("keeps the normal Nothing to compact result for a small safe session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "small safe session" }],
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await expect(harness.session.compact()).rejects.toThrow("Nothing to compact (session too small)");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("fails closed when an oversized protected user message cannot be compacted or trimmed", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 3_000, maxTokens: 100 }],
		});
		harnesses.push(harness);

		await harness.session.prompt("中".repeat(4_000));

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("context_trim").at(-1)).toMatchObject({
			succeeded: false,
			trimmedBlocks: 0,
		});
		expect(harness.eventsOfType("context_trim").at(-1)?.remainingOverage).toBeGreaterThan(0);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 } },
			models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.shouldStopBeforeModelRequest = undefined;
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("x".repeat(10_000))).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for errors using same-model request calibration", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		successfulAssistant.requestContextEstimate = { version: 1, heuristicInputTokens: 1_000 };
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
