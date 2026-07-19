import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ModelRouteCandidate, ModelRoutePlan } from "./model-routing.ts";

export type StructuredFailureKind =
	| "context_overflow"
	| "transient_provider"
	| "rate_limited"
	| "quota_exhausted"
	| "authentication"
	| "invalid_request"
	| "tool_failed"
	| "policy_denied"
	| "budget_exhausted"
	| "aborted"
	| "unknown";

export type StructuredFailureSource = "model" | "tool" | "policy" | "runtime";

export interface StructuredFailure {
	kind: StructuredFailureKind;
	source: StructuredFailureSource;
	summary: string;
	attempt: number;
	code?: string;
	retryAfterMs?: number;
	tool?: { name: string; retrySafe: boolean };
	approvalAvailable?: boolean;
}

export interface ClassifyAssistantFailureOptions {
	attempt: number;
	contextWindow?: number;
}

interface RecoveryActionBase {
	id: string;
	summary: string;
}

export interface RetryRequestRecoveryAction extends RecoveryActionBase {
	kind: "retry_request";
	routeId?: string;
	afterMs: number;
}

export interface SwitchModelRecoveryAction extends RecoveryActionBase {
	kind: "switch_model";
	routeId: string;
	provider: string;
	model: string;
}

export interface CompactContextRecoveryAction extends RecoveryActionBase {
	kind: "compact_context";
}

export interface RetryToolRecoveryAction extends RecoveryActionBase {
	kind: "retry_tool";
	toolName: string;
}

export interface ReauthenticateRecoveryAction extends RecoveryActionBase {
	kind: "reauthenticate";
	provider?: string;
}

export interface RequestApprovalRecoveryAction extends RecoveryActionBase {
	kind: "request_approval";
}

export interface StopRecoveryAction extends RecoveryActionBase {
	kind: "stop";
	reason: StructuredFailureKind;
}

export type StructuredRecoveryAction =
	| RetryRequestRecoveryAction
	| SwitchModelRecoveryAction
	| CompactContextRecoveryAction
	| RetryToolRecoveryAction
	| ReauthenticateRecoveryAction
	| RequestApprovalRecoveryAction
	| StopRecoveryAction;

export interface PlanStructuredRecoveryOptions {
	failure: StructuredFailure;
	routePlan?: ModelRoutePlan;
	currentRouteId?: string;
	maxRequestAttempts?: number;
	maxToolAttempts?: number;
	maxRetryDelayMs?: number;
	compaction?: { available: boolean; attempts: number; maxAttempts: number };
	reauthenticationAvailable?: boolean;
	approvalAvailable?: boolean;
}

export interface StructuredRecoveryPlan {
	version: 1;
	failure: StructuredFailure;
	currentRouteId?: string;
	recommendedActionId: string;
	actions: StructuredRecoveryAction[];
	terminal: boolean;
}

export interface StructuredRecoveryHandlers<TResult> {
	retryRequest?: (action: RetryRequestRecoveryAction, signal: AbortSignal) => TResult | Promise<TResult>;
	switchModel?: (action: SwitchModelRecoveryAction, signal: AbortSignal) => TResult | Promise<TResult>;
	compactContext?: (action: CompactContextRecoveryAction, signal: AbortSignal) => TResult | Promise<TResult>;
	retryTool?: (action: RetryToolRecoveryAction, signal: AbortSignal) => TResult | Promise<TResult>;
	reauthenticate?: (action: ReauthenticateRecoveryAction, signal: AbortSignal) => TResult | Promise<TResult>;
	requestApproval?: (action: RequestApprovalRecoveryAction, signal: AbortSignal) => TResult | Promise<TResult>;
	stop?: (action: StopRecoveryAction, signal: AbortSignal) => TResult | Promise<TResult>;
}

export type StructuredRecoveryErrorCode =
	| "invalid_failure"
	| "invalid_options"
	| "action_not_found"
	| "handler_missing"
	| "aborted";

export class StructuredRecoveryError extends Error {
	public code: StructuredRecoveryErrorCode;

	constructor(code: StructuredRecoveryErrorCode, message: string) {
		super(message);
		this.name = "StructuredRecoveryError";
		this.code = code;
	}
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new StructuredRecoveryError("invalid_failure", `${label} must not be empty`);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireOptionNonEmpty(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new StructuredRecoveryError("invalid_options", `${label} must not be empty`);
	}
}

