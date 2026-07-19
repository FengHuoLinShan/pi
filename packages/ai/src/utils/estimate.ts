import type { Context, ImageContent, Message, Model, TextContent, Tool, Usage } from "../types.ts";

export interface ContextTokenBreakdown {
	systemPrompt: number;
	tools: number;
	messages: number;
	messageFraming: number;
	contentFraming: number;
	images: number;
}

export type ContextEstimateSource = "heuristic" | "calibrated";

export interface ContextUsageEstimate {
	/** Conservative full-context estimate after optional same-model calibration. */
	tokens: number;
	/** Full-context estimate before calibration. */
	rawTokens: number;
	/** Upward-only same-model calibration factor. */
	calibrationFactor: number;
	/** Whether the result used only the heuristic or a persisted usage calibration. */
	source: ContextEstimateSource;
	/** Raw-token contribution by request component. */
	breakdown: ContextTokenBreakdown;
	/** Input tokens from the calibration response, or zero when unavailable. */
	usageTokens: number;
	/** @deprecated Full-context estimation no longer uses a usage prefix plus trailing estimate. */
	trailingTokens: number;
	/** Index of the assistant message used for calibration, or null when unavailable. */
	lastUsageIndex: number | null;
}

export interface ContextEstimateOptions {
	/** Pending request model. Required for same-model calibration. */
	model?: Pick<Model<any>, "api" | "provider" | "id">;
	/** Disable persisted usage calibration when recording a request's raw estimate. */
	calibrate?: boolean;
}

const ASCII_CODE_POINT_MAX = 0x7f;
const ASCII_CODE_POINTS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_TOKENS = 1200;
const MESSAGE_FRAMING_TOKENS = 4;
const CONTENT_BLOCK_FRAMING_TOKENS = 1;
const TOOL_FRAMING_TOKENS = 8;
const MAX_ESTIMATION_MARGIN_TOKENS = 4096;

export function calculateContextEstimationMarginTokens(contextWindow: number): number {
	return Math.min(MAX_ESTIMATION_MARGIN_TOKENS, Math.ceil(contextWindow * 0.02));
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function calculateInputTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

export function estimateTextTokens(text: string): number {
	let weightedCodePoints = 0;
	for (const codePoint of text) {
		weightedCodePoints += (codePoint.codePointAt(0) ?? 0) <= ASCII_CODE_POINT_MAX ? 1 : ASCII_CODE_POINTS_PER_TOKEN;
	}
	return Math.ceil(weightedCodePoints / ASCII_CODE_POINTS_PER_TOKEN);
}

function estimateOptionalText(text: string | undefined): number {
	return text ? estimateTextTokens(text) : 0;
}

function emptyBreakdown(): ContextTokenBreakdown {
	return {
		systemPrompt: 0,
		tools: 0,
		messages: 0,
		messageFraming: 0,
		contentFraming: 0,
		images: 0,
	};
}

function estimateContentBlock(block: TextContent | ImageContent): { content: number; image: number } {
	if (block.type === "image") return { content: 0, image: ESTIMATED_IMAGE_TOKENS };
	return { content: estimateTextTokens(block.text) + estimateOptionalText(block.textSignature), image: 0 };
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") {
		return CONTENT_BLOCK_FRAMING_TOKENS + estimateTextTokens(content);
	}
	let tokens = 0;
	for (const block of content) {
		const estimate = estimateContentBlock(block);
		tokens += CONTENT_BLOCK_FRAMING_TOKENS + estimate.content + estimate.image;
	}
	return tokens;
}

export function estimateMessageTokens(message: Message): number {
	let tokens = MESSAGE_FRAMING_TOKENS;

	if (message.role === "user") return tokens + estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") {
		tokens +=
			estimateTextTokens(message.toolCallId) +
			estimateTextTokens(message.toolName) +
			estimateTextTokens(safeJsonStringify(message.addedToolNames ?? []));
		return tokens + estimateTextAndImageContentTokens(message.content);
	}

	tokens += estimateOptionalText(message.responseId);
	for (const block of message.content) {
		tokens += CONTENT_BLOCK_FRAMING_TOKENS;
		if (block.type === "text") {
			tokens += estimateTextTokens(block.text) + estimateOptionalText(block.textSignature);
		} else if (block.type === "thinking") {
			tokens += estimateTextTokens(block.thinking) + estimateOptionalText(block.thinkingSignature);
		} else {
			tokens +=
				estimateTextTokens(block.id) +
				estimateTextTokens(block.name) +
				estimateTextTokens(safeJsonStringify(block.arguments)) +
				estimateOptionalText(block.thoughtSignature);
		}
	}
	return tokens;
}

