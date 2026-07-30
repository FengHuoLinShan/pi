import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import type { OrchestratorRequest, OrchestratorResponse, SpawnRequest } from "../src/ipc/protocol.ts";
import type { IpcRequestHandler } from "../src/ipc/server.ts";
import { type RunningRemoteServer, startRemoteServer } from "../src/remote/server.ts";

const TOKEN = "test-token-0123456789-0123456789-abcdef";
const INSTANCE = {
	id: "instance-1",
	status: "online" as const,
	cwd: "/tmp/project",
	label: "Test Pi",
	sessionId: "session-1",
};
const RESUMABLE_INSTANCE = {
	id: "instance-offline",
	status: "stopped" as const,
	cwd: "/tmp/resumable-project",
	label: "Resumable Pi",
	sessionId: "session-old",
	sessionFile: "/tmp/session-old.jsonl",
};
const RESUMED_INSTANCE = {
	...RESUMABLE_INSTANCE,
	id: "instance-resumed",
	status: "online" as const,
	sessionId: "session-new",
};

interface FakeRemoteHandler {
	handler: IpcRequestHandler;
	emitSessionEvent(event: AgentSessionEvent): void;
	emitUiRequest(request: RpcExtensionUIRequest): void;
}

function responseFor(command: RpcCommand): RpcResponse {
	const base = { id: command.id, type: "response" as const, command: command.type, success: true as const };
	switch (command.type) {
		case "get_state":
			return {
				...base,
				command: "get_state",
				data: {
					thinkingLevel: "medium",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "one-at-a-time",
					sessionId: "session-1",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			};
		case "get_messages":
			return { ...base, command: "get_messages", data: { messages: [] } };
		case "get_tree":
			return { ...base, command: "get_tree", data: { tree: [], leafId: null } };
		case "get_session_stats":
			return {
				...base,
				command: "get_session_stats",
				data: {
					sessionFile: undefined,
					sessionId: "session-1",
					userMessages: 0,
					assistantMessages: 0,
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
				},
			};
		case "get_available_models":
			return { ...base, command: "get_available_models", data: { models: [] } };
		case "prompt":
			return { ...base, command: "prompt" };
		case "abort":
			return { ...base, command: "abort" };
		case "switch_session":
			return { ...base, command: "switch_session", data: { cancelled: false } };
		default:
			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: `Unsupported fake command: ${command.type}`,
			};
	}
}

interface ResumeCalls {
	spawn?: SpawnRequest;
}

function createResumeHandler(): { handler: IpcRequestHandler; calls: ResumeCalls } {
	const calls: ResumeCalls = {};
	const requestHandler = async (request: OrchestratorRequest): Promise<OrchestratorResponse> => {
		switch (request.type) {
			case "list":
				return { type: "list_result", ok: true, instances: [RESUMABLE_INSTANCE] };
			case "status": {
				const instance =
					request.instanceId === RESUMABLE_INSTANCE.id
						? RESUMABLE_INSTANCE
						: request.instanceId === RESUMED_INSTANCE.id
							? RESUMED_INSTANCE
							: undefined;
				return instance
					? { type: "status_result", ok: true, instance }
					: { type: "error", ok: false, error: "Unknown instance" };
			}
			case "spawn":
				calls.spawn = request;
				return { type: "spawn_result", ok: true, instance: RESUMED_INSTANCE };
			case "stop":
				return { type: "stop_result", ok: true, instanceId: request.instanceId };
			case "rpc":
				return { type: "rpc_result", ok: true, response: responseFor(request.command) };
			case "rpc_stream":
				return { type: "rpc_ready", ok: true, instance: RESUMED_INSTANCE };
		}
	};
	const handler = Object.assign(requestHandler, {
		openRpcStream(
			instanceId: string,
			responseHandler: (response: RpcResponse) => void,
			_sessionEventHandler: (event: AgentSessionEvent) => void,
			_uiRequestHandler: (request: RpcExtensionUIRequest) => void,
		) {
			if (instanceId !== RESUMED_INSTANCE.id) {
				return undefined;
			}
			return {
				async handleRequest(request: RpcCommand | RpcExtensionUIResponse): Promise<void> {
					if (request.type === "extension_ui_response") {
						return;
					}
					responseHandler(responseFor(request));
				},
				close(): void {},
			};
		},
	}) as IpcRequestHandler;
	return { handler, calls };
}

