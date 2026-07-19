import { replayRuntimeEvents } from "../runtime-events/reducer.ts";
import type { RuntimeRecoveryState } from "../runtime-events/types.ts";
import {
	TRACE_BUNDLE_VERSION,
	type TraceBundle,
	type TraceModelExchange,
	type TraceToolExchange,
	verifyTraceBundle,
} from "./trace-bundle.ts";

export const REPLAY_BRANCH_VERSION = 1 as const;

export type ReplayBranchErrorCode = "invalid_bundle" | "invalid_branch" | "content_unavailable" | "override_not_found";

export class ReplayBranchError extends Error {
	public code: ReplayBranchErrorCode;

	constructor(code: ReplayBranchErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ReplayBranchError";
		this.code = code;
	}
}

export interface ReplayBranchValue {
	value: unknown;
}

export type ReplayBranchModelResponse = { source: "override"; value: unknown } | { source: "adapter" };

export interface ReplayBranchModelOverride {
	kind: "model";
	requestId: string;
	provider?: string;
	modelId?: string;
	input?: ReplayBranchValue;
	response?: ReplayBranchModelResponse;
}

export type ReplayBranchToolResponse = { source: "override"; value: unknown; isError: boolean } | { source: "adapter" };

export interface ReplayBranchToolOverride {
	kind: "tool";
	toolCallId: string;
	toolName?: string;
	input?: ReplayBranchValue;
	response?: ReplayBranchToolResponse;
}

export type ReplayBranchOverride = ReplayBranchModelOverride | ReplayBranchToolOverride;

export interface CreateReplayBranchOptions {
	branchId: string;
	/**
	 * First canonical event owned by the new branch. Values range from 1 to
	 * eventCount + 1, so callers can fork before the first event or after the last.
	 */
	forkBeforeSequence: number;
	label?: string;
	effectiveConfig?: ReplayBranchValue;
	overrides?: readonly ReplayBranchOverride[];
}

interface ReplayBranchStepBase {
	sequence: number;
	input: unknown;
	inputSource: "recorded" | "override";
	responseSource?: "recorded" | "override";
}

export interface ReplayBranchModelStep extends ReplayBranchStepBase {
	kind: "model";
	requestId: string;
	provider: string;
	modelId: string;
	response?: unknown;
}

export interface ReplayBranchToolStep extends ReplayBranchStepBase {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	response?: unknown;
	isError?: boolean;
}

export type ReplayBranchStep = ReplayBranchModelStep | ReplayBranchToolStep;

export interface ReplayBranchManifest {
	version: typeof REPLAY_BRANCH_VERSION;
	branchId: string;
	label?: string;
	sourceBundleId: string;
	sourceBundleChecksum: string;
	forkBeforeSequence: number;
	prefixEventCount: number;
	definitionHash: string;
}

/** Immutable replay plan. Creation does not invoke models or tools. */
export interface ReplayBranch {
	manifest: ReplayBranchManifest;
	effectiveConfig?: unknown;
	stateAtFork: RuntimeRecoveryState;
	steps: ReplayBranchStep[];
}

export interface ReplayBranchAdapters {
	invokeModel(step: Readonly<ReplayBranchModelStep>, signal: AbortSignal): Promise<unknown>;
	invokeTool(
		step: Readonly<ReplayBranchToolStep>,
		signal: AbortSignal,
	): Promise<{ result: unknown; isError: boolean }>;
}

export interface ReplayBranchExecutionItem {
	kind: "model" | "tool";
	id: string;
	sequence: number;
	status: "resolved" | "blocked" | "error";
	responseSource?: "recorded" | "override" | "adapter";
	resultHash?: string;
	result?: unknown;
	isError?: boolean;
	errorName?: string;
}

export interface ReplayBranchExecution {
	branchId: string;
	definitionHash: string;
	status: "complete" | "blocked" | "error";
	items: ReplayBranchExecutionItem[];
	outcomeHash: string;
}

