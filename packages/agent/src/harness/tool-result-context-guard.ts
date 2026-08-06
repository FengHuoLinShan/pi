import {
	type Api,
	type Context,
	calculateContextEstimationMarginTokens,
	estimateContextTokens,
	estimateTextTokens,
	type Model,
	type TextContent,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";

/** Maximum UTF-8 bytes of text from one tool result in a provider request, including its truncation notice. */
export const TOOL_RESULT_TEXT_MAX_BYTES = 50 * 1024;
/** Maximum estimated text tokens from one tool result in a provider request, including its truncation notice. */
export const TOOL_RESULT_TEXT_MAX_TOKENS = 12 * 1024;
/** Maximum estimated text tokens from all tool results in one provider request. */
export const TOOL_RESULT_TEXT_TOTAL_MAX_TOKENS = 24 * 1024;

const COMPACT_TRUNCATION_NOTICE =
	"[Tool result truncated before model request to protect context. Re-run the tool with narrower output.]";
const MINIMAL_TRUNCATION_NOTICE = "[Tool output omitted. Re-run narrowly.]";
const MINIMAL_TRUNCATION_NOTICE_TOKENS = estimateTextTokens(MINIMAL_TRUNCATION_NOTICE);
const originalToolResults = new WeakMap<ToolResultMessage, ToolResultMessage>();

interface TextBudget {
	bytes: number;
	tokenUnits: number;
}

interface GuardedToolResult {
	message: ToolResultMessage;
	textTokens: number;
}

/** Raised before a provider call when even an actionable truncation notice cannot fit. */
export class ToolResultContextBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolResultContextBudgetError";
	}
}

function sourceToolResult(message: ToolResultMessage): ToolResultMessage {
	return originalToolResults.get(message) ?? message;
}

function textBlocks(message: ToolResultMessage): TextContent[] {
	return message.content.filter((block): block is TextContent => block.type === "text");
}

function combinedTextBytes(message: ToolResultMessage): number {
	return textBlocks(message).reduce((total, block) => total + Buffer.byteLength(block.text, "utf8"), 0);
}

function combinedTextTokens(message: ToolResultMessage): number {
	return textBlocks(message).reduce((total, block) => total + estimateTextTokens(block.text), 0);
}

function truncationNotice(originalBytes: number, originalTokens: number, maxTokens: number): string {
	const detailed = `[Tool result truncated before model request: original ${originalBytes} bytes / ${originalTokens} estimated tokens; provider-context limits are ${TOOL_RESULT_TEXT_MAX_BYTES} bytes / ${maxTokens} estimated tokens. Re-run the tool with narrower arguments, filtering, pagination, or an explicit output file. Only output references already present in this preview are available; no full-output artifact was created by this guard.]`;
	if (estimateTextTokens(detailed) <= maxTokens) return detailed;
	if (estimateTextTokens(COMPACT_TRUNCATION_NOTICE) <= maxTokens) return COMPACT_TRUNCATION_NOTICE;
	return MINIMAL_TRUNCATION_NOTICE;
}

function textTokenUnits(character: string): number {
	return (character.codePointAt(0) ?? 0) <= 0x7f ? 1 : 4;
}

function takeTextPrefix(text: string, budget: TextBudget): { text: string; bytes: number } {
	let bytes = 0;
	let tokenUnits = 0;
	let end = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		const characterTokenUnits = textTokenUnits(character);
		if (bytes + characterBytes > budget.bytes || tokenUnits + characterTokenUnits > budget.tokenUnits) break;
		bytes += characterBytes;
		tokenUnits += characterTokenUnits;
		end += character.length;
	}
	return { text: text.slice(0, end), bytes };
}

function boundToolResult(message: ToolResultMessage, availableTokens: number): GuardedToolResult {
	const originalBytes = combinedTextBytes(message);
	const originalTokens = combinedTextTokens(message);
	const maxTokens = Math.max(0, Math.min(TOOL_RESULT_TEXT_MAX_TOKENS, availableTokens));
	if (originalBytes <= TOOL_RESULT_TEXT_MAX_BYTES && originalTokens <= maxTokens) {
		return { message, textTokens: originalTokens };
	}
	if (maxTokens < MINIMAL_TRUNCATION_NOTICE_TOKENS) {
		throw new ToolResultContextBudgetError(
			"Cannot safely include tool-result text and an actionable truncation notice while preserving the requested model output reservation. Reduce context, compact earlier history, lower maxTokens, or re-run the tool with narrower output.",
		);
	}

	const notice = truncationNotice(originalBytes, originalTokens, maxTokens);
	const separatedNotice = `\n\n${notice}`;
	const previewBudget: TextBudget = {
		bytes: Math.max(0, TOOL_RESULT_TEXT_MAX_BYTES - Buffer.byteLength(separatedNotice, "utf8")),
		tokenUnits: Math.max(0, (maxTokens - estimateTextTokens(separatedNotice)) * 4),
	};
	const content: ToolResultMessage["content"] = [];
	let retainedBytes = 0;
	let retainedTokens = 0;

	for (const block of message.content) {
		if (block.type === "image") {
			content.push(block);
			continue;
		}
		const retained = takeTextPrefix(block.text, {
			bytes: previewBudget.bytes - retainedBytes,
			tokenUnits: Math.max(0, previewBudget.tokenUnits - retainedTokens * 4),
		});
		if (retained.text.length > 0) {
			content.push(retained.text === block.text ? block : { type: "text", text: retained.text });
			retainedBytes += retained.bytes;
			retainedTokens += estimateTextTokens(retained.text);
		}
	}
	let lastTextIndex = content.length - 1;
	while (lastTextIndex >= 0 && content[lastTextIndex]?.type !== "text") lastTextIndex--;
	if (lastTextIndex >= 0) {
		const lastText = content[lastTextIndex];
		if (lastText?.type === "text")
			content[lastTextIndex] = { type: "text", text: `${lastText.text}${separatedNotice}` };
	} else {
		content.push({ type: "text", text: notice });
	}
	const guardedMessage = { ...message, content };
	return { message: guardedMessage, textTokens: combinedTextTokens(guardedMessage) };
}

