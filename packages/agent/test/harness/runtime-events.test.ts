import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { SessionRuntimeEventStore } from "../../src/harness/runtime-events/event-store.ts";
import {
	createRuntimeRecoveryState,
	planRuntimeRecovery,
	reduceRuntimeEvent,
	replayRuntimeEvents,
} from "../../src/harness/runtime-events/reducer.ts";
import {
	RUNTIME_EVENT_VERSION,
	type RuntimeEvent,
	type RuntimeEventEnvelope,
} from "../../src/harness/runtime-events/types.ts";
import { JsonlSessionStorage } from "../../src/harness/session/jsonl-storage.ts";
import { InMemorySessionRepo } from "../../src/harness/session/memory-repo.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { createTempDir } from "./session-test-utils.ts";

function envelope(sequence: number, event: RuntimeEvent): RuntimeEventEnvelope {
	return {
		version: RUNTIME_EVENT_VERSION,
		eventId: `event-${sequence}`,
		sequence,
		timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		sessionId: "session-1",
		event,
	};
}

function createIdFactory(): () => string {
	let next = 0;
	return () => `id-${++next}`;
}

describe("runtime event reducer", () => {
	it("ties queue consumption to a durable turn start", () => {
		let state = createRuntimeRecoveryState("session-1");
		state = reduceRuntimeEvent(
			state,
			envelope(1, { type: "queue_enqueued", queueItemId: "queue-1", queue: "steer", message: "fix it" }),
		);
		state = reduceRuntimeEvent(
			state,
			envelope(2, { type: "operation_started", operationId: "operation-1", kind: "turn" }),
		);
		state = reduceRuntimeEvent(
			state,
			envelope(3, {
				type: "turn_started",
				turnId: "turn-1",
				operationId: "operation-1",
				consumedQueueItemIds: ["queue-1"],
			}),
		);
		expect(state.queueItems["queue-1"]).toMatchObject({
			status: "consumed",
			consumedByTurnId: "turn-1",
			consumedSequence: 3,
		});
		expect(state.turns["turn-1"]?.status).toBe("active");
	});

	it("rejects sequence gaps and invalid causal transitions", () => {
		const empty = createRuntimeRecoveryState("session-1");
		expect(() =>
			reduceRuntimeEvent(
				empty,
				envelope(2, { type: "operation_started", operationId: "operation-1", kind: "turn" }),
			),
		).toThrow("Expected runtime event sequence 1");
		expect(() => reduceRuntimeEvent(empty, envelope(1, { type: "turn_finished", turnId: "missing" }))).toThrow(
			"Turn missing does not exist",
		);
	});

	it("replays from a checkpoint and continues reducing", () => {
		const first = envelope(1, { type: "operation_started", operationId: "operation-1", kind: "turn" });
		const stateAtFirst = reduceRuntimeEvent(createRuntimeRecoveryState("session-1"), first);
		const checkpoint = envelope(2, { type: "checkpoint", throughSequence: 1, state: stateAtFirst });
		const finished = envelope(3, { type: "operation_finished", operationId: "operation-1" });
		const replayed = replayRuntimeEvents("session-1", [first, checkpoint, finished]);
		expect(replayed.lastSequence).toBe(3);
		expect(replayed.operations["operation-1"]?.status).toBe("finished");
	});

	it("rejects a checkpoint whose nested snapshot does not match replayed history", () => {
		const first = envelope(1, {
			type: "queue_enqueued",
			queueItemId: "queue-1",
			queue: "steer",
			message: "original",
		});
		const stateAtFirst = reduceRuntimeEvent(createRuntimeRecoveryState("session-1"), first);
		const checkpoint = envelope(2, {
			type: "checkpoint",
			throughSequence: 1,
			state: {
				...stateAtFirst,
				queueItems: {
					...stateAtFirst.queueItems,
					"queue-1": { ...stateAtFirst.queueItems["queue-1"]!, message: "tampered" },
				},
			},
		});

		expect(() => replayRuntimeEvents("session-1", [first, checkpoint])).toThrow(
			"Checkpoint snapshot does not match the replayed state",
		);
	});

	it("plans conservative recovery without consuming queues or retrying tools", () => {
		const events: RuntimeEvent[] = [
			{ type: "queue_enqueued", queueItemId: "queue-1", queue: "follow_up", message: "next" },
			{
				type: "pending_write_enqueued",
				pendingWriteId: "write-1",
				targetEntryId: "entry-1",
				write: { type: "message" },
			},
			{ type: "operation_started", operationId: "operation-1", kind: "turn" },
			{ type: "turn_started", turnId: "turn-1", operationId: "operation-1", consumedQueueItemIds: [] },
			{
				type: "provider_request_started",
				requestId: "request-1",
				turnId: "turn-1",
				provider: "deepseek",
				modelId: "v4-flash",
			},
			{
				type: "tool_call_started",
				toolCallId: "safe-call",
				turnId: "turn-1",
				toolName: "read",
				retrySafe: true,
			},
			{
				type: "tool_call_started",
				toolCallId: "unsafe-call",
				turnId: "turn-1",
				toolName: "deploy",
				retrySafe: false,
			},
		];
		let state = createRuntimeRecoveryState("session-1");
		for (let i = 0; i < events.length; i++) state = reduceRuntimeEvent(state, envelope(i + 1, events[i]!));
		const plan = planRuntimeRecovery(state, { recoveryId: "recovery-1" });
		expect(plan.preservedQueueItemIds).toEqual(["queue-1"]);
		expect(plan.pendingWriteIds).toEqual(["write-1"]);
		expect(plan.retryableToolCallIds).toEqual(["safe-call"]);
		expect(plan.events.map((event) => event.type)).toEqual([
			"recovery_started",
			"provider_request_interrupted",
			"tool_call_interrupted",
			"tool_call_interrupted",
			"turn_interrupted",
			"operation_interrupted",
		]);
	});
});

