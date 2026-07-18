import { replayRuntimeEvents } from "../runtime-events/reducer.ts";
import type { RuntimeEventEnvelope, RuntimeRecoveryState } from "../runtime-events/types.ts";
import {
	type IncludedTraceValue,
	TRACE_BUNDLE_VERSION,
	type TraceBundle,
	type TraceModelExchange,
	type TraceToolExchange,
	verifyTraceBundle,
} from "./trace-bundle.ts";

export type ReplayLevel = "ui" | "state" | "model_input" | "deterministic_tool" | "live";

export type ReplayErrorCode =
	| "unsupported_bundle"
	| "invalid_bundle"
	| "level_unavailable"
	| "recording_not_found"
	| "input_mismatch";

export class ReplayError extends Error {
	public code: ReplayErrorCode;

	constructor(code: ReplayErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ReplayError";
		this.code = code;
	}
}

export interface UiReplayItem {
	sequence: number;
	timestamp: string;
	kind: string;
	entityId?: string;
	parentId?: string;
	status?: "started" | "finished" | "failed" | "interrupted" | "queued" | "discarded" | "checkpoint";
	attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface ModelInputReplayItem {
	sequence: number;
	requestId: string;
	provider: string;
	modelId: string;
	input: unknown;
}

export interface DeterministicToolReplayRequest {
	toolCallId: string;
	toolName: string;
	input: unknown;
}

export interface DeterministicToolReplayResult {
	result: unknown;
	isError: boolean;
	recorded: true;
}

export interface DeterministicToolReplay {
	invoke(request: DeterministicToolReplayRequest): Promise<DeterministicToolReplayResult>;
}

export interface LiveReplayAdapters {
	invokeModel(exchange: ModelInputReplayItem): Promise<unknown>;
	invokeTool(request: DeterministicToolReplayRequest): Promise<unknown>;
}

export interface LiveReplayItemResult {
	kind: "model" | "tool";
	id: string;
	status: "match" | "different" | "not_comparable" | "error";
	expectedHash?: string;
	actualHash?: string;
	errorName?: string;
}

export interface ReplayCapability {
	level: ReplayLevel;
	available: boolean;
	reason?: string;
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function jsonSafe(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
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
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, jsonSafe(item, seen)]),
		);
	} finally {
		seen.delete(value);
	}
}

