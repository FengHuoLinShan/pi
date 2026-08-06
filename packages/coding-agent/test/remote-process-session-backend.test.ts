import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/core/artifact-store.ts";
import { ProcessSessionManager } from "../src/core/process-session.ts";
import {
	REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION,
	type RemoteProcessExecutorTransport,
	type RemoteProcessReplayRequest,
	RemoteProcessSessionBackend,
	type RemoteProcessStartRequest,
	type RemoteProcessStatusRequest,
	type RemoteProcessTerminateRequest,
} from "../src/core/remote-process-session-backend.ts";

interface FakeEvent {
	type: "output" | "exit";
	cursor: number;
	stream?: "stdout" | "stderr";
	dataBase64?: string;
	exit?: { exitCode: number | null; signal?: string; error?: string };
}

interface FakeRemoteProcess {
	events: FakeEvent[];
	terminated: boolean;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for remote process state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

class FakeRemoteTransport implements RemoteProcessExecutorTransport {
	readonly processes = new Map<string, FakeRemoteProcess>();
	readonly replayRequests: RemoteProcessReplayRequest[] = [];
	readonly startRequests: RemoteProcessStartRequest[] = [];
	readonly terminateRequests: RemoteProcessTerminateRequest[] = [];
	readonly descriptor = {
		protocolVersion: REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION,
		executorId: "fake-executor",
		instanceId: "instance-1",
		capabilities: {
			durableHandles: true,
			cursorReplay: true,
			cancellation: true,
			maxReplayEvents: 100,
			maxOutputChunkBytes: 1_024,
		},
	} as const;
	private readonly handleByStartKey = new Map<string, string>();
	private readonly handleByTerminateKey = new Map<string, string>();
	private nextHandle = 0;

	async negotiate(): Promise<unknown> {
		return this.descriptor;
	}

	async start(request: RemoteProcessStartRequest): Promise<unknown> {
		this.startRequests.push({
			...request,
			args: [...request.args],
			env: { ...request.env },
		});
		expect(request.protocolVersion).toBe(REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION);
		expect(request.idempotencyKey).toMatch(/^[0-9a-f-]+$/);
		const existingHandleId = this.handleByStartKey.get(request.idempotencyKey);
		if (existingHandleId) return { handleId: existingHandleId, cursor: 0 };
		const handleId = `remote-${this.nextHandle++}`;
		this.handleByStartKey.set(request.idempotencyKey, handleId);
		this.processes.set(handleId, { events: [], terminated: false });
		return { handleId, cursor: 0 };
	}

	async replay(request: RemoteProcessReplayRequest): Promise<unknown> {
		this.replayRequests.push({ ...request });
		const process = this.processes.get(request.handleId);
		if (!process) throw new Error("remote handle unavailable");
		const events = process.events.filter((event) => event.cursor > request.afterCursor).slice(0, request.limit);
		const nextCursor = events.at(-1)?.cursor ?? request.afterCursor;
		const hasMore = process.events.some((event) => event.cursor > nextCursor);
		const terminal = events.at(-1)?.type === "exit";
		return {
			events,
			nextCursor,
			hasMore,
			state: terminal ? "exited" : "running",
		};
	}

	async status(request: RemoteProcessStatusRequest): Promise<unknown> {
		const process = this.processes.get(request.handleId);
		if (!process) return { state: "unavailable" };
		const exit = process.events.find((event) => event.type === "exit");
		return exit ? { state: "exited", exit: exit.exit } : { state: "running" };
	}

	async terminate(request: RemoteProcessTerminateRequest): Promise<unknown> {
		this.terminateRequests.push({ ...request });
		const existingHandleId = this.handleByTerminateKey.get(request.idempotencyKey);
		if (existingHandleId !== undefined) {
			if (existingHandleId !== request.handleId) throw new Error("termination key reused for another handle");
			return { accepted: true };
		}
		const process = this.processes.get(request.handleId);
		if (!process) throw new Error("remote handle unavailable");
		this.handleByTerminateKey.set(request.idempotencyKey, request.handleId);
		process.terminated = true;
		this.exit(request.handleId, null, "SIGTERM");
		return { accepted: true };
	}