describe("SessionRuntimeEventStore", () => {
	it("serializes concurrent appends and restores state from session entries", async () => {
		const storage = new InMemorySessionStorage({
			metadata: { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" },
		});
		const session = new Session(storage);
		const store = await SessionRuntimeEventStore.open(session, { createId: createIdFactory() });
		const [first, second] = await Promise.all([
			store.append({ type: "queue_enqueued", queueItemId: "queue-1", queue: "steer", message: "one" }),
			store.append({ type: "queue_enqueued", queueItemId: "queue-2", queue: "follow_up", message: "two" }),
		]);
		expect([first.sequence, second.sequence]).toEqual([1, 2]);
		await store.appendCheckpoint();

		const restored = await SessionRuntimeEventStore.open(new Session(storage));
		expect(restored.getState().lastSequence).toBe(3);
		expect(Object.keys(restored.getState().queueItems)).toEqual(["queue-1", "queue-2"]);
	});

	it("marks unfinished work interrupted and preserves recovery inputs", async () => {
		const session = new Session(
			new InMemorySessionStorage({
				metadata: { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" },
			}),
		);
		const store = await SessionRuntimeEventStore.open(session, { createId: createIdFactory() });
		await store.append({ type: "queue_enqueued", queueItemId: "queue-1", queue: "next_turn", message: "next" });
		await store.append({
			type: "pending_write_enqueued",
			pendingWriteId: "write-1",
			targetEntryId: "entry-1",
			write: { type: "custom" },
		});
		await store.append({ type: "operation_started", operationId: "operation-1", kind: "turn" });
		await store.append({
			type: "turn_started",
			turnId: "turn-1",
			operationId: "operation-1",
			consumedQueueItemIds: [],
		});
		await store.append({
			type: "tool_call_started",
			toolCallId: "tool-1",
			turnId: "turn-1",
			toolName: "read",
			retrySafe: true,
		});

		const recovery = await store.recover({ recoveryId: "recovery-1", reason: "crash" });
		expect(recovery.plan.preservedQueueItemIds).toEqual(["queue-1"]);
		expect(recovery.plan.pendingWriteIds).toEqual(["write-1"]);
		expect(recovery.plan.retryableToolCallIds).toEqual(["tool-1"]);
		expect(store.getState().toolCalls["tool-1"]?.status).toBe("interrupted");
		expect(store.getState().turns["turn-1"]?.status).toBe("interrupted");
		expect(store.getState().operations["operation-1"]?.status).toBe("interrupted");
	});

	it("round-trips canonical runtime events through JSONL session storage", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const store = await SessionRuntimeEventStore.open(new Session(storage), { createId: createIdFactory() });
		await store.append({ type: "operation_started", operationId: "operation-1", kind: "compaction" });

		const reopenedStorage = await JsonlSessionStorage.open(env, filePath);
		const reopened = await SessionRuntimeEventStore.open(new Session(reopenedStorage));
		expect(reopened.getEvents()).toHaveLength(1);
		expect(reopened.getState().operations["operation-1"]?.kind).toBe("compaction");
	});

	it("keeps inherited source events historical when a session is forked", async () => {
		const repo = new InMemorySessionRepo();
		const source = await repo.create({ id: "source-session" });
		const sourceStore = await SessionRuntimeEventStore.open(source, { createId: createIdFactory() });
		await sourceStore.append({ type: "queue_enqueued", queueItemId: "source-queue", queue: "steer", message: "old" });
		const fork = await repo.fork(await source.getMetadata(), { id: "fork-session" });

		const forkStore = await SessionRuntimeEventStore.open(fork, { createId: createIdFactory() });
		expect(forkStore.getEvents()).toEqual([]);
		const firstForkEvent = await forkStore.append({
			type: "queue_enqueued",
			queueItemId: "fork-queue",
			queue: "steer",
			message: "new",
		});
		expect(firstForkEvent.sequence).toBe(1);
		expect(firstForkEvent.sessionId).toBe("fork-session");
	});
});
