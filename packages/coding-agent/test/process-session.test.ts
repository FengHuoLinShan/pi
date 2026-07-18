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

describe("ProcessSessionManager", () => {
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
