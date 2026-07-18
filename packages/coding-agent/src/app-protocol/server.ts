import { BoundedEventReplay } from "./replay.ts";
import {
	APP_PROTOCOL_ERROR_CODES,
	type AppCapabilities,
	type AppEventNotification,
	type AppProtocolConnectionState,
	type AppProtocolIssue,
	type AppProtocolLimits,
	type AppProtocolReceiveResult,
	type AppProtocolServerOptions,
	type EventsReplayResult,
	type InitializeParams,
	type InitializeResult,
	type JsonRpcErrorObject,
	type JsonRpcErrorResponse,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type JsonRpcSuccessResponse,
	type JsonValue,
	type ProtocolClientRequest,
	type ServerReverseRequest,
	type ServerReverseRequestSpec,
} from "./types.ts";
import {
	isJsonValue,
	ProtocolValidationError,
	parseAppProtocolEvent,
	parseApprovalRequestParams,
	parseApprovalResponseResult,
	parseEventsReplayParams,
	parseInitializedParams,
	parseInitializeParams,
	parseJsonRpcErrorObject,
	parseJsonRpcMessage,
	parseJsonRpcText,
	parseProtocolClientRequest,
	parseUserInputRequestParams,
	parseUserInputResponseResult,
} from "./validation.ts";

interface PendingReverseRequest {
	method: ServerReverseRequest["method"];
}

export const DEFAULT_APP_PROTOCOL_CAPABILITIES: AppCapabilities = {
	streaming: true,
	approvals: true,
	userInput: true,
	images: true,
	dynamicTools: false,
	terminal: true,
	replay: true,
};

export const DEFAULT_APP_PROTOCOL_LIMITS: AppProtocolLimits = {
	maxPendingRequests: 64,
	maxQueuedTurns: 16,
	maxEventReplayEvents: 1_000,
	maxItemDeltaBytes: 256 * 1024,
};

/**
 * Pure protocol state for one client connection. It validates and negotiates
 * messages but deliberately does not execute thread or turn operations.
 */
export class AppProtocolServerConnection {
	private readonly options: AppProtocolServerOptions;
	private readonly replayStore: BoundedEventReplay;
	private readonly pendingClientRequests = new Map<JsonRpcId, ProtocolClientRequest["method"]>();
	private readonly pendingReverseRequests = new Map<JsonRpcId, PendingReverseRequest>();
	private connectionState: AppProtocolConnectionState = "awaiting_initialize";
	private negotiatedVersionValue: string | undefined;
	private negotiatedCapabilitiesValue: AppCapabilities | undefined;
	private negotiatedLimitsValue: AppProtocolLimits | undefined;
	private nextReverseRequestId = 0;

	constructor(options: AppProtocolServerOptions, replayStore?: BoundedEventReplay) {
		validateServerOptions(options);
		this.options = structuredClone(options);
		this.replayStore =
			replayStore ?? new BoundedEventReplay(options.limits.maxEventReplayEvents, options.protocolVersions[0]);
	}

	get state(): AppProtocolConnectionState {
		return this.connectionState;
	}

	get negotiatedProtocolVersion(): string | undefined {
		return this.negotiatedVersionValue;
	}

	get negotiatedCapabilities(): AppCapabilities | undefined {
		return this.negotiatedCapabilitiesValue === undefined
			? undefined
			: structuredClone(this.negotiatedCapabilitiesValue);
	}

	get negotiatedLimits(): AppProtocolLimits | undefined {
		return this.negotiatedLimitsValue === undefined ? undefined : structuredClone(this.negotiatedLimitsValue);
	}

	get pendingReverseRequestCount(): number {
		return this.pendingReverseRequests.size;
	}

	receiveJson(text: string): AppProtocolReceiveResult {
		try {
			return this.receiveParsed(parseJsonRpcText(text));
		} catch (error: unknown) {
			return this.validationFailure(error);
		}
	}

	receive(value: unknown): AppProtocolReceiveResult {
		try {
			return this.receiveParsed(parseJsonRpcMessage(value));
		} catch (error: unknown) {
			return this.validationFailure(error);
		}
	}