export interface ReplayBranchDifference {
	kind: "model" | "tool";
	id: string;
	status: "same" | "different" | "left_only" | "right_only";
	leftStatus?: ReplayBranchExecutionItem["status"];
	rightStatus?: ReplayBranchExecutionItem["status"];
	leftHash?: string;
	rightHash?: string;
}

export interface ReplayBranchComparison {
	leftBranchId: string;
	rightBranchId: string;
	equivalent: boolean;
	differences: ReplayBranchDifference[];
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function jsonSafe(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : { $type: "number", value: String(value) };
	if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
	if (typeof value === "undefined") return { $type: "undefined" };
	if (typeof value === "function") return { $type: "function" };
	if (typeof value === "symbol") return { $type: "symbol", value: value.description ?? "" };
	if (value instanceof Uint8Array) return { $type: "bytes", values: [...value] };
	if (value instanceof Date) return { $type: "date", value: value.toISOString() };
	if (value instanceof Error) return { $type: "error", name: value.name, message: value.message };
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return { $type: "circular" };
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => compareStrings(left, right))
				.map(([key, item]) => [key, jsonSafe(item, seen)]),
		);
	} finally {
		seen.delete(value);
	}
}

async function sha256(value: unknown): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new ReplayBranchError("invalid_branch", "Replay branches require Web Crypto SHA-256");
	}
	const bytes = new TextEncoder().encode(JSON.stringify(jsonSafe(value)));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ReplayBranchError("invalid_branch", `${label} must be a non-empty string`);
	}
}

function requireExact(value: TraceModelExchange["input"] | TraceToolExchange["input"], label: string): unknown {
	if (value.capture !== "included" || !value.exact) {
		throw new ReplayBranchError("content_unavailable", `${label} was not captured exactly and requires an override`);
	}
	return jsonSafe(value.value);
}

function exactResponse(value: TraceModelExchange["output"] | TraceToolExchange["result"]): unknown | undefined {
	return value?.capture === "included" && value.exact ? jsonSafe(value.value) : undefined;
}

function responseWasCaptured(value: TraceModelExchange["output"] | TraceToolExchange["result"]): boolean {
	return value?.capture === "included" && value.exact;
}

function branchBody(
	branch: Omit<ReplayBranch, "manifest"> & { manifest: Omit<ReplayBranchManifest, "definitionHash"> },
): unknown {
	return branch;
}

