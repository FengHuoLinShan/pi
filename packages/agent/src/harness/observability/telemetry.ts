import type { AgentTool, ToolAttemptOutcome } from "../../types.ts";
import type { AgentHarness } from "../agent-harness.ts";
import { uuidv7 } from "../session/uuid.ts";
import type { AgentHarnessEvent, PromptTemplate, Skill } from "../types.ts";

export const HARNESS_TELEMETRY_VERSION = 1 as const;

export type TelemetryAttribute = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttribute>>;
export type TelemetryMetricKind = "counter" | "histogram";
export type TelemetrySpanStatus = "ok" | "error" | "cancelled";

interface HarnessTelemetryRecordBase {
	version: typeof HARNESS_TELEMETRY_VERSION;
	sequence: number;
	timestamp: number;
	traceId: string;
}

export interface HarnessTelemetrySpanStart extends HarnessTelemetryRecordBase {
	type: "span_start";
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes: TelemetryAttributes;
}

export interface HarnessTelemetrySpanEnd extends HarnessTelemetryRecordBase {
	type: "span_end";
	spanId: string;
	parentSpanId?: string;
	name: string;
	durationMs: number;
	status: TelemetrySpanStatus;
	attributes: TelemetryAttributes;
}

export interface HarnessTelemetryLog extends HarnessTelemetryRecordBase {
	type: "log";
	severity: "debug" | "info" | "warn" | "error";
	name: string;
	attributes: TelemetryAttributes;
}

export interface HarnessTelemetryMetric extends HarnessTelemetryRecordBase {
	type: "metric";
	name: string;
	kind: TelemetryMetricKind;
	value: number;
	unit: "1" | "ms" | "token" | "cost_unit" | "byte";
	/** Low-cardinality dimensions only. Trace and session identifiers never appear here. */
	dimensions: TelemetryAttributes;
}

export type HarnessTelemetryRecord =
	| HarnessTelemetrySpanStart
	| HarnessTelemetrySpanEnd
	| HarnessTelemetryLog
	| HarnessTelemetryMetric;

type HarnessTelemetryRecordInput = HarnessTelemetryRecord extends infer TRecord
	? TRecord extends HarnessTelemetryRecord
		? Omit<TRecord, "version" | "sequence" | "timestamp">
		: never
	: never;

/** Passive sink. Rejections and exceptions are isolated from harness execution. */
export interface HarnessTelemetrySink {
	emit(record: HarnessTelemetryRecord): void | Promise<void>;
}

export interface HarnessTelemetryOptions {
	createId?: () => string;
	now?: () => number;
}

interface ActiveSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startedAt: number;
	attributes: Record<string, TelemetryAttribute>;
}

function messageSize(message: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(message)).byteLength;
	} catch {
		return 0;
	}
}

function messageRole(message: unknown): string {
	if (typeof message !== "object" || message === null || !("role" in message)) return "unknown";
	if (
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult" ||
		message.role === "custom"
	) {
		return message.role;
	}
	return "other";
}

function assistantStatus(message: unknown): TelemetrySpanStatus {
	if (typeof message !== "object" || message === null || !("stopReason" in message)) return "ok";
	if (message.stopReason === "aborted") return "cancelled";
	return message.stopReason === "error" ? "error" : "ok";
}

function assistantCompletionAttributes(message: unknown): Record<string, TelemetryAttribute> {
	if (typeof message !== "object" || message === null || !("stopReason" in message)) {
		return { stopReason: "unknown", hasErrorMessage: false };
	}
	const stopReason =
		message.stopReason === "stop" ||
		message.stopReason === "length" ||
		message.stopReason === "toolUse" ||
		message.stopReason === "error" ||
		message.stopReason === "aborted"
			? message.stopReason
			: "unknown";
	return {
		stopReason,
		hasErrorMessage: "errorMessage" in message && typeof message.errorMessage === "string",
	};
}

