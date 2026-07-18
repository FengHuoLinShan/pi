import { describe, expect, test } from "vitest";
import { BoundedEventReplay } from "../src/app-protocol/replay.ts";
import {
	AppProtocolServerConnection,
	DEFAULT_APP_PROTOCOL_CAPABILITIES,
	DEFAULT_APP_PROTOCOL_LIMITS,
} from "../src/app-protocol/server.ts";
import {
	APP_PROTOCOL_ERROR_CODES,
	type AppCapabilities,
	type AppProtocolReceiveResult,
	type AppProtocolServerOptions,
	type EventsReplayResult,
	type InitializeResult,
	type JsonRpcErrorResponse,
	type JsonRpcSuccessResponse,
} from "../src/app-protocol/types.ts";
import { ProtocolValidationError } from "../src/app-protocol/validation.ts";

const CLIENT_CAPABILITIES: AppCapabilities = {
	streaming: true,
	approvals: true,
	userInput: true,
	images: true,
	dynamicTools: true,
	terminal: true,
	replay: true,
};

function serverOptions(overrides: Partial<AppProtocolServerOptions> = {}): AppProtocolServerOptions {
	return {
		server: { name: "pi", version: "0.80.10" },
		protocolVersions: ["1.1", "1.0"],
		capabilities: { ...DEFAULT_APP_PROTOCOL_CAPABILITIES },
		limits: { ...DEFAULT_APP_PROTOCOL_LIMITS, maxEventReplayEvents: 4 },
		featureFlags: ["canonical-events"],
		...overrides,
	};
}

function initialize(
	connection: AppProtocolServerConnection,
	options: {
		protocolVersion?: string;
		supportedProtocolVersions?: string[];
		capabilities?: Partial<AppCapabilities>;
		requiredCapabilities?: Array<keyof AppCapabilities>;
		limits?: { maxPendingRequests?: number; maxEventReplayEvents?: number };
	} = {},
): InitializeResult {
	const response = connection.receive({
		jsonrpc: "2.0",
		id: "init-1",
		method: "initialize",
		params: {
			protocolVersion: options.protocolVersion ?? "1.1",
			...(options.supportedProtocolVersions === undefined
				? {}
				: { supportedProtocolVersions: options.supportedProtocolVersions }),
			client: { name: "test-client", version: "1.0.0" },
			capabilities: options.capabilities ?? CLIENT_CAPABILITIES,
			...(options.requiredCapabilities === undefined ? {} : { requiredCapabilities: options.requiredCapabilities }),
			...(options.limits === undefined ? {} : { limits: options.limits }),
		},
	});
	const result = successResult<InitializeResult>(response);
	expect(connection.state).toBe("awaiting_initialized");
	const initialized = connection.receive({
		jsonrpc: "2.0",
		method: "initialized",
		params: { protocolVersion: result.protocolVersion },
	});
	expect(initialized.actions).toEqual([{ kind: "initialized", protocolVersion: result.protocolVersion }]);
	expect(connection.state).toBe("ready");
	return result;
}

function successResult<T>(result: AppProtocolReceiveResult): T {
	expect(result.issues).toEqual([]);
	expect(result.outbound).toHaveLength(1);
	const response = result.outbound[0];
	if (!("result" in response)) throw new Error("Expected a success response");
	return (response as JsonRpcSuccessResponse<T>).result;
}

function errorResponse(result: AppProtocolReceiveResult): JsonRpcErrorResponse {
	expect(result.outbound).toHaveLength(1);
	const response = result.outbound[0];
	if (!("error" in response)) throw new Error("Expected an error response");
	return response;
}

function threadStarted(id: string) {
	return {
		type: "thread/started",
		schemaVersion: 1,
		thread: {
			id,
			version: 1,
			status: "active",
			createdAt: "2026-07-19T00:00:00.000Z",
			updatedAt: "2026-07-19T00:00:00.000Z",
		},
	};
}

