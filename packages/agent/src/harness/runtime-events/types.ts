/** Version of the canonical runtime-event envelope. */
export const RUNTIME_EVENT_VERSION = 1 as const;

/** Session custom-entry discriminator used to keep runtime events in the canonical session log. */
export const RUNTIME_EVENT_CUSTOM_TYPE = "pi.runtime_event";

export type RuntimeQueueName = "steer" | "follow_up" | "next_turn";
export type RuntimeOperationKind = "turn" | "compaction" | "branch_summary" | "retry";
export type RuntimeEntityStatus = "active" | "finished" | "failed" | "interrupted";

export interface QueueEnqueuedRuntimeEvent {
	type: "queue_enqueued";
	queueItemId: string;
	queue: RuntimeQueueName;
	message: unknown;
}

export interface QueueDiscardedRuntimeEvent {
	type: "queue_discarded";
	queueItemId: string;
	reason: string;
}

export interface PendingWriteEnqueuedRuntimeEvent {
	type: "pending_write_enqueued";
	pendingWriteId: string;
	/** Deterministic target session-entry id used to make recovery idempotent. */
	targetEntryId: string;
	write: unknown;
}

export interface PendingWriteAppliedRuntimeEvent {
	type: "pending_write_applied";
	pendingWriteId: string;
	targetEntryId: string;
}

export interface OperationStartedRuntimeEvent {
	type: "operation_started";
	operationId: string;
	kind: RuntimeOperationKind;
}

export interface OperationFinishedRuntimeEvent {
	type: "operation_finished";
	operationId: string;
}

export interface OperationInterruptedRuntimeEvent {
	type: "operation_interrupted";
	operationId: string;
	reason: string;
}

export interface TurnStartedRuntimeEvent {
	type: "turn_started";
	turnId: string;
	operationId: string;
	/** Queue items are considered consumed atomically with this durable event. */
	consumedQueueItemIds: string[];
}

export interface TurnFinishedRuntimeEvent {
	type: "turn_finished";
	turnId: string;
}

export interface TurnInterruptedRuntimeEvent {
	type: "turn_interrupted";
	turnId: string;
	reason: string;
}

export interface ProviderRequestStartedRuntimeEvent {
	type: "provider_request_started";
	requestId: string;
	turnId: string;
	provider: string;
	modelId: string;
}

export interface ProviderRequestFinishedRuntimeEvent {
	type: "provider_request_finished";
	requestId: string;
}

export interface ProviderRequestFailedRuntimeEvent {
	type: "provider_request_failed";
	requestId: string;
	reason: string;
}

export interface ProviderRequestInterruptedRuntimeEvent {
	type: "provider_request_interrupted";
	requestId: string;
	reason: string;
}

export interface ToolCallStartedRuntimeEvent {
	type: "tool_call_started";
	toolCallId: string;
	turnId: string;
	toolName: string;
	/** Only retry-safe calls are eligible for an explicit host-driven retry after recovery. */
	retrySafe: boolean;
}

export interface ToolCallFinishedRuntimeEvent {
	type: "tool_call_finished";
	toolCallId: string;
}

export interface ToolCallInterruptedRuntimeEvent {
	type: "tool_call_interrupted";
	toolCallId: string;
	reason: string;
}

export interface RecoveryStartedRuntimeEvent {
	type: "recovery_started";
	recoveryId: string;
	reason: string;
}

export interface RuntimeQueueItemState {
	queueItemId: string;
	queue: RuntimeQueueName;
	message: unknown;
	status: "queued" | "consumed" | "discarded";
	enqueuedSequence: number;
	consumedSequence?: number;
	consumedByTurnId?: string;
	discardedSequence?: number;
	discardReason?: string;
}

export interface RuntimePendingWriteState {
	pendingWriteId: string;
	targetEntryId: string;
	write: unknown;
	status: "pending" | "applied";
	enqueuedSequence: number;
	appliedSequence?: number;
}