function normalizeToolAttemptOutcome(value: unknown): ToolAttemptOutcome | "unknown" {
	switch (value) {
		case "not_executed_missing_tool":
		case "not_executed_preparation_error":
		case "not_executed_before_hook_error":
		case "not_executed_blocked":
		case "not_executed_aborted_before_body":
		case "not_executed_truncated":
		case "not_executed_budget":
		case "not_executed_deadline":
		case "not_executed_loop":
		case "body_success":
		case "body_error":
		case "after_hook_error":
			return value;
		default:
			return "unknown";
	}
}

/**
 * Projects harness lifecycle events into privacy-safe logs, metrics, and causal spans.
 *
 * Prompt text, message bodies, provider payloads, headers, tool arguments, and tool results are
 * never copied into telemetry. Their byte lengths may be recorded. Telemetry is an operational
 * projection; the canonical runtime event log remains the source of truth.
 */
export class HarnessTelemetryCollector {
	private readonly sink: HarnessTelemetrySink;
	private readonly createId: () => string;
	private readonly now: () => number;
	private sequence = 0;
	private run?: ActiveSpan;
	private runStatus: TelemetrySpanStatus = "ok";
	private turn?: ActiveSpan;
	private provider?: ActiveSpan;
	private readonly tools = new Map<string, ActiveSpan>();

	constructor(sink: HarnessTelemetrySink, options: HarnessTelemetryOptions = {}) {
		this.sink = sink;
		this.createId = options.createId ?? uuidv7;
		this.now = options.now ?? (() => Date.now());
	}

	record(event: AgentHarnessEvent): void {
		try {
			this.recordSafely(event);
		} catch {
			// Telemetry is passive and must never alter harness behavior.
		}
	}

	private recordSafely(event: AgentHarnessEvent): void {
		switch (event.type) {
			case "before_agent_start":
				this.ensureRun({
					invocation: "prompt",
					imageCount: event.images?.length ?? 0,
					promptBytes: messageSize(event.prompt),
				});
				break;
			case "agent_start":
				this.ensureRun({ invocation: "run" });
				break;
			case "turn_start":
				this.startTurn();
				break;
			case "before_provider_request":
				this.startProvider(event.model.provider, event.model.id);
				break;
			case "before_provider_payload":
				this.emitLog("debug", "pi.provider.payload_prepared", {
					provider: event.model.provider,
					model: event.model.id,
					payloadBytes: messageSize(event.payload),
					contentCaptured: false,
				});
				break;
			case "after_provider_response":
				this.emitLog(event.status >= 400 ? "warn" : "debug", "pi.provider.response_headers", {
					provider: this.provider?.attributes.provider ?? "unknown",
					model: this.provider?.attributes.model ?? "unknown",
					statusCode: event.status,
					headerCount: Object.keys(event.headers).length,
					contentCaptured: false,
				});
				break;
			case "message_end": {
				const role = messageRole(event.message);
				this.emitMetric("pi.agent.message_bytes", "histogram", messageSize(event.message), "byte", { role });
				if (role === "assistant") {
					const status = assistantStatus(event.message);
					this.emitLog(status === "error" ? "warn" : "debug", "pi.provider.completion", {
						provider: this.provider?.attributes.provider ?? "unknown",
						model: this.provider?.attributes.model ?? "unknown",
						...assistantCompletionAttributes(event.message),
						contentCaptured: false,
					});
					this.endProvider(status);
				}
				break;
			}
			case "tool_execution_start":
				this.startTool(event.toolCallId, event.toolName);
				break;
			case "tool_execution_end": {
				const attemptOutcome = normalizeToolAttemptOutcome(event.attemptOutcome);
				this.emitLog(event.isError ? "warn" : "debug", "pi.agent.tool_result", {
					tool: event.toolName,
					isError: event.isError,
					attemptOutcome,
					contentCaptured: false,
				});
				this.emitMetric("pi.agent.tool_attempt_outcomes", "counter", 1, "1", { attemptOutcome });
				this.endTool(event.toolCallId, event.isError ? "error" : "ok", attemptOutcome);
				break;
			}
			case "turn_end":
				this.endTurn(assistantStatus(event.message));
				break;
			case "agent_termination":
				this.raiseRunStatus("error");
				this.emitLog("warn", "pi.agent.terminated", {
					status: event.termination.status,
					reason: event.termination.reason,
					partialResult: event.termination.partialResult,
				});
				this.emitUsage(event.usage);
				break;
			case "agent_end":
				this.endDanglingChildren();
				this.endRun(this.runStatus);
				break;
			case "queue_update":
				this.emitLog("debug", "pi.agent.queue_update", {
					steerCount: event.steer.length,
					followUpCount: event.followUp.length,
					nextTurnCount: event.nextTurn.length,
				});
				break;
			case "context":
				this.emitMetric("pi.agent.context_messages", "histogram", event.messages.length, "1", {});
				break;
			case "abort":
				this.emitLog("info", "pi.agent.abort", {
					clearedSteerCount: event.clearedSteer.length,
					clearedFollowUpCount: event.clearedFollowUp.length,
				});
				break;
			case "session_compact":
				this.emitMetric("pi.agent.compaction", "counter", 1, "1", { source: event.fromHook ? "hook" : "model" });
				break;
			default:
				break;
		}
	}

