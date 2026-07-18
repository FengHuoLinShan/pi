import type { Session } from "../session/session.ts";
import { uuidv7 } from "../session/uuid.ts";
import type { CustomEntry, SessionMetadata } from "../types.ts";
import { toError } from "../types.ts";
import { planRuntimeRecovery, reduceRuntimeEvent, replayRuntimeEvents } from "./reducer.ts";
import {
	RUNTIME_EVENT_CUSTOM_TYPE,
	RUNTIME_EVENT_VERSION,
	type RuntimeCheckpointEvent,
	type RuntimeEvent,
	type RuntimeEventEnvelope,
	RuntimeEventError,
	type RuntimeRecoveryPlan,
	type RuntimeRecoveryState,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value) {
		throw new RuntimeEventError("invalid_event", `Runtime event is missing ${key}`);
	}
	return value;
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
		throw new RuntimeEventError("invalid_event", `Runtime event has invalid ${key}`);
	}
	return value;
}

function validateRecoveryState(value: unknown): RuntimeRecoveryState {
	if (!isRecord(value)) throw new RuntimeEventError("invalid_event", "Checkpoint state must be an object");
	if (value.version !== RUNTIME_EVENT_VERSION) {
		throw new RuntimeEventError("invalid_event", "Checkpoint state has an unsupported version");
	}
	requireString(value, "sessionId");
	if (!Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0) {
		throw new RuntimeEventError("invalid_event", "Checkpoint state has an invalid lastSequence");
	}
	for (const key of ["queueItems", "pendingWrites", "operations", "turns", "providerRequests", "toolCalls"]) {
		if (!isRecord(value[key])) throw new RuntimeEventError("invalid_event", `Checkpoint state has invalid ${key}`);
	}
	return value as unknown as RuntimeRecoveryState;
}

function parseRuntimeEvent(value: unknown): RuntimeEvent {
	if (!isRecord(value)) throw new RuntimeEventError("invalid_event", "Runtime event body must be an object");
	const type = requireString(value, "type");
	switch (type) {
		case "queue_enqueued": {
			const queue = value.queue;
			if (queue !== "steer" && queue !== "follow_up" && queue !== "next_turn") {
				throw new RuntimeEventError("invalid_event", "Runtime queue event has an invalid queue");
			}
			return { type, queueItemId: requireString(value, "queueItemId"), queue, message: value.message };
		}
		case "queue_discarded":
			return {
				type,
				queueItemId: requireString(value, "queueItemId"),
				reason: requireString(value, "reason"),
			};
		case "pending_write_enqueued":
			return {
				type,
				pendingWriteId: requireString(value, "pendingWriteId"),
				targetEntryId: requireString(value, "targetEntryId"),
				write: value.write,
			};
		case "pending_write_applied":
			return {
				type,
				pendingWriteId: requireString(value, "pendingWriteId"),
				targetEntryId: requireString(value, "targetEntryId"),
			};
		case "operation_started": {
			const kind = value.kind;
			if (kind !== "turn" && kind !== "compaction" && kind !== "branch_summary" && kind !== "retry") {
				throw new RuntimeEventError("invalid_event", "Operation event has an invalid kind");
			}
			return { type, operationId: requireString(value, "operationId"), kind };
		}
		case "operation_finished":
			return { type, operationId: requireString(value, "operationId") };
		case "operation_interrupted":
			return {
				type,
				operationId: requireString(value, "operationId"),
				reason: requireString(value, "reason"),
			};
		case "turn_started":
			return {
				type,
				turnId: requireString(value, "turnId"),
				operationId: requireString(value, "operationId"),
				consumedQueueItemIds: requireStringArray(value, "consumedQueueItemIds"),
			};
		case "turn_finished":
			return { type, turnId: requireString(value, "turnId") };
		case "turn_interrupted":
			return { type, turnId: requireString(value, "turnId"), reason: requireString(value, "reason") };
		case "provider_request_started":
			return {
				type,
				requestId: requireString(value, "requestId"),
				turnId: requireString(value, "turnId"),
				provider: requireString(value, "provider"),
				modelId: requireString(value, "modelId"),
			};
		case "provider_request_finished":
			return { type, requestId: requireString(value, "requestId") };
		case "provider_request_failed":
		case "provider_request_interrupted":
			return {
				type,
				requestId: requireString(value, "requestId"),
				reason: requireString(value, "reason"),
			};
		case "tool_call_started": {
			if (typeof value.retrySafe !== "boolean") {
				throw new RuntimeEventError("invalid_event", "Tool-call event has invalid retrySafe metadata");
			}
			return {
				type,
				toolCallId: requireString(value, "toolCallId"),
				turnId: requireString(value, "turnId"),
				toolName: requireString(value, "toolName"),
				retrySafe: value.retrySafe,
			};
		}
		case "tool_call_finished":
			return { type, toolCallId: requireString(value, "toolCallId") };
		case "tool_call_interrupted":
			return {
				type,
				toolCallId: requireString(value, "toolCallId"),
				reason: requireString(value, "reason"),
			};
		case "recovery_started":
			return {
				type,
				recoveryId: requireString(value, "recoveryId"),
				reason: requireString(value, "reason"),
			};
		case "checkpoint": {
			if (!Number.isSafeInteger(value.throughSequence) || (value.throughSequence as number) < 0) {
				throw new RuntimeEventError("invalid_event", "Checkpoint has an invalid throughSequence");
			}
			return {
				type,
				throughSequence: value.throughSequence as number,
				state: validateRecoveryState(value.state),
			};
		}
		default:
			throw new RuntimeEventError("invalid_event", `Unknown runtime event type ${type}`);
	}
}

