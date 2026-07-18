import type { RuntimeEventEnvelope, RuntimeRecoveryState } from "../runtime-events/types.ts";
import { uuidv7 } from "../session/uuid.ts";

export const TRACE_BUNDLE_VERSION = 1 as const;

export type TraceContentKind = "model_input" | "model_output" | "tool_input" | "tool_result" | "artifact";
export type TraceSensitivity = "public" | "internal" | "sensitive" | "secret";

export interface RedactedTraceValue {
	capture: "redacted";
	sha256: string;
	bytes: number;
}

export interface IncludedTraceValue {
	capture: "included";
	sha256: string;
	bytes: number;
	exact: boolean;
	value: unknown;
}

export type TraceValue = RedactedTraceValue | IncludedTraceValue;

export interface TraceModelExchangeSource {
	sequence: number;
	requestId: string;
	provider: string;
	modelId: string;
	input: unknown;
	output?: unknown;
}

export interface TraceToolExchangeSource {
	sequence: number;
	toolCallId: string;
	toolName: string;
	input: unknown;
	result?: unknown;
	isError: boolean;
}

export interface TraceArtifactSource {
	artifactId: string;
	mimeType: string;
	sensitivity: TraceSensitivity;
	size: number;
	checksum: string;
	content?: unknown;
}

export interface TracePolicyDecisionSource {
	decisionId: string;
	sequence?: number;
	toolName: string;
	effect: string;
	outcome: "allow" | "deny" | "ask";
	resolvedActionHash?: string;
	reason?: string;
}

export interface TraceProviderMetadata {
	provider: string;
	modelId: string;
	api?: string;
	capabilityProfileHash?: string;
}

export interface TraceWorkspaceSource {
	revision?: string;
	diff?: unknown;
}

export interface TraceBundleSource {
	sessionId: string;
	canonicalEvents: readonly RuntimeEventEnvelope[];
	effectiveConfig?: unknown;
	providerMetadata?: readonly TraceProviderMetadata[];
	schemaHashes?: Readonly<Record<string, string>>;
	policyDecisions?: readonly TracePolicyDecisionSource[];
	workspace?: TraceWorkspaceSource;
	modelExchanges?: readonly TraceModelExchangeSource[];
	toolExchanges?: readonly TraceToolExchangeSource[];
	artifacts?: readonly TraceArtifactSource[];
	metrics?: Readonly<Record<string, number>>;
}

export interface TraceContentCapturePolicy {
	/** Explicit opt-in. Exact content is included only when this returns true. */
	include(kind: TraceContentKind, id: string): boolean;
	/** Optional content sanitizer. When present, replay marks the captured value as non-exact. */
	transform?: (kind: TraceContentKind, id: string, value: unknown) => unknown;
}

export interface TraceBundleOptions {
	createId?: () => string;
	now?: () => Date;
	contentCapture?: TraceContentCapturePolicy;
}

export interface TraceBundleManifest {
	schemaVersion: typeof TRACE_BUNDLE_VERSION;
	bundleId: string;
	createdAt: string;
	sessionId: string;
	eventCount: number;
	checksum: string;
	replay: Readonly<Record<"ui" | "state" | "model_input" | "deterministic_tool" | "live", boolean>>;
}

export interface TraceBundleRedactionReport {
	redactedValues: number;
	includedValues: number;
	redactedBytes: number;
	/** Categories are counts, never captured values. */
	categories: Readonly<Record<string, number>>;
}

export interface TraceModelExchange {
	sequence: number;
	requestId: string;
	provider: string;
	modelId: string;
	input: TraceValue;
	output?: TraceValue;
}

export interface TraceToolExchange {
	sequence: number;
	toolCallId: string;
	toolName: string;
	input: TraceValue;
	result?: TraceValue;
	isError: boolean;
}

export interface TraceArtifact {
	artifactId: string;
	mimeType: string;
	sensitivity: TraceSensitivity;
	size: number;
	checksum: string;
	content?: TraceValue;
}

export interface TracePolicyDecision {
	decisionId: string;
	sequence?: number;
	toolName: string;
	effect: string;
	outcome: "allow" | "deny" | "ask";
	resolvedActionHash?: string;
	reason?: RedactedTraceValue;
}

export interface TraceBundle {
	manifest: TraceBundleManifest;
	effectiveConfig?: unknown;
	canonicalEvents: RuntimeEventEnvelope[];
	providerMetadata: TraceProviderMetadata[];
	schemaHashes: Record<string, string>;
	policyDecisions: TracePolicyDecision[];
	workspace?: { revision?: string; diff?: TraceValue };
	modelExchanges: TraceModelExchange[];
	toolExchanges: TraceToolExchange[];
	artifacts: TraceArtifact[];
	metrics: Record<string, number>;
	redactionReport: TraceBundleRedactionReport;
}

