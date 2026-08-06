import { SessionRuntimeEventStore } from "../harness/runtime-events/event-store.ts";
import { replayRuntimeEvents } from "../harness/runtime-events/reducer.ts";
import type {
	RuntimeEvent,
	RuntimeEventEnvelope,
	RuntimeRecoveryPlan,
	RuntimeRecoveryState,
} from "../harness/runtime-events/types.ts";
import { RUNTIME_EVENT_CUSTOM_TYPE } from "../harness/runtime-events/types.ts";
import { InMemorySessionStorage } from "../harness/session/memory-storage.ts";
import { Session } from "../harness/session/session.ts";
import type { SessionMetadata, SessionStorage, SessionTreeEntry } from "../harness/types.ts";

export const RUNTIME_LIFECYCLE_FAULT_LAB_VERSION = 1 as const;

const MAX_STEPS = 256;
const SCENARIO_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export type RuntimeLifecycleFaultPhase = "before-persist" | "after-persist";

export type RuntimeLifecycleFaultStep =
	| {
			readonly kind: "event";
			readonly event: RuntimeEvent;
	  }
	| {
			readonly kind: "checkpoint";
	  };

export interface RuntimeLifecycleFaultScenario {
	readonly version: typeof RUNTIME_LIFECYCLE_FAULT_LAB_VERSION;
	readonly id: string;
	readonly steps: readonly RuntimeLifecycleFaultStep[];
}

export interface RuntimeLifecycleFaultPoint {
	readonly stepIndex: number;
	readonly eventType: RuntimeEvent["type"];
	readonly phase: RuntimeLifecycleFaultPhase;
}

export interface RuntimeLifecycleFaultCaseReport {
	readonly fault: RuntimeLifecycleFaultPoint;
	readonly passed: boolean;
	readonly faultTriggered: boolean;
	readonly appendRejected: boolean;
	readonly persistedEventCount: number;
	readonly recoveryEventTypes: readonly RuntimeEvent["type"][];
	readonly preservedQueueItemCount: number;
	readonly pendingWriteCount: number;
	readonly retryableToolCallCount: number;
	readonly violations: readonly string[];
}

export interface RuntimeLifecycleHappyPathReport {
	readonly passed: boolean;
	readonly eventTypes: readonly RuntimeEvent["type"][];
	readonly violations: readonly string[];
}

export interface RuntimeLifecycleFaultFailure {
	readonly fault: RuntimeLifecycleFaultPoint;
	readonly violations: readonly string[];
}

export interface RuntimeLifecycleFaultLabReport {
	readonly version: typeof RUNTIME_LIFECYCLE_FAULT_LAB_VERSION;
	readonly scenarioId: string;
	readonly passed: boolean;
	readonly happyPath: RuntimeLifecycleHappyPathReport;
	readonly cases: readonly RuntimeLifecycleFaultCaseReport[];
	readonly firstFailure?: RuntimeLifecycleFaultFailure;
}

export class RuntimeLifecycleFaultLabError extends Error {
	readonly code: "invalid_scenario" | "happy_path_failed";

	constructor(code: "invalid_scenario" | "happy_path_failed", message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "RuntimeLifecycleFaultLabError";
		this.code = code;
	}
}

class InjectedLifecycleFault extends Error {
	constructor() {
		super("Injected lifecycle persistence fault");
		this.name = "InjectedLifecycleFault";
	}
}

class FaultInjectingSessionStorage implements SessionStorage {
	private readonly storage: SessionStorage;
	private readonly targetAppend: number;
	private readonly phase: RuntimeLifecycleFaultPhase;
	private runtimeAppendCount = 0;
	private triggered = false;

	constructor(storage: SessionStorage, targetAppend: number, phase: RuntimeLifecycleFaultPhase) {
		this.storage = storage;
		this.targetAppend = targetAppend;
		this.phase = phase;
	}