export interface RuntimeOperationState {
	operationId: string;
	kind: RuntimeOperationKind;
	status: RuntimeEntityStatus;
	startedSequence: number;
	settledSequence?: number;
	interruptionReason?: string;
}

export interface RuntimeTurnState {
	turnId: string;
	operationId: string;
	status: RuntimeEntityStatus;
	consumedQueueItemIds: string[];
	startedSequence: number;
	settledSequence?: number;
	interruptionReason?: string;
}

export interface RuntimeProviderRequestState {
	requestId: string;
	turnId: string;
	provider: string;
	modelId: string;
	status: RuntimeEntityStatus;
	startedSequence: number;
	settledSequence?: number;
	interruptionReason?: string;
}

export interface RuntimeToolCallState {
	toolCallId: string;
	turnId: string;
	toolName: string;
	retrySafe: boolean;
	status: RuntimeEntityStatus;
	startedSequence: number;
	settledSequence?: number;
	interruptionReason?: string;
}

export interface RuntimeRecoveryState {
	version: typeof RUNTIME_EVENT_VERSION;
	sessionId: string;
	lastSequence: number;
	lastEventId?: string;
	queueItems: Readonly<Record<string, RuntimeQueueItemState>>;
	pendingWrites: Readonly<Record<string, RuntimePendingWriteState>>;
	operations: Readonly<Record<string, RuntimeOperationState>>;
	turns: Readonly<Record<string, RuntimeTurnState>>;
	providerRequests: Readonly<Record<string, RuntimeProviderRequestState>>;
	toolCalls: Readonly<Record<string, RuntimeToolCallState>>;
	lastRecovery?: { recoveryId: string; reason: string; sequence: number };
}

export interface RuntimeCheckpointEvent {
	type: "checkpoint";
	throughSequence: number;
	state: RuntimeRecoveryState;
}

/** Serializable event body carried by a {@link RuntimeEventEnvelope}. */
export type RuntimeEvent =
	| QueueEnqueuedRuntimeEvent
	| QueueDiscardedRuntimeEvent
	| PendingWriteEnqueuedRuntimeEvent
	| PendingWriteAppliedRuntimeEvent
	| OperationStartedRuntimeEvent
	| OperationFinishedRuntimeEvent
	| OperationInterruptedRuntimeEvent
	| TurnStartedRuntimeEvent
	| TurnFinishedRuntimeEvent
	| TurnInterruptedRuntimeEvent
	| ProviderRequestStartedRuntimeEvent
	| ProviderRequestFinishedRuntimeEvent
	| ProviderRequestFailedRuntimeEvent
	| ProviderRequestInterruptedRuntimeEvent
	| ToolCallStartedRuntimeEvent
	| ToolCallFinishedRuntimeEvent
	| ToolCallInterruptedRuntimeEvent
	| RecoveryStartedRuntimeEvent
	| RuntimeCheckpointEvent;

/** Canonical, append-only envelope for durable harness runtime state. */
export interface RuntimeEventEnvelope<TEvent extends RuntimeEvent = RuntimeEvent> {
	version: typeof RUNTIME_EVENT_VERSION;
	eventId: string;
	/** Branch-local contiguous sequence, starting at 1. */
	sequence: number;
	timestamp: string;
	sessionId: string;
	event: TEvent;
}

export type RuntimeEventErrorCode = "invalid_event" | "invalid_sequence" | "invalid_transition" | "session" | "storage";

/** Typed failure from runtime-event validation, reduction, or persistence. */
export class RuntimeEventError extends Error {
	public code: RuntimeEventErrorCode;

	constructor(code: RuntimeEventErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "RuntimeEventError";
		this.code = code;
	}
}

export interface RuntimeRecoveryPlan {
	events: RuntimeEvent[];
	preservedQueueItemIds: string[];
	pendingWriteIds: string[];
	retryableToolCallIds: string[];
}