function requirePositiveInteger(value: number | undefined, label: string, code: StructuredRecoveryErrorCode): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new StructuredRecoveryError(code, `${label} must be a positive integer`);
	}
}

function validateFailure(failure: StructuredFailure): StructuredFailure {
	if (!isPlainObject(failure)) {
		throw new StructuredRecoveryError("invalid_failure", "Structured failure must be an object");
	}
	if (
		![
			"context_overflow",
			"transient_provider",
			"rate_limited",
			"quota_exhausted",
			"authentication",
			"invalid_request",
			"tool_failed",
			"policy_denied",
			"budget_exhausted",
			"aborted",
			"unknown",
		].includes(failure.kind)
	) {
		throw new StructuredRecoveryError("invalid_failure", `Invalid structured failure kind: ${String(failure.kind)}`);
	}
	if (!(["model", "tool", "policy", "runtime"] as const).includes(failure.source)) {
		throw new StructuredRecoveryError(
			"invalid_failure",
			`Invalid structured failure source: ${String(failure.source)}`,
		);
	}
	requireNonEmpty(failure.summary, "Structured failure summary");
	requirePositiveInteger(failure.attempt, "Structured failure attempt", "invalid_failure");
	if (failure.retryAfterMs !== undefined && (!Number.isFinite(failure.retryAfterMs) || failure.retryAfterMs < 0)) {
		throw new StructuredRecoveryError("invalid_failure", "Structured failure retry delay must be non-negative");
	}
	if (failure.code !== undefined) requireNonEmpty(failure.code, "Structured failure code");
	if (failure.approvalAvailable !== undefined && typeof failure.approvalAvailable !== "boolean") {
		throw new StructuredRecoveryError("invalid_failure", "Structured failure approval availability must be boolean");
	}
	if (failure.kind === "tool_failed") {
		if (!isPlainObject(failure.tool) || typeof failure.tool.retrySafe !== "boolean") {
			throw new StructuredRecoveryError("invalid_failure", "Tool failure requires retry-safety metadata");
		}
		requireNonEmpty(failure.tool.name, "Failed tool name");
	}
	return {
		...failure,
		tool: failure.tool ? { ...failure.tool } : undefined,
	};
}

/** Convert pi-ai terminal messages into a stable recovery failure when one is present. */
export function classifyAssistantFailure(
	message: AssistantMessage,
	options: ClassifyAssistantFailureOptions,
): StructuredFailure | undefined {
	requirePositiveInteger(options.attempt, "Assistant failure attempt", "invalid_options");
	if (isContextOverflow(message, options.contextWindow)) {
		return {
			kind: "context_overflow",
			source: "model",
			summary: message.errorMessage ?? "Model context window was exceeded",
			attempt: options.attempt,
		};
	}
	if (message.stopReason === "aborted") {
		return {
			kind: "aborted",
			source: "runtime",
			summary: message.errorMessage ?? "Model request was aborted",
			attempt: options.attempt,
		};
	}
	if (message.stopReason !== "error") return undefined;
	return {
		kind: isRetryableAssistantError(message) ? "transient_provider" : "unknown",
		source: "model",
		summary: message.errorMessage ?? "Model request failed",
		attempt: options.attempt,
	};
}

function orderedRoutes(plan: ModelRoutePlan | undefined): ModelRouteCandidate[] {
	if (!plan?.selected) return [];
	return [plan.selected, ...plan.fallbacks];
}

function validateRecoveryRoutes(plan: ModelRoutePlan | undefined): ModelRouteCandidate[] {
	if (plan === undefined) return [];
	if (!isPlainObject(plan) || plan.version !== 1 || !Array.isArray(plan.fallbacks)) {
		throw new StructuredRecoveryError("invalid_options", "Recovery route plan is invalid");
	}
	if (plan.selected === undefined) {
		if (plan.fallbacks.length > 0) {
			throw new StructuredRecoveryError("invalid_options", "Recovery route plan has fallbacks without a selection");
		}
		return [];
	}
	const routes = orderedRoutes(plan);
	const ids = new Set<string>();
	for (const route of routes) {
		if (
			!isPlainObject(route) ||
			!isPlainObject(route.profile) ||
			!isPlainObject(route.profile.limits) ||
			!Number.isSafeInteger(route.profile.limits.contextWindow) ||
			route.profile.limits.contextWindow <= 0
		) {
			throw new StructuredRecoveryError("invalid_options", "Recovery route candidate is invalid");
		}
		requireOptionNonEmpty(route.id, "Recovery route id");
		requireOptionNonEmpty(route.profile.provider, `Recovery route ${route.id} provider`);
		requireOptionNonEmpty(route.profile.model, `Recovery route ${route.id} model`);
		if (ids.has(route.id)) {
			throw new StructuredRecoveryError("invalid_options", `Duplicate recovery route id: ${route.id}`);
		}
		ids.add(route.id);
	}
	return routes;
}