describe("stable app protocol", () => {
	test("negotiates version, capabilities, limits, flags, and requires initialized", () => {
		const connection = new AppProtocolServerConnection(
			serverOptions({
				capabilities: { ...DEFAULT_APP_PROTOCOL_CAPABILITIES, images: false, dynamicTools: false },
				limits: { ...DEFAULT_APP_PROTOCOL_LIMITS, maxPendingRequests: 8, maxEventReplayEvents: 4 },
			}),
		);
		const init = connection.receive({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: {
				protocolVersion: "2.0",
				supportedProtocolVersions: ["1.0"],
				client: { name: "ide", version: "2.1" },
				capabilities: CLIENT_CAPABILITIES,
				limits: { maxPendingRequests: 3, maxEventReplayEvents: 10 },
			},
		});
		const negotiated = successResult<InitializeResult>(init);
		expect(negotiated).toMatchObject({
			protocolVersion: "1.0",
			capabilities: { images: false, dynamicTools: false, streaming: true },
			limits: { maxPendingRequests: 3, maxEventReplayEvents: 4 },
			featureFlags: ["canonical-events"],
			resume: { supported: true, earliestCursor: 0, latestCursor: 0 },
		});

		const tooEarly = connection.receive({
			jsonrpc: "2.0",
			id: "thread-before-ready",
			method: "thread/start",
			params: { schemaVersion: 1 },
		});
		expect(errorResponse(tooEarly).error.code).toBe(APP_PROTOCOL_ERROR_CODES.NOT_INITIALIZED);

		const initialized = connection.receive({
			jsonrpc: "2.0",
			method: "initialized",
			params: { protocolVersion: "1.0" },
		});
		expect(initialized.actions[0]?.kind).toBe("initialized");
		expect(connection.state).toBe("ready");
	});

	test("rejects calls before initialize", () => {
		const connection = new AppProtocolServerConnection(serverOptions());
		const result = connection.receive({
			jsonrpc: "2.0",
			id: 1,
			method: "turn/start",
			params: { schemaVersion: 1, threadId: "t", input: [{ type: "text", text: "go" }] },
		});
		const response = errorResponse(result);
		expect(response.id).toBe(1);
		expect(response.error.code).toBe(APP_PROTOCOL_ERROR_CODES.NOT_INITIALIZED);
	});

	test("strictly rejects malformed JSON-RPC and method params", () => {
		const connection = new AppProtocolServerConnection(serverOptions());
		expect(errorResponse(connection.receiveJson("{")).error.code).toBe(APP_PROTOCOL_ERROR_CODES.PARSE_ERROR);
		expect(errorResponse(connection.receive([])).error.code).toBe(APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST);
		expect(
			errorResponse(connection.receive({ jsonrpc: "2.0", id: "x", method: "initialize", params: {}, extra: true }))
				.error.code,
		).toBe(APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST);

		initialize(connection);
		const invalidParams = connection.receive({
			jsonrpc: "2.0",
			id: "turn-1",
			method: "turn/start",
			params: { schemaVersion: 1, threadId: "thread-1", input: [], unknown: true },
		});
		expect(errorResponse(invalidParams).error.code).toBe(APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS);
		const unknownMethod = connection.receive({ jsonrpc: "2.0", id: "nope", method: "thread/delete", params: {} });
		expect(errorResponse(unknownMethod).error.code).toBe(APP_PROTOCOL_ERROR_CODES.METHOD_NOT_FOUND);
	});

	test("dispatches turn start, steer, cancel, and interrupt as distinct side-effect-free actions", () => {
		const connection = new AppProtocolServerConnection(serverOptions());
		initialize(connection);
		const requests = [
			{
				jsonrpc: "2.0",
				id: "start",
				method: "turn/start",
				params: { schemaVersion: 1, threadId: "thread-1", input: [{ type: "text", text: "start" }] },
			},
			{
				jsonrpc: "2.0",
				id: "steer",
				method: "turn/steer",
				params: {
					schemaVersion: 1,
					threadId: "thread-1",
					turnId: "turn-1",
					input: [{ type: "text", text: "change direction" }],
				},
			},
			{
				jsonrpc: "2.0",
				id: "cancel",
				method: "turn/cancel",
				params: { schemaVersion: 1, threadId: "thread-1", turnId: "turn-1", reason: "graceful" },
			},
			{
				jsonrpc: "2.0",
				id: "interrupt",
				method: "turn/interrupt",
				params: { schemaVersion: 1, threadId: "thread-1", turnId: "turn-1", target: "process" },
			},
		];

		const methods = requests.map((request) => {
			const result = connection.receive(request);
			expect(result.outbound).toEqual([]);
			const action = result.actions[0];
			if (action?.kind !== "request") throw new Error("Expected request action");
			return action.request.method;
		});
		expect(methods).toEqual(["turn/start", "turn/steer", "turn/cancel", "turn/interrupt"]);
	});

	test("correlates reverse approval and user-input responses", () => {
		const connection = new AppProtocolServerConnection(serverOptions());
		initialize(connection);
		const approval = connection.createReverseRequest({
			method: "approval/request",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-1",
				summary: "Run tests",
			},
		});
		const userInput = connection.createReverseRequest({
			method: "userInput/request",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-2",
				prompt: "Which package?",
			},
		});
		expect(approval.id).not.toBe(userInput.id);
		expect(connection.pendingReverseRequestCount).toBe(2);

		const inputResponse = connection.receive({ jsonrpc: "2.0", id: userInput.id, result: { value: "agent" } });
		expect(inputResponse.actions).toEqual([
			{
				kind: "reverse_response",
				id: userInput.id,
				method: "userInput/request",
				result: { value: "agent" },
			},
		]);
		const approvalResponse = connection.receive({
			jsonrpc: "2.0",
			id: approval.id,
			result: { decision: "allow", grantId: "grant-1" },
		});
		expect(approvalResponse.actions[0]).toMatchObject({
			kind: "reverse_response",
			method: "approval/request",
			result: { decision: "allow", grantId: "grant-1" },
		});
		expect(connection.pendingReverseRequestCount).toBe(0);

		const unknown = connection.receive({ jsonrpc: "2.0", id: "server:404", result: { value: "x" } });
		expect(unknown.issues[0]?.code).toBe(APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST);

		const invalidApproval = connection.createReverseRequest({
			method: "approval/request",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-3", summary: "Retry approval" },
		});
		const invalidResponse = connection.receive({
			jsonrpc: "2.0",
			id: invalidApproval.id,
			result: { decision: "later" },
		});
		expect(invalidResponse.actions[0]).toMatchObject({
			kind: "reverse_error",
			id: invalidApproval.id,
			method: "approval/request",
			error: { code: APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS },
		});
		expect(invalidResponse.issues[0]?.code).toBe(APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS);
	});

	test("validates versioned Thread, Turn, and Item lifecycle events", () => {
		const connection = new AppProtocolServerConnection(serverOptions());
		initialize(connection);
		const started = connection.publishEvent({
			type: "item/started",
			schemaVersion: 1,
			item: {
				id: "item-1",
				threadId: "thread-1",
				turnId: "turn-1",
				version: 1,
				kind: "tool_call",
				status: "running",
				data: { toolName: "read" },
			},
		});
		const delta = connection.publishEvent({
			type: "item/delta",
			schemaVersion: 1,
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "item-1",
			itemVersion: 2,
			deltaIndex: 0,
			delta: { output: "partial" },
		});
		const completed = connection.publishEvent({
			type: "item/completed",
			schemaVersion: 1,
			item: {
				id: "item-1",
				threadId: "thread-1",
				turnId: "turn-1",
				version: 3,
				kind: "tool_call",
				status: "completed",
				data: { output: "done" },
			},
		});
		expect([started.method, delta.method, completed.method]).toEqual([
			"item/started",
			"item/delta",
			"item/completed",
		]);
		expect([started.params.cursor, delta.params.cursor, completed.params.cursor]).toEqual([1, 2, 3]);
		expect(() =>
			connection.publishEvent({
				type: "turn/completed",
				schemaVersion: 1,
				turn: {
					id: "turn-1",
					threadId: "thread-1",
					version: 2,
					status: "completed",
					startedAt: "2026-07-19T00:00:00.000Z",
				},
			}),
		).toThrow(ProtocolValidationError);
	});

	test("replays bounded events across connections and reports explicit cursor gaps", () => {
		const replay = new BoundedEventReplay(2, "1.1");
		const first = new AppProtocolServerConnection(serverOptions(), replay);
		initialize(first);
		first.publishEvent(threadStarted("thread-1"), new Date("2026-07-19T00:00:01.000Z"));
		first.publishEvent(threadStarted("thread-2"), new Date("2026-07-19T00:00:02.000Z"));
		first.publishEvent(threadStarted("thread-3"), new Date("2026-07-19T00:00:03.000Z"));
		expect(replay.earliestCursor).toBe(2);
		expect(replay.latestCursor).toBe(3);

		const reconnected = new AppProtocolServerConnection(serverOptions(), replay);
		const negotiated = initialize(reconnected, { limits: { maxEventReplayEvents: 1 } });
		expect(negotiated.resume).toEqual({ supported: true, earliestCursor: 2, latestCursor: 3 });
		const replayed = successResult<EventsReplayResult>(
			reconnected.receive({
				jsonrpc: "2.0",
				id: "replay",
				method: "events/replay",
				params: { afterCursor: 1, limit: 10 },
			}),
		);
		expect(replayed.events.map((event) => event.params.cursor)).toEqual([2]);
		expect(replayed).toMatchObject({ nextCursor: 2, latestCursor: 3, hasMore: true });

		const gap = reconnected.receive({
			jsonrpc: "2.0",
			id: "gap",
			method: "events/replay",
			params: { afterCursor: 0 },
		});
		const gapError = errorResponse(gap);
		expect(gapError.error.code).toBe(APP_PROTOCOL_ERROR_CODES.REPLAY_GAP);
		expect(gapError.error.data).toMatchObject({
			requestedCursor: 0,
			earliestCursor: 2,
			latestCursor: 3,
			minimumResumeCursor: 1,
		});
	});

	test("downgrades optional capabilities and rejects unavailable required capabilities", () => {
		const options = serverOptions({
			capabilities: {
				...DEFAULT_APP_PROTOCOL_CAPABILITIES,
				approvals: false,
				images: false,
				dynamicTools: false,
			},
		});
		const optional = new AppProtocolServerConnection(options);
		const negotiated = initialize(optional);
		expect(negotiated.capabilities).toMatchObject({ approvals: false, images: false, dynamicTools: false });
		expect(() =>
			optional.createReverseRequest({
				method: "approval/request",
				params: { threadId: "t", turnId: "r", itemId: "i", summary: "approve" },
			}),
		).toThrow(ProtocolValidationError);
		const imageTurn = optional.receive({
			jsonrpc: "2.0",
			id: "image-turn",
			method: "turn/start",
			params: {
				schemaVersion: 1,
				threadId: "thread-1",
				input: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
			},
		});
		expect(errorResponse(imageTurn).error.code).toBe(APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE);

		const required = new AppProtocolServerConnection(options);
		const rejected = required.receive({
			jsonrpc: "2.0",
			id: "init-required",
			method: "initialize",
			params: {
				protocolVersion: "1.1",
				client: { name: "client", version: "1" },
				capabilities: CLIENT_CAPABILITIES,
				requiredCapabilities: ["dynamicTools"],
			},
		});
		expect(errorResponse(rejected).error.code).toBe(APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE);
		expect(required.state).toBe("awaiting_initialize");
	});

	test("tracks duplicate client ids until the application returns a correlated response", () => {
		const connection = new AppProtocolServerConnection(serverOptions());
		initialize(connection);
		const request = {
			jsonrpc: "2.0",
			id: "thread-1",
			method: "thread/start",
			params: { schemaVersion: 1 },
		};
		expect(connection.receive(request).actions[0]?.kind).toBe("request");
		expect(errorResponse(connection.receive(request)).error.code).toBe(APP_PROTOCOL_ERROR_CODES.DUPLICATE_REQUEST);
		expect(connection.completeRequest("thread-1", { threadId: "thread-1" })).toEqual({
			jsonrpc: "2.0",
			id: "thread-1",
			result: { threadId: "thread-1" },
		});
		expect(connection.receive(request).actions[0]?.kind).toBe("request");
	});
});