	/** Record a canonical lifecycle event and return the live notification. */
	publishEvent(value: unknown, timestamp?: Date): AppEventNotification {
		if (this.connectionState !== "ready") {
			throw new ProtocolValidationError(APP_PROTOCOL_ERROR_CODES.NOT_INITIALIZED, "Connection is not initialized");
		}
		const capabilities = this.requireNegotiatedCapabilities();
		if (!capabilities.streaming) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE,
				"Client did not negotiate streaming",
			);
		}
		const event = parseAppProtocolEvent(value);
		if (event.type === "item/delta") {
			const size = Buffer.byteLength(JSON.stringify(event), "utf8");
			if (size > this.requireNegotiatedLimits().maxItemDeltaBytes) {
				throw new ProtocolValidationError(
					APP_PROTOCOL_ERROR_CODES.OVERLOADED,
					"Item delta exceeds negotiated maxItemDeltaBytes",
					{ data: { size, limit: this.requireNegotiatedLimits().maxItemDeltaBytes } },
				);
			}
		}
		return this.projectEventNotification(this.replayStore.append(event, timestamp));
	}

	/** Create a correlated server-to-client approval or user-input request. */
	createReverseRequest(spec: ServerReverseRequestSpec): ServerReverseRequest {
		if (this.connectionState !== "ready") {
			throw new ProtocolValidationError(APP_PROTOCOL_ERROR_CODES.NOT_INITIALIZED, "Connection is not initialized");
		}
		const capabilities = this.requireNegotiatedCapabilities();
		if (spec.method === "approval/request" && !capabilities.approvals) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE,
				"Client did not negotiate approvals",
			);
		}
		if (spec.method === "userInput/request" && !capabilities.userInput) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE,
				"Client did not negotiate user input",
			);
		}
		if (this.pendingReverseRequests.size >= this.requireNegotiatedLimits().maxPendingRequests) {
			throw new ProtocolValidationError(APP_PROTOCOL_ERROR_CODES.OVERLOADED, "Too many pending reverse requests");
		}

		const id = `server:${++this.nextReverseRequestId}`;
		if (spec.method === "approval/request") {
			const request: ServerReverseRequest = {
				jsonrpc: "2.0",
				id,
				method: "approval/request",
				params: parseApprovalRequestParams(spec.params),
			};
			this.pendingReverseRequests.set(id, { method: request.method });
			return request;
		}
		const request: ServerReverseRequest = {
			jsonrpc: "2.0",
			id,
			method: "userInput/request",
			params: parseUserInputRequestParams(spec.params),
		};
		this.pendingReverseRequests.set(id, { method: request.method });
		return request;
	}

	/** Complete a previously dispatched client request. */
	completeRequest(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
		if (!this.pendingClientRequests.has(id)) throw new Error(`No pending client request for id ${String(id)}`);
		if (!isJsonValue(result)) throw new Error("Protocol response result must be a JSON value");
		this.pendingClientRequests.delete(id);
		return { jsonrpc: "2.0", id, result: structuredClone(result) };
	}

	failRequest(id: JsonRpcId, error: JsonRpcErrorObject): JsonRpcErrorResponse {
		if (!this.pendingClientRequests.has(id)) throw new Error(`No pending client request for id ${String(id)}`);
		const validatedError = parseJsonRpcErrorObject(error);
		this.pendingClientRequests.delete(id);
		return { jsonrpc: "2.0", id, error: validatedError };
	}

	private receiveParsed(message: JsonRpcMessage): AppProtocolReceiveResult {
		if (isResponse(message)) return this.handleReverseResponse(message);
		if (this.connectionState === "awaiting_initialize") return this.handleAwaitingInitialize(message);
		if (this.connectionState === "awaiting_initialized") return this.handleAwaitingInitialized(message);
		return this.handleReadyMessage(message);
	}

	private handleAwaitingInitialize(message: JsonRpcRequest | JsonRpcNotification): AppProtocolReceiveResult {
		if (!("id" in message) || message.method !== "initialize") {
			return this.rejectMessage(
				message,
				APP_PROTOCOL_ERROR_CODES.NOT_INITIALIZED,
				"First request must be initialize",
			);
		}
		try {
			const params = parseInitializeParams(message.params);
			const result = this.negotiate(params);
			this.connectionState = "awaiting_initialized";
			return emptyReceiveResult({ jsonrpc: "2.0", id: message.id, result });
		} catch (error: unknown) {
			return this.validationFailure(error, message.id);
		}
	}

	private handleAwaitingInitialized(message: JsonRpcRequest | JsonRpcNotification): AppProtocolReceiveResult {
		if (!("id" in message) && message.method === "initialized") {
			try {
				const params = parseInitializedParams(message.params);
				if (params.protocolVersion !== this.negotiatedVersionValue) {
					throw new ProtocolValidationError(
						APP_PROTOCOL_ERROR_CODES.INCOMPATIBLE_PROTOCOL,
						"initialized protocolVersion does not match negotiated version",
					);
				}
				this.connectionState = "ready";
				return {
					outbound: [],
					actions: [{ kind: "initialized", protocolVersion: params.protocolVersion }],
					issues: [],
				};
			} catch (error: unknown) {
				return this.notificationFailure(error);
			}
		}
		if (message.method === "initialize") {
			return this.rejectMessage(
				message,
				APP_PROTOCOL_ERROR_CODES.ALREADY_INITIALIZED,
				"initialize was already completed",
			);
		}
		return this.rejectMessage(
			message,
			APP_PROTOCOL_ERROR_CODES.NOT_INITIALIZED,
			"Client must send initialized before other methods",
		);
	}

	private handleReadyMessage(message: JsonRpcRequest | JsonRpcNotification): AppProtocolReceiveResult {
		if (!("id" in message)) {
			const code =
				message.method === "initialized"
					? APP_PROTOCOL_ERROR_CODES.ALREADY_INITIALIZED
					: APP_PROTOCOL_ERROR_CODES.METHOD_NOT_FOUND;
			return this.rejectMessage(message, code, `Unexpected notification: ${message.method}`);
		}
		if (message.method === "initialize") {
			return this.rejectMessage(
				message,
				APP_PROTOCOL_ERROR_CODES.ALREADY_INITIALIZED,
				"initialize was already completed",
			);
		}
		if (message.method === "events/replay") return this.handleReplay(message);
		if (this.pendingClientRequests.has(message.id)) {
			return this.rejectMessage(message, APP_PROTOCOL_ERROR_CODES.DUPLICATE_REQUEST, "Duplicate request id");
		}
		if (this.pendingClientRequests.size >= this.requireNegotiatedLimits().maxPendingRequests) {
			return this.rejectMessage(message, APP_PROTOCOL_ERROR_CODES.OVERLOADED, "Too many pending client requests", {
				retryAfterMs: 100,
			});
		}

		try {
			const request = parseProtocolClientRequest(message);
			this.validateRequestCapabilities(request);
			this.pendingClientRequests.set(request.id, request.method);
			return { outbound: [], actions: [{ kind: "request", request }], issues: [] };
		} catch (error: unknown) {
			return this.validationFailure(error, message.id);
		}
	}

	private handleReplay(request: JsonRpcRequest): AppProtocolReceiveResult {
		if (!this.requireNegotiatedCapabilities().replay) {
			return this.rejectMessage(
				request,
				APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE,
				"Client did not negotiate event replay",
			);
		}
		try {
			const params = parseEventsReplayParams(request.params);
			const limit = Math.min(
				params.limit ?? this.requireNegotiatedLimits().maxEventReplayEvents,
				this.requireNegotiatedLimits().maxEventReplayEvents,
			);
			const replayed = this.replayStore.replay(params.afterCursor, limit);
			const result: EventsReplayResult = {
				...replayed,
				events: replayed.events.map((event) => this.projectEventNotification(event)),
			};
			return emptyReceiveResult({ jsonrpc: "2.0", id: request.id, result });
		} catch (error: unknown) {
			return this.validationFailure(error, request.id);
		}
	}

	private handleReverseResponse(response: JsonRpcResponse): AppProtocolReceiveResult {
		if (this.connectionState !== "ready") {
			return issueReceiveResult(APP_PROTOCOL_ERROR_CODES.NOT_INITIALIZED, "Response received before initialized");
		}
		if (response.id === null) {
			return issueReceiveResult(APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST, "Reverse response id cannot be null");
		}
		const pending = this.pendingReverseRequests.get(response.id);
		if (pending === undefined) {
			return issueReceiveResult(APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST, "Unknown reverse response id", {
				id: response.id,
			});
		}
		this.pendingReverseRequests.delete(response.id);
		if ("error" in response) {
			return {
				outbound: [],
				actions: [{ kind: "reverse_error", id: response.id, method: pending.method, error: response.error }],
				issues: [],
			};
		}

		try {
			if (pending.method === "approval/request") {
				return {
					outbound: [],
					actions: [
						{
							kind: "reverse_response",
							id: response.id,
							method: pending.method,
							result: parseApprovalResponseResult(response.result),
						},
					],
					issues: [],
				};
			}
			return {
				outbound: [],
				actions: [
					{
						kind: "reverse_response",
						id: response.id,
						method: pending.method,
						result: parseUserInputResponseResult(response.result),
					},
				],
				issues: [],
			};
		} catch (error: unknown) {
			const validationError = normalizeValidationError(error);
			return {
				outbound: [],
				actions: [
					{
						kind: "reverse_error",
						id: response.id,
						method: pending.method,
						error: {
							code: validationError.code,
							message: validationError.message,
							...(validationError.data === undefined ? {} : { data: validationError.data }),
						},
					},
				],
				issues: [{ code: validationError.code, message: validationError.message }],
			};
		}
	}

	private negotiate(params: InitializeParams): InitializeResult {
		const requestedVersions = [params.protocolVersion, ...(params.supportedProtocolVersions ?? [])];
		const protocolVersion = requestedVersions.find((version) => this.options.protocolVersions.includes(version));
		if (protocolVersion === undefined) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.INCOMPATIBLE_PROTOCOL,
				"No compatible protocol version",
				{ data: { supportedProtocolVersions: this.options.protocolVersions } },
			);
		}
		if (
			params.auth !== undefined &&
			this.options.allowedAuthSchemes !== undefined &&
			!this.options.allowedAuthSchemes.includes(params.auth.scheme)
		) {
			throw new ProtocolValidationError(APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS, "Unsupported auth scheme");
		}

		const capabilities = negotiateCapabilities(params.capabilities, this.options.capabilities);
		for (const required of params.requiredCapabilities ?? []) {
			if (!capabilities[required]) {
				throw new ProtocolValidationError(
					APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE,
					`Required capability is unavailable: ${required}`,
					{ data: { capability: required } },
				);
			}
		}
		const limits = negotiateLimits(params.limits, this.options.limits, this.replayStore.capacity);
		this.negotiatedVersionValue = protocolVersion;
		this.negotiatedCapabilitiesValue = capabilities;
		this.negotiatedLimitsValue = limits;
		return {
			protocolVersion,
			server: structuredClone(this.options.server),
			capabilities: structuredClone(capabilities),
			limits: structuredClone(limits),
			featureFlags: [...(this.options.featureFlags ?? [])],
			resume: {
				supported: capabilities.replay,
				earliestCursor: this.replayStore.earliestCursor,
				latestCursor: this.replayStore.latestCursor,
			},
		};
	}

	private validateRequestCapabilities(request: ProtocolClientRequest): void {
		if (
			(request.method === "turn/start" || request.method === "turn/steer") &&
			request.params.input.some((part) => part.type === "image") &&
			!this.requireNegotiatedCapabilities().images
		) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.CAPABILITY_UNAVAILABLE,
				"Client did not negotiate image input",
				{ requestId: request.id },
			);
		}
	}

	private rejectMessage(
		message: JsonRpcRequest | JsonRpcNotification,
		code: number,
		messageText: string,
		data?: JsonValue,
	): AppProtocolReceiveResult {
		if (!("id" in message)) return issueReceiveResult(code, messageText, data);
		return emptyReceiveResult(errorResponse(message.id, code, messageText, data));
	}

	private validationFailure(error: unknown, requestId?: JsonRpcId): AppProtocolReceiveResult {
		const validationError = normalizeValidationError(error, requestId);
		return emptyReceiveResult(
			errorResponse(
				requestId ?? validationError.requestId,
				validationError.code,
				validationError.message,
				validationError.data,
			),
		);
	}

	private notificationFailure(error: unknown): AppProtocolReceiveResult {
		const validationError = normalizeValidationError(error);
		return issueReceiveResult(validationError.code, validationError.message, validationError.data);
	}

	private requireNegotiatedCapabilities(): AppCapabilities {
		if (this.negotiatedCapabilitiesValue === undefined) throw new Error("Capabilities were not negotiated");
		return this.negotiatedCapabilitiesValue;
	}

	private requireNegotiatedLimits(): AppProtocolLimits {
		if (this.negotiatedLimitsValue === undefined) throw new Error("Limits were not negotiated");
		return this.negotiatedLimitsValue;
	}

	private projectEventNotification(notification: AppEventNotification): AppEventNotification {
		const projected = structuredClone(notification);
		projected.params.protocolVersion = this.negotiatedVersionValue ?? projected.params.protocolVersion;
		return projected;
	}
}