	private ensureRun(attributes: Record<string, TelemetryAttribute>): ActiveSpan {
		if (this.run) return this.run;
		const traceId = this.createId();
		this.runStatus = "ok";
		this.run = this.startSpan("pi.agent.run", traceId, undefined, attributes);
		return this.run;
	}

	private startTurn(): void {
		const run = this.ensureRun({ invocation: "run" });
		if (this.turn) this.endSpan(this.turn, "error", { reason: "overlapping_turn" });
		this.turn = this.startSpan("pi.agent.turn", run.traceId, run.spanId, {});
	}

	private startProvider(provider: string, model: string): void {
		const parent = this.turn ?? this.ensureRun({ invocation: "run" });
		if (this.provider) this.endSpan(this.provider, "error", { reason: "overlapping_request" });
		this.provider = this.startSpan("pi.provider.request", parent.traceId, parent.spanId, { provider, model });
		this.emitMetric("pi.provider.requests", "counter", 1, "1", { provider, model });
	}

	private startTool(toolCallId: string, toolName: string): void {
		const parent = this.turn ?? this.ensureRun({ invocation: "run" });
		const existing = this.tools.get(toolCallId);
		if (existing) this.endSpan(existing, "error", { reason: "duplicate_start" });
		this.tools.set(
			toolCallId,
			this.startSpan("pi.agent.tool_call", parent.traceId, parent.spanId, { tool: toolName }),
		);
		this.emitMetric("pi.agent.tool_calls", "counter", 1, "1", {
			toolNamespace: toolName.split(/[.:/]/, 1)[0] || "unknown",
		});
	}

	private endProvider(status: TelemetrySpanStatus): void {
		if (!this.provider) return;
		this.raiseRunStatus(status);
		this.endSpan(this.provider, status, {});
		this.emitDuration("pi.provider.request_duration", this.provider, status, this.provider.attributes);
		this.provider = undefined;
	}

	private endTool(
		toolCallId: string,
		status: TelemetrySpanStatus,
		attemptOutcome: ToolAttemptOutcome | "unknown" = "unknown",
	): void {
		const span = this.tools.get(toolCallId);
		if (!span) return;
		this.raiseRunStatus(status);
		this.endSpan(span, status, { attemptOutcome });
		this.emitDuration("pi.agent.tool_duration", span, status, span.attributes);
		this.tools.delete(toolCallId);
	}

	private endTurn(status: TelemetrySpanStatus): void {
		if (!this.turn) return;
		this.raiseRunStatus(status);
		this.endSpan(this.turn, status, {});
		this.emitDuration("pi.agent.turn_duration", this.turn, status, {});
		this.turn = undefined;
	}

	private endRun(status: TelemetrySpanStatus): void {
		if (!this.run) return;
		this.endSpan(this.run, status, {});
		this.emitDuration("pi.agent.run_duration", this.run, status, {});
		this.run = undefined;
	}

	private raiseRunStatus(status: TelemetrySpanStatus): void {
		if (status === "error" || (status === "cancelled" && this.runStatus === "ok")) this.runStatus = status;
	}

	private endDanglingChildren(): void {
		this.endProvider("error");
		for (const [toolCallId] of this.tools) this.endTool(toolCallId, "error");
		this.endTurn("error");
	}