	output(handleId: string, content: string, stream: "stdout" | "stderr" = "stdout"): void {
		const process = this.processes.get(handleId);
		if (!process) throw new Error("remote handle unavailable");
		process.events.push({
			type: "output",
			cursor: process.events.length + 1,
			stream,
			dataBase64: Buffer.from(content).toString("base64"),
		});
	}

	exit(handleId: string, exitCode: number | null, signal?: string): void {
		const process = this.processes.get(handleId);
		if (!process) throw new Error("remote handle unavailable");
		process.events.push({
			type: "exit",
			cursor: process.events.length + 1,
			exit: { exitCode, ...(signal ? { signal } : {}) },
		});
	}
}

async function createStores(): Promise<{ directory: string; artifactStore: ArtifactStore; root: string }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-remote-process-"));
	temporaryDirectories.push(directory);
	const artifactStore = (await ArtifactStore.open({ root: join(directory, "artifacts"), allowedRoots: [directory] }))
		.store;
	return { directory, artifactStore, root: join(directory, "processes") };
}

describe("RemoteProcessSessionBackend", () => {
	it("replays only unconsumed remote events after a client restart", async () => {
		const stores = await createStores();
		const transport = new FakeRemoteTransport();
		const firstBackend = await RemoteProcessSessionBackend.connect(transport, {
			pollIntervalMs: 10,
			environmentAllowlist: ["ALLOWED"],
		});
		const first = await ProcessSessionManager.open({
			root: stores.root,
			allowedRoots: [stores.directory],
			artifactStore: stores.artifactStore,
			backend: firstBackend,
		});
		const started = await first.manager.start({
			command: "remote-command",
			env: { ALLOWED: "yes", HOST_SECRET: "must-not-leave-host" },
		});
		expect(transport.startRequests[0]?.env).toEqual({ ALLOWED: "yes" });
		expect(started).toMatchObject({ state: "running" });
		expect(first.manager.getEvents(started.id)[0]).toMatchObject({ environmentNames: ["ALLOWED"] });
		const handleId = started.backendHandle!.id;
		transport.output(handleId, "one");
		await waitUntil(() => first.manager.status(started.id).outputs.length === 1);
		await first.manager.flush();
		expect(first.manager.status(started.id).backendHandle?.cursor).toBe(1);
		firstBackend.close();

		transport.output(handleId, "two");
		transport.exit(handleId, 0);
		const secondBackend = await RemoteProcessSessionBackend.connect(transport, { pollIntervalMs: 10 });
		const second = await ProcessSessionManager.open({
			root: stores.root,
			allowedRoots: [stores.directory],
			artifactStore: stores.artifactStore,
			backend: secondBackend,
		});
		expect(second.recovery.reattached).toEqual([started.id]);
		const exited = await second.manager.waitForExit(started.id);
		await second.manager.flush();

		expect(exited).toMatchObject({ state: "exited", exit: { exitCode: 0 } });
		expect(exited.backendHandle?.cursor).toBe(3);
		expect((await second.manager.readOutput(started.id)).toString()).toBe("onetwo");
		expect(second.manager.getEvents(started.id).filter((event) => event.type === "process_output")).toHaveLength(2);
		secondBackend.close();
	});

	it("routes cancellation through an idempotent remote termination request", async () => {
		const stores = await createStores();
		const transport = new FakeRemoteTransport();
		const backend = await RemoteProcessSessionBackend.connect(transport, { pollIntervalMs: 10 });
		const { manager } = await ProcessSessionManager.open({
			root: stores.root,
			artifactStore: stores.artifactStore,
			backend,
		});
		const started = await manager.start({ command: "remote-command" });
		await manager.terminate(started.id);
		const terminated = await manager.waitForExit(started.id);

		expect(terminated).toMatchObject({ state: "terminated", exit: { signal: "SIGTERM" } });
		expect(transport.processes.get(started.backendHandle!.id)?.terminated).toBe(true);
		expect(transport.terminateRequests).toHaveLength(1);
		expect(transport.terminateRequests[0]?.idempotencyKey).toMatch(/^[0-9a-f-]+$/);
		backend.close();
	});

	it("recovers an ambiguous termination response with the same idempotency key", async () => {
		const transport = new FakeRemoteTransport();
		const terminate = transport.terminate.bind(transport);
		let loseFirstResponse = true;
		transport.terminate = async (request) => {
			const response = await terminate(request);
			if (loseFirstResponse) {
				loseFirstResponse = false;
				throw new Error("response lost after remote termination");
			}
			return response;
		};
		const backend = await RemoteProcessSessionBackend.connect(transport, {
			pollIntervalMs: 10,
			maxConsecutiveTransportFailures: 2,
		});
		const handle = await backend.start(
			{ command: "remote-command", args: [], cwd: "/remote", env: {} },
			{ onOutput: () => {}, onExit: () => {} },
		);

		await backend.terminate(handle);

		expect(transport.terminateRequests).toHaveLength(2);
		expect(transport.terminateRequests[1]?.idempotencyKey).toBe(transport.terminateRequests[0]?.idempotencyKey);
		expect(transport.processes.get(handle.id)?.events.filter((event) => event.type === "exit")).toHaveLength(1);
		backend.close();
	});

	it("recovers an ambiguous start response with the same idempotency key", async () => {
		const transport = new FakeRemoteTransport();
		const start = transport.start.bind(transport);
		let loseFirstResponse = true;
		transport.start = async (request) => {
			const response = await start(request);
			if (loseFirstResponse) {
				loseFirstResponse = false;
				throw new Error("response lost after remote start");
			}
			return response;
		};
		const backend = await RemoteProcessSessionBackend.connect(transport, {
			pollIntervalMs: 10,
			maxConsecutiveTransportFailures: 2,
		});
		const handle = await backend.start(
			{ command: "remote-command", args: [], cwd: "/remote", env: {} },
			{ onOutput: () => {}, onExit: () => {} },
		);

		expect(handle.id).toBe("remote-0");
		expect(transport.startRequests).toHaveLength(2);
		expect(transport.startRequests[1]?.idempotencyKey).toBe(transport.startRequests[0]?.idempotencyKey);
		expect(transport.processes.size).toBe(1);
		backend.close();
	});

	it("bounds retries when a remote start outcome stays unknown", async () => {
		const transport = new FakeRemoteTransport();
		transport.start = async (request) => {
			transport.startRequests.push({ ...request, args: [...request.args], env: { ...request.env } });
			throw new Error("connection lost");
		};
		const backend = await RemoteProcessSessionBackend.connect(transport, {
			pollIntervalMs: 10,
			maxConsecutiveTransportFailures: 2,
		});

		await expect(
			backend.start(
				{ command: "remote-command", args: [], cwd: "/remote", env: {} },
				{ onOutput: () => {}, onExit: () => {} },
			),
		).rejects.toThrow("start outcome remained unknown after 2 idempotent attempt(s)");
		expect(transport.startRequests).toHaveLength(2);
		expect(transport.startRequests[1]?.idempotencyKey).toBe(transport.startRequests[0]?.idempotencyKey);
	});

	it("does not advance replay until the durable callback acknowledges an event", async () => {
		const transport = new FakeRemoteTransport();
		const backend = await RemoteProcessSessionBackend.connect(transport, { pollIntervalMs: 10 });
		const outputs: string[] = [];
		let releaseOutput: (() => void) | undefined;
		const outputReleased = new Promise<void>((resolve) => {
			releaseOutput = resolve;
		});
		let exited = false;
		const handle = await backend.start(
			{ command: "remote-command", args: [], cwd: "/remote", env: { HOST_SECRET: "must-not-leave-host" } },
			{
				onOutput: async (_stream, chunk) => {
					outputs.push(chunk.toString());
					if (outputs.length === 1) await outputReleased;
				},
				onExit: () => {
					exited = true;
				},
			},
		);
		expect(transport.startRequests[0]?.env).toEqual({});
		transport.output(handle.id, "one");
		await waitUntil(() => outputs.length === 1);
		transport.output(handle.id, "two");
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(outputs).toEqual(["one"]);
		expect(transport.replayRequests.at(-1)?.afterCursor).toBe(0);

		releaseOutput?.();
		transport.exit(handle.id, 0);
		await waitUntil(() => exited);
		expect(outputs).toEqual(["one", "two"]);
		backend.close();
	});

	it("bounds aggregate output in one replay page", async () => {
		const transport = new FakeRemoteTransport();
		transport.negotiate = async () => ({
			...transport.descriptor,
			capabilities: {
				...transport.descriptor.capabilities,
				maxOutputChunkBytes: 1024 * 1024,
			},
		});
		const chunk = Buffer.alloc(1024 * 1024).toString("base64");
		transport.replay = async (request) => {
			transport.replayRequests.push({ ...request });
			const events = Array.from({ length: 9 }, (_, index) => ({
				type: "output",
				cursor: request.afterCursor + index + 1,
				stream: "stdout",
				dataBase64: chunk,
			}));
			return {
				events,
				nextCursor: request.afterCursor + events.length,
				hasMore: false,
				state: "running",
			};
		};
		const backend = await RemoteProcessSessionBackend.connect(transport, { pollIntervalMs: 10 });
		let error: string | undefined;
		await backend.start(
			{ command: "remote-command", args: [], cwd: "/remote", env: {} },
			{
				onOutput: () => {
					throw new Error("oversized replay must not emit partial output");
				},
				onExit: (exit) => {
					error = exit.error;
				},
			},
		);
		await waitUntil(() => error !== undefined);

		expect(error).toContain("aggregate output limit");
		backend.close();
	});

	it("fails negotiation and sessions closed on protocol or replay cursor violations", async () => {
		const invalidTransport = new FakeRemoteTransport();
		invalidTransport.negotiate = async () => ({
			...invalidTransport.descriptor,
			capabilities: { ...invalidTransport.descriptor.capabilities, cursorReplay: false },
		});
		await expect(RemoteProcessSessionBackend.connect(invalidTransport)).rejects.toMatchObject({
			code: "negotiation_failed",
		});
		invalidTransport.negotiate = async () => ({
			...invalidTransport.descriptor,
			capabilities: { ...invalidTransport.descriptor.capabilities, maxOutputChunkBytes: 2 * 1024 * 1024 },
		});
		await expect(RemoteProcessSessionBackend.connect(invalidTransport)).rejects.toMatchObject({
			code: "negotiation_failed",
		});

		const stores = await createStores();
		const transport = new FakeRemoteTransport();
		transport.replay = async (request) => ({
			events: [
				{
					type: "output",
					cursor: request.afterCursor + 2,
					stream: "stdout",
					dataBase64: Buffer.from("gap").toString("base64"),
				},
			],
			nextCursor: request.afterCursor + 2,
			hasMore: false,
			state: "running",
		});
		const backend = await RemoteProcessSessionBackend.connect(transport, { pollIntervalMs: 10 });
		const { manager } = await ProcessSessionManager.open({
			root: stores.root,
			artifactStore: stores.artifactStore,
			backend,
		});
		const started = await manager.start({ command: "remote-command" });
		await waitUntil(() => manager.status(started.id).state === "failed");

		expect(manager.status(started.id).error).toContain("cursor gap");
		expect(manager.status(started.id).outputs).toEqual([]);
		backend.close();
	});

	it("rejects replay pages that claim more data without cursor progress", async () => {
		const stores = await createStores();
		const transport = new FakeRemoteTransport();
		transport.replay = async (request) => {
			transport.replayRequests.push({ ...request });
			return {
				events: [],
				nextCursor: request.afterCursor,
				hasMore: true,
				state: "running",
			};
		};
		const backend = await RemoteProcessSessionBackend.connect(transport, { pollIntervalMs: 10 });
		const { manager } = await ProcessSessionManager.open({
			root: stores.root,
			artifactStore: stores.artifactStore,
			backend,
		});
		const started = await manager.start({ command: "remote-command" });
		await waitUntil(() => manager.status(started.id).state === "failed");

		expect(manager.status(started.id).error).toContain("without progress");
		backend.close();
	});
});
