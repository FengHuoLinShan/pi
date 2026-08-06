import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
	ProcessBackendCallbacks,
	ProcessBackendExit,
	ProcessBackendHandle,
	ProcessBackendStartRequest,
	ProcessBackendStatus,
	ProcessOutputStream,
	ProcessSessionBackend,
} from "./process-session.ts";

export const REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION = 1 as const;

const MAX_ID_LENGTH = 512;
const MAX_EVENTS_PER_PAGE = 1_000;
const MAX_OUTPUT_CHUNK_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES_PER_PAGE = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 32 * 1024;

export interface RemoteProcessExecutorDescriptor {
	protocolVersion: typeof REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION;
	executorId: string;
	instanceId: string;
	capabilities: {
		durableHandles: true;
		cursorReplay: true;
		cancellation: true;
		maxReplayEvents: number;
		maxOutputChunkBytes: number;
	};
	boundaryBinding?: {
		backendId: string;
		profileDigest: string;
	};
}

export interface RemoteProcessStartRequest {
	protocolVersion: typeof REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION;
	idempotencyKey: string;
	command: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string>>;
}

export interface RemoteProcessReplayRequest {
	protocolVersion: typeof REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION;
	handleId: string;
	afterCursor: number;
	limit: number;
}

export interface RemoteProcessStatusRequest {
	protocolVersion: typeof REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION;
	handleId: string;
}

export interface RemoteProcessTerminateRequest extends RemoteProcessStatusRequest {
	idempotencyKey: string;
}

export interface RemoteProcessExecutorTransport {
	negotiate(signal?: AbortSignal): Promise<unknown>;
	start(request: RemoteProcessStartRequest, signal?: AbortSignal): Promise<unknown>;
	replay(request: RemoteProcessReplayRequest, signal?: AbortSignal): Promise<unknown>;
	status(request: RemoteProcessStatusRequest, signal?: AbortSignal): Promise<unknown>;
	terminate(request: RemoteProcessTerminateRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface RemoteProcessSessionBackendOptions {
	pollIntervalMs?: number;
	maxConsecutiveTransportFailures?: number;
	/** Host environment names explicitly forwarded to the remote executor. Default: none. */
	environmentAllowlist?: readonly string[];
}

interface RemoteOutputEvent {
	type: "output";
	cursor: number;
	stream: ProcessOutputStream;
	data: Buffer;
}

interface RemoteExitEvent {
	type: "exit";
	cursor: number;
	exit: ProcessBackendExit;
}

type RemoteProcessEvent = RemoteOutputEvent | RemoteExitEvent;

interface RemoteReplayPage {
	events: RemoteProcessEvent[];
	nextCursor: number;
	hasMore: boolean;
	state: "running" | "exited";
}

interface LiveRemotePump {
	controller: AbortController;
}

export class RemoteProcessExecutorError extends Error {
	readonly code: "negotiation_failed" | "protocol_error" | "handle_mismatch" | "transport_failed";

	constructor(
		code: "negotiation_failed" | "protocol_error" | "handle_mismatch" | "transport_failed",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "RemoteProcessExecutorError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireId(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.length > MAX_ID_LENGTH ||
		value.includes("\0") ||
		/[\r\n]/.test(value)
	) {
		throw new RemoteProcessExecutorError("protocol_error", `${label} must be a bounded single-line string`);
	}
	return value;
}

function requireCursor(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new RemoteProcessExecutorError("protocol_error", `${label} must be a non-negative safe integer`);
	}
	return value as number;
}

function parseDescriptor(value: unknown): RemoteProcessExecutorDescriptor {
	if (!isRecord(value) || value.protocolVersion !== REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION) {
		throw new RemoteProcessExecutorError("negotiation_failed", "Remote executor protocol version is unsupported");
	}
	const capabilities = value.capabilities;
	if (
		!isRecord(capabilities) ||
		capabilities.durableHandles !== true ||
		capabilities.cursorReplay !== true ||
		capabilities.cancellation !== true ||
		!Number.isSafeInteger(capabilities.maxReplayEvents) ||
		(capabilities.maxReplayEvents as number) < 1 ||
		(capabilities.maxReplayEvents as number) > MAX_EVENTS_PER_PAGE ||
		!Number.isSafeInteger(capabilities.maxOutputChunkBytes) ||
		(capabilities.maxOutputChunkBytes as number) < 1 ||
		(capabilities.maxOutputChunkBytes as number) > MAX_OUTPUT_CHUNK_BYTES
	) {
		throw new RemoteProcessExecutorError(
			"negotiation_failed",
			"Remote executor lacks durable handle, cursor replay, cancellation, or bounded output capabilities",
		);
	}
	let boundaryBinding: RemoteProcessExecutorDescriptor["boundaryBinding"];
	if (value.boundaryBinding !== undefined) {
		if (
			!isRecord(value.boundaryBinding) ||
			typeof value.boundaryBinding.backendId !== "string" ||
			value.boundaryBinding.backendId.trim() === "" ||
			typeof value.boundaryBinding.profileDigest !== "string" ||
			!/^[0-9a-f]{64}$/.test(value.boundaryBinding.profileDigest)
		) {
			throw new RemoteProcessExecutorError("negotiation_failed", "Remote executor boundary binding is invalid");
		}
		boundaryBinding = {
			backendId: value.boundaryBinding.backendId,
			profileDigest: value.boundaryBinding.profileDigest,
		};
	}
	return {
		protocolVersion: REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION,
		executorId: requireId(value.executorId, "Remote executor id"),
		instanceId: requireId(value.instanceId, "Remote executor instance id"),
		capabilities: {
			durableHandles: true,
			cursorReplay: true,
			cancellation: true,
			maxReplayEvents: capabilities.maxReplayEvents as number,
			maxOutputChunkBytes: capabilities.maxOutputChunkBytes as number,
		},
		...(boundaryBinding ? { boundaryBinding } : {}),
	};
}

function parseHandle(value: unknown, descriptor: RemoteProcessExecutorDescriptor): ProcessBackendHandle {
	if (!isRecord(value))
		throw new RemoteProcessExecutorError("protocol_error", "Remote start response must be an object");
	const handleId = requireId(value.handleId, "Remote process handle id");
	const cursor = requireCursor(value.cursor, "Remote process cursor");
	return {
		id: handleId,
		cursor,
		metadata: {
			executorId: descriptor.executorId,
			instanceId: descriptor.instanceId,
			protocolVersion: descriptor.protocolVersion,
		},
	};
}

function parseExit(value: unknown): ProcessBackendExit {
	if (!isRecord(value))
		throw new RemoteProcessExecutorError("protocol_error", "Remote process exit must be an object");
	if (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode))) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote process exit code is invalid");
	}
	if (
		value.signal !== undefined &&
		(typeof value.signal !== "string" ||
			value.signal.length > MAX_ID_LENGTH ||
			value.signal.includes("\0") ||
			/[\r\n]/.test(value.signal))
	) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote process signal is invalid");
	}
	if (
		value.error !== undefined &&
		(typeof value.error !== "string" || value.error.length > MAX_DIAGNOSTIC_LENGTH || value.error.includes("\0"))
	) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote process error is invalid");
	}
	return {
		exitCode: value.exitCode as number | null,
		...(value.signal === undefined ? {} : { signal: value.signal }),
		...(value.error === undefined ? {} : { error: value.error }),
	};
}

