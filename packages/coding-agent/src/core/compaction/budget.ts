import {
	type Context,
	type ContextEstimateSource,
	type ContextTokenBreakdown,
	calculateContextEstimationMarginTokens,
	estimateContextTokens,
	type Model,
} from "@earendil-works/pi-ai/compat";

export const COMPACTION_RETRY_MARGIN_TOKENS = 4096;
export const MAX_SUMMARY_HEADROOM_TOKENS = 8192;

export type CompactionFitMode = "compacted" | "trim_required";

export interface CompactionTrimReport {
	trimmedBlocks: number;
	toolResultTextBlocks: number;
	toolResultImages: number;
	thinkingBlocks: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
}

export interface CompactionBudgetReport {
	contextWindow: number;
	reserveTokens: number;
	estimationMarginTokens: number;
	safeInputTokens: number;
	fixedPrefixTokens: number;
	summaryHeadroomTokens: number;
	configuredKeepRecentTokens: number;
	effectiveKeepRecentTokens: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
	attempts: number;
	fitMode: CompactionFitMode;
	trim?: CompactionTrimReport;
}

export interface ContextBudgetEvaluation {
	estimatedTokens: number;
	rawEstimatedTokens: number;
	calibrationFactor: number;
	estimateSource: ContextEstimateSource;
	breakdown: ContextTokenBreakdown;
	contextWindow: number;
	reserveTokens: number;
	estimationMarginTokens: number;
	safeInputTokens: number;
	overBudgetBy: number;
	overBudget: boolean;
}

export function validateCompactionTokenSettings(
	settings: { reserveTokens: number; keepRecentTokens: number },
	contextWindow?: number,
): void {
	if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens <= 0) {
		throw new Error("Compaction reserveTokens must be a positive safe integer");
	}
	if (!Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens < 0) {
		throw new Error("Compaction keepRecentTokens must be a non-negative safe integer");
	}
	if (contextWindow !== undefined) {
		if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
			throw new Error("The selected model must define a positive context window for compaction");
		}
		if (settings.reserveTokens >= contextWindow) {
			throw new Error(
				`Compaction reserveTokens (${settings.reserveTokens}) must be smaller than the model context window (${contextWindow})`,
			);
		}
	}
}

export function calculateEstimationMarginTokens(contextWindow: number): number {
	return calculateContextEstimationMarginTokens(contextWindow);
}

export function calculateSummaryHeadroomTokens(
	model: Pick<Model<any>, "maxTokens">,
	reserveTokens: number,
	isSplitTurn: boolean,
): number {
	const base = Math.min(model.maxTokens, Math.floor(reserveTokens * 0.8), MAX_SUMMARY_HEADROOM_TOKENS);
	return isSplitTurn ? Math.min(reserveTokens, base * 2) : base;
}

export function evaluateContextBudget(
	context: Context,
	model: Pick<Model<any>, "api" | "provider" | "id" | "contextWindow">,
	reserveTokens: number,
): ContextBudgetEvaluation {
	validateCompactionTokenSettings({ reserveTokens, keepRecentTokens: 0 }, model.contextWindow);
	const estimate = estimateContextTokens(context, { model });
	const estimationMarginTokens = calculateEstimationMarginTokens(model.contextWindow);
	const safeInputTokens = Math.max(0, model.contextWindow - reserveTokens - estimationMarginTokens);
	const overBudgetBy = Math.max(0, estimate.tokens - safeInputTokens);
	return {
		estimatedTokens: estimate.tokens,
		rawEstimatedTokens: estimate.rawTokens,
		calibrationFactor: estimate.calibrationFactor,
		estimateSource: estimate.source,
		breakdown: estimate.breakdown,
		contextWindow: model.contextWindow,
		reserveTokens,
		estimationMarginTokens,
		safeInputTokens,
		overBudgetBy,
		overBudget: overBudgetBy > 0,
	};
}

export function estimateFixedPrefixTokens(context: Pick<Context, "systemPrompt" | "tools">): number {
	return estimateContextTokens({ ...context, messages: [] }, { calibrate: false }).rawTokens;
}