	getMetadata(): Promise<SessionMetadata> {
		return this.storage.getMetadata();
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	setLeafId(leafId: string | null): Promise<void> {
		return this.storage.setLeafId(leafId);
	}

	createEntryId(): Promise<string> {
		return this.storage.createEntryId();
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		const isRuntimeEvent = entry.type === "custom" && entry.customType === RUNTIME_EVENT_CUSTOM_TYPE;
		if (!isRuntimeEvent) {
			await this.storage.appendEntry(entry);
			return;
		}
		this.runtimeAppendCount++;
		const shouldFault = !this.triggered && this.runtimeAppendCount === this.targetAppend;
		if (shouldFault && this.phase === "before-persist") {
			this.triggered = true;
			throw new InjectedLifecycleFault();
		}
		await this.storage.appendEntry(entry);
		if (shouldFault) {
			this.triggered = true;
			throw new InjectedLifecycleFault();
		}
	}

	getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.getEntry(id);
	}

	findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.storage.findEntries(type);
	}

	getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}

	getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		return this.storage.getPathToRoot(leafId);
	}

	getEntries(): Promise<SessionTreeEntry[]> {
		return this.storage.getEntries();
	}

	didTrigger(): boolean {
		return this.triggered;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateScenario(value: RuntimeLifecycleFaultScenario): void {
	if (!isRecord(value)) {
		throw new RuntimeLifecycleFaultLabError("invalid_scenario", "Lifecycle fault scenario must be an object");
	}
	if (value.version !== RUNTIME_LIFECYCLE_FAULT_LAB_VERSION) {
		throw new RuntimeLifecycleFaultLabError("invalid_scenario", "Lifecycle fault scenario version must be 1");
	}
	if (typeof value.id !== "string" || !SCENARIO_ID_PATTERN.test(value.id)) {
		throw new RuntimeLifecycleFaultLabError(
			"invalid_scenario",
			"Lifecycle fault scenario id must be lowercase and portable",
		);
	}
	if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_STEPS) {
		throw new RuntimeLifecycleFaultLabError(
			"invalid_scenario",
			`Lifecycle fault scenario must contain between 1 and ${MAX_STEPS} steps`,
		);
	}
	for (let index = 0; index < value.steps.length; index++) {
		if (!(index in value.steps)) {
			throw new RuntimeLifecycleFaultLabError("invalid_scenario", "Lifecycle fault scenario steps must be dense");
		}
		const step = value.steps[index];
		if (!isRecord(step) || (step.kind !== "event" && step.kind !== "checkpoint")) {
			throw new RuntimeLifecycleFaultLabError("invalid_scenario", `Lifecycle fault step ${index} is invalid`);
		}
		if (step.kind === "event" && !isRecord(step.event)) {
			throw new RuntimeLifecycleFaultLabError(
				"invalid_scenario",
				`Lifecycle fault event step ${index} must contain an event`,
			);
		}
	}
}

function createIdFactory(prefix: string): () => string {
	let next = 0;
	return () => `${prefix}-${++next}`;
}

function createClock(): () => Date {
	let tick = 0;
	const epoch = Date.parse("2026-01-01T00:00:00.000Z");
	return () => new Date(epoch + tick++ * 1_000);
}

function eventType(step: RuntimeLifecycleFaultStep): RuntimeEvent["type"] {
	return step.kind === "checkpoint" ? "checkpoint" : step.event.type;
}

async function applyStep(store: SessionRuntimeEventStore, step: RuntimeLifecycleFaultStep): Promise<void> {
	if (step.kind === "checkpoint") {
		await store.appendCheckpoint();
		return;
	}
	await store.append(step.event);
}

function terminalIdentity(event: RuntimeEvent): { kind: string; id: string } | undefined {
	switch (event.type) {
		case "operation_finished":
		case "operation_interrupted":
			return { kind: "operation", id: event.operationId };
		case "turn_finished":
		case "turn_interrupted":
			return { kind: "turn", id: event.turnId };
		case "provider_request_finished":
		case "provider_request_failed":
		case "provider_request_interrupted":
			return { kind: "provider_request", id: event.requestId };
		case "tool_call_finished":
		case "tool_call_interrupted":
			return { kind: "tool_call", id: event.toolCallId };
		default:
			return undefined;
	}
}

