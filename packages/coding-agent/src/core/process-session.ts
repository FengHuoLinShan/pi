import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import type { ArtifactRef, ArtifactStore } from "./artifact-store.ts";
import {
	createBoundaryProfileDigest,
	type ExecutionBoundary,
	filterBoundaryEnvironment,
	resolveExecutionBoundary,
} from "./execution-boundary.ts";
import { captureFilePathSnapshot, revalidateFilePathSnapshot } from "./tools/file-transaction.ts";

export type ProcessOutputStream = "stdout" | "stderr";
export type ProcessSessionState =
	| "created"
	| "running"
	| "terminating"
	| "exited"
	| "terminated"
	| "failed"
	| "interrupted";

export interface ProcessBackendHandle {
	id: string;
	pid?: number;
	metadata?: Record<string, string | number | boolean | null>;
}

export interface ProcessBackendExit {
	exitCode: number | null;
	signal?: string;
	error?: string;
}

export interface ProcessBackendStatus {
	state: "running" | "exited" | "unavailable";
	exit?: ProcessBackendExit;
}

export interface ProcessBackendCallbacks {
	onOutput: (stream: ProcessOutputStream, chunk: Buffer) => void;
	onExit: (exit: ProcessBackendExit) => void;
}

export interface ProcessBackendStartRequest {
	command: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface ProcessSessionBackend {
	id: string;
	/** Required when the backend is used through an ExecutionBoundary. */
	boundaryBinding?: {
		backendId: string;
		profileDigest: string;
	};
	start: (request: ProcessBackendStartRequest, callbacks: ProcessBackendCallbacks) => Promise<ProcessBackendHandle>;
	/** Returns false when the backend cannot durably reattach this handle. */
	attach: (handle: ProcessBackendHandle, callbacks: ProcessBackendCallbacks) => Promise<boolean>;
	status: (handle: ProcessBackendHandle) => Promise<ProcessBackendStatus>;
	terminate: (handle: ProcessBackendHandle) => Promise<void>;
}

export interface ProcessOutputRecord {
	sequence: number;
	stream: ProcessOutputStream;
	artifact: ArtifactRef;
	byteLength: number;
	timestamp: string;
}

export interface ProcessSessionRecord {
	id: string;
	command: string;
	args: string[];
	cwd: string;
	createdAt: string;
	updatedAt: string;
	backendId: string;
	backendHandle?: ProcessBackendHandle;
	state: ProcessSessionState;
	outputs: ProcessOutputRecord[];
	exit?: ProcessBackendExit & { timestamp: string };
	error?: string;
}

export interface StartProcessSessionOptions {
	id?: string;
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface ProcessSessionRecoveryReport {
	sessions: number;
	reattached: string[];
	interrupted: string[];
	invalidLines: number[];
}

export interface ProcessSessionManagerOptions {
	root: string;
	artifactStore: ArtifactStore;
	allowedRoots?: string[];
	backend?: ProcessSessionBackend;
	executionBoundary?: ExecutionBoundary;
	defaultCwd?: string;
}

interface ProcessEventBase {
	version: 1;
	eventId: string;
	processSessionId: string;
	sequence: number;
	timestamp: string;
}

interface ProcessCreatedEvent extends ProcessEventBase {
	type: "process_created";
	command: string;
	args: string[];
	cwd: string;
	backendId: string;
	environmentNames: string[];
}

interface ProcessStartedEvent extends ProcessEventBase {
	type: "process_started";
	handle: ProcessBackendHandle;
}

interface ProcessOutputEvent extends ProcessEventBase {
	type: "process_output";
	stream: ProcessOutputStream;
	artifact: ArtifactRef;
	byteLength: number;
}

interface ProcessTerminationRequestedEvent extends ProcessEventBase {
	type: "process_termination_requested";
}

interface ProcessExitedEvent extends ProcessEventBase {
	type: "process_exited";
	exitCode: number | null;
	signal?: string;
}

interface ProcessFailedEvent extends ProcessEventBase {
	type: "process_failed";
	error: string;
}

interface ProcessInterruptedEvent extends ProcessEventBase {
	type: "process_interrupted";
	reason: string;
}

export type ProcessSessionEvent =
	| ProcessCreatedEvent
	| ProcessStartedEvent
	| ProcessOutputEvent
	| ProcessTerminationRequestedEvent
	| ProcessExitedEvent
	| ProcessFailedEvent
	| ProcessInterruptedEvent;

type ProcessSessionListener = (record: ProcessSessionRecord, event: ProcessSessionEvent) => void;

function isActiveState(state: ProcessSessionState): boolean {
	return state === "created" || state === "running" || state === "terminating";
}

function isTerminalState(state: ProcessSessionState): boolean {
	return state === "exited" || state === "terminated" || state === "failed" || state === "interrupted";
}

function copyHandle(handle: ProcessBackendHandle): ProcessBackendHandle {
	return { ...handle, metadata: handle.metadata ? { ...handle.metadata } : undefined };
}

function copyRecord(record: ProcessSessionRecord): ProcessSessionRecord {
	return {
		...record,
		args: [...record.args],
		backendHandle: record.backendHandle ? copyHandle(record.backendHandle) : undefined,
		outputs: record.outputs.map((output) => ({ ...output })),
		exit: record.exit ? { ...record.exit } : undefined,
	};
}

function isProcessBackendHandle(value: unknown): value is ProcessBackendHandle {
	if (typeof value !== "object" || value === null) return false;
	const handle = value as Partial<ProcessBackendHandle>;
	return (
		typeof handle.id === "string" &&
		handle.id.length > 0 &&
		(handle.pid === undefined ||
			(typeof handle.pid === "number" && Number.isSafeInteger(handle.pid) && handle.pid > 0)) &&
		(handle.metadata === undefined ||
			(typeof handle.metadata === "object" &&
				handle.metadata !== null &&
				Object.values(handle.metadata).every(
					(entry) =>
						entry === null ||
						typeof entry === "string" ||
						(typeof entry === "number" && Number.isFinite(entry)) ||
						typeof entry === "boolean",
				)))
	);
}

function copyEvent(event: ProcessSessionEvent): ProcessSessionEvent {
	switch (event.type) {
		case "process_created":
			return { ...event, args: [...event.args], environmentNames: [...event.environmentNames] };
		case "process_started":
			return { ...event, handle: copyHandle(event.handle) };
		default:
			return { ...event };
	}
}

function isProcessSessionEvent(value: unknown): value is ProcessSessionEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Partial<ProcessSessionEvent>;
	if (
		event.version !== 1 ||
		typeof event.eventId !== "string" ||
		typeof event.processSessionId !== "string" ||
		typeof event.sequence !== "number" ||
		!Number.isSafeInteger(event.sequence) ||
		event.sequence < 0 ||
		typeof event.timestamp !== "string" ||
		typeof event.type !== "string"
	) {
		return false;
	}
	switch (event.type) {
		case "process_created":
			return (
				typeof event.command === "string" &&
				Array.isArray(event.args) &&
				event.args.every((arg) => typeof arg === "string") &&
				typeof event.cwd === "string" &&
				typeof event.backendId === "string" &&
				Array.isArray(event.environmentNames) &&
				event.environmentNames.every((name) => typeof name === "string")
			);
		case "process_started":
			return isProcessBackendHandle(event.handle);
		case "process_output":
			return (
				(event.stream === "stdout" || event.stream === "stderr") &&
				typeof event.artifact === "string" &&
				/^sha256:[0-9a-f]{64}$/.test(event.artifact) &&
				typeof event.byteLength === "number" &&
				Number.isSafeInteger(event.byteLength) &&
				event.byteLength >= 0
			);
		case "process_termination_requested":
			return true;
		case "process_exited":
			return (
				(event.exitCode === null || (typeof event.exitCode === "number" && Number.isSafeInteger(event.exitCode))) &&
				(event.signal === undefined || typeof event.signal === "string")
			);
		case "process_failed":
			return typeof event.error === "string";
		case "process_interrupted":
			return typeof event.reason === "string";
		default:
			return false;
	}
}

interface NodeLiveProcess {
	child: ChildProcess;
	callbacks: ProcessBackendCallbacks;
	status: ProcessBackendStatus;
}

/**
 * Default local backend. It can attach only while this backend instance still
 * owns the ChildProcess. A new pi process cannot reconstruct a ChildProcess
 * from a PID, so recovery correctly marks such sessions interrupted.
 */
export class NodeProcessSessionBackend implements ProcessSessionBackend {
	readonly id = "node-local";
	private readonly live = new Map<string, NodeLiveProcess>();