function resolveCurrentRouteId(
	routes: readonly ModelRouteCandidate[],
	routePlan: ModelRoutePlan | undefined,
	currentRouteId: string | undefined,
): string | undefined {
	if (currentRouteId !== undefined) {
		requireOptionNonEmpty(currentRouteId, "Current recovery route id");
		if (routePlan !== undefined && !routes.some((route) => route.id === currentRouteId)) {
			throw new StructuredRecoveryError(
				"invalid_options",
				`Current recovery route is not present in the route plan: ${currentRouteId}`,
			);
		}
		return currentRouteId;
	}
	return routes[0]?.id;
}

function alternateRoutes(
	routes: readonly ModelRouteCandidate[],
	currentRouteId: string | undefined,
	predicate: (candidate: ModelRouteCandidate, current: ModelRouteCandidate | undefined) => boolean = () => true,
): ModelRouteCandidate[] {
	const current = routes.find((candidate) => candidate.id === currentRouteId);
	return routes.filter((candidate) => candidate.id !== currentRouteId && predicate(candidate, current));
}

function switchActions(routes: readonly ModelRouteCandidate[]): SwitchModelRecoveryAction[] {
	return routes.map((candidate) => ({
		id: `switch-model:${candidate.id}`,
		kind: "switch_model",
		routeId: candidate.id,
		provider: candidate.profile.provider,
		model: candidate.profile.model,
		summary: `Switch to ${candidate.profile.provider}/${candidate.profile.model}`,
	}));
}

/** Build explicit recovery alternatives. This function performs no retry, wait, compaction, or model switch. */
export function planStructuredRecovery(options: PlanStructuredRecoveryOptions): StructuredRecoveryPlan {
	if (!isPlainObject(options)) {
		throw new StructuredRecoveryError("invalid_options", "Structured recovery options must be an object");
	}
	const failure = validateFailure(options.failure);
	requirePositiveInteger(options.maxRequestAttempts, "Maximum request attempts", "invalid_options");
	requirePositiveInteger(options.maxToolAttempts, "Maximum tool attempts", "invalid_options");
	if (
		options.maxRetryDelayMs !== undefined &&
		(!Number.isFinite(options.maxRetryDelayMs) || options.maxRetryDelayMs < 0)
	) {
		throw new StructuredRecoveryError("invalid_options", "Maximum retry delay must be non-negative");
	}
	if (options.compaction) {
		if (
			!isPlainObject(options.compaction) ||
			typeof options.compaction.available !== "boolean" ||
			!Number.isSafeInteger(options.compaction.attempts) ||
			options.compaction.attempts < 0 ||
			!Number.isSafeInteger(options.compaction.maxAttempts) ||
			options.compaction.maxAttempts < 0
		) {
			throw new StructuredRecoveryError("invalid_options", "Compaction attempt limits are invalid");
		}
	}
	for (const [label, value] of [
		["Reauthentication availability", options.reauthenticationAvailable],
		["Approval availability", options.approvalAvailable],
	] as const) {
		if (value !== undefined && typeof value !== "boolean") {
			throw new StructuredRecoveryError("invalid_options", `${label} must be boolean`);
		}
	}
	const routes = validateRecoveryRoutes(options.routePlan);
	const currentRouteId = resolveCurrentRouteId(routes, options.routePlan, options.currentRouteId);
	const actions: StructuredRecoveryAction[] = [];
	const allAlternates = alternateRoutes(routes, currentRouteId);
	const maxRequestAttempts = options.maxRequestAttempts ?? 1;
	const maxToolAttempts = options.maxToolAttempts ?? 1;
	const retryDelay = failure.retryAfterMs ?? 0;
	const retryDelayAllowed = options.maxRetryDelayMs === undefined || retryDelay <= options.maxRetryDelayMs;

	switch (failure.kind) {
		case "context_overflow": {
			if (options.compaction?.available && options.compaction.attempts < options.compaction.maxAttempts) {
				actions.push({
					id: "compact-context",
					kind: "compact_context",
					summary: "Compact context and retry explicitly",
				});
			}
			actions.push(
				...switchActions(
					alternateRoutes(
						routes,
						currentRouteId,
						(candidate, current) =>
							current === undefined ||
							candidate.profile.limits.contextWindow > current.profile.limits.contextWindow,
					),
				),
			);
			break;
		}
		case "transient_provider":
		case "rate_limited":
			if (failure.attempt < maxRequestAttempts && retryDelayAllowed) {
				actions.push({
					id: "retry-request",
					kind: "retry_request",
					routeId: currentRouteId,
					afterMs: retryDelay,
					summary: retryDelay > 0 ? `Retry after ${retryDelay} ms` : "Retry the current model request",
				});
			}
			actions.push(...switchActions(allAlternates));
			break;
		case "quota_exhausted":
			return buildPlan(failure, currentRouteId, [...switchActions(allAlternates), stopAction(failure.kind)]);
		case "authentication": {
			if (options.reauthenticationAvailable) {
				const current = routes.find((candidate) => candidate.id === currentRouteId);
				actions.push({
					id: "reauthenticate",
					kind: "reauthenticate",
					provider: current?.profile.provider,
					summary: "Refresh or replace provider credentials",
				});
			}
			const current = routes.find((candidate) => candidate.id === currentRouteId);
			actions.push(
				...switchActions(
					allAlternates.filter((candidate) => candidate.profile.provider !== current?.profile.provider),
				),
			);
			break;
		}
		case "tool_failed":
			if (failure.tool!.retrySafe && failure.attempt < maxToolAttempts) {
				actions.push({
					id: "retry-tool",
					kind: "retry_tool",
					toolName: failure.tool!.name,
					summary: `Retry retry-safe tool ${failure.tool!.name}`,
				});
			}
			break;
		case "policy_denied":
			if (failure.approvalAvailable && options.approvalAvailable) {
				actions.push({
					id: "request-approval",
					kind: "request_approval",
					summary: "Request explicit approval for the denied action",
				});
			}
			break;
		case "invalid_request":
		case "budget_exhausted":
		case "aborted":
		case "unknown":
			break;
	}
	actions.push(stopAction(failure.kind));
	return buildPlan(failure, currentRouteId, actions);
}