function createFakeHandler(): FakeRemoteHandler {
	let onResponse: ((response: RpcResponse) => void) | undefined;
	let onSessionEvent: ((event: AgentSessionEvent) => void) | undefined;
	let onUiRequest: ((request: RpcExtensionUIRequest) => void) | undefined;

	const requestHandler = async (request: OrchestratorRequest): Promise<OrchestratorResponse> => {
		switch (request.type) {
			case "list":
				return { type: "list_result", ok: true, instances: [INSTANCE] };
			case "status":
				return request.instanceId === INSTANCE.id
					? { type: "status_result", ok: true, instance: INSTANCE }
					: { type: "error", ok: false, error: "Unknown instance" };
			case "spawn":
				return { type: "spawn_result", ok: true, instance: INSTANCE };
			case "stop":
				return { type: "stop_result", ok: true, instanceId: request.instanceId };
			case "rpc":
				return { type: "rpc_result", ok: true, response: responseFor(request.command) };
			case "rpc_stream":
				return { type: "rpc_ready", ok: true, instance: INSTANCE };
		}
	};

	const handler = Object.assign(requestHandler, {
		openRpcStream(
			instanceId: string,
			responseHandler: (response: RpcResponse) => void,
			sessionEventHandler: (event: AgentSessionEvent) => void,
			uiRequestHandler: (request: RpcExtensionUIRequest) => void,
		) {
			if (instanceId !== INSTANCE.id) {
				return undefined;
			}
			onResponse = responseHandler;
			onSessionEvent = sessionEventHandler;
			onUiRequest = uiRequestHandler;
			return {
				async handleRequest(request: RpcCommand | RpcExtensionUIResponse): Promise<void> {
					if (request.type === "extension_ui_response") {
						return;
					}
					onResponse?.(responseFor(request));
				},
				close(): void {
					onResponse = undefined;
					onSessionEvent = undefined;
					onUiRequest = undefined;
				},
			};
		},
	}) as IpcRequestHandler;

	return {
		handler,
		emitSessionEvent(event) {
			onSessionEvent?.(event);
		},
		emitUiRequest(request) {
			onUiRequest?.(request);
		},
	};
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown>> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const result = await reader.read();
		if (result.done) {
			throw new Error("SSE stream ended before an event arrived");
		}
		buffer += decoder.decode(result.value, { stream: true });
		for (;;) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary === -1) {
				break;
			}
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const data = frame
				.split("\n")
				.find((line) => line.startsWith("data: "))
				?.slice("data: ".length);
			if (data) {
				return JSON.parse(data) as Record<string, unknown>;
			}
		}
	}
}

describe("remote server", () => {
	let running: RunningRemoteServer | undefined;

	afterEach(async () => {
		await running?.close();
		running = undefined;
	});

	test("exposes health while protecting instance data", async () => {
		const fake = createFakeHandler();
		running = await startRemoteServer({ host: "127.0.0.1", port: 0, token: TOKEN }, fake.handler);
		const baseUrl = `http://127.0.0.1:${running.port}`;

		const health = await fetch(`${baseUrl}/v1/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true, protocolVersion: 1 });

		const unauthorized = await fetch(`${baseUrl}/v1/instances`);
		expect(unauthorized.status).toBe(401);

		const authorized = await fetch(`${baseUrl}/v1/instances`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(authorized.status).toBe(200);
		expect(await authorized.json()).toMatchObject({ ok: true, instances: [INSTANCE] });
	});

	test("streams, replays, and snapshots Pi RPC state and pending UI requests", async () => {
		const fake = createFakeHandler();
		running = await startRemoteServer({ host: "127.0.0.1", port: 0, token: TOKEN }, fake.handler);
		const baseUrl = `http://127.0.0.1:${running.port}`;
		const headers = { Authorization: `Bearer ${TOKEN}` };

		const streamResponse = await fetch(`${baseUrl}/v1/instances/${INSTANCE.id}/events`, { headers });
		expect(streamResponse.status).toBe(200);
		const reader = streamResponse.body?.getReader();
		if (!reader) {
			throw new Error("Expected SSE response body");
		}

		const commandResponse = await fetch(`${baseUrl}/v1/instances/${INSTANCE.id}/command`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ command: { type: "prompt", message: "hello" } }),
		});
		expect(commandResponse.status).toBe(200);
		expect(await commandResponse.json()).toMatchObject({ command: "prompt", success: true });

		const streamed = await readSseEvent(reader);
		expect(streamed).toMatchObject({ sequence: 1, instanceId: INSTANCE.id, kind: "rpc_response" });
		await reader.cancel();

		const replayResponse = await fetch(`${baseUrl}/v1/instances/${INSTANCE.id}/events?after=0`, { headers });
		const replayReader = replayResponse.body?.getReader();
		if (!replayReader) {
			throw new Error("Expected replay response body");
		}
		expect(await readSseEvent(replayReader)).toMatchObject({ sequence: 1, kind: "rpc_response" });
		await replayReader.cancel();

		fake.emitUiRequest({
			type: "extension_ui_request",
			id: "approval-1",
			method: "confirm",
			title: "Run command?",
			message: "npm run check",
		});
		fake.emitSessionEvent({ type: "agent_start" });

		const activityResponse = await fetch(`${baseUrl}/v1/instances/${INSTANCE.id}/activity`, { headers });
		expect(activityResponse.status).toBe(200);
		expect(await activityResponse.json()).toMatchObject({
			instance: INSTANCE,
			pendingUiRequests: [{ id: "approval-1", method: "confirm" }],
		});

		const snapshotResponse = await fetch(`${baseUrl}/v1/instances/${INSTANCE.id}/snapshot`, { headers });
		expect(snapshotResponse.status).toBe(200);
		const snapshot = (await snapshotResponse.json()) as Record<string, unknown>;
		expect(snapshot).toMatchObject({
			instance: INSTANCE,
			pendingUiRequests: [{ id: "approval-1", method: "confirm" }],
		});
		expect(snapshot.latestSequence).toBe(9);
	});

	test("resumes an offline session with explicit project trust", async () => {
		const fake = createResumeHandler();
		running = await startRemoteServer({ host: "127.0.0.1", port: 0, token: TOKEN }, fake.handler);
		const baseUrl = `http://127.0.0.1:${running.port}`;
		const response = await fetch(`${baseUrl}/v1/instances/${RESUMABLE_INSTANCE.id}/resume`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ approveProject: true }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			ok: true,
			instance: RESUMED_INSTANCE,
			resumeSessionFile: RESUMABLE_INSTANCE.sessionFile,
			sourceInstanceId: RESUMABLE_INSTANCE.id,
		});
		expect(fake.calls.spawn).toMatchObject({
			type: "spawn",
			cwd: RESUMABLE_INSTANCE.cwd,
			label: RESUMABLE_INSTANCE.label,
			approveProject: true,
		});
	});
});