	async start(request: ProcessBackendStartRequest, callbacks: ProcessBackendCallbacks): Promise<ProcessBackendHandle> {
		const backendProcessId = randomUUID();
		const child = spawnProcess(request.command, [...request.args], {
			cwd: request.cwd,
			detached: process.platform !== "win32",
			env: request.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const live: NodeLiveProcess = { child, callbacks, status: { state: "running" } };
		this.live.set(backendProcessId, live);
		child.stdout?.on("data", (chunk: Buffer) => live.callbacks.onOutput("stdout", Buffer.from(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => live.callbacks.onOutput("stderr", Buffer.from(chunk)));
		if (child.pid) trackDetachedChildPid(child.pid);
		let exitSignal: string | undefined;
		child.once("exit", (_code, signal) => {
			exitSignal = signal ?? undefined;
		});
		void waitForChildProcess(child).then(
			(exitCode) => {
				if (child.pid) untrackDetachedChildPid(child.pid);
				const exit: ProcessBackendExit = { exitCode, signal: exitSignal };
				live.status = { state: "exited", exit };
				live.callbacks.onExit(exit);
			},
			(error: unknown) => {
				if (child.pid) untrackDetachedChildPid(child.pid);
				const message = error instanceof Error ? error.message : String(error);
				const exit: ProcessBackendExit = { exitCode: null, error: message };
				live.status = { state: "exited", exit };
				live.callbacks.onExit(exit);
			},
		);
		return { id: backendProcessId, pid: child.pid };
	}

	async attach(handle: ProcessBackendHandle, callbacks: ProcessBackendCallbacks): Promise<boolean> {
		const live = this.live.get(handle.id);
		if (!live || live.status.state !== "running") return false;
		live.callbacks = callbacks;
		return true;
	}

	async status(handle: ProcessBackendHandle): Promise<ProcessBackendStatus> {
		return this.live.get(handle.id)?.status ?? { state: "unavailable" };
	}

	async terminate(handle: ProcessBackendHandle): Promise<void> {
		const live = this.live.get(handle.id);
		if (!live || live.status.state !== "running") throw new Error(`Process handle is unavailable: ${handle.id}`);
		if (live.child.pid) killProcessTree(live.child.pid);
		else live.child.kill("SIGKILL");
	}
}

/** Durable process lifecycle coordinator with artifact-backed output. */
export class ProcessSessionManager {
	private readonly root: string;
	private readonly allowedRoots: string[];
	private readonly artifactStore: ArtifactStore;
	private readonly backend: ProcessSessionBackend;
	private readonly eventLogPath: string;
	private readonly defaultCwd: string;
	private readonly boundary?: ExecutionBoundary;
	private readonly records = new Map<string, ProcessSessionRecord>();
	private readonly eventsBySession = new Map<string, ProcessSessionEvent[]>();
	private readonly listeners = new Set<ProcessSessionListener>();
	private writeQueue: Promise<void> = Promise.resolve();
	private backgroundError: Error | undefined;

	private constructor(options: ProcessSessionManagerOptions) {
		this.root = resolve(options.root);
		this.allowedRoots = (options.allowedRoots ?? [this.root]).map((root) => resolve(root));
		this.artifactStore = options.artifactStore;
		this.eventLogPath = join(this.root, "process-sessions.jsonl");
		this.boundary = options.executionBoundary;

		if (options.executionBoundary) {
			const resolvedBoundary = resolveExecutionBoundary(options.executionBoundary, ["bash"]);
			if (resolvedBoundary.profile.process.mode !== "isolated") {
				throw new Error("Process sessions require an execution boundary with isolated process mode");
			}
			if (!options.backend) {
				throw new Error("Process sessions with an execution boundary require an explicit durable process backend");
			}
			const binding = options.backend.boundaryBinding;
			if (
				!binding ||
				binding.backendId !== options.executionBoundary.backend.id ||
				binding.profileDigest !== createBoundaryProfileDigest(options.executionBoundary.profile)
			) {
				throw new Error("Process session backend is not bound to the attested execution boundary profile");
			}
			this.backend = options.backend;
			this.defaultCwd = resolvedBoundary.cwd;
		} else {
			this.backend = options.backend ?? new NodeProcessSessionBackend();
			this.defaultCwd = resolve(options.defaultCwd ?? process.cwd());
		}
	}

	static async open(options: ProcessSessionManagerOptions): Promise<{
		manager: ProcessSessionManager;
		recovery: ProcessSessionRecoveryReport;
	}> {
		const manager = new ProcessSessionManager(options);
		await manager.initialize();
		const invalidLines = await manager.loadEvents();
		const recovery = await manager.recoverActiveSessions(invalidLines);
		return { manager, recovery };
	}

	private async initialize(): Promise<void> {
		const snapshot = await captureFilePathSnapshot(this.root, this.root, this.allowedRoots, realpath, true);
		await mkdir(this.root, { recursive: true });
		await revalidateFilePathSnapshot(snapshot, this.root, this.allowedRoots, realpath);
		await captureFilePathSnapshot(this.eventLogPath, this.eventLogPath, this.allowedRoots, realpath, true);
	}

	private async loadEvents(): Promise<number[]> {
		let content: string;
		try {
			content = await readFile(this.eventLogPath, "utf8");
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		const invalidLines: number[] = [];
		if (!content.endsWith("\n")) {
			const lastNewline = content.lastIndexOf("\n");
			const partialLine = content.slice(lastNewline + 1);
			if (partialLine.trim()) invalidLines.push(content.slice(0, lastNewline + 1).split("\n").length);
			await truncate(this.eventLogPath, lastNewline + 1);
			content = content.slice(0, lastNewline + 1);
		}
		const lines = content.split("\n");
		const completeLineCount = lines.length - 1;
		for (let index = 0; index < completeLineCount; index++) {
			const line = lines[index];
			if (!line?.trim()) continue;
			try {
				const event = JSON.parse(line) as unknown;
				if (!isProcessSessionEvent(event) || !this.canApplyEvent(event)) throw new Error("invalid event");
				this.applyEvent(event);
			} catch {
				invalidLines.push(index + 1);
			}
		}
		return invalidLines;
	}

	private canApplyEvent(event: ProcessSessionEvent): boolean {
		const existing = this.eventsBySession.get(event.processSessionId) ?? [];
		if (event.sequence !== existing.length) return false;
		if (event.type === "process_created") return existing.length === 0 && !this.records.has(event.processSessionId);
		const state = this.records.get(event.processSessionId)?.state;
		if (!state) return false;
		switch (event.type) {
			case "process_started":
				return state === "created";
			case "process_output":
				return state === "running" || state === "terminating";
			case "process_termination_requested":
				return state === "running";
			case "process_exited":
				return state === "running" || state === "terminating";
			case "process_failed":
			case "process_interrupted":
				return isActiveState(state);
		}
	}

	private async recoverActiveSessions(invalidLines: number[]): Promise<ProcessSessionRecoveryReport> {
		const reattached: string[] = [];
		const interrupted: string[] = [];
		for (const record of [...this.records.values()]) {
			if (!isActiveState(record.state)) continue;
			if (record.backendId !== this.backend.id || !record.backendHandle) {
				await this.runForeground(() => this.appendInterrupted(record.id, "durable backend handle is unavailable"));
				interrupted.push(record.id);
				continue;
			}
			let recoveredExit: ProcessBackendExit | undefined;
			let interruptionReason = "backend cannot reattach the active process";
			try {
				if (await this.backend.attach(record.backendHandle, this.createCallbacks(record.id))) {
					reattached.push(record.id);
					continue;
				}
				const status = await this.backend.status(record.backendHandle);
				if (status.state === "exited") recoveredExit = status.exit;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				interruptionReason = `backend recovery failed: ${message}`;
			}
			if (recoveredExit) {
				await this.runForeground(() => this.appendExit(record.id, recoveredExit));
				continue;
			}
			await this.runForeground(() => this.appendInterrupted(record.id, interruptionReason));
			interrupted.push(record.id);
		}
		return { sessions: this.records.size, reattached, interrupted, invalidLines };
	}

	async start(options: StartProcessSessionOptions): Promise<ProcessSessionRecord> {
		if (!options.command.trim()) throw new Error("Process command must not be empty");
		const id = options.id ?? randomUUID();
		if (!id.trim()) throw new Error("Process session id must not be empty");
		if (this.records.has(id)) throw new Error(`Process session already exists: ${id}`);
		const args = [...(options.args ?? [])];
		const cwd = this.resolveProcessCwd(options.cwd);
		const environment = this.resolveProcessEnvironment(options.env);
		const created = this.createEvent(id, 0, {
			type: "process_created",
			command: options.command,
			args,
			cwd,
			backendId: this.backend.id,
			environmentNames: Object.keys(environment).sort(),
		});
		await this.runForeground(() => this.appendAndApply(created));

		const bufferedCallbacks: Array<() => void> = [];
		let started = false;
		const callbacks = this.createCallbacks(id, (callback) => {
			if (started) callback();
			else bufferedCallbacks.push(callback);
		});
		let handle: ProcessBackendHandle | undefined;
		try {
			handle = await this.backend.start({ command: options.command, args, cwd, env: environment }, callbacks);
			if (!isProcessBackendHandle(handle)) throw new Error("Process backend returned an invalid durable handle");
			const startedEvent = this.createEvent(id, 1, { type: "process_started", handle: copyHandle(handle) });
			await this.runForeground(() => this.appendAndApply(startedEvent));
			started = true;
			for (const callback of bufferedCallbacks) callback();
			return this.requireRecord(id);
		} catch (error) {
			started = true;
			if (handle) {
				try {
					await this.backend.terminate(handle);
				} catch {
					// The original start or persistence failure remains authoritative.
				}
			}
			const message = error instanceof Error ? error.message : String(error);
			await this.runForeground(() => this.appendFailed(id, message));
			for (const callback of bufferedCallbacks) callback();
			throw error;
		}
	}

	get(id: string): ProcessSessionRecord | undefined {
		const record = this.records.get(id);
		return record ? copyRecord(record) : undefined;
	}

	list(): ProcessSessionRecord[] {
		return [...this.records.values()]
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.map(copyRecord);
	}

	status(id: string): ProcessSessionRecord {
		return this.requireRecord(id);
	}

	async attach(id: string): Promise<ProcessSessionRecord> {
		const record = this.records.get(id);
		if (!record) throw new Error(`Process session not found: ${id}`);
		if (!isActiveState(record.state)) return copyRecord(record);
		if (!record.backendHandle || record.backendId !== this.backend.id) {
			await this.runForeground(() => this.appendInterrupted(id, "durable backend handle is unavailable"));
			return this.requireRecord(id);
		}
		let recoveredExit: ProcessBackendExit | undefined;
		let interruptionReason = "backend cannot reattach the active process";
		try {
			if (await this.backend.attach(record.backendHandle, this.createCallbacks(id))) return this.requireRecord(id);
			const status = await this.backend.status(record.backendHandle);
			if (status.state === "exited") recoveredExit = status.exit;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			interruptionReason = `backend attach failed: ${message}`;
		}
		if (recoveredExit) await this.runForeground(() => this.appendExit(id, recoveredExit));
		else await this.runForeground(() => this.appendInterrupted(id, interruptionReason));
		return this.requireRecord(id);
	}

	async terminate(id: string): Promise<void> {
		const record = this.records.get(id);
		if (!record) throw new Error(`Process session not found: ${id}`);
		if (!isActiveState(record.state)) return;
		if (!record.backendHandle || record.backendId !== this.backend.id) {
			await this.runForeground(() => this.appendInterrupted(id, "cannot terminate without a live backend handle"));
			return;
		}
		const event = this.createNextEvent(id, { type: "process_termination_requested" });
		await this.runForeground(() => this.appendAndApply(event));
		try {
			await this.backend.terminate(record.backendHandle);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.runForeground(() => this.appendInterrupted(id, `backend termination failed: ${message}`));
			throw error;
		}
	}

	async readOutput(id: string, stream?: ProcessOutputStream): Promise<Buffer> {
		const record = this.records.get(id);
		if (!record) throw new Error(`Process session not found: ${id}`);
		const chunks: Buffer[] = [];
		for (const output of record.outputs) {
			if (!stream || output.stream === stream) chunks.push(await this.artifactStore.read(output.artifact));
		}
		return Buffer.concat(chunks);
	}

	getEvents(id: string): ProcessSessionEvent[] {
		return (this.eventsBySession.get(id) ?? []).map(copyEvent);
	}

	subscribe(listener: ProcessSessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async waitForExit(id: string): Promise<ProcessSessionRecord> {
		const current = this.records.get(id);
		if (!current) throw new Error(`Process session not found: ${id}`);
		if (isTerminalState(current.state)) return copyRecord(current);
		return new Promise((resolvePromise) => {
			const unsubscribe = this.subscribe((record) => {
				if (record.id === id && isTerminalState(record.state)) {
					unsubscribe();
					resolvePromise(record);
				}
			});
		});
	}

	async flush(): Promise<void> {
		await this.writeQueue;
		if (this.backgroundError) {
			const error = this.backgroundError;
			this.backgroundError = undefined;
			throw error;
		}
	}

	private resolveProcessCwd(requestedCwd: string | undefined): string {
		if (this.boundary) {
			const cwd = requestedCwd ?? this.defaultCwd;
			if (cwd !== this.defaultCwd) {
				throw new Error(`Bounded process cwd must be the attested working directory: ${this.defaultCwd}`);
			}
			return cwd;
		}
		return resolve(requestedCwd ?? this.defaultCwd);
	}

	private resolveProcessEnvironment(environment: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
		const source = environment ?? process.env;
		return this.boundary ? filterBoundaryEnvironment(this.boundary.profile, source) : { ...source };
	}

	private createCallbacks(id: string, schedule?: (callback: () => void) => void): ProcessBackendCallbacks {
		const enqueue = schedule ?? ((callback: () => void) => callback());
		return {
			onOutput: (stream, chunk) => {
				const durableChunk = Buffer.from(chunk);
				enqueue(() => this.enqueueBackground(() => this.appendOutput(id, stream, durableChunk)));
			},
			onExit: (exit) => {
				const durableExit = { ...exit };
				enqueue(() => this.enqueueBackground(() => this.appendExit(id, durableExit)));
			},
		};
	}

	private enqueueBackground(operation: () => Promise<void>): void {
		void this.queueOperation(operation);
	}

	private async runForeground(operation: () => Promise<void>): Promise<void> {
		await this.queueOperation(operation);
	}

	private queueOperation(operation: () => Promise<void>): Promise<void> {
		const result = this.writeQueue.then(operation);
		this.writeQueue = result.catch((error: unknown) => {
			this.backgroundError = error instanceof Error ? error : new Error(String(error));
		});
		return result;
	}

	private async appendOutput(id: string, stream: ProcessOutputStream, chunk: Buffer): Promise<void> {
		const record = this.records.get(id);
		if (!record || !isActiveState(record.state) || chunk.length === 0) return;
		const artifact = await this.artifactStore.put(chunk, {
			mediaType: "application/octet-stream",
			provenance: {
				producer: this.backend.id,
				processSessionId: id,
				attributes: { stream, outputSequence: record.outputs.length },
			},
		});
		const event = this.createNextEvent(id, {
			type: "process_output",
			stream,
			artifact: artifact.ref,
			byteLength: chunk.length,
		});
		await this.appendAndApply(event);
	}

	private async appendExit(id: string, exit: ProcessBackendExit): Promise<void> {
		const record = this.records.get(id);
		if (!record || isTerminalState(record.state)) return;
		if (exit.error) {
			await this.appendFailed(id, exit.error);
			return;
		}
		const event = this.createNextEvent(id, {
			type: "process_exited",
			exitCode: exit.exitCode,
			signal: exit.signal,
		});
		await this.appendAndApply(event);
	}

	private async appendFailed(id: string, error: string): Promise<void> {
		const record = this.records.get(id);
		if (!record || isTerminalState(record.state)) return;
		await this.appendAndApply(this.createNextEvent(id, { type: "process_failed", error }));
	}

	private async appendInterrupted(id: string, reason: string): Promise<void> {
		const record = this.records.get(id);
		if (!record || isTerminalState(record.state)) return;
		await this.appendAndApply(this.createNextEvent(id, { type: "process_interrupted", reason }));
	}

	private createEvent<T extends Omit<ProcessSessionEvent, keyof ProcessEventBase>>(
		id: string,
		sequence: number,
		data: T,
	): ProcessSessionEvent {
		return {
			...data,
			version: 1,
			eventId: randomUUID(),
			processSessionId: id,
			sequence,
			timestamp: new Date().toISOString(),
		} as ProcessSessionEvent;
	}

	private createNextEvent<T extends Omit<ProcessSessionEvent, keyof ProcessEventBase>>(
		id: string,
		data: T,
	): ProcessSessionEvent {
		return this.createEvent(id, this.eventsBySession.get(id)?.length ?? 0, data);
	}

	private async appendAndApply(event: ProcessSessionEvent): Promise<void> {
		if (!this.canApplyEvent(event)) throw new Error(`Invalid process event sequence for ${event.processSessionId}`);
		const snapshot = await captureFilePathSnapshot(
			this.eventLogPath,
			this.eventLogPath,
			this.allowedRoots,
			realpath,
			true,
		);
		await revalidateFilePathSnapshot(snapshot, this.eventLogPath, this.allowedRoots, realpath);
		const file = await open(this.eventLogPath, "a");
		try {
			await file.appendFile(`${JSON.stringify(event)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		this.applyEvent(event);
	}

	private applyEvent(event: ProcessSessionEvent): void {
		const events = this.eventsBySession.get(event.processSessionId) ?? [];
		events.push(event);
		this.eventsBySession.set(event.processSessionId, events);

		if (event.type === "process_created") {
			const record: ProcessSessionRecord = {
				id: event.processSessionId,
				command: event.command,
				args: [...event.args],
				cwd: event.cwd,
				createdAt: event.timestamp,
				updatedAt: event.timestamp,
				backendId: event.backendId,
				state: "created",
				outputs: [],
			};
			this.records.set(event.processSessionId, record);
			const snapshot = copyRecord(record);
			for (const listener of this.listeners) listener(snapshot, event);
			return;
		}

		const record = this.records.get(event.processSessionId);
		if (!record) throw new Error(`Process session not found: ${event.processSessionId}`);
		record.updatedAt = event.timestamp;
		switch (event.type) {
			case "process_started":
				record.backendHandle = copyHandle(event.handle);
				record.state = "running";
				break;
			case "process_output":
				record.outputs.push({
					sequence: record.outputs.length,
					stream: event.stream,
					artifact: event.artifact,
					byteLength: event.byteLength,
					timestamp: event.timestamp,
				});
				break;
			case "process_termination_requested":
				record.state = "terminating";
				break;
			case "process_exited":
				record.state = record.state === "terminating" ? "terminated" : "exited";
				record.exit = { exitCode: event.exitCode, signal: event.signal, timestamp: event.timestamp };
				break;
			case "process_failed":
				record.state = "failed";
				record.error = event.error;
				record.exit = { exitCode: null, error: event.error, timestamp: event.timestamp };
				break;
			case "process_interrupted":
				record.state = "interrupted";
				record.error = event.reason;
				break;
		}
		const snapshot = copyRecord(record);
		for (const listener of this.listeners) listener(snapshot, event);
	}

	private requireRecord(id: string): ProcessSessionRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Process session not found: ${id}`);
		return copyRecord(record);
	}
}