/** Parse and validate a runtime envelope loaded from an untyped session entry. */
export function parseRuntimeEventEnvelope(value: unknown): RuntimeEventEnvelope {
	if (!isRecord(value)) throw new RuntimeEventError("invalid_event", "Runtime event envelope must be an object");
	if (value.version !== RUNTIME_EVENT_VERSION) {
		throw new RuntimeEventError("invalid_event", `Unsupported runtime event version ${String(value.version)}`);
	}
	if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0) {
		throw new RuntimeEventError("invalid_event", "Runtime event envelope has an invalid sequence");
	}
	return {
		version: RUNTIME_EVENT_VERSION,
		eventId: requireString(value, "eventId"),
		sequence: value.sequence as number,
		timestamp: requireString(value, "timestamp"),
		sessionId: requireString(value, "sessionId"),
		event: parseRuntimeEvent(value.event),
	};
}

function runtimeEnvelopeFromEntry(entry: CustomEntry): RuntimeEventEnvelope | undefined {
	if (entry.customType !== RUNTIME_EVENT_CUSTOM_TYPE) return undefined;
	try {
		return parseRuntimeEventEnvelope(entry.data);
	} catch (error) {
		const cause = toError(error);
		if (cause instanceof RuntimeEventError) throw cause;
		throw new RuntimeEventError("invalid_event", `Invalid runtime event in session entry ${entry.id}`, cause);
	}
}

function copyState(state: RuntimeRecoveryState): RuntimeRecoveryState {
	return {
		...state,
		queueItems: Object.fromEntries(Object.entries(state.queueItems).map(([id, item]) => [id, { ...item }])),
		pendingWrites: Object.fromEntries(Object.entries(state.pendingWrites).map(([id, write]) => [id, { ...write }])),
		operations: Object.fromEntries(Object.entries(state.operations).map(([id, operation]) => [id, { ...operation }])),
		turns: Object.fromEntries(
			Object.entries(state.turns).map(([id, turn]) => [
				id,
				{ ...turn, consumedQueueItemIds: [...turn.consumedQueueItemIds] },
			]),
		),
		providerRequests: Object.fromEntries(
			Object.entries(state.providerRequests).map(([id, request]) => [id, { ...request }]),
		),
		toolCalls: Object.fromEntries(Object.entries(state.toolCalls).map(([id, call]) => [id, { ...call }])),
		lastRecovery: state.lastRecovery ? { ...state.lastRecovery } : undefined,
	};
}

export interface SessionRuntimeEventStoreOptions {
	createId?: () => string;
	now?: () => Date;
}

export interface RuntimeRecoveryResult {
	plan: RuntimeRecoveryPlan;
	appended: RuntimeEventEnvelope[];
}