function stopAction(reason: StructuredFailureKind): StopRecoveryAction {
	return { id: "stop", kind: "stop", reason, summary: `Stop after ${reason}` };
}

function buildPlan(
	failure: StructuredFailure,
	currentRouteId: string | undefined,
	actions: StructuredRecoveryAction[],
): StructuredRecoveryPlan {
	const recommended = actions[0] ?? stopAction(failure.kind);
	const normalizedActions = actions.length > 0 ? actions : [recommended];
	return {
		version: 1,
		failure,
		currentRouteId,
		recommendedActionId: recommended.id,
		actions: normalizedActions,
		terminal: recommended.kind === "stop",
	};
}

function requireHandler<TResult, TAction extends StructuredRecoveryAction>(
	handler: ((action: TAction, signal: AbortSignal) => TResult | Promise<TResult>) | undefined,
	action: TAction,
): (action: TAction, signal: AbortSignal) => TResult | Promise<TResult> {
	if (!handler) throw new StructuredRecoveryError("handler_missing", `No handler registered for ${action.kind}`);
	return handler;
}

function validateRecoveryAction(action: StructuredRecoveryAction): void {
	if (!isPlainObject(action)) {
		throw new StructuredRecoveryError("invalid_options", "Recovery plan action must be an object");
	}
	requireOptionNonEmpty(action.id, "Recovery action id");
	requireOptionNonEmpty(action.summary, `Recovery action ${action.id} summary`);
	switch (action.kind) {
		case "retry_request":
			if (action.routeId !== undefined) requireOptionNonEmpty(action.routeId, "Retry route id");
			if (!Number.isFinite(action.afterMs) || action.afterMs < 0) {
				throw new StructuredRecoveryError("invalid_options", "Retry delay must be non-negative");
			}
			return;
		case "switch_model":
			requireOptionNonEmpty(action.routeId, "Switch route id");
			requireOptionNonEmpty(action.provider, "Switch provider");
			requireOptionNonEmpty(action.model, "Switch model");
			return;
		case "compact_context":
		case "request_approval":
			return;
		case "retry_tool":
			requireOptionNonEmpty(action.toolName, "Retry tool name");
			return;
		case "reauthenticate":
			if (action.provider !== undefined) requireOptionNonEmpty(action.provider, "Reauthentication provider");
			return;
		case "stop":
			if (
				![
					"context_overflow",
					"transient_provider",
					"rate_limited",
					"quota_exhausted",
					"authentication",
					"invalid_request",
					"tool_failed",
					"policy_denied",
					"budget_exhausted",
					"aborted",
					"unknown",
				].includes(action.reason)
			) {
				throw new StructuredRecoveryError("invalid_options", "Recovery stop reason is invalid");
			}
			return;
		default:
			throw new StructuredRecoveryError("invalid_options", "Recovery action kind is invalid");
	}
}

