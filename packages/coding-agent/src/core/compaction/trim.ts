import { type Context, estimateTextTokens, type Message, type Model } from "@earendil-works/pi-ai/compat";
import type { CompactionTrimReport, ContextBudgetEvaluation } from "./budget.ts";
import { evaluateContextBudget } from "./budget.ts";

const MIN_TOOL_RESULT_TEXT_TOKENS = 256;
const MIN_THINKING_TOKENS = 128;

export interface ContextTrimResult {
	context: Context;
	evaluation: ContextBudgetEvaluation;
	stats: CompactionTrimReport;
	protectedTokens?: number;
}

function cloneMessage(message: Message): Message {
	if (message.role === "user") {
		return {
			...message,
			content:
				typeof message.content === "string" ? message.content : message.content.map((block) => ({ ...block })),
		};
	}
	if (message.role === "toolResult") {
		return { ...message, content: message.content.map((block) => ({ ...block })) };
	}
	return { ...message, content: message.content.map((block) => ({ ...block })) };
}

function takeTextByWeight(codePoints: string[], budgetTokens: number, fromEnd: boolean): string {
	let weight = 0;
	const selected: string[] = [];
	const iterable = fromEnd ? [...codePoints].reverse() : codePoints;
	for (const codePoint of iterable) {
		const nextWeight = (codePoint.codePointAt(0) ?? 0) <= 0x7f ? 1 : 4;
		if (weight + nextWeight > budgetTokens * 4) break;
		selected.push(codePoint);
		weight += nextWeight;
	}
	return (fromEnd ? selected.reverse() : selected).join("");
}

function truncateMiddle(text: string, targetTokens: number, label: string): string {
	const originalTokens = estimateTextTokens(text);
	if (originalTokens <= targetTokens) return text;
	const omittedTokens = Math.max(1, originalTokens - targetTokens);
	const marker = `\n[… ${label}: approximately ${omittedTokens} tokens omitted …]\n`;
	const remainingTokens = Math.max(0, targetTokens - estimateTextTokens(marker));
	const headTokens = Math.ceil(remainingTokens / 2);
	const tailTokens = Math.floor(remainingTokens / 2);
	const codePoints = [...text];
	const head = takeTextByWeight(codePoints, headTokens, false);
	const tail = takeTextByWeight(codePoints.slice([...head].length), tailTokens, true);
	return `${head}${marker}${tail}`;
}

function currentRawReductionNeeded(evaluation: ContextBudgetEvaluation): number {
	return Math.ceil(evaluation.overBudgetBy / Math.max(1, evaluation.calibrationFactor));
}

export function trimContextToBudget(
	input: Context,
	model: Pick<Model<any>, "api" | "provider" | "id" | "contextWindow">,
	reserveTokens: number,
): ContextTrimResult {
	const context: Context = {
		...input,
		messages: input.messages.map(cloneMessage),
		tools: input.tools ? [...input.tools] : undefined,
	};
	const before = evaluateContextBudget(context, model, reserveTokens);
	let evaluation = before;
	let trimmedBlocks = 0;
	let toolResultTextBlocks = 0;
	let toolResultImages = 0;
	let thinkingBlocks = 0;

	for (const message of context.messages) {
		if (!evaluation.overBudget) break;
		if (message.role === "toolResult") {
			for (let index = 0; index < message.content.length && evaluation.overBudget; index++) {
				const block = message.content[index];
				if (block.type !== "image") continue;
				message.content[index] = {
					type: "text",
					text: `[tool result image omitted from request projection: ${block.mimeType}]`,
				};
				trimmedBlocks++;
				toolResultImages++;
				evaluation = evaluateContextBudget(context, model, reserveTokens);
			}

			const textIndexes: number[] = [];
			for (let index = 0; index < message.content.length; index++) {
				const block = message.content[index];
				if (block.type === "text" && !block.textSignature) textIndexes.push(index);
			}
			textIndexes.sort((left, right) => {
				const leftBlock = message.content[left];
				const rightBlock = message.content[right];
				return leftBlock.type === "text" && rightBlock.type === "text"
					? estimateTextTokens(rightBlock.text) - estimateTextTokens(leftBlock.text)
					: 0;
			});
			for (const index of textIndexes) {
				if (!evaluation.overBudget) break;
				const block = message.content[index];
				if (block.type !== "text") continue;
				const originalTokens = estimateTextTokens(block.text);
				if (originalTokens <= MIN_TOOL_RESULT_TEXT_TOKENS) continue;
				const targetTokens = Math.max(
					MIN_TOOL_RESULT_TEXT_TOKENS,
					originalTokens - currentRawReductionNeeded(evaluation),
				);
				const text = truncateMiddle(block.text, targetTokens, "tool result truncated");
				if (text === block.text) continue;
				message.content[index] = { ...block, text };
				trimmedBlocks++;
				toolResultTextBlocks++;
				evaluation = evaluateContextBudget(context, model, reserveTokens);
			}
		} else if (message.role === "assistant") {
			const thinkingIndexes: number[] = [];
			for (let index = 0; index < message.content.length; index++) {
				const block = message.content[index];
				if (block.type === "thinking" && !block.redacted && !block.thinkingSignature) thinkingIndexes.push(index);
			}
			thinkingIndexes.sort((left, right) => {
				const leftBlock = message.content[left];
				const rightBlock = message.content[right];
				return leftBlock.type === "thinking" && rightBlock.type === "thinking"
					? estimateTextTokens(rightBlock.thinking) - estimateTextTokens(leftBlock.thinking)
					: 0;
			});
			for (const index of thinkingIndexes) {
				if (!evaluation.overBudget) break;
				const block = message.content[index];
				if (block.type !== "thinking") continue;
				const originalTokens = estimateTextTokens(block.thinking);
				if (originalTokens <= MIN_THINKING_TOKENS) continue;
				const targetTokens = Math.max(MIN_THINKING_TOKENS, originalTokens - currentRawReductionNeeded(evaluation));
				const thinking = truncateMiddle(block.thinking, targetTokens, "plaintext thinking truncated");
				if (thinking === block.thinking) continue;
				message.content[index] = { ...block, thinking };
				trimmedBlocks++;
				thinkingBlocks++;
				evaluation = evaluateContextBudget(context, model, reserveTokens);
			}
		}
	}

	return {
		context,
		evaluation,
		stats: {
			trimmedBlocks,
			toolResultTextBlocks,
			toolResultImages,
			thinkingBlocks,
			estimatedTokensBefore: before.estimatedTokens,
			estimatedTokensAfter: evaluation.estimatedTokens,
		},
		protectedTokens: evaluation.overBudget ? evaluation.estimatedTokens : undefined,
	};
}