function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	let tokens = 0;
	for (const tool of tools ?? []) {
		tokens +=
			TOOL_FRAMING_TOKENS +
			estimateTextTokens(tool.name) +
			estimateTextTokens(tool.description) +
			estimateTextTokens(safeJsonStringify(tool.parameters));
	}
	return tokens;
}

function estimateRawContext(context: Context): { rawTokens: number; breakdown: ContextTokenBreakdown } {
	const breakdown = emptyBreakdown();
	breakdown.systemPrompt = estimateOptionalText(context.systemPrompt);
	breakdown.tools = estimateToolsTokens(context.tools);

	for (const message of context.messages) {
		breakdown.messageFraming += MESSAGE_FRAMING_TOKENS;
		if (message.role === "user") {
			const blocks =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			for (const block of blocks) {
				breakdown.contentFraming += CONTENT_BLOCK_FRAMING_TOKENS;
				const estimate = estimateContentBlock(block);
				breakdown.messages += estimate.content;
				breakdown.images += estimate.image;
			}
		} else if (message.role === "toolResult") {
			breakdown.messages +=
				estimateTextTokens(message.toolCallId) +
				estimateTextTokens(message.toolName) +
				estimateTextTokens(safeJsonStringify(message.addedToolNames ?? []));
			for (const block of message.content) {
				breakdown.contentFraming += CONTENT_BLOCK_FRAMING_TOKENS;
				const estimate = estimateContentBlock(block);
				breakdown.messages += estimate.content;
				breakdown.images += estimate.image;
			}
		} else {
			breakdown.messages += estimateOptionalText(message.responseId);
			for (const block of message.content) {
				breakdown.contentFraming += CONTENT_BLOCK_FRAMING_TOKENS;
				if (block.type === "text") {
					breakdown.messages += estimateTextTokens(block.text) + estimateOptionalText(block.textSignature);
				} else if (block.type === "thinking") {
					breakdown.messages += estimateTextTokens(block.thinking) + estimateOptionalText(block.thinkingSignature);
				} else {
					breakdown.messages +=
						estimateTextTokens(block.id) +
						estimateTextTokens(block.name) +
						estimateTextTokens(safeJsonStringify(block.arguments)) +
						estimateOptionalText(block.thoughtSignature);
				}
			}
		}
	}

	return { rawTokens: Object.values(breakdown).reduce((sum, value) => sum + value, 0), breakdown };
}

function findCalibration(
	messages: readonly Message[],
	model: ContextEstimateOptions["model"],
): { factor: number; usageTokens: number; index: number } | undefined {
	if (!model) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message.role !== "assistant" ||
			message.api !== model.api ||
			message.provider !== model.provider ||
			message.model !== model.id ||
			message.stopReason === "aborted" ||
			message.stopReason === "error" ||
			message.requestContextEstimate?.version !== 1 ||
			message.requestContextEstimate.heuristicInputTokens <= 0
		) {
			continue;
		}
		const usageTokens = calculateInputTokens(message.usage);
		if (usageTokens <= 0) continue;
		const factor = usageTokens / message.requestContextEstimate.heuristicInputTokens;
		if (!Number.isFinite(factor) || factor <= 1) return { factor: 1, usageTokens, index };
		return { factor, usageTokens, index };
	}
	return undefined;
}

function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
	return Array.isArray(value);
}

export function estimateContextTokens(
	contextOrMessages: Context | readonly Message[],
	options: ContextEstimateOptions = {},
): ContextUsageEstimate {
	const context: Context = isMessageArray(contextOrMessages)
		? { messages: [...contextOrMessages] }
		: contextOrMessages;
	const { rawTokens, breakdown } = estimateRawContext(context);
	const calibration = options.calibrate === false ? undefined : findCalibration(context.messages, options.model);
	const calibrationFactor = calibration?.factor ?? 1;
	return {
		tokens: Math.ceil(rawTokens * calibrationFactor),
		rawTokens,
		calibrationFactor,
		source: calibrationFactor > 1 ? "calibrated" : "heuristic",
		breakdown,
		usageTokens: calibration?.usageTokens ?? 0,
		trailingTokens: rawTokens,
		lastUsageIndex: calibration?.index ?? null,
	};
}