async function sha256(value: unknown): Promise<string> {
	if (!globalThis.crypto?.subtle) throw new ReplayError("invalid_bundle", "Replay requires Web Crypto SHA-256");
	const bytes = new TextEncoder().encode(JSON.stringify(jsonSafe(value)));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireIncluded(
	value: TraceModelExchange["input"] | TraceToolExchange["input"],
	label: string,
): IncludedTraceValue {
	if (value.capture !== "included" || !value.exact) {
		throw new ReplayError("level_unavailable", `${label} was not captured exactly`);
	}
	return value;
}

function runtimeEventToUiItem(envelope: RuntimeEventEnvelope): UiReplayItem {
	const event = envelope.event;
	const base = {
		sequence: envelope.sequence,
		timestamp: envelope.timestamp,
		kind: event.type,
		attributes: {} as Record<string, string | number | boolean>,
	};
	switch (event.type) {
		case "queue_enqueued":
			return { ...base, entityId: event.queueItemId, status: "queued", attributes: { queue: event.queue } };
		case "queue_discarded":
			return { ...base, entityId: event.queueItemId, status: "discarded" };
		case "pending_write_enqueued":
			return { ...base, entityId: event.pendingWriteId, status: "queued" };
		case "pending_write_applied":
			return { ...base, entityId: event.pendingWriteId, status: "finished" };
		case "operation_started":
			return { ...base, entityId: event.operationId, status: "started", attributes: { operationKind: event.kind } };
		case "operation_finished":
			return { ...base, entityId: event.operationId, status: "finished" };
		case "operation_interrupted":
			return { ...base, entityId: event.operationId, status: "interrupted" };
		case "turn_started":
			return { ...base, entityId: event.turnId, parentId: event.operationId, status: "started" };
		case "turn_finished":
			return { ...base, entityId: event.turnId, status: "finished" };
		case "turn_interrupted":
			return { ...base, entityId: event.turnId, status: "interrupted" };
		case "provider_request_started":
			return {
				...base,
				entityId: event.requestId,
				parentId: event.turnId,
				status: "started",
				attributes: { provider: event.provider, model: event.modelId },
			};
		case "provider_request_finished":
			return { ...base, entityId: event.requestId, status: "finished" };
		case "provider_request_failed":
			return { ...base, entityId: event.requestId, status: "failed" };
		case "provider_request_interrupted":
			return { ...base, entityId: event.requestId, status: "interrupted" };
		case "tool_call_started":
			return {
				...base,
				entityId: event.toolCallId,
				parentId: event.turnId,
				status: "started",
				attributes: { tool: event.toolName, retrySafe: event.retrySafe },
			};
		case "tool_call_finished":
			return { ...base, entityId: event.toolCallId, status: "finished" };
		case "tool_call_interrupted":
			return { ...base, entityId: event.toolCallId, status: "interrupted" };
		case "recovery_started":
			return { ...base, entityId: event.recoveryId, status: "started" };
		case "checkpoint":
			return { ...base, status: "checkpoint", attributes: { throughSequence: event.throughSequence } };
	}
}

/** Return level availability without inspecting or exposing captured content. */
export function getReplayCapabilities(bundle: TraceBundle): ReplayCapability[] {
	const reasons: Partial<Record<ReplayLevel, string>> = {
		model_input: "Exact model inputs were not captured",
		deterministic_tool: "Exact tool inputs and results were not captured",
		live: "Exact inputs required for live re-execution were not captured",
	};
	return (["ui", "state", "model_input", "deterministic_tool", "live"] as const).map((level) => ({
		level,
		available: bundle.manifest.replay[level],
		reason: bundle.manifest.replay[level] ? undefined : reasons[level],
	}));
}

async function validateBundle(bundle: TraceBundle, level: ReplayLevel): Promise<void> {
	if (bundle.manifest.schemaVersion !== TRACE_BUNDLE_VERSION) {
		throw new ReplayError("unsupported_bundle", `Unsupported trace bundle version ${bundle.manifest.schemaVersion}`);
	}
	if (!(await verifyTraceBundle(bundle))) throw new ReplayError("invalid_bundle", "Trace bundle checksum mismatch");
	if (!bundle.manifest.replay[level]) throw new ReplayError("level_unavailable", `${level} replay is unavailable`);
}

/** Level 1: project canonical events into a content-free UI timeline. */
export async function replayUi(bundle: TraceBundle): Promise<UiReplayItem[]> {
	await validateBundle(bundle, "ui");
	return bundle.canonicalEvents.map(runtimeEventToUiItem);
}

/** Level 2: rebuild the durable harness state from canonical events. */
export async function replayState(bundle: TraceBundle): Promise<RuntimeRecoveryState> {
	await validateBundle(bundle, "state");
	return replayRuntimeEvents(bundle.manifest.sessionId, bundle.canonicalEvents);
}

/** Level 3: reconstruct exact request inputs in their recorded order without calling a provider. */
export async function replayModelInputs(bundle: TraceBundle): Promise<ModelInputReplayItem[]> {
	await validateBundle(bundle, "model_input");
	return [...bundle.modelExchanges]
		.sort((left, right) => left.sequence - right.sequence)
		.map((exchange) => ({
			sequence: exchange.sequence,
			requestId: exchange.requestId,
			provider: exchange.provider,
			modelId: exchange.modelId,
			input: requireIncluded(exchange.input, `Model input ${exchange.requestId}`).value,
		}));
}

/** Level 4: return recorded tool outcomes and never execute a real tool. */
class DeterministicToolReplayImpl implements DeterministicToolReplay {
	private readonly records: ReadonlyMap<string, TraceToolExchange>;

	constructor(bundle: TraceBundle) {
		if (!bundle.manifest.replay.deterministic_tool) {
			throw new ReplayError("level_unavailable", "deterministic_tool replay is unavailable");
		}
		this.records = new Map(bundle.toolExchanges.map((exchange) => [exchange.toolCallId, exchange]));
	}

	async invoke(request: DeterministicToolReplayRequest): Promise<DeterministicToolReplayResult> {
		const record = this.records.get(request.toolCallId);
		if (!record) throw new ReplayError("recording_not_found", `No recording for tool call ${request.toolCallId}`);
		if (record.toolName !== request.toolName) {
			throw new ReplayError("input_mismatch", `Tool name does not match recording ${request.toolCallId}`);
		}
		if ((await sha256(request.input)) !== record.input.sha256) {
			throw new ReplayError("input_mismatch", `Tool input does not match recording ${request.toolCallId}`);
		}
		if (!record.result) {
			throw new ReplayError("recording_not_found", `Tool call ${request.toolCallId} has no recorded result`);
		}
		return {
			result: requireIncluded(record.result, `Tool result ${request.toolCallId}`).value,
			isError: record.isError,
			recorded: true,
		};
	}
}

/** Validate a bundle before constructing a deterministic tool executor. */
export async function createDeterministicToolReplay(bundle: TraceBundle): Promise<DeterministicToolReplay> {
	await validateBundle(bundle, "deterministic_tool");
	return new DeterministicToolReplayImpl(bundle);
}

/**
 * Level 5: explicitly re-execute captured model/tool inputs and compare hashes.
 * Model outputs are not promised to be deterministic; differences are the expected diagnostic output.
 */
export async function replayLive(bundle: TraceBundle, adapters: LiveReplayAdapters): Promise<LiveReplayItemResult[]> {
	await validateBundle(bundle, "live");
	const records = [
		...bundle.modelExchanges.map((exchange) => ({ kind: "model" as const, sequence: exchange.sequence, exchange })),
		...bundle.toolExchanges.map((exchange) => ({ kind: "tool" as const, sequence: exchange.sequence, exchange })),
	].sort((left, right) => left.sequence - right.sequence);
	const results: LiveReplayItemResult[] = [];
	for (const record of records) {
		try {
			if (record.kind === "model") {
				const exchange = record.exchange;
				const actual = await adapters.invokeModel({
					sequence: exchange.sequence,
					requestId: exchange.requestId,
					provider: exchange.provider,
					modelId: exchange.modelId,
					input: requireIncluded(exchange.input, `Model input ${exchange.requestId}`).value,
				});
				const actualHash = await sha256(actual);
				results.push({
					kind: "model",
					id: exchange.requestId,
					status: exchange.output
						? actualHash === exchange.output.sha256
							? "match"
							: "different"
						: "not_comparable",
					expectedHash: exchange.output?.sha256,
					actualHash,
				});
			} else {
				const exchange = record.exchange;
				const actual = await adapters.invokeTool({
					toolCallId: exchange.toolCallId,
					toolName: exchange.toolName,
					input: requireIncluded(exchange.input, `Tool input ${exchange.toolCallId}`).value,
				});
				const actualHash = await sha256(actual);
				results.push({
					kind: "tool",
					id: exchange.toolCallId,
					status: exchange.result
						? actualHash === exchange.result.sha256
							? "match"
							: "different"
						: "not_comparable",
					expectedHash: exchange.result?.sha256,
					actualHash,
				});
			}
		} catch (error) {
			const cause = errorFromUnknown(error);
			results.push({
				kind: record.kind,
				id: record.kind === "model" ? record.exchange.requestId : record.exchange.toolCallId,
				status: "error",
				errorName: cause.name,
			});
		}
	}
	return results;
}