async function validateBundle(bundle: TraceBundle): Promise<void> {
	if (
		!bundle ||
		typeof bundle !== "object" ||
		!isPlainObject(bundle.manifest) ||
		bundle.manifest.schemaVersion !== TRACE_BUNDLE_VERSION ||
		!Array.isArray(bundle.canonicalEvents) ||
		!Array.isArray(bundle.modelExchanges) ||
		!Array.isArray(bundle.toolExchanges)
	) {
		throw new ReplayBranchError("invalid_bundle", "Replay branch source bundle is invalid");
	}
	let verified: boolean;
	try {
		verified = await verifyTraceBundle(bundle);
	} catch (error) {
		throw new ReplayBranchError(
			"invalid_bundle",
			"Replay branch source bundle is malformed",
			errorFromUnknown(error),
		);
	}
	if (!verified) throw new ReplayBranchError("invalid_bundle", "Replay branch source bundle is invalid");
	if (
		bundle.manifest.eventCount !== bundle.canonicalEvents.length ||
		bundle.canonicalEvents.some(
			(event, index) => event.sequence !== index + 1 || event.sessionId !== bundle.manifest.sessionId,
		)
	) {
		throw new ReplayBranchError("invalid_bundle", "Replay branch source events are not canonical");
	}
	let recoveryState: RuntimeRecoveryState;
	try {
		recoveryState = replayRuntimeEvents(bundle.manifest.sessionId, bundle.canonicalEvents);
	} catch (error) {
		throw new ReplayBranchError(
			"invalid_bundle",
			"Replay branch source event lifecycle is invalid",
			errorFromUnknown(error),
		);
	}
	const modelIds = new Set<string>();
	for (const exchange of bundle.modelExchanges) {
		if (
			!Number.isSafeInteger(exchange.sequence) ||
			exchange.sequence < 1 ||
			exchange.sequence > bundle.canonicalEvents.length
		) {
			throw new ReplayBranchError("invalid_bundle", "Replay exchange sequence is outside the canonical event log");
		}
		if (modelIds.has(exchange.requestId)) {
			throw new ReplayBranchError("invalid_bundle", `Duplicate model exchange: ${exchange.requestId}`);
		}
		modelIds.add(exchange.requestId);
		const event = bundle.canonicalEvents[exchange.sequence - 1]?.event;
		const state = recoveryState.providerRequests[exchange.requestId];
		if (
			event?.type !== "provider_request_started" ||
			event.requestId !== exchange.requestId ||
			event.provider !== exchange.provider ||
			event.modelId !== exchange.modelId ||
			state?.startedSequence !== exchange.sequence
		) {
			throw new ReplayBranchError(
				"invalid_bundle",
				`Model exchange ${exchange.requestId} is not paired with its canonical start event`,
			);
		}
	}
	const toolIds = new Set<string>();
	for (const exchange of bundle.toolExchanges) {
		if (
			!Number.isSafeInteger(exchange.sequence) ||
			exchange.sequence < 1 ||
			exchange.sequence > bundle.canonicalEvents.length
		) {
			throw new ReplayBranchError("invalid_bundle", "Replay exchange sequence is outside the canonical event log");
		}
		if (toolIds.has(exchange.toolCallId)) {
			throw new ReplayBranchError("invalid_bundle", `Duplicate tool exchange: ${exchange.toolCallId}`);
		}
		toolIds.add(exchange.toolCallId);
		const event = bundle.canonicalEvents[exchange.sequence - 1]?.event;
		const state = recoveryState.toolCalls[exchange.toolCallId];
		if (
			event?.type !== "tool_call_started" ||
			event.toolCallId !== exchange.toolCallId ||
			event.toolName !== exchange.toolName ||
			state?.startedSequence !== exchange.sequence
		) {
			throw new ReplayBranchError(
				"invalid_bundle",
				`Tool exchange ${exchange.toolCallId} is not paired with its canonical start event`,
			);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireBranchValue(value: unknown, label: string): asserts value is ReplayBranchValue {
	if (!isPlainObject(value) || !Object.hasOwn(value, "value")) {
		throw new ReplayBranchError("invalid_branch", `${label} must explicitly contain a value`);
	}
}

function indexOverrides(overrides: readonly ReplayBranchOverride[]): {
	models: Map<string, ReplayBranchModelOverride>;
	tools: Map<string, ReplayBranchToolOverride>;
} {
	const models = new Map<string, ReplayBranchModelOverride>();
	const tools = new Map<string, ReplayBranchToolOverride>();
	for (const override of overrides) {
		if (!isPlainObject(override) || (override.kind !== "model" && override.kind !== "tool")) {
			throw new ReplayBranchError("invalid_branch", "Replay override kind must be model or tool");
		}
		if (override.kind === "model") {
			requireNonEmpty(override.requestId, "Replay model override request id");
			if (override.provider !== undefined) requireNonEmpty(override.provider, "Replay model override provider");
			if (override.modelId !== undefined) requireNonEmpty(override.modelId, "Replay model override model id");
			if (override.input !== undefined) requireBranchValue(override.input, "Replay model input override");
			if (override.response !== undefined) {
				if (
					!isPlainObject(override.response) ||
					(override.response.source !== "override" && override.response.source !== "adapter")
				) {
					throw new ReplayBranchError("invalid_branch", "Replay model response override is invalid");
				}
				if (override.response.source === "override") {
					requireBranchValue(override.response, "Replay model response override");
				}
			}
			if (models.has(override.requestId)) {
				throw new ReplayBranchError("invalid_branch", `Duplicate model override: ${override.requestId}`);
			}
			models.set(override.requestId, override);
		} else {
			requireNonEmpty(override.toolCallId, "Replay tool override call id");
			if (override.toolName !== undefined) requireNonEmpty(override.toolName, "Replay tool override name");
			if (override.input !== undefined) requireBranchValue(override.input, "Replay tool input override");
			if (override.response !== undefined) {
				if (
					!isPlainObject(override.response) ||
					(override.response.source !== "override" && override.response.source !== "adapter")
				) {
					throw new ReplayBranchError("invalid_branch", "Replay tool response override is invalid");
				}
				if (override.response.source === "override") {
					requireBranchValue(override.response, "Replay tool response override");
					if (typeof override.response.isError !== "boolean") {
						throw new ReplayBranchError(
							"invalid_branch",
							"Replay tool response override requires an isError boolean",
						);
					}
				}
			}
			if (tools.has(override.toolCallId)) {
				throw new ReplayBranchError("invalid_branch", `Duplicate tool override: ${override.toolCallId}`);
			}
			tools.set(override.toolCallId, override);
		}
	}
	return { models, tools };
}

function modelStep(
	exchange: TraceModelExchange,
	override: ReplayBranchModelOverride | undefined,
): ReplayBranchModelStep {
	const invocationChanged =
		override?.provider !== undefined || override?.modelId !== undefined || override?.input !== undefined;
	const input = override?.input
		? jsonSafe(override.input.value)
		: requireExact(exchange.input, `Model input ${exchange.requestId}`);
	let response = invocationChanged ? undefined : exactResponse(exchange.output);
	let responseSource: ReplayBranchModelStep["responseSource"] = responseWasCaptured(exchange.output)
		? "recorded"
		: undefined;
	if (invocationChanged) responseSource = undefined;
	if (override?.response?.source === "override") {
		response = jsonSafe(override.response.value);
		responseSource = "override";
	} else if (override?.response?.source === "adapter") {
		response = undefined;
		responseSource = undefined;
	}
	return {
		kind: "model",
		sequence: exchange.sequence,
		requestId: exchange.requestId,
		provider: override?.provider ?? exchange.provider,
		modelId: override?.modelId ?? exchange.modelId,
		input,
		inputSource: override?.input ? "override" : "recorded",
		response,
		responseSource,
	};
}

function toolStep(exchange: TraceToolExchange, override: ReplayBranchToolOverride | undefined): ReplayBranchToolStep {
	const invocationChanged = override?.toolName !== undefined || override?.input !== undefined;
	const input = override?.input
		? jsonSafe(override.input.value)
		: requireExact(exchange.input, `Tool input ${exchange.toolCallId}`);
	let response = invocationChanged ? undefined : exactResponse(exchange.result);
	let responseSource: ReplayBranchToolStep["responseSource"] = responseWasCaptured(exchange.result)
		? "recorded"
		: undefined;
	let isError = responseWasCaptured(exchange.result) && !invocationChanged ? exchange.isError : undefined;
	if (override?.response?.source === "override") {
		response = jsonSafe(override.response.value);
		responseSource = "override";
		isError = override.response.isError;
	} else if (override?.response?.source === "adapter") {
		response = undefined;
		responseSource = undefined;
		isError = undefined;
	}
	return {
		kind: "tool",
		sequence: exchange.sequence,
		toolCallId: exchange.toolCallId,
		toolName: override?.toolName ?? exchange.toolName,
		input,
		inputSource: override?.input ? "override" : "recorded",
		response,
		responseSource,
		isError,
	};
}

/** Create a deterministic branch plan at an explicit event boundary. */
export async function createReplayBranch(
	bundle: TraceBundle,
	options: CreateReplayBranchOptions,
): Promise<ReplayBranch> {
	await validateBundle(bundle);
	if (!isPlainObject(options)) {
		throw new ReplayBranchError("invalid_branch", "Replay branch options must be an object");
	}
	requireNonEmpty(options.branchId, "Replay branch id");
	if (
		!Number.isSafeInteger(options.forkBeforeSequence) ||
		options.forkBeforeSequence < 1 ||
		options.forkBeforeSequence > bundle.canonicalEvents.length + 1
	) {
		throw new ReplayBranchError(
			"invalid_branch",
			`forkBeforeSequence must be between 1 and ${bundle.canonicalEvents.length + 1}`,
		);
	}
	if (options.label !== undefined) requireNonEmpty(options.label, "Replay branch label");
	if (options.effectiveConfig !== undefined) {
		requireBranchValue(options.effectiveConfig, "Replay branch effective config");
	}
	if (options.overrides !== undefined && !Array.isArray(options.overrides)) {
		throw new ReplayBranchError("invalid_branch", "Replay branch overrides must be an array");
	}
	const indexed = indexOverrides(options.overrides ?? []);
	assertReplayForkBoundary(bundle, options.forkBeforeSequence);
	const suffixModels = bundle.modelExchanges.filter((exchange) => exchange.sequence >= options.forkBeforeSequence);
	const suffixTools = bundle.toolExchanges.filter((exchange) => exchange.sequence >= options.forkBeforeSequence);
	const modelIds = new Set<string>();
	for (const exchange of suffixModels) {
		if (modelIds.has(exchange.requestId)) {
			throw new ReplayBranchError("invalid_bundle", `Duplicate model exchange: ${exchange.requestId}`);
		}
		modelIds.add(exchange.requestId);
	}
	const toolIds = new Set<string>();
	for (const exchange of suffixTools) {
		if (toolIds.has(exchange.toolCallId)) {
			throw new ReplayBranchError("invalid_bundle", `Duplicate tool exchange: ${exchange.toolCallId}`);
		}
		toolIds.add(exchange.toolCallId);
	}
	for (const id of indexed.models.keys()) {
		if (!modelIds.has(id))
			throw new ReplayBranchError("override_not_found", `Model override is outside the branch: ${id}`);
	}
	for (const id of indexed.tools.keys()) {
		if (!toolIds.has(id))
			throw new ReplayBranchError("override_not_found", `Tool override is outside the branch: ${id}`);
	}
	const suffixModelIds = new Set(suffixModels.map((exchange) => exchange.requestId));
	const suffixToolIds = new Set(suffixTools.map((exchange) => exchange.toolCallId));
	const suffixState = replayRuntimeEvents(bundle.manifest.sessionId, bundle.canonicalEvents);
	for (const request of Object.values(suffixState.providerRequests)) {
		if (request.startedSequence >= options.forkBeforeSequence && !suffixModelIds.has(request.requestId)) {
			throw new ReplayBranchError(
				"content_unavailable",
				`Model request ${request.requestId} has no exchange recording in the branch`,
			);
		}
	}
	for (const toolCall of Object.values(suffixState.toolCalls)) {
		if (toolCall.startedSequence >= options.forkBeforeSequence && !suffixToolIds.has(toolCall.toolCallId)) {
			throw new ReplayBranchError(
				"content_unavailable",
				`Tool call ${toolCall.toolCallId} has no exchange recording in the branch`,
			);
		}
	}
	const steps = [
		...suffixModels.map((exchange) => modelStep(exchange, indexed.models.get(exchange.requestId))),
		...suffixTools.map((exchange) => toolStep(exchange, indexed.tools.get(exchange.toolCallId))),
	].sort(
		(left, right) =>
			left.sequence - right.sequence ||
			compareStrings(left.kind, right.kind) ||
			compareStrings(
				left.kind === "model" ? left.requestId : left.toolCallId,
				right.kind === "model" ? right.requestId : right.toolCallId,
			),
	);
	const prefix = bundle.canonicalEvents.slice(0, options.forkBeforeSequence - 1);
	const manifestWithoutHash: Omit<ReplayBranchManifest, "definitionHash"> = {
		version: REPLAY_BRANCH_VERSION,
		branchId: options.branchId,
		label: options.label,
		sourceBundleId: bundle.manifest.bundleId,
		sourceBundleChecksum: bundle.manifest.checksum,
		forkBeforeSequence: options.forkBeforeSequence,
		prefixEventCount: prefix.length,
	};
	const body = branchBody({
		manifest: manifestWithoutHash,
		effectiveConfig: jsonSafe(
			options.effectiveConfig === undefined ? bundle.effectiveConfig : options.effectiveConfig.value,
		),
		stateAtFork: replayRuntimeEvents(bundle.manifest.sessionId, prefix),
		steps,
	});
	return {
		...(body as Omit<ReplayBranch, "manifest">),
		manifest: { ...manifestWithoutHash, definitionHash: await sha256(body) },
	};
}

function assertReplayForkBoundary(bundle: TraceBundle, forkBeforeSequence: number): void {
	const state = replayRuntimeEvents(bundle.manifest.sessionId, bundle.canonicalEvents);
	for (const request of Object.values(state.providerRequests)) {
		if (
			request.startedSequence < forkBeforeSequence &&
			(request.settledSequence === undefined || request.settledSequence >= forkBeforeSequence)
		) {
			throw new ReplayBranchError(
				"invalid_branch",
				`Replay fork would split model request ${request.requestId} from its terminal event`,
			);
		}
	}
	for (const toolCall of Object.values(state.toolCalls)) {
		if (
			toolCall.startedSequence < forkBeforeSequence &&
			(toolCall.settledSequence === undefined || toolCall.settledSequence >= forkBeforeSequence)
		) {
			throw new ReplayBranchError(
				"invalid_branch",
				`Replay fork would split tool call ${toolCall.toolCallId} from its terminal event`,
			);
		}
	}
}

/** Detect mutation before a branch is executed or persisted. */
export async function verifyReplayBranch(branch: ReplayBranch): Promise<boolean> {
	if (
		!isPlainObject(branch) ||
		!isPlainObject(branch.manifest) ||
		branch.manifest.version !== REPLAY_BRANCH_VERSION ||
		typeof branch.manifest.definitionHash !== "string" ||
		!Array.isArray(branch.steps)
	) {
		return false;
	}
	try {
		const { definitionHash, ...manifest } = branch.manifest;
		return (await sha256(branchBody({ ...branch, manifest }))) === definitionHash;
	} catch (error) {
		if (error instanceof ReplayBranchError) throw error;
		return false;
	}
}

function blockedItem(step: ReplayBranchStep): ReplayBranchExecutionItem {
	return {
		kind: step.kind,
		id: step.kind === "model" ? step.requestId : step.toolCallId,
		sequence: step.sequence,
		status: "blocked",
	};
}

const replayAborted = Symbol("replay branch aborted");

async function waitForReplayAdapter<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof replayAborted> {
	if (signal.aborted) return replayAborted;
	return await new Promise((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			resolve(replayAborted);
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

/** Explicitly execute one branch plan. Recorded and override responses never call adapters. */
export async function executeReplayBranch(
	branch: ReplayBranch,
	adapters?: ReplayBranchAdapters,
	options: { signal?: AbortSignal } = {},
): Promise<ReplayBranchExecution> {
	if (!(await verifyReplayBranch(branch))) {
		throw new ReplayBranchError("invalid_branch", "Replay branch definition hash mismatch");
	}
	const signal = options.signal ?? new AbortController().signal;
	const items: ReplayBranchExecutionItem[] = [];
	for (const step of branch.steps) {
		if (signal.aborted || (step.responseSource === undefined && !adapters)) {
			items.push(blockedItem(step));
			continue;
		}
		try {
			if (step.responseSource !== undefined) {
				const result = jsonSafe(step.response);
				const isError = step.kind === "tool" ? step.isError : undefined;
				items.push({
					kind: step.kind,
					id: step.kind === "model" ? step.requestId : step.toolCallId,
					sequence: step.sequence,
					status: "resolved",
					responseSource: step.responseSource,
					resultHash: await sha256(step.kind === "tool" ? { result, isError } : { result }),
					result,
					isError,
				});
			} else if (step.kind === "model") {
				const invoked = await waitForReplayAdapter(adapters!.invokeModel(step, signal), signal);
				if (invoked === replayAborted) {
					items.push(blockedItem(step));
					continue;
				}
				const result = jsonSafe(invoked);
				items.push({
					kind: "model",
					id: step.requestId,
					sequence: step.sequence,
					status: "resolved",
					responseSource: "adapter",
					resultHash: await sha256({ result }),
					result,
				});
			} else {
				const invoked = await waitForReplayAdapter(adapters!.invokeTool(step, signal), signal);
				if (invoked === replayAborted) {
					items.push(blockedItem(step));
					continue;
				}
				if (!isPlainObject(invoked) || !Object.hasOwn(invoked, "result") || typeof invoked.isError !== "boolean") {
					throw new ReplayBranchError("invalid_branch", "Replay tool adapter returned an invalid result");
				}
				const result = jsonSafe(invoked.result);
				items.push({
					kind: "tool",
					id: step.toolCallId,
					sequence: step.sequence,
					status: "resolved",
					responseSource: "adapter",
					resultHash: await sha256({ result, isError: invoked.isError }),
					result,
					isError: invoked.isError,
				});
			}
		} catch (error) {
			items.push({
				kind: step.kind,
				id: step.kind === "model" ? step.requestId : step.toolCallId,
				sequence: step.sequence,
				status: signal.aborted ? "blocked" : "error",
				errorName: signal.aborted ? undefined : errorFromUnknown(error).name,
			});
		}
	}
	const status = items.some((item) => item.status === "error")
		? "error"
		: items.some((item) => item.status === "blocked")
			? "blocked"
			: "complete";
	const publicOutcome = items.map(({ result: _result, ...item }) => item);
	return {
		branchId: branch.manifest.branchId,
		definitionHash: branch.manifest.definitionHash,
		status,
		items,
		outcomeHash: await sha256({ status, items: publicOutcome }),
	};
}

function executionItemKey(item: ReplayBranchExecutionItem): string {
	return `${item.kind}:${item.id}`;
}

/** Compare resolved branch outcomes without comparing or exposing raw result content. */
export function compareReplayBranches(
	left: ReplayBranchExecution,
	right: ReplayBranchExecution,
): ReplayBranchComparison {
	const leftItems = new Map(left.items.map((item) => [executionItemKey(item), item]));
	const rightItems = new Map(right.items.map((item) => [executionItemKey(item), item]));
	const keys = [...new Set([...leftItems.keys(), ...rightItems.keys()])].sort(compareStrings);
	const differences = keys.map((key): ReplayBranchDifference => {
		const leftItem = leftItems.get(key);
		const rightItem = rightItems.get(key);
		const [kind, ...idParts] = key.split(":");
		const id = idParts.join(":");
		if (!leftItem)
			return {
				kind: kind as "model" | "tool",
				id,
				status: "right_only",
				rightStatus: rightItem?.status,
				rightHash: rightItem?.resultHash,
			};
		if (!rightItem)
			return {
				kind: kind as "model" | "tool",
				id,
				status: "left_only",
				leftStatus: leftItem.status,
				leftHash: leftItem.resultHash,
			};
		const same =
			leftItem.status === rightItem.status &&
			leftItem.resultHash === rightItem.resultHash &&
			leftItem.errorName === rightItem.errorName;
		return {
			kind: leftItem.kind,
			id: leftItem.id,
			status: same ? "same" : "different",
			leftStatus: leftItem.status,
			rightStatus: rightItem.status,
			leftHash: leftItem.resultHash,
			rightHash: rightItem.resultHash,
		};
	});
	return {
		leftBranchId: left.branchId,
		rightBranchId: right.branchId,
		equivalent: differences.every((difference) => difference.status === "same"),
		differences,
	};
}
