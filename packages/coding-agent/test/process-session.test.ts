import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/core/artifact-store.ts";
import {
	type BoundaryEnforcementCapabilities,
	type BoundaryProfile,
	createBoundaryProfileDigest,
	type ExecutionBoundary,
} from "../src/core/execution-boundary.ts";
import {
	NodeProcessSessionBackend,
	type ProcessBackendCallbacks,
	type ProcessBackendHandle,
	type ProcessBackendStartRequest,
	type ProcessBackendStatus,
	type ProcessSessionBackend,
	ProcessSessionManager,
} from "../src/core/process-session.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-process-session-"));
	tempDirectories.push(directory);
	return directory;
}

async function createArtifactStore(directory: string): Promise<ArtifactStore> {
	return (await ArtifactStore.open({ root: join(directory, "artifacts"), allowedRoots: [directory] })).store;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeProcessBackend implements ProcessSessionBackend {
	readonly id: string;
	readonly boundaryBinding?: { backendId: string; profileDigest: string };
	lastStart: ProcessBackendStartRequest | undefined;
	private readonly handles = new Map<string, ProcessBackendCallbacks>();
	private readonly canAttach: boolean;
	private nextHandle = 0;

	constructor(options?: {
		id?: string;
		canAttach?: boolean;
		boundaryBinding?: { backendId: string; profileDigest: string };
	}) {
		this.id = options?.id ?? "fake-process-backend";
		this.canAttach = options?.canAttach ?? true;
		this.boundaryBinding = options?.boundaryBinding;
	}

	async start(request: ProcessBackendStartRequest, callbacks: ProcessBackendCallbacks): Promise<ProcessBackendHandle> {
		this.lastStart = { ...request, args: [...request.args], env: { ...request.env } };
		const id = `fake-${this.nextHandle++}`;
		this.handles.set(id, callbacks);
		return { id };
	}

	async attach(handle: ProcessBackendHandle, callbacks: ProcessBackendCallbacks): Promise<boolean> {
		if (!this.canAttach || !this.handles.has(handle.id)) return false;
		this.handles.set(handle.id, callbacks);
		return true;
	}

	async status(handle: ProcessBackendHandle): Promise<ProcessBackendStatus> {
		return this.handles.has(handle.id) ? { state: "running" } : { state: "unavailable" };
	}

	async terminate(handle: ProcessBackendHandle): Promise<void> {
		const callbacks = this.handles.get(handle.id);
		if (!callbacks) throw new Error(`Unknown fake handle: ${handle.id}`);
		this.handles.delete(handle.id);
		callbacks.onExit({ exitCode: null, signal: "SIGKILL" });
	}

	emit(handle: ProcessBackendHandle, stream: "stdout" | "stderr", content: string): void {
		const callbacks = this.handles.get(handle.id);
		if (!callbacks) throw new Error(`Unknown fake handle: ${handle.id}`);
		callbacks.onOutput(stream, Buffer.from(content));
	}
}

class EagerOutputBackend extends FakeProcessBackend {
	acknowledgedDuringStart: boolean | undefined;
	outputAcknowledgment: Promise<void> | undefined;

	override async start(
		request: ProcessBackendStartRequest,
		callbacks: ProcessBackendCallbacks,
	): Promise<ProcessBackendHandle> {
		const handle = await super.start(request, callbacks);
		let acknowledged = false;
		this.outputAcknowledgment = Promise.resolve(callbacks.onOutput("stdout", Buffer.from("eager"), 1)).then(() => {
			acknowledged = true;
		});
		await Promise.resolve();
		this.acknowledgedDuringStart = acknowledged;
		return handle;
	}
}

describe("ProcessSessionManager", () => {
	it("does not acknowledge eager backend output before persisting process start", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const backend = new EagerOutputBackend();
		const { manager } = await ProcessSessionManager.open({
			root: join(directory, "processes"),
			allowedRoots: [directory],
			artifactStore,
			backend,
		});

		const started = await manager.start({ command: "fake" });
		await backend.outputAcknowledgment;
		await manager.flush();

		expect(backend.acknowledgedDuringStart).toBe(false);
		expect(started.backendHandle?.cursor).toBe(1);
		expect((await manager.readOutput(started.id)).toString()).toBe("eager");
	});

	it("treats termination of an owned process that already exited as successful cleanup", async () => {
		const backend = new NodeProcessSessionBackend();
		let resolveExit: (() => void) | undefined;
		const exited = new Promise<void>((resolvePromise) => {
			resolveExit = resolvePromise;
		});
		const handle = await backend.start(
			{ command: process.execPath, args: ["-e", ""], cwd: process.cwd(), env: process.env },
			{
				onOutput: () => {},
				onExit: () => resolveExit?.(),
			},
		);

		await exited;

		await expect(backend.terminate(handle)).resolves.toBeUndefined();
	});

	it("persists local process output as artifact references and records exit", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const root = join(directory, "processes");
		const { manager } = await ProcessSessionManager.open({
			root,
			allowedRoots: [directory],
			artifactStore,
			defaultCwd: directory,
		});
		const secretOutput = "output-value-not-in-event-log";

		const started = await manager.start({
			command: process.execPath,
			args: ["-e", "process.stdout.write(process.env.PI_PROCESS_TEST_OUTPUT); process.stderr.write('stderr');"],
			env: { PI_PROCESS_TEST_OUTPUT: secretOutput },
		});
		const exited = await manager.waitForExit(started.id);
		await manager.flush();

		expect(exited.state).toBe("exited");
		expect(exited.exit?.exitCode).toBe(0);
		expect((await manager.readOutput(started.id, "stdout")).toString()).toBe(secretOutput);
		expect((await manager.readOutput(started.id, "stderr")).toString()).toBe("stderr");
		expect(exited.outputs.every((output) => output.artifact.startsWith("sha256:"))).toBe(true);
		const eventLog = await readFile(join(root, "process-sessions.jsonl"), "utf8");
		expect(eventLog).not.toContain(secretOutput);
		expect(eventLog).toContain('"type":"process_output"');
		expect(eventLog).toContain('"artifact":"sha256:');
	});

	it("reattaches through a capable backend and persists explicit termination", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const root = join(directory, "processes");
		const backend = new FakeProcessBackend();
		const first = await ProcessSessionManager.open({ root, artifactStore, backend });
		const started = await first.manager.start({ command: "fake" });
		if (!started.backendHandle) throw new Error("Expected fake backend handle");
		backend.emit(started.backendHandle, "stdout", "before attach");
		await first.manager.flush();

		const second = await ProcessSessionManager.open({ root, artifactStore, backend });
		expect(second.recovery.reattached).toEqual([started.id]);
		expect(second.manager.status(started.id).state).toBe("running");
		await second.manager.terminate(started.id);
		const terminated = await second.manager.waitForExit(started.id);
		await second.manager.flush();

		expect(terminated.state).toBe("terminated");
		expect(terminated.exit).toMatchObject({ exitCode: null, signal: "SIGKILL" });
		expect((await second.manager.readOutput(started.id)).toString()).toBe("before attach");
		expect(second.manager.getEvents(started.id).map((event) => event.type)).toEqual([
			"process_created",
			"process_started",
			"process_output",
			"process_termination_requested",
			"process_exited",
		]);
	});

	it("marks unrecoverable active sessions interrupted and repairs a partial JSONL tail", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const root = join(directory, "processes");
		const firstBackend = new FakeProcessBackend();
		const first = await ProcessSessionManager.open({ root, artifactStore, backend: firstBackend });
		const started = await first.manager.start({ command: "fake" });
		await appendFile(join(root, "process-sessions.jsonl"), '{"partial":', "utf8");

		const reopened = await ProcessSessionManager.open({
			root,
			artifactStore,
			backend: new FakeProcessBackend({ canAttach: false }),
		});

		expect(reopened.recovery.invalidLines).toHaveLength(1);
		expect(reopened.recovery.interrupted).toEqual([started.id]);
		expect(reopened.manager.status(started.id)).toMatchObject({
			state: "interrupted",
			error: "backend cannot reattach the active process",
		});
		const repairedLog = await readFile(join(root, "process-sessions.jsonl"), "utf8");
		expect(repairedLog.endsWith("\n")).toBe(true);
		expect(repairedLog).not.toContain('{"partial":');
		expect(repairedLog).toContain('"type":"process_interrupted"');
	});

	it("fails and terminates a process at its durable output limit and reads bounded output tails", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const backend = new FakeProcessBackend();
		const { manager } = await ProcessSessionManager.open({
			root: join(directory, "processes"),
			artifactStore,
			backend,
			maxOutputBytesPerSession: 5,
		});
		const started = await manager.start({ command: "fake" });
		if (!started.backendHandle) throw new Error("Expected fake backend handle");

		backend.emit(started.backendHandle, "stdout", "1234567");
		await manager.flush();

		expect(manager.status(started.id)).toMatchObject({
			state: "failed",
			error: "Process output reached the configured 5 byte limit",
		});
		expect((await manager.readOutput(started.id)).toString()).toBe("12345");
		expect((await manager.readOutputTail(started.id, { maxBytes: 3 })).toString()).toBe("345");
		expect(await backend.status(started.backendHandle)).toEqual({ state: "unavailable" });
	});

	it("serializes termination after already queued output events", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const backend = new FakeProcessBackend();
		const { manager } = await ProcessSessionManager.open({
			root: join(directory, "processes"),
			artifactStore,
			backend,
		});
		const started = await manager.start({ command: "fake" });
		if (!started.backendHandle) throw new Error("Expected fake backend handle");

		backend.emit(started.backendHandle, "stdout", "queued");
		await manager.terminate(started.id);
		await manager.waitForExit(started.id);
		await manager.flush();

		expect(manager.status(started.id).state).toBe("terminated");
		expect(manager.getEvents(started.id).map((event) => event.type)).toEqual([
			"process_created",
			"process_started",
			"process_output",
			"process_termination_requested",
			"process_exited",
		]);
	});

	it("prunes terminal sessions, preserves shared output, and retains unknown journal lines", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const root = join(directory, "processes");
		const backend = new FakeProcessBackend();
		const first = await ProcessSessionManager.open({ root, artifactStore, backend });
		const pruned = await first.manager.start({
			id: "job-pruned",
			command: "fake",
			args: ["private-argument"],
		});
		const retained = await first.manager.start({ id: "job-retained", command: "fake" });
		if (!pruned.backendHandle || !retained.backendHandle) throw new Error("Expected fake backend handles");
		backend.emit(pruned.backendHandle, "stdout", "shared output");
		backend.emit(retained.backendHandle, "stdout", "shared output");
		await first.manager.flush();
		await first.manager.terminate(pruned.id);
		await first.manager.terminate(retained.id);
		await Promise.all([first.manager.waitForExit(pruned.id), first.manager.waitForExit(retained.id)]);
		await first.manager.flush();
		await appendFile(join(root, "process-sessions.jsonl"), '{"version":2,"future":true}\n', "utf8");

		const second = await ProcessSessionManager.open({ root, artifactStore, backend });
		expect(second.recovery.invalidLines).toHaveLength(1);
		expect(await second.manager.pruneTerminalSessions([pruned.id, pruned.id])).toEqual({
			processSessionIds: [pruned.id],
			artifacts: {
				processSessionIds: [pruned.id],
				metadataRecordsRemoved: 1,
				artifactsRemoved: 0,
			},
			artifactCleanupError: undefined,
		});
		expect(second.manager.get(pruned.id)).toBeUndefined();
		expect((await second.manager.readOutput(retained.id)).toString()).toBe("shared output");

		const eventLog = await readFile(join(root, "process-sessions.jsonl"), "utf8");
		expect(eventLog).not.toContain(pruned.id);
		expect(eventLog).not.toContain("private-argument");
		expect(eventLog).toContain(retained.id);
		expect(eventLog).toContain('{"version":2,"future":true}\n');

		const reopened = await ProcessSessionManager.open({ root, artifactStore, backend });
		expect(reopened.recovery).toMatchObject({ sessions: 1, invalidLines: [6] });
		expect(reopened.manager.get(pruned.id)).toBeUndefined();
		expect(reopened.manager.status(retained.id).state).toBe("terminated");
	});

	it("rejects pruning active sessions without changing their journal", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const root = join(directory, "processes");
		const backend = new FakeProcessBackend();
		const { manager } = await ProcessSessionManager.open({ root, artifactStore, backend });
		const started = await manager.start({ id: "job-active", command: "fake" });
		const before = await readFile(join(root, "process-sessions.jsonl"), "utf8");

		await expect(manager.pruneTerminalSessions([started.id])).rejects.toThrow(
			"Process session must be terminal before pruning: job-active (running)",
		);
		expect(await readFile(join(root, "process-sessions.jsonl"), "utf8")).toBe(before);
		expect(manager.status(started.id).state).toBe("running");

		await manager.terminate(started.id);
		await manager.waitForExit(started.id);
		await manager.flush();
	});

	it("rejects invalid process output limits", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);

		await expect(
			ProcessSessionManager.open({
				root: join(directory, "processes"),
				artifactStore,
				maxOutputBytesPerSession: 0,
			}),
		).rejects.toThrow("output limit must be a positive safe integer");
	});
});