function negotiateCapabilities(client: Partial<AppCapabilities>, server: AppCapabilities): AppCapabilities {
	return {
		streaming: client.streaming === true && server.streaming,
		approvals: client.approvals === true && server.approvals,
		userInput: client.userInput === true && server.userInput,
		images: client.images === true && server.images,
		dynamicTools: client.dynamicTools === true && server.dynamicTools,
		terminal: client.terminal === true && server.terminal,
		replay: client.replay === true && server.replay,
	};
}

function negotiateLimits(
	client: Partial<AppProtocolLimits> | undefined,
	server: AppProtocolLimits,
	replayCapacity: number,
): AppProtocolLimits {
	return {
		maxPendingRequests: Math.min(client?.maxPendingRequests ?? server.maxPendingRequests, server.maxPendingRequests),
		maxQueuedTurns: Math.min(client?.maxQueuedTurns ?? server.maxQueuedTurns, server.maxQueuedTurns),
		maxEventReplayEvents: Math.min(
			client?.maxEventReplayEvents ?? server.maxEventReplayEvents,
			server.maxEventReplayEvents,
			replayCapacity,
		),
		maxItemDeltaBytes: Math.min(client?.maxItemDeltaBytes ?? server.maxItemDeltaBytes, server.maxItemDeltaBytes),
	};
}