function activeCount(state: RuntimeRecoveryState): number {
	return [
		...Object.values(state.operations),
		...Object.values(state.turns),
		...Object.values(state.providerRequests),
		...Object.values(state.toolCalls),
	].filter((entry) => entry.status === "active").length;
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Verify that recovery exposes every and only the durable host-owned item that
 * remains actionable. Messages, pending-write bodies, and entity ids never enter violations.
 */
export function verifyRuntimeRecoveryPlan(state: RuntimeRecoveryState, plan: RuntimeRecoveryPlan): string[] {
	const expectedQueueItems = Object.values(state.queueItems)
		.filter((item) => item.status === "queued")
		.sort((left, right) => left.enqueuedSequence - right.enqueuedSequence)
		.map((item) => item.queueItemId);
	const expectedPendingWrites = Object.values(state.pendingWrites)
		.filter((write) => write.status === "pending")
		.sort((left, right) => left.enqueuedSequence - right.enqueuedSequence)
		.map((write) => write.pendingWriteId);
	const expectedRetryableToolCalls = Object.values(state.toolCalls)
		.filter((call) => call.status === "active" && call.retrySafe)
		.sort((left, right) => left.startedSequence - right.startedSequence)
		.map((call) => call.toolCallId);
	const violations: string[] = [];
	if (!equalIds(plan.preservedQueueItemIds, expectedQueueItems)) {
		violations.push("Recovery did not preserve exactly the durable queued items");
	}
	if (!equalIds(plan.pendingWriteIds, expectedPendingWrites)) {
		violations.push("Recovery did not preserve exactly the durable pending writes");
	}
	if (!equalIds(plan.retryableToolCallIds, expectedRetryableToolCalls)) {
		violations.push("Recovery did not expose exactly the active retry-safe tool calls");
	}
	return violations;
}

function verifyPreservedRuntimeInputs(before: RuntimeRecoveryState, after: RuntimeRecoveryState): string[] {
	const violations: string[] = [];
	for (const item of Object.values(before.queueItems).filter((entry) => entry.status === "queued")) {
		if (JSON.stringify(after.queueItems[item.queueItemId]) !== JSON.stringify(item)) {
			violations.push("Recovery mutated a durable queued item");
			break;
		}
	}
	for (const write of Object.values(before.pendingWrites).filter((entry) => entry.status === "pending")) {
		if (JSON.stringify(after.pendingWrites[write.pendingWriteId]) !== JSON.stringify(write)) {
			violations.push("Recovery mutated a durable pending write");
			break;
		}
	}
	return violations;
}

/**
 * Validate privacy-safe lifecycle invariants from canonical events and their reduced state.
 *
 * Violations intentionally omit messages, tool arguments, pending-write bodies, and entity ids.
 */
export function verifyRuntimeLifecycleInvariants(
	events: readonly RuntimeEventEnvelope[],
	state: RuntimeRecoveryState,
	options: { requireSettled?: boolean } = {},
): string[] {
	const violations: string[] = [];
	if (state.lastSequence !== events.length) {
		violations.push("Reduced state sequence does not match the canonical event count");
	}
	const eventIds = new Set<string>();
	for (let index = 0; index < events.length; index++) {
		const envelope = events[index]!;
		if (envelope.sequence !== index + 1) {
			violations.push("Canonical runtime event sequences are not contiguous");
			break;
		}
		if (eventIds.has(envelope.eventId)) {
			violations.push("Canonical runtime event ids are not unique");
			break;
		}
		eventIds.add(envelope.eventId);
	}
	try {
		const replayed = replayRuntimeEvents(state.sessionId, events);
		if (JSON.stringify(replayed) !== JSON.stringify(state)) {
			violations.push("Reduced runtime state does not match canonical replay");
		}
	} catch {
		violations.push("Canonical runtime events cannot be replayed");
	}

	const terminalCounts = new Map<string, number>();
	for (const envelope of events) {
		const terminal = terminalIdentity(envelope.event);
		if (!terminal) continue;
		const key = `${terminal.kind}\0${terminal.id}`;
		terminalCounts.set(key, (terminalCounts.get(key) ?? 0) + 1);
	}
	if ([...terminalCounts.values()].some((count) => count > 1)) {
		violations.push("A runtime entity has more than one terminal event");
	}

	for (const request of Object.values(state.providerRequests)) {
		const turn = state.turns[request.turnId];
		if (!turn) {
			violations.push("A provider request has no owning turn");
		} else if (request.status === "active" && turn.status !== "active") {
			violations.push("An active provider request belongs to a terminal turn");
		}
	}
	for (const call of Object.values(state.toolCalls)) {
		const turn = state.turns[call.turnId];
		if (!turn) {
			violations.push("A tool call has no owning turn");
		} else if (call.status === "active" && turn.status !== "active") {
			violations.push("An active tool call belongs to a terminal turn");
		}
	}
	for (const turn of Object.values(state.turns)) {
		const operation = state.operations[turn.operationId];
		if (!operation) {
			violations.push("A turn has no owning operation");
		} else if (turn.status === "active" && operation.status !== "active") {
			violations.push("An active turn belongs to a terminal operation");
		}
		for (const queueItemId of turn.consumedQueueItemIds) {
			const queueItem = state.queueItems[queueItemId];
			if (!queueItem || queueItem.status !== "consumed" || queueItem.consumedByTurnId !== turn.turnId) {
				violations.push("A consumed queue item is not owned by its recorded turn");
			}
		}
	}
	if (options.requireSettled && activeCount(state) > 0) {
		violations.push("Recovery left active runtime work");
	}
	return [...new Set(violations)];
}

async function runHappyPath(scenario: RuntimeLifecycleFaultScenario): Promise<RuntimeLifecycleHappyPathReport> {
	const storage = new InMemorySessionStorage({
		metadata: {
			id: `fault-lab-${scenario.id}-happy`,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	});
	const store = await SessionRuntimeEventStore.open(new Session(storage), {
		createId: createIdFactory("happy-event"),
		now: createClock(),
	});
	try {
		for (const step of scenario.steps) await applyStep(store, step);
	} catch (error) {
		throw new RuntimeLifecycleFaultLabError(
			"happy_path_failed",
			"Lifecycle fault scenario does not form a valid canonical happy path",
			{ cause: error },
		);
	}
	const reopened = await SessionRuntimeEventStore.open(new Session(storage));
	const events = reopened.getEvents();
	const violations = verifyRuntimeLifecycleInvariants(events, reopened.getState());
	return {
		passed: violations.length === 0,
		eventTypes: events.map((envelope) => envelope.event.type),
		violations,
	};
}

async function runFaultCase(
	scenario: RuntimeLifecycleFaultScenario,
	fault: RuntimeLifecycleFaultPoint,
): Promise<RuntimeLifecycleFaultCaseReport> {
	const metadata: SessionMetadata = {
		id: `fault-lab-${scenario.id}-${fault.stepIndex}-${fault.phase}`,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const storage = new InMemorySessionStorage({ metadata });
	const faultingStorage = new FaultInjectingSessionStorage(storage, fault.stepIndex + 1, fault.phase);
	const store = await SessionRuntimeEventStore.open(new Session(faultingStorage), {
		createId: createIdFactory("fault-event"),
		now: createClock(),
	});
	let appendRejected = false;
	try {
		for (const step of scenario.steps) await applyStep(store, step);
	} catch {
		appendRejected = true;
	}

	const reopened = await SessionRuntimeEventStore.open(new Session(storage), {
		createId: createIdFactory("recovery-event"),
		now: createClock(),
	});
	const beforeRecoveryEvents = reopened.getEvents();
	const beforeRecoveryState = reopened.getState();
	const expectedPersistedEventCount = fault.stepIndex + (fault.phase === "after-persist" ? 1 : 0);
	const violations = verifyRuntimeLifecycleInvariants(beforeRecoveryEvents, beforeRecoveryState);
	if (beforeRecoveryEvents.length !== expectedPersistedEventCount) {
		violations.push("Fault persistence position does not match the requested phase");
	}
	const recovery = await reopened.recover({
		recoveryId: `recovery-${fault.stepIndex}-${fault.phase}`,
		reason: "fault_injected",
	});
	violations.push(...verifyRuntimeRecoveryPlan(beforeRecoveryState, recovery.plan));
	const recoveryEvents = reopened.getEvents();
	const recoveredState = reopened.getState();
	violations.push(...verifyRuntimeLifecycleInvariants(recoveryEvents, recoveredState, { requireSettled: true }));
	violations.push(...verifyPreservedRuntimeInputs(beforeRecoveryState, recoveredState));
	if (JSON.stringify(recovery.appended.map((envelope) => envelope.event)) !== JSON.stringify(recovery.plan.events)) {
		violations.push("Recovery persisted events that do not match its plan");
	}
	const uniqueViolations = [...new Set(violations)];
	const faultTriggered = faultingStorage.didTrigger();
	return {
		fault,
		passed: faultTriggered && appendRejected && uniqueViolations.length === 0,
		faultTriggered,
		appendRejected,
		persistedEventCount: beforeRecoveryEvents.length,
		recoveryEventTypes: recovery.appended.map((envelope) => envelope.event.type),
		preservedQueueItemCount: recovery.plan.preservedQueueItemIds.length,
		pendingWriteCount: recovery.plan.pendingWriteIds.length,
		retryableToolCallCount: recovery.plan.retryableToolCallIds.length,
		violations: uniqueViolations,
	};
}

/** Run every canonical append through before-persist and after-persist crash recovery. */
export async function runRuntimeLifecycleFaultLab(
	scenario: RuntimeLifecycleFaultScenario,
): Promise<RuntimeLifecycleFaultLabReport> {
	validateScenario(scenario);
	let snapshot: RuntimeLifecycleFaultScenario;
	try {
		snapshot = structuredClone(scenario);
	} catch {
		throw new RuntimeLifecycleFaultLabError(
			"invalid_scenario",
			"Lifecycle fault scenario must be structured-cloneable",
		);
	}
	validateScenario(snapshot);
	const happyPath = await runHappyPath(snapshot);
	if (!happyPath.passed) {
		throw new RuntimeLifecycleFaultLabError(
			"happy_path_failed",
			`Lifecycle fault happy path violates invariants: ${happyPath.violations.join("; ")}`,
		);
	}
	const cases: RuntimeLifecycleFaultCaseReport[] = [];
	for (let stepIndex = 0; stepIndex < snapshot.steps.length; stepIndex++) {
		for (const phase of ["before-persist", "after-persist"] as const) {
			cases.push(
				await runFaultCase(snapshot, {
					stepIndex,
					eventType: eventType(snapshot.steps[stepIndex]!),
					phase,
				}),
			);
		}
	}
	const firstFailedCase = cases.find((entry) => !entry.passed);
	return {
		version: RUNTIME_LIFECYCLE_FAULT_LAB_VERSION,
		scenarioId: snapshot.id,
		passed: firstFailedCase === undefined,
		happyPath,
		cases,
		...(firstFailedCase
			? {
					firstFailure: {
						fault: firstFailedCase.fault,
						violations: firstFailedCase.violations,
					},
				}
			: {}),
	};
}

/** Canonical event matrix used by the tracked repository gate. */
export function createCoreRuntimeLifecycleFaultScenario(): RuntimeLifecycleFaultScenario {
	return {
		version: RUNTIME_LIFECYCLE_FAULT_LAB_VERSION,
		id: "core-runtime-boundaries",
		steps: [
			{
				kind: "event",
				event: {
					type: "queue_enqueued",
					queueItemId: "queue-consumed",
					queue: "steer",
					message: { role: "user", content: "consumed input" },
				},
			},
			{
				kind: "event",
				event: {
					type: "queue_enqueued",
					queueItemId: "queue-preserved",
					queue: "follow_up",
					message: { role: "user", content: "preserved input" },
				},
			},
			{
				kind: "event",
				event: {
					type: "pending_write_enqueued",
					pendingWriteId: "write-applied",
					targetEntryId: "entry-applied",
					write: { type: "custom", data: "applied" },
				},
			},
			{
				kind: "event",
				event: {
					type: "pending_write_enqueued",
					pendingWriteId: "write-preserved",
					targetEntryId: "entry-preserved",
					write: { type: "custom", data: "preserved" },
				},
			},
			{
				kind: "event",
				event: { type: "operation_started", operationId: "operation-turn", kind: "turn" },
			},
			{
				kind: "event",
				event: {
					type: "turn_started",
					turnId: "turn-main",
					operationId: "operation-turn",
					consumedQueueItemIds: ["queue-consumed"],
				},
			},
			{
				kind: "event",
				event: {
					type: "provider_request_started",
					requestId: "request-main",
					turnId: "turn-main",
					provider: "faux",
					modelId: "fault-lab",
				},
			},
			{
				kind: "event",
				event: { type: "provider_request_finished", requestId: "request-main" },
			},
			{
				kind: "event",
				event: {
					type: "tool_call_started",
					toolCallId: "tool-safe",
					turnId: "turn-main",
					toolName: "read",
					retrySafe: true,
				},
			},
			{
				kind: "event",
				event: { type: "tool_call_finished", toolCallId: "tool-safe" },
			},
			{
				kind: "event",
				event: {
					type: "tool_call_started",
					toolCallId: "tool-unsafe",
					turnId: "turn-main",
					toolName: "deploy",
					retrySafe: false,
				},
			},
			{
				kind: "event",
				event: { type: "tool_call_finished", toolCallId: "tool-unsafe" },
			},
			{
				kind: "event",
				event: { type: "turn_finished", turnId: "turn-main" },
			},
			{
				kind: "event",
				event: { type: "operation_finished", operationId: "operation-turn" },
			},
			{
				kind: "event",
				event: {
					type: "pending_write_applied",
					pendingWriteId: "write-applied",
					targetEntryId: "entry-applied",
				},
			},
			{
				kind: "event",
				event: {
					type: "queue_discarded",
					queueItemId: "queue-preserved",
					reason: "happy_path_cleanup",
				},
			},
			{
				kind: "event",
				event: { type: "operation_started", operationId: "operation-retry", kind: "retry" },
			},
			{
				kind: "event",
				event: {
					type: "turn_started",
					turnId: "turn-retry",
					operationId: "operation-retry",
					consumedQueueItemIds: [],
				},
			},
			{
				kind: "event",
				event: {
					type: "provider_request_started",
					requestId: "request-retry",
					turnId: "turn-retry",
					provider: "faux",
					modelId: "fault-lab",
				},
			},
			{
				kind: "event",
				event: {
					type: "provider_request_failed",
					requestId: "request-retry",
					reason: "scripted_failure",
				},
			},
			{
				kind: "event",
				event: { type: "turn_finished", turnId: "turn-retry" },
			},
			{
				kind: "event",
				event: { type: "operation_finished", operationId: "operation-retry" },
			},
			{
				kind: "event",
				event: { type: "operation_started", operationId: "operation-compact", kind: "compaction" },
			},
			{
				kind: "event",
				event: { type: "operation_finished", operationId: "operation-compact" },
			},
			{ kind: "checkpoint" },
		],
	};
}
