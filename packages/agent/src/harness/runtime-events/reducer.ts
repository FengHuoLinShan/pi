import {
	RUNTIME_EVENT_VERSION,
	type RuntimeCheckpointEvent,
	type RuntimeEventEnvelope,
	RuntimeEventError,
	type RuntimeOperationState,
	type RuntimeProviderRequestState,
	type RuntimeQueueItemState,
	type RuntimeRecoveryPlan,
	type RuntimeRecoveryState,
	type RuntimeToolCallState,
	type RuntimeTurnState,
} from "./types.ts";

/** Create the empty reducer state for one session branch. */
export function createRuntimeRecoveryState(sessionId: string): RuntimeRecoveryState {
	if (!sessionId) throw new RuntimeEventError("invalid_event", "Runtime state requires a session id");
	return {
		version: RUNTIME_EVENT_VERSION,
		sessionId,
		lastSequence: 0,
		queueItems: {},
		pendingWrites: {},
		operations: {},
		turns: {},
		providerRequests: {},
		toolCalls: {},
	};
}

function invalidTransition(message: string): never {
	throw new RuntimeEventError("invalid_transition", message);
}

function requireActive<TState extends { status: string }>(state: TState | undefined, label: string): TState {
	if (!state) invalidTransition(`${label} does not exist`);
	if (state.status !== "active") invalidTransition(`${label} is already ${state.status}`);
	return state;
}

function withEnvelopeState(state: RuntimeRecoveryState, envelope: RuntimeEventEnvelope): RuntimeRecoveryState {
	return { ...state, lastSequence: envelope.sequence, lastEventId: envelope.eventId };
}

function withEnvelopeStateFromPatch(
	state: RuntimeRecoveryState,
	envelope: RuntimeEventEnvelope,
	patch: Partial<RuntimeRecoveryState>,
): RuntimeRecoveryState {
	return withEnvelopeState({ ...state, ...patch }, envelope);
}

function validateEnvelope(state: RuntimeRecoveryState, envelope: RuntimeEventEnvelope): void {
	if (envelope.version !== RUNTIME_EVENT_VERSION) {
		throw new RuntimeEventError("invalid_event", `Unsupported runtime event version ${String(envelope.version)}`);
	}
	if (!envelope.eventId || !envelope.timestamp || !envelope.sessionId) {
		throw new RuntimeEventError("invalid_event", "Runtime event envelope is missing required metadata");
	}
	if (envelope.sessionId !== state.sessionId) {
		throw new RuntimeEventError(
			"invalid_event",
			`Runtime event session ${envelope.sessionId} does not match ${state.sessionId}`,
		);
	}
	if (envelope.sequence !== state.lastSequence + 1) {
		throw new RuntimeEventError(
			"invalid_sequence",
			`Expected runtime event sequence ${state.lastSequence + 1}, received ${envelope.sequence}`,
		);
	}
}

/**
 * Purely reduce one canonical event. The input state and event are never mutated.
 * Invalid causal transitions fail instead of silently producing ambiguous recovery state.
 */