export type TraceBundleErrorCode = "invalid_source" | "crypto_unavailable" | "capture_failed";

export class TraceBundleError extends Error {
	public code: TraceBundleErrorCode;

	constructor(code: TraceBundleErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TraceBundleError";
		this.code = code;
	}
}

interface MutableRedactionReport {
	redactedValues: number;
	includedValues: number;
	redactedBytes: number;
	categories: Record<string, number>;
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

function serialize(value: unknown): string {
	return JSON.stringify(jsonSafe(value));
}

async function sha256(value: unknown): Promise<{ sha256: string; bytes: number }> {
	if (!globalThis.crypto?.subtle) {
		throw new TraceBundleError("crypto_unavailable", "Trace bundle export requires Web Crypto SHA-256");
	}
	const bytes = new TextEncoder().encode(serialize(value));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return {
		sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
		bytes: bytes.byteLength,
	};
}

function count(report: MutableRedactionReport, category: string, bytes: number, included: boolean): void {
	report.categories[category] = (report.categories[category] ?? 0) + 1;
	if (included) report.includedValues++;
	else {
		report.redactedValues++;
		report.redactedBytes += bytes;
	}
}

async function capture(
	value: unknown,
	kind: TraceContentKind,
	id: string,
	policy: TraceContentCapturePolicy | undefined,
	report: MutableRedactionReport,
): Promise<TraceValue> {
	const original = await sha256(value);
	let include = false;
	try {
		include = policy?.include(kind, id) ?? false;
	} catch (error) {
		throw new TraceBundleError(
			"capture_failed",
			`Content capture policy failed for ${kind} ${id}`,
			errorFromUnknown(error),
		);
	}
	if (!policy || !include) {
		count(report, kind, original.bytes, false);
		return { capture: "redacted", ...original };
	}
	try {
		const transformed = policy.transform ? policy.transform(kind, id, value) : value;
		const safeValue = jsonSafe(transformed);
		const captured = await sha256(safeValue);
		count(report, kind, captured.bytes, true);
		return {
			capture: "included",
			...captured,
			exact: policy.transform === undefined,
			value: safeValue,
		};
	} catch (error) {
		throw new TraceBundleError("capture_failed", `Failed to capture ${kind} ${id}`, errorFromUnknown(error));
	}
}

async function redact(value: unknown, category: string, report: MutableRedactionReport): Promise<RedactedTraceValue> {
	const digest = await sha256(value);
	count(report, category, digest.bytes, false);
	return { capture: "redacted", ...digest };
}

async function redactString(value: string, category: string, report: MutableRedactionReport): Promise<string> {
	const digest = await sha256(value);
	count(report, category, digest.bytes, false);
	return `redacted:sha256:${digest.sha256}`;
}

function pseudonymizeSessionId(digest: string): string {
	return `session-${digest.slice(0, 16)}`;
}

async function sanitizeRecoveryState(
	state: RuntimeRecoveryState,
	sessionId: string,
	report: MutableRedactionReport,
): Promise<RuntimeRecoveryState> {
	const queueItems = Object.fromEntries(
		await Promise.all(
			Object.entries(state.queueItems).map(async ([id, item]) => [
				id,
				{ ...item, message: await capture(item.message, "artifact", `runtime.queue.${id}`, undefined, report) },
			]),
		),
	);
	const pendingWrites = Object.fromEntries(
		await Promise.all(
			Object.entries(state.pendingWrites).map(async ([id, write]) => [
				id,
				{ ...write, write: await capture(write.write, "artifact", `runtime.write.${id}`, undefined, report) },
			]),
		),
	);
	const sanitizeReason = async <TValue extends { interruptionReason?: string }>(value: TValue): Promise<TValue> => ({
		...value,
		interruptionReason: value.interruptionReason
			? await redactString(value.interruptionReason, "runtime_reason", report)
			: undefined,
	});
	return {
		...state,
		sessionId,
		queueItems,
		pendingWrites,
		operations: Object.fromEntries(
			await Promise.all(
				Object.entries(state.operations).map(async ([id, value]) => [id, await sanitizeReason(value)]),
			),
		),
		turns: Object.fromEntries(
			await Promise.all(Object.entries(state.turns).map(async ([id, value]) => [id, await sanitizeReason(value)])),
		),
		providerRequests: Object.fromEntries(
			await Promise.all(
				Object.entries(state.providerRequests).map(async ([id, value]) => [id, await sanitizeReason(value)]),
			),
		),
		toolCalls: Object.fromEntries(
			await Promise.all(
				Object.entries(state.toolCalls).map(async ([id, value]) => [id, await sanitizeReason(value)]),
			),
		),
		lastRecovery: state.lastRecovery
			? {
					...state.lastRecovery,
					reason: await redactString(state.lastRecovery.reason, "runtime_reason", report),
				}
			: undefined,
	};
}

async function sanitizeRuntimeEnvelope(
	envelope: RuntimeEventEnvelope,
	sessionId: string,
	report: MutableRedactionReport,
): Promise<RuntimeEventEnvelope> {
	const event = envelope.event;
	switch (event.type) {
		case "queue_enqueued":
			return {
				...envelope,
				sessionId,
				event: {
					...event,
					message: await capture(
						event.message,
						"artifact",
						`runtime.queue.${event.queueItemId}`,
						undefined,
						report,
					),
				},
			};
		case "pending_write_enqueued":
			return {
				...envelope,
				sessionId,
				event: {
					...event,
					write: await capture(
						event.write,
						"artifact",
						`runtime.write.${event.pendingWriteId}`,
						undefined,
						report,
					),
				},
			};
		case "operation_interrupted":
		case "turn_interrupted":
		case "provider_request_failed":
		case "provider_request_interrupted":
		case "tool_call_interrupted":
		case "queue_discarded":
			return {
				...envelope,
				sessionId,
				event: { ...event, reason: await redactString(event.reason, "runtime_reason", report) },
			};
		case "recovery_started":
			return {
				...envelope,
				sessionId,
				event: { ...event, reason: await redactString(event.reason, "runtime_reason", report) },
			};
		case "checkpoint":
			return {
				...envelope,
				sessionId,
				event: { ...event, state: await sanitizeRecoveryState(event.state, sessionId, report) },
			};
		default:
			return { ...envelope, sessionId };
	}
}

const CONFIG_SAFE_STRING_KEYS = new Set([
	"api",
	"effect",
	"kind",
	"mode",
	"model",
	"modelId",
	"provider",
	"sandboxProfile",
	"status",
	"toolName",
	"transport",
	"type",
	"version",
]);
const CONFIG_SENSITIVE_KEYS = /authorization|cookie|credential|env|header|key|password|prompt|secret|token/i;

async function sanitizeConfigValue(
	value: unknown,
	key: string,
	path: string,
	report: MutableRedactionReport,
): Promise<unknown> {
	if (CONFIG_SENSITIVE_KEYS.test(key)) return capture(value, "artifact", `config.${path}`, undefined, report);
	if (typeof value === "string") {
		return CONFIG_SAFE_STRING_KEYS.has(key) ? value : capture(value, "artifact", `config.${path}`, undefined, report);
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		return await Promise.all(
			value.map(async (item, index) => await sanitizeConfigValue(item, key, `${path}.${index}`, report)),
		);
	}
	if (typeof value === "object") {
		return Object.fromEntries(
			await Promise.all(
				Object.entries(value).map(async ([childKey, item]) => [
					childKey,
					await sanitizeConfigValue(item, childKey, `${path}.${childKey}`, report),
				]),
			),
		);
	}
	return capture(value, "artifact", `config.${path}`, undefined, report);
}

function allExact(values: readonly TraceValue[]): boolean {
	return values.every((value) => value.capture === "included" && value.exact);
}

function validateSource(source: TraceBundleSource): void {
	if (!source.sessionId) throw new TraceBundleError("invalid_source", "Trace bundle requires a session id");
	let previousSequence = 0;
	for (const event of source.canonicalEvents) {
		if (event.sessionId !== source.sessionId) {
			throw new TraceBundleError("invalid_source", `Runtime event ${event.eventId} belongs to another session`);
		}
		if (event.sequence !== previousSequence + 1) {
			throw new TraceBundleError("invalid_source", "Canonical runtime event sequences must be contiguous");
		}
		previousSequence = event.sequence;
	}
	for (const [name, value] of Object.entries(source.metrics ?? {})) {
		if (!Number.isFinite(value)) throw new TraceBundleError("invalid_source", `Metric ${name} is not finite`);
	}
}

/** Build a portable, privacy-safe diagnostic bundle. Content capture is opt-in per item. */
export async function createTraceBundle(
	source: TraceBundleSource,
	options: TraceBundleOptions = {},
): Promise<TraceBundle> {
	validateSource(source);
	const report: MutableRedactionReport = {
		redactedValues: 0,
		includedValues: 0,
		redactedBytes: 0,
		categories: {},
	};
	const bundleId = options.createId?.() ?? uuidv7();
	const sessionDigest = await sha256({ bundleId, sessionId: source.sessionId });
	const sessionId = pseudonymizeSessionId(sessionDigest.sha256);
	const canonicalEvents = await Promise.all(
		source.canonicalEvents.map(async (event) => await sanitizeRuntimeEnvelope(event, sessionId, report)),
	);
	const modelExchanges = await Promise.all(
		(source.modelExchanges ?? []).map(
			async (exchange): Promise<TraceModelExchange> => ({
				sequence: exchange.sequence,
				requestId: exchange.requestId,
				provider: exchange.provider,
				modelId: exchange.modelId,
				input: await capture(exchange.input, "model_input", exchange.requestId, options.contentCapture, report),
				output:
					exchange.output === undefined
						? undefined
						: await capture(exchange.output, "model_output", exchange.requestId, options.contentCapture, report),
			}),
		),
	);
	const toolExchanges = await Promise.all(
		(source.toolExchanges ?? []).map(
			async (exchange): Promise<TraceToolExchange> => ({
				sequence: exchange.sequence,
				toolCallId: exchange.toolCallId,
				toolName: exchange.toolName,
				input: await capture(exchange.input, "tool_input", exchange.toolCallId, options.contentCapture, report),
				result:
					exchange.result === undefined
						? undefined
						: await capture(exchange.result, "tool_result", exchange.toolCallId, options.contentCapture, report),
				isError: exchange.isError,
			}),
		),
	);
	const artifacts = await Promise.all(
		(source.artifacts ?? []).map(
			async (artifact): Promise<TraceArtifact> => ({
				artifactId: artifact.artifactId,
				mimeType: artifact.mimeType,
				sensitivity: artifact.sensitivity,
				size: artifact.size,
				checksum: artifact.checksum,
				content:
					artifact.content === undefined
						? undefined
						: await capture(artifact.content, "artifact", artifact.artifactId, options.contentCapture, report),
			}),
		),
	);
	const policyDecisions = await Promise.all(
		(source.policyDecisions ?? []).map(
			async (decision): Promise<TracePolicyDecision> => ({
				decisionId: decision.decisionId,
				sequence: decision.sequence,
				toolName: decision.toolName,
				effect: decision.effect,
				outcome: decision.outcome,
				resolvedActionHash: decision.resolvedActionHash,
				reason: decision.reason === undefined ? undefined : await redact(decision.reason, "policy_reason", report),
			}),
		),
	);
	const effectiveConfig =
		source.effectiveConfig === undefined
			? undefined
			: await sanitizeConfigValue(source.effectiveConfig, "config", "config", report);
	const workspace = source.workspace
		? {
				revision: source.workspace.revision,
				diff:
					source.workspace.diff === undefined
						? undefined
						: await capture(source.workspace.diff, "artifact", "workspace.diff", options.contentCapture, report),
			}
		: undefined;
	const replay = {
		ui: true,
		state: true,
		model_input: modelExchanges.length > 0 && allExact(modelExchanges.map((exchange) => exchange.input)),
		deterministic_tool:
			toolExchanges.length > 0 &&
			toolExchanges.every(
				(exchange) => exchange.result !== undefined && allExact([exchange.input, exchange.result]),
			),
		live:
			modelExchanges.length + toolExchanges.length > 0 &&
			allExact([
				...modelExchanges.map((exchange) => exchange.input),
				...toolExchanges.map((exchange) => exchange.input),
			]),
	};
	const body = {
		effectiveConfig,
		canonicalEvents,
		providerMetadata: [...(source.providerMetadata ?? [])],
		schemaHashes: { ...(source.schemaHashes ?? {}) },
		policyDecisions,
		workspace,
		modelExchanges,
		toolExchanges,
		artifacts,
		metrics: { ...(source.metrics ?? {}) },
		redactionReport: report,
	};
	const checksum = await sha256(body);
	return {
		manifest: {
			schemaVersion: TRACE_BUNDLE_VERSION,
			bundleId,
			createdAt: (options.now?.() ?? new Date()).toISOString(),
			sessionId,
			eventCount: canonicalEvents.length,
			checksum: checksum.sha256,
			replay,
		},
		...body,
	};
}

/** Verify the content checksum before replaying or importing a trace bundle. */
export async function verifyTraceBundle(bundle: TraceBundle): Promise<boolean> {
	if (bundle.manifest.schemaVersion !== TRACE_BUNDLE_VERSION) return false;
	const { manifest: _manifest, ...body } = bundle;
	return (await sha256(body)).sha256 === bundle.manifest.checksum;
}