function validateServerOptions(options: AppProtocolServerOptions): void {
	if (options.server.name.length === 0 || options.server.version.length === 0)
		throw new Error("Server identity is required");
	if (options.protocolVersions.length === 0 || options.protocolVersions.some((version) => version.length === 0)) {
		throw new Error("At least one protocol version is required");
	}
	for (const [name, value] of Object.entries(options.limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	}
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
	return "result" in message || "error" in message;
}

function errorResponse(id: JsonRpcId | null, code: number, message: string, data?: JsonValue): JsonRpcErrorResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: { code, message, ...(data === undefined ? {} : { data }) },
	};
}

function emptyReceiveResult(outbound?: JsonRpcMessage): AppProtocolReceiveResult {
	return { outbound: outbound === undefined ? [] : [outbound], actions: [], issues: [] };
}

function issueReceiveResult(code: number, message: string, data?: JsonValue): AppProtocolReceiveResult {
	const issue: AppProtocolIssue = { code, message, ...(data === undefined ? {} : { data }) };
	return { outbound: [], actions: [], issues: [issue] };
}

function normalizeValidationError(error: unknown, requestId?: JsonRpcId): ProtocolValidationError {
	if (error instanceof ProtocolValidationError) {
		if (requestId === undefined || error.requestId !== null) return error;
		return new ProtocolValidationError(error.code, error.message, { data: error.data, requestId });
	}
	return new ProtocolValidationError(
		APP_PROTOCOL_ERROR_CODES.INTERNAL_ERROR,
		error instanceof Error ? error.message : String(error),
		{
			requestId,
		},
	);
}