export function reduceRuntimeEvent(state: RuntimeRecoveryState, envelope: RuntimeEventEnvelope): RuntimeRecoveryState {
	validateEnvelope(state, envelope);
	const event = envelope.event;
	switch (event.type) {
		case "queue_enqueued": {
			if (state.queueItems[event.queueItemId]) invalidTransition(`Queue item ${event.queueItemId} already exists`);
			const item: RuntimeQueueItemState = {
				queueItemId: event.queueItemId,
				queue: event.queue,
				message: event.message,
				status: "queued",
				enqueuedSequence: envelope.sequence,
			};
			return withEnvelopeStateFromPatch(state, envelope, {
				queueItems: { ...state.queueItems, [event.queueItemId]: item },
			});
		}
		case "queue_discarded": {
			const item = state.queueItems[event.queueItemId];
			if (!item) invalidTransition(`Queue item ${event.queueItemId} does not exist`);
			if (item.status !== "queued") invalidTransition(`Queue item ${event.queueItemId} is already ${item.status}`);
			return withEnvelopeStateFromPatch(state, envelope, {
				queueItems: {
					...state.queueItems,
					[event.queueItemId]: {
						...item,
						status: "discarded",
						discardedSequence: envelope.sequence,
						discardReason: event.reason,
					},
				},
			});
		}
		case "pending_write_enqueued": {
			if (state.pendingWrites[event.pendingWriteId]) {
				invalidTransition(`Pending write ${event.pendingWriteId} already exists`);
			}
			return withEnvelopeStateFromPatch(state, envelope, {
				pendingWrites: {
					...state.pendingWrites,
					[event.pendingWriteId]: {
						pendingWriteId: event.pendingWriteId,
						targetEntryId: event.targetEntryId,
						write: event.write,
						status: "pending",
						enqueuedSequence: envelope.sequence,
					},
				},
			});
		}
		case "pending_write_applied": {
			const pending = state.pendingWrites[event.pendingWriteId];
			if (!pending) invalidTransition(`Pending write ${event.pendingWriteId} does not exist`);
			if (pending.status !== "pending")
				invalidTransition(`Pending write ${event.pendingWriteId} is already applied`);
			if (pending.targetEntryId !== event.targetEntryId) {
				invalidTransition(`Pending write ${event.pendingWriteId} target does not match its enqueue event`);
			}
			return withEnvelopeStateFromPatch(state, envelope, {
				pendingWrites: {
					...state.pendingWrites,
					[event.pendingWriteId]: { ...pending, status: "applied", appliedSequence: envelope.sequence },
				},
			});
		}
		case "operation_started": {
			if (state.operations[event.operationId]) invalidTransition(`Operation ${event.operationId} already exists`);
			const operation: RuntimeOperationState = {
				operationId: event.operationId,
				kind: event.kind,
				status: "active",
				startedSequence: envelope.sequence,
			};
			return withEnvelopeStateFromPatch(state, envelope, {
				operations: { ...state.operations, [event.operationId]: operation },
			});
		}
		case "operation_finished":
		case "operation_interrupted": {
			const operation = requireActive(state.operations[event.operationId], `Operation ${event.operationId}`);
			if (
				Object.values(state.turns).some(
					(turn) => turn.operationId === event.operationId && turn.status === "active",
				)
			) {
				invalidTransition(`Operation ${event.operationId} still has an active turn`);
			}
			const interrupted = event.type === "operation_interrupted";
			return withEnvelopeStateFromPatch(state, envelope, {
				operations: {
					...state.operations,
					[event.operationId]: {
						...operation,
						status: interrupted ? "interrupted" : "finished",
						settledSequence: envelope.sequence,
						interruptionReason: interrupted ? event.reason : undefined,
					},
				},
			});
		}
		case "turn_started": {
			if (state.turns[event.turnId]) invalidTransition(`Turn ${event.turnId} already exists`);
			const operation = requireActive(state.operations[event.operationId], `Operation ${event.operationId}`);
			if (operation.kind !== "turn" && operation.kind !== "retry") {
				invalidTransition(`Operation ${event.operationId} cannot own a turn`);
			}
			if (new Set(event.consumedQueueItemIds).size !== event.consumedQueueItemIds.length) {
				invalidTransition(`Turn ${event.turnId} contains duplicate queue item ids`);
			}
			const queueItems = { ...state.queueItems };
			for (const queueItemId of event.consumedQueueItemIds) {
				const item = queueItems[queueItemId];
				if (!item) invalidTransition(`Queue item ${queueItemId} does not exist`);
				if (item.status !== "queued") invalidTransition(`Queue item ${queueItemId} is already consumed`);
				queueItems[queueItemId] = {
					...item,
					status: "consumed",
					consumedSequence: envelope.sequence,
					consumedByTurnId: event.turnId,
				};
			}
			const turn: RuntimeTurnState = {
				turnId: event.turnId,
				operationId: event.operationId,
				status: "active",
				consumedQueueItemIds: [...event.consumedQueueItemIds],
				startedSequence: envelope.sequence,
			};
			return withEnvelopeStateFromPatch(state, envelope, {
				queueItems,
				turns: { ...state.turns, [event.turnId]: turn },
			});
		}
		case "turn_finished":
		case "turn_interrupted": {
			const turn = requireActive(state.turns[event.turnId], `Turn ${event.turnId}`);
			if (
				Object.values(state.providerRequests).some(
					(request) => request.turnId === event.turnId && request.status === "active",
				) ||
				Object.values(state.toolCalls).some((call) => call.turnId === event.turnId && call.status === "active")
			) {
				invalidTransition(`Turn ${event.turnId} still has active child work`);
			}
			const interrupted = event.type === "turn_interrupted";
			return withEnvelopeStateFromPatch(state, envelope, {
				turns: {
					...state.turns,
					[event.turnId]: {
						...turn,
						status: interrupted ? "interrupted" : "finished",
						settledSequence: envelope.sequence,
						interruptionReason: interrupted ? event.reason : undefined,
					},
				},
			});
		}
		case "provider_request_started": {
			if (state.providerRequests[event.requestId]) {
				invalidTransition(`Provider request ${event.requestId} already exists`);
			}
			requireActive(state.turns[event.turnId], `Turn ${event.turnId}`);
			if (
				Object.values(state.providerRequests).some(
					(request) => request.turnId === event.turnId && request.status === "active",
				)
			) {
				invalidTransition(`Turn ${event.turnId} already has an active provider request`);
			}
			const request: RuntimeProviderRequestState = {
				requestId: event.requestId,
				turnId: event.turnId,
				provider: event.provider,
				modelId: event.modelId,
				status: "active",
				startedSequence: envelope.sequence,
			};
			return withEnvelopeStateFromPatch(state, envelope, {
				providerRequests: { ...state.providerRequests, [event.requestId]: request },
			});
		}
		case "provider_request_finished":
		case "provider_request_failed":
		case "provider_request_interrupted": {
			const request = requireActive(state.providerRequests[event.requestId], `Provider request ${event.requestId}`);
			const interrupted = event.type === "provider_request_interrupted";
			const failed = event.type === "provider_request_failed";
			return withEnvelopeStateFromPatch(state, envelope, {
				providerRequests: {
					...state.providerRequests,
					[event.requestId]: {
						...request,
						status: interrupted ? "interrupted" : failed ? "failed" : "finished",
						settledSequence: envelope.sequence,
						interruptionReason: interrupted || failed ? event.reason : undefined,
					},
				},
			});
		}
		case "tool_call_started": {
			if (state.toolCalls[event.toolCallId]) invalidTransition(`Tool call ${event.toolCallId} already exists`);
			requireActive(state.turns[event.turnId], `Turn ${event.turnId}`);
			const toolCall: RuntimeToolCallState = {
				toolCallId: event.toolCallId,
				turnId: event.turnId,
				toolName: event.toolName,
				retrySafe: event.retrySafe,
				status: "active",
				startedSequence: envelope.sequence,
			};
			return withEnvelopeStateFromPatch(state, envelope, {
				toolCalls: { ...state.toolCalls, [event.toolCallId]: toolCall },
			});
		}
		case "tool_call_finished":
		case "tool_call_interrupted": {
			const toolCall = requireActive(state.toolCalls[event.toolCallId], `Tool call ${event.toolCallId}`);
			const interrupted = event.type === "tool_call_interrupted";
			return withEnvelopeStateFromPatch(state, envelope, {
				toolCalls: {
					...state.toolCalls,
					[event.toolCallId]: {
						...toolCall,
						status: interrupted ? "interrupted" : "finished",
						settledSequence: envelope.sequence,
						interruptionReason: interrupted ? event.reason : undefined,
					},
				},
			});
		}
		case "recovery_started":
			return withEnvelopeStateFromPatch(state, envelope, {
				lastRecovery: { recoveryId: event.recoveryId, reason: event.reason, sequence: envelope.sequence },
			});
		case "checkpoint":
			validateCheckpoint(event, state);
			return withEnvelopeState(state, envelope);
	}
}