/**
 * Durable runtime-event store backed by `Session` custom entries.
 *
 * One instance should own appends for a session branch. Writes are serialized and reduced before
 * persistence so an invalid transition can never be appended by this store.
 */
export class SessionRuntimeEventStore<TMetadata extends SessionMetadata = SessionMetadata> {
	private readonly session: Session<TMetadata>;
	private readonly sessionId: string;
	private readonly createId: () => string;
	private readonly now: () => Date;
	private events: RuntimeEventEnvelope[];
	private state: RuntimeRecoveryState;
	private writeChain: Promise<void> = Promise.resolve();

	private constructor(
		session: Session<TMetadata>,
		sessionId: string,
		events: RuntimeEventEnvelope[],
		state: RuntimeRecoveryState,
		options: SessionRuntimeEventStoreOptions,
	) {
		this.session = session;
		this.sessionId = sessionId;
		this.events = events;
		this.state = state;
		this.createId = options.createId ?? uuidv7;
		this.now = options.now ?? (() => new Date());
	}

	static async open<TMetadata extends SessionMetadata = SessionMetadata>(
		session: Session<TMetadata>,
		options: SessionRuntimeEventStoreOptions = {},
	): Promise<SessionRuntimeEventStore<TMetadata>> {
		const metadata = await session.getMetadata();
		const branch = await session.getBranch();
		const events: RuntimeEventEnvelope[] = [];
		for (const entry of branch) {
			if (entry.type !== "custom") continue;
			const envelope = runtimeEnvelopeFromEntry(entry);
			// Forks retain source entries for parent-chain integrity. Runtime state is session-scoped,
			// so inherited source-session envelopes remain historical but are not replayed in the fork.
			if (envelope?.sessionId === metadata.id) events.push(envelope);
		}
		const state = replayRuntimeEvents(metadata.id, events);
		return new SessionRuntimeEventStore(session, metadata.id, events, state, options);
	}

	getState(): RuntimeRecoveryState {
		return copyState(this.state);
	}

	getEvents(): RuntimeEventEnvelope[] {
		return [...this.events];
	}

	append(event: RuntimeEvent): Promise<RuntimeEventEnvelope> {
		return this.serialize(async () => await this.appendUnlocked(event));
	}

	appendCheckpoint(): Promise<RuntimeEventEnvelope<RuntimeCheckpointEvent>> {
		return this.serialize(async () => {
			const checkpoint: RuntimeCheckpointEvent = {
				type: "checkpoint",
				throughSequence: this.state.lastSequence,
				state: copyState(this.state),
			};
			return (await this.appendUnlocked(checkpoint)) as RuntimeEventEnvelope<RuntimeCheckpointEvent>;
		});
	}

	/** Mark unfinished work interrupted while preserving queues and unapplied writes for the host. */
	recover(options: { reason?: string; recoveryId?: string } = {}): Promise<RuntimeRecoveryResult> {
		return this.serialize(async () => {
			const plan = planRuntimeRecovery(this.state, {
				recoveryId: options.recoveryId ?? this.createId(),
				reason: options.reason,
			});
			const appended: RuntimeEventEnvelope[] = [];
			for (const event of plan.events) appended.push(await this.appendUnlocked(event));
			return { plan, appended };
		});
	}

	private async appendUnlocked(event: RuntimeEvent): Promise<RuntimeEventEnvelope> {
		const envelope = parseRuntimeEventEnvelope({
			version: RUNTIME_EVENT_VERSION,
			eventId: this.createId(),
			sequence: this.state.lastSequence + 1,
			timestamp: this.now().toISOString(),
			sessionId: this.sessionId,
			event,
		});
		const nextState = reduceRuntimeEvent(this.state, envelope);
		try {
			await this.session.appendCustomEntry(RUNTIME_EVENT_CUSTOM_TYPE, envelope);
		} catch (error) {
			throw new RuntimeEventError("session", `Failed to append runtime event ${envelope.eventId}`, toError(error));
		}
		this.events.push(envelope);
		this.state = nextState;
		return envelope;
	}

	private serialize<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		const result = this.writeChain.then(operation, operation);
		this.writeChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