	private emitUsage(usage: {
		steps: number;
		modelCalls: number;
		toolCalls: number;
		modelTokens: number;
		cost: number;
		elapsedMs: number;
	}): void {
		this.emitMetric("pi.agent.steps", "histogram", usage.steps, "1", {});
		this.emitMetric("pi.agent.model_calls", "histogram", usage.modelCalls, "1", {});
		this.emitMetric("pi.agent.tool_calls_per_run", "histogram", usage.toolCalls, "1", {});
		this.emitMetric("pi.agent.model_tokens", "histogram", usage.modelTokens, "token", {});
		this.emitMetric("pi.agent.cost", "histogram", usage.cost, "cost_unit", {});
		this.emitMetric("pi.agent.elapsed", "histogram", usage.elapsedMs, "ms", {});
	}

	private startSpan(
		name: string,
		traceId: string,
		parentSpanId: string | undefined,
		attributes: Record<string, TelemetryAttribute>,
	): ActiveSpan {
		const span: ActiveSpan = {
			traceId,
			spanId: this.createId(),
			parentSpanId,
			name,
			startedAt: this.now(),
			attributes: { ...attributes },
		};
		this.emit({
			type: "span_start",
			traceId,
			spanId: span.spanId,
			parentSpanId,
			name,
			attributes: span.attributes,
		});
		return span;
	}

	private endSpan(
		span: ActiveSpan,
		status: TelemetrySpanStatus,
		attributes: Record<string, TelemetryAttribute>,
	): void {
		this.emit({
			type: "span_end",
			traceId: span.traceId,
			spanId: span.spanId,
			parentSpanId: span.parentSpanId,
			name: span.name,
			durationMs: Math.max(0, this.now() - span.startedAt),
			status,
			attributes: { ...span.attributes, ...attributes },
		});
	}

	private emitDuration(
		name: string,
		span: ActiveSpan,
		status: TelemetrySpanStatus,
		dimensions: Record<string, TelemetryAttribute>,
	): void {
		this.emitMetric(name, "histogram", Math.max(0, this.now() - span.startedAt), "ms", {
			...dimensions,
			status,
		});
	}

	private emitLog(
		severity: HarnessTelemetryLog["severity"],
		name: string,
		attributes: Record<string, TelemetryAttribute>,
	): void {
		const traceId = this.run?.traceId ?? this.createId();
		this.emit({ type: "log", traceId, severity, name, attributes });
	}

	private emitMetric(
		name: string,
		kind: TelemetryMetricKind,
		value: number,
		unit: HarnessTelemetryMetric["unit"],
		dimensions: Record<string, TelemetryAttribute>,
	): void {
		const traceId = this.run?.traceId ?? this.createId();
		this.emit({ type: "metric", traceId, name, kind, value, unit, dimensions });
	}

	private emit(record: HarnessTelemetryRecordInput): void {
		const complete = {
			...record,
			version: HARNESS_TELEMETRY_VERSION,
			sequence: ++this.sequence,
			timestamp: this.now(),
		} as HarnessTelemetryRecord;
		try {
			const result = this.sink.emit(complete);
			if (result && typeof result.then === "function") void result.catch(() => undefined);
		} catch {
			// Subscriber failures are intentionally isolated.
		}
	}
}

/** Attach passive telemetry to a harness. Returns an idempotent unsubscribe function. */
export function attachHarnessTelemetry<
	TSkill extends Skill,
	TPromptTemplate extends PromptTemplate,
	TTool extends AgentTool,
>(
	harness: AgentHarness<TSkill, TPromptTemplate, TTool>,
	sink: HarnessTelemetrySink,
	options: HarnessTelemetryOptions = {},
): () => void {
	const collector = new HarnessTelemetryCollector(sink, options);
	return harness.subscribe((event) => collector.record(event));
}

/** Test/debug sink that retains records in emission order. */
export class InMemoryHarnessTelemetrySink implements HarnessTelemetrySink {
	readonly records: HarnessTelemetryRecord[] = [];

	emit(record: HarnessTelemetryRecord): void {
		this.records.push(record);
	}
}