function validateCheckpoint(event: RuntimeCheckpointEvent, state: RuntimeRecoveryState): void {
	if (event.throughSequence !== state.lastSequence) {
		throw new RuntimeEventError(
			"invalid_sequence",
			`Checkpoint covers ${event.throughSequence}, expected ${state.lastSequence}`,
		);
	}
	if (event.state.sessionId !== state.sessionId || event.state.lastSequence !== event.throughSequence) {
		throw new RuntimeEventError("invalid_event", "Checkpoint snapshot does not match its envelope position");
	}
}

function restoreCheckpoint(envelope: RuntimeEventEnvelope<RuntimeCheckpointEvent>): RuntimeRecoveryState {
	const event = envelope.event;
	if (event.throughSequence !== envelope.sequence - 1) {
		throw new RuntimeEventError("invalid_sequence", "Checkpoint is not adjacent to the state it snapshots");
	}
	if (event.state.sessionId !== envelope.sessionId || event.state.lastSequence !== event.throughSequence) {
		throw new RuntimeEventError("invalid_event", "Checkpoint snapshot does not match its envelope");
	}
	return { ...event.state, lastSequence: envelope.sequence, lastEventId: envelope.eventId };
}

/** Replay canonical events, starting from the latest valid checkpoint when one is present. */
export function replayRuntimeEvents(sessionId: string, events: readonly RuntimeEventEnvelope[]): RuntimeRecoveryState {
	let previousSequence = 0;
	const eventIds = new Set<string>();
	for (const envelope of events) {
		if (envelope.sessionId !== sessionId) {
			throw new RuntimeEventError("invalid_event", `Runtime event ${envelope.eventId} belongs to another session`);
		}
		if (envelope.sequence !== previousSequence + 1) {
			throw new RuntimeEventError(
				"invalid_sequence",
				`Expected runtime event sequence ${previousSequence + 1}, received ${envelope.sequence}`,
			);
		}
		if (eventIds.has(envelope.eventId)) {
			throw new RuntimeEventError("invalid_event", `Duplicate runtime event id ${envelope.eventId}`);
		}
		eventIds.add(envelope.eventId);
		previousSequence = envelope.sequence;
	}

	let checkpointIndex = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.event.type === "checkpoint") {
			checkpointIndex = i;
			break;
		}
	}
	let state = createRuntimeRecoveryState(sessionId);
	let startIndex = 0;
	if (checkpointIndex >= 0) {
		const checkpoint = events[checkpointIndex] as RuntimeEventEnvelope<RuntimeCheckpointEvent>;
		state = restoreCheckpoint(checkpoint);
		startIndex = checkpointIndex + 1;
	}
	for (let i = startIndex; i < events.length; i++) {
		state = reduceRuntimeEvent(state, events[i]!);
	}
	return state;
}