function parseStatus(value: unknown): ProcessBackendStatus {
	if (!isRecord(value) || (value.state !== "running" && value.state !== "exited" && value.state !== "unavailable")) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote process status is invalid");
	}
	if (value.state === "exited") return { state: "exited", exit: parseExit(value.exit) };
	if (value.exit !== undefined) {
		throw new RemoteProcessExecutorError("protocol_error", "Only exited remote processes may include exit data");
	}
	return { state: value.state };
}

function decodeOutput(value: unknown, maxBytes: number): Buffer {
	if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote output chunk is invalid or exceeds its limit");
	}
	const output = Buffer.from(value, "base64");
	const canonical = output.toString("base64");
	if (output.length === 0 || output.length > maxBytes || canonical !== value) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote output chunk is not canonical bounded base64");
	}
	return output;
}

function parseReplayPage(
	value: unknown,
	afterCursor: number,
	descriptor: RemoteProcessExecutorDescriptor,
): RemoteReplayPage {
	if (
		!isRecord(value) ||
		!Array.isArray(value.events) ||
		value.events.length > descriptor.capabilities.maxReplayEvents ||
		typeof value.hasMore !== "boolean" ||
		(value.state !== "running" && value.state !== "exited")
	) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote replay page is invalid");
	}
	const events: RemoteProcessEvent[] = [];
	let expectedCursor = afterCursor + 1;
	let outputBytes = 0;
	for (const raw of value.events) {
		if (!isRecord(raw) || requireCursor(raw.cursor, "Remote event cursor") !== expectedCursor) {
			throw new RemoteProcessExecutorError("protocol_error", `Remote replay cursor gap at ${expectedCursor}`);
		}
		if (raw.type === "output" && (raw.stream === "stdout" || raw.stream === "stderr")) {
			const data = decodeOutput(raw.dataBase64, descriptor.capabilities.maxOutputChunkBytes);
			outputBytes += data.length;
			if (outputBytes > MAX_OUTPUT_BYTES_PER_PAGE) {
				throw new RemoteProcessExecutorError(
					"protocol_error",
					"Remote replay page exceeds its aggregate output limit",
				);
			}
			events.push({
				type: "output",
				cursor: expectedCursor,
				stream: raw.stream,
				data,
			});
		} else if (raw.type === "exit") {
			events.push({ type: "exit", cursor: expectedCursor, exit: parseExit(raw.exit) });
		} else {
			throw new RemoteProcessExecutorError("protocol_error", "Remote replay event is invalid");
		}
		expectedCursor++;
	}
	const nextCursor = requireCursor(value.nextCursor, "Remote replay next cursor");
	if (nextCursor !== expectedCursor - 1) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote replay next cursor does not match its events");
	}
	if (value.hasMore && events.length === 0) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote replay cannot claim more events without progress");
	}
	const exitIndex = events.findIndex((event) => event.type === "exit");
	if (
		(exitIndex >= 0 && (exitIndex !== events.length - 1 || value.state !== "exited" || value.hasMore)) ||
		(value.state === "exited" && exitIndex < 0)
	) {
		throw new RemoteProcessExecutorError("protocol_error", "Remote exit must be the final replay event");
	}
	return { events, nextCursor, hasMore: value.hasMore, state: value.state };
}