function validateExecutionPlan(plan: StructuredRecoveryPlan): void {
	if (!isPlainObject(plan) || plan.version !== 1 || !Array.isArray(plan.actions) || plan.actions.length === 0) {
		throw new StructuredRecoveryError("invalid_options", "Structured recovery plan is invalid");
	}
	const ids = new Set<string>();
	for (const action of plan.actions) {
		validateRecoveryAction(action);
		if (ids.has(action.id)) {
			throw new StructuredRecoveryError("invalid_options", `Duplicate recovery action id: ${action.id}`);
		}
		ids.add(action.id);
	}
	requireOptionNonEmpty(plan.recommendedActionId, "Recommended recovery action id");
	if (!ids.has(plan.recommendedActionId)) {
		throw new StructuredRecoveryError("invalid_options", "Recommended recovery action is not in the plan");
	}
}

const recoveryAborted = Symbol("structured recovery aborted");

async function waitForRecoveryHandler<TResult>(
	promise: Promise<TResult>,
	signal: AbortSignal,
): Promise<TResult | typeof recoveryAborted> {
	if (signal.aborted) return recoveryAborted;
	return await new Promise((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			resolve(recoveryAborted);
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

async function executeRecoveryHandler<TResult, TAction extends StructuredRecoveryAction>(
	handler: ((action: TAction, signal: AbortSignal) => TResult | Promise<TResult>) | undefined,
	action: TAction,
	signal: AbortSignal,
): Promise<TResult> {
	const result = await waitForRecoveryHandler(
		Promise.resolve(requireHandler(handler, action)(action, signal)),
		signal,
	);
	if (result === recoveryAborted) {
		throw new StructuredRecoveryError("aborted", "Recovery action was aborted during execution");
	}
	return result;
}

/** Execute exactly one caller-selected recovery action. It never chains to another action. */
export async function executeStructuredRecoveryAction<TResult>(
	plan: StructuredRecoveryPlan,
	actionId: string,
	handlers: StructuredRecoveryHandlers<TResult>,
	options: { signal?: AbortSignal } = {},
): Promise<TResult> {
	validateExecutionPlan(plan);
	requireOptionNonEmpty(actionId, "Recovery action id");
	if (!isPlainObject(handlers)) {
		throw new StructuredRecoveryError("invalid_options", "Structured recovery handlers must be an object");
	}
	const normalizedHandlers = handlers as unknown as StructuredRecoveryHandlers<TResult>;
	const action = plan.actions.find((candidate) => candidate.id === actionId);
	if (!action) throw new StructuredRecoveryError("action_not_found", `Recovery action not found: ${actionId}`);
	const signal = options.signal ?? new AbortController().signal;
	if (signal.aborted) throw new StructuredRecoveryError("aborted", "Recovery action was aborted before execution");
	switch (action.kind) {
		case "retry_request":
			return await executeRecoveryHandler(normalizedHandlers.retryRequest, action, signal);
		case "switch_model":
			return await executeRecoveryHandler(normalizedHandlers.switchModel, action, signal);
		case "compact_context":
			return await executeRecoveryHandler(normalizedHandlers.compactContext, action, signal);
		case "retry_tool":
			return await executeRecoveryHandler(normalizedHandlers.retryTool, action, signal);
		case "reauthenticate":
			return await executeRecoveryHandler(normalizedHandlers.reauthenticate, action, signal);
		case "request_approval":
			return await executeRecoveryHandler(normalizedHandlers.requestApproval, action, signal);
		case "stop":
			return await executeRecoveryHandler(normalizedHandlers.stop, action, signal);
	}
}