function activeBySequence<TState extends { status: string; startedSequence: number }>(
	states: Readonly<Record<string, TState>>,
): TState[] {
	return Object.values(states)
		.filter((state) => state.status === "active")
		.sort((a, b) => a.startedSequence - b.startedSequence);
}

/** Build a conservative, deterministic crash-recovery plan without mutating state. */
export function planRuntimeRecovery(
	state: RuntimeRecoveryState,
	options: { recoveryId: string; reason?: string },
): RuntimeRecoveryPlan {
	const reason = options.reason ?? "process_interrupted";
	const activeRequests = activeBySequence(state.providerRequests);
	const activeToolCalls = activeBySequence(state.toolCalls);
	const activeTurns = activeBySequence(state.turns);
	const activeOperations = activeBySequence(state.operations);
	return {
		events: [
			{ type: "recovery_started", recoveryId: options.recoveryId, reason },
			...activeRequests.map((request) => ({
				type: "provider_request_interrupted" as const,
				requestId: request.requestId,
				reason,
			})),
			...activeToolCalls.map((toolCall) => ({
				type: "tool_call_interrupted" as const,
				toolCallId: toolCall.toolCallId,
				reason,
			})),
			...activeTurns.map((turn) => ({ type: "turn_interrupted" as const, turnId: turn.turnId, reason })),
			...activeOperations.map((operation) => ({
				type: "operation_interrupted" as const,
				operationId: operation.operationId,
				reason,
			})),
		],
		preservedQueueItemIds: Object.values(state.queueItems)
			.filter((item) => item.status === "queued")
			.sort((a, b) => a.enqueuedSequence - b.enqueuedSequence)
			.map((item) => item.queueItemId),
		pendingWriteIds: Object.values(state.pendingWrites)
			.filter((write) => write.status === "pending")
			.sort((a, b) => a.enqueuedSequence - b.enqueuedSequence)
			.map((write) => write.pendingWriteId),
		retryableToolCallIds: activeToolCalls.filter((call) => call.retrySafe).map((call) => call.toolCallId),
	};
}