function assertHandleMatches(handle: ProcessBackendHandle, descriptor: RemoteProcessExecutorDescriptor): void {
	if (
		handle.metadata?.executorId !== descriptor.executorId ||
		handle.metadata.instanceId !== descriptor.instanceId ||
		handle.metadata.protocolVersion !== descriptor.protocolVersion
	) {
		throw new RemoteProcessExecutorError(
			"handle_mismatch",
			"Remote process handle belongs to a different executor instance or protocol",
		);
	}
	requireCursor(handle.cursor ?? 0, "Remote process handle cursor");
}

function environmentRecord(environment: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment)
			.filter((entry): entry is [string, string] => entry[1] !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}

export class RemoteProcessSessionBackend implements ProcessSessionBackend {
	readonly id: string;
	readonly boundaryBinding?: { backendId: string; profileDigest: string };
	readonly descriptor: RemoteProcessExecutorDescriptor;
	private readonly transport: RemoteProcessExecutorTransport;
	private readonly pollIntervalMs: number;
	private readonly maxConsecutiveTransportFailures: number;
	private readonly environmentAllowlist: ReadonlySet<string>;
	private readonly pumps = new Map<string, LiveRemotePump>();

	private constructor(
		transport: RemoteProcessExecutorTransport,
		descriptor: RemoteProcessExecutorDescriptor,
		options: RemoteProcessSessionBackendOptions,
	) {
		this.transport = transport;
		this.descriptor = descriptor;
		this.id = `remote:${descriptor.executorId}`;
		this.boundaryBinding = descriptor.boundaryBinding;
		const pollIntervalMs = options.pollIntervalMs ?? 250;
		if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
			throw new RemoteProcessExecutorError("negotiation_failed", "Remote executor poll interval is invalid");
		}
		this.pollIntervalMs = pollIntervalMs;
		const maxFailures = options.maxConsecutiveTransportFailures ?? 5;
		if (!Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 100) {
			throw new RemoteProcessExecutorError(
				"negotiation_failed",
				"Remote executor transport failure budget is invalid",
			);
		}
		this.maxConsecutiveTransportFailures = maxFailures;
		const environmentAllowlist = options.environmentAllowlist ?? [];
		if (
			!Array.isArray(environmentAllowlist) ||
			environmentAllowlist.length > 256 ||
			environmentAllowlist.some(
				(name) => typeof name !== "string" || name.length > 256 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
			)
		) {
			throw new RemoteProcessExecutorError("negotiation_failed", "Remote executor environment allowlist is invalid");
		}
		this.environmentAllowlist = new Set(environmentAllowlist);
	}

	static async connect(
		transport: RemoteProcessExecutorTransport,
		options: RemoteProcessSessionBackendOptions = {},
		signal?: AbortSignal,
	): Promise<RemoteProcessSessionBackend> {
		let descriptor: RemoteProcessExecutorDescriptor;
		try {
			descriptor = parseDescriptor(await transport.negotiate(signal));
		} catch (error) {
			if (error instanceof RemoteProcessExecutorError) throw error;
			throw new RemoteProcessExecutorError("negotiation_failed", "Remote executor negotiation failed", {
				cause: error,
			});
		}
		return new RemoteProcessSessionBackend(transport, descriptor, options);
	}

	filterEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
		return Object.fromEntries(
			Object.entries(environment).filter(
				(entry): entry is [string, string] => this.environmentAllowlist.has(entry[0]) && entry[1] !== undefined,
			),
		);
	}

	async start(request: ProcessBackendStartRequest, callbacks: ProcessBackendCallbacks): Promise<ProcessBackendHandle> {
		let response: unknown;
		const environment = this.filterEnvironment(request.env);
		const remoteRequest: RemoteProcessStartRequest = {
			protocolVersion: REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION,
			idempotencyKey: randomUUID(),
			command: request.command,
			args: [...request.args],
			cwd: request.cwd,
			env: environmentRecord(environment),
		};
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.maxConsecutiveTransportFailures; attempt++) {
			try {
				response = await this.transport.start(remoteRequest);
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				if (attempt < this.maxConsecutiveTransportFailures) {
					await delay(Math.min(this.pollIntervalMs * attempt, 5_000));
				}
			}
		}
		if (lastError !== undefined) {
			throw new RemoteProcessExecutorError(
				"transport_failed",
				`Remote process start outcome remained unknown after ${this.maxConsecutiveTransportFailures} idempotent attempt(s)`,
				{ cause: lastError },
			);
		}
		const handle = parseHandle(response, this.descriptor);
		this.startPump(handle, callbacks);
		return handle;
	}

	async attach(handle: ProcessBackendHandle, callbacks: ProcessBackendCallbacks): Promise<boolean> {
		assertHandleMatches(handle, this.descriptor);
		this.startPump(handle, callbacks);
		return true;
	}

	async status(handle: ProcessBackendHandle): Promise<ProcessBackendStatus> {
		assertHandleMatches(handle, this.descriptor);
		try {
			return parseStatus(
				await this.transport.status({
					protocolVersion: REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION,
					handleId: handle.id,
				}),
			);
		} catch (error) {
			if (error instanceof RemoteProcessExecutorError) throw error;
			throw new RemoteProcessExecutorError("transport_failed", "Remote process status failed", { cause: error });
		}
	}

	async terminate(handle: ProcessBackendHandle): Promise<void> {
		assertHandleMatches(handle, this.descriptor);
		const request: RemoteProcessTerminateRequest = {
			protocolVersion: REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION,
			handleId: handle.id,
			idempotencyKey: randomUUID(),
		};
		let result: unknown;
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.maxConsecutiveTransportFailures; attempt++) {
			try {
				result = await this.transport.terminate(request);
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				if (attempt < this.maxConsecutiveTransportFailures) {
					await delay(Math.min(this.pollIntervalMs * attempt, 5_000));
				}
			}
		}
		if (lastError !== undefined) {
			throw new RemoteProcessExecutorError(
				"transport_failed",
				`Remote process termination outcome remained unknown after ${this.maxConsecutiveTransportFailures} idempotent attempt(s)`,
				{ cause: lastError },
			);
		}
		if (!isRecord(result) || result.accepted !== true) {
			throw new RemoteProcessExecutorError("protocol_error", "Remote termination was not accepted");
		}
	}

	close(): void {
		for (const pump of this.pumps.values()) pump.controller.abort();
		this.pumps.clear();
	}

	private startPump(handle: ProcessBackendHandle, callbacks: ProcessBackendCallbacks): void {
		this.pumps.get(handle.id)?.controller.abort();
		const controller = new AbortController();
		this.pumps.set(handle.id, { controller });
		void this.pump(handle, callbacks, controller.signal)
			.catch(() => undefined)
			.finally(() => {
				if (this.pumps.get(handle.id)?.controller === controller) this.pumps.delete(handle.id);
			});
	}

	private async pump(
		handle: ProcessBackendHandle,
		callbacks: ProcessBackendCallbacks,
		signal: AbortSignal,
	): Promise<void> {
		let cursor = handle.cursor ?? 0;
		let failures = 0;
		while (!signal.aborted) {
			try {
				const page = parseReplayPage(
					await this.transport.replay(
						{
							protocolVersion: REMOTE_PROCESS_EXECUTOR_PROTOCOL_VERSION,
							handleId: handle.id,
							afterCursor: cursor,
							limit: this.descriptor.capabilities.maxReplayEvents,
						},
						signal,
					),
					cursor,
					this.descriptor,
				);
				failures = 0;
				for (const event of page.events) {
					if (event.type === "output") {
						await callbacks.onOutput(event.stream, event.data, event.cursor);
						cursor = event.cursor;
					} else {
						await callbacks.onExit(event.exit, event.cursor);
						return;
					}
				}
				if (page.hasMore) continue;
				if (page.state === "exited") {
					throw new RemoteProcessExecutorError("protocol_error", "Remote replay omitted its terminal event");
				}
				await delay(this.pollIntervalMs, undefined, { signal });
			} catch (error) {
				if (signal.aborted) return;
				failures++;
				if (error instanceof RemoteProcessExecutorError || failures >= this.maxConsecutiveTransportFailures) {
					const message =
						error instanceof RemoteProcessExecutorError
							? error.message
							: "Remote process replay exceeded its transport failure budget";
					await callbacks.onExit({ exitCode: null, error: message });
					return;
				}
				await delay(Math.min(this.pollIntervalMs * failures, 5_000), undefined, { signal }).catch(() => undefined);
			}
		}
	}
}