describe("ProcessSessionManager execution boundary", () => {
	const profile: BoundaryProfile = {
		scope: "built-in-tools",
		workspace: {
			workingDirectory: "/sandbox/workspace",
			mounts: [{ source: "/host/workspace", target: "/sandbox/workspace", access: "read-write" }],
		},
		process: { mode: "isolated" },
		network: { mode: "deny" },
		environment: { allow: ["PI_ALLOWED"] },
	};
	const capabilities: BoundaryEnforcementCapabilities = {
		isolation: "remote-sandbox",
		workspace: { mountIsolation: true, accessModes: ["read-write"] },
		process: { modes: ["isolated"] },
		network: { modes: ["deny"] },
		environment: { allowlist: true },
	};
	const boundary: ExecutionBoundary = {
		profile,
		backend: {
			id: "sandbox-backend",
			operations: { bash: { exec: async () => ({ exitCode: 0 }) } },
			attest: () => ({
				backendId: "sandbox-backend",
				profileDigest: createBoundaryProfileDigest(profile),
				capabilities,
			}),
		},
	};

	it("fails closed without a backend bound to the exact attested profile", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const options = { root: join(directory, "processes"), artifactStore, executionBoundary: boundary };

		await expect(ProcessSessionManager.open(options)).rejects.toThrow("require an explicit durable process backend");
		await expect(ProcessSessionManager.open({ ...options, backend: new FakeProcessBackend() })).rejects.toThrow(
			"not bound to the attested execution boundary profile",
		);
	});

	it("uses the attested cwd and filters process environment before delegation", async () => {
		const directory = await createTempDirectory();
		const artifactStore = await createArtifactStore(directory);
		const backend = new FakeProcessBackend({
			boundaryBinding: {
				backendId: boundary.backend.id,
				profileDigest: createBoundaryProfileDigest(profile),
			},
		});
		const { manager } = await ProcessSessionManager.open({
			root: join(directory, "processes"),
			artifactStore,
			executionBoundary: boundary,
			backend,
		});

		await manager.start({
			command: "fake",
			env: { PI_ALLOWED: "allowed", PI_DENIED: "denied" },
		});
		expect(backend.lastStart?.cwd).toBe("/sandbox/workspace");
		expect(backend.lastStart?.env).toEqual({ PI_ALLOWED: "allowed" });
		await expect(manager.start({ command: "fake", cwd: "/sandbox/other" })).rejects.toThrow(
			"must be the attested working directory",
		);
	});
});