function contextWithoutToolText(context: Context): Context {
	return {
		...context,
		messages: context.messages.map((message) =>
			message.role === "toolResult"
				? {
						...message,
						content: message.content.map((block) => (block.type === "text" ? { ...block, text: "" } : block)),
					}
				: message,
		),
	};
}

function normalizedOutputReservation(model: Model<Api>, outputReservationTokens: number | undefined): number {
	const reservation = outputReservationTokens ?? model.maxTokens;
	return Number.isFinite(reservation) ? Math.max(0, Math.floor(reservation)) : 0;
}

/** Assert that a complete provider context preserves its requested output reservation and estimator margin. */
export function assertContextFitsOutputReservation(
	context: Context,
	model: Model<Api>,
	outputReservationTokens: number = model.maxTokens,
): void {
	if (model.contextWindow <= 0) return;
	const reservation = normalizedOutputReservation(model, outputReservationTokens);
	const margin = calculateContextEstimationMarginTokens(model.contextWindow);
	const inputTokens = estimateContextTokens(context, { model }).tokens;
	if (inputTokens + margin + reservation > model.contextWindow) {
		throw new ToolResultContextBudgetError(
			`Provider context uses ${inputTokens} estimated input tokens and cannot preserve the requested ${reservation}-token model output reservation plus ${margin} safety tokens within the ${model.contextWindow}-token context window. Reduce context, compact earlier history, lower maxTokens, or re-run tools with narrower output.`,
		);
	}
}

/**
 * Bound text from tool-result messages at a provider-request boundary.
 *
 * The output reservation, estimator margin, calibrated non-tool input, per-result caps,
 * and aggregate cap are all deducted before previews are allocated newest-first. Images,
 * metadata, structured details, errors, and deferred-tool names are preserved. The input
 * context and canonical session history are not mutated. If actionable notices cannot fit,
 * the request fails closed before calling the provider.
 */
export function guardToolResultContext(
	context: Context,
	model: Model<Api>,
	outputReservationTokens: number = model.maxTokens,
): Context {
	const textualResults = context.messages
		.filter((message): message is ToolResultMessage => message.role === "toolResult")
		.map(sourceToolResult)
		.filter((message) => textBlocks(message).length > 0);
	if (textualResults.length === 0 || model.contextWindow <= 0) return context;

	const baseline = estimateContextTokens(contextWithoutToolText(context), { model });
	const reservation = normalizedOutputReservation(model, outputReservationTokens);
	const margin = calculateContextEstimationMarginTokens(model.contextWindow);
	const safeInputTokens = Math.max(0, model.contextWindow - margin - reservation);
	const remainingContextTokens = Math.max(
		0,
		Math.floor((safeInputTokens - baseline.tokens - 1) / baseline.calibrationFactor),
	);
	const remainingToolBudget = Math.min(TOOL_RESULT_TEXT_TOTAL_MAX_TOKENS, remainingContextTokens);
	const originalTotalTokens = textualResults.reduce((total, message) => total + combinedTextTokens(message), 0);
	const allWithinPerResultCaps = textualResults.every(
		(message) =>
			combinedTextBytes(message) <= TOOL_RESULT_TEXT_MAX_BYTES &&
			combinedTextTokens(message) <= TOOL_RESULT_TEXT_MAX_TOKENS,
	);
	if (allWithinPerResultCaps && originalTotalTokens <= remainingToolBudget) return context;

	const requiredNoticeTokens = textualResults.length * MINIMAL_TRUNCATION_NOTICE_TOKENS;
	if (remainingToolBudget < requiredNoticeTokens) {
		throw new ToolResultContextBudgetError(
			"Cannot safely include tool-result text and actionable truncation notices while preserving the requested model output reservation. Reduce context, compact earlier history, lower maxTokens, or re-run tools with narrower output.",
		);
	}

	let remainingToolTokens = remainingToolBudget;
	let remainingToolResults = textualResults.length;
	let changed = false;
	const messages = [...context.messages];

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult") continue;
		const sourceMessage = sourceToolResult(message);
		if (textBlocks(sourceMessage).length === 0) continue;
		remainingToolResults--;
		const reservedForOlderResults = remainingToolResults * MINIMAL_TRUNCATION_NOTICE_TOKENS;
		const availableTokens = Math.max(0, remainingToolTokens - reservedForOlderResults);
		const guarded = boundToolResult(sourceMessage, availableTokens);
		messages[index] = guarded.message;
		if (guarded.message !== sourceMessage) originalToolResults.set(guarded.message, sourceMessage);
		changed ||= guarded.message !== message;
		remainingToolTokens = Math.max(0, remainingToolTokens - guarded.textTokens);
	}

	const guardedContext = changed ? { ...context, messages } : context;
	assertContextFitsOutputReservation(guardedContext, model, reservation);
	return guardedContext;
}
