import {
	APP_PROTOCOL_ERROR_CODES,
	type AppCapabilities,
	type AppCapabilityName,
	type AppProtocolEvent,
	type AppProtocolLimits,
	type ApprovalRequestParams,
	type ApprovalResponseResult,
	type EventsReplayParams,
	type InitializedParams,
	type InitializeParams,
	type JsonObject,
	type JsonRpcErrorObject,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonValue,
	type ProtocolClientRequest,
	type ProtocolInputPart,
	type ThreadStartParams,
	type TurnCancelParams,
	type TurnInterruptParams,
	type TurnStartParams,
	type TurnSteerParams,
	type UserInputRequestParams,
	type UserInputResponseResult,
} from "./types.ts";

const CAPABILITY_NAMES = [
	"streaming",
	"approvals",
	"userInput",
	"images",
	"dynamicTools",
	"terminal",
	"replay",
] as const satisfies readonly AppCapabilityName[];

const LIMIT_NAMES = [
	"maxPendingRequests",
	"maxQueuedTurns",
	"maxEventReplayEvents",
	"maxItemDeltaBytes",
] as const satisfies readonly (keyof AppProtocolLimits)[];

export class ProtocolValidationError extends Error {
	readonly code: number;
	readonly data?: JsonValue;
	readonly requestId: JsonRpcId | null;

	constructor(code: number, message: string, options?: { data?: JsonValue; requestId?: JsonRpcId | null }) {
		super(message);
		this.name = "ProtocolValidationError";
		this.code = code;
		this.data = options?.data;
		this.requestId = options?.requestId ?? null;
	}
}

export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isObject(value)) return false;
	return Object.values(value).every(isJsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
	return isObject(value) && Object.values(value).every(isJsonValue);
}

export function parseJsonRpcText(text: string): JsonRpcMessage {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error: unknown) {
		throw new ProtocolValidationError(
			APP_PROTOCOL_ERROR_CODES.PARSE_ERROR,
			`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseJsonRpcMessage(value);
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
	if (Array.isArray(value)) {
		throw new ProtocolValidationError(
			APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST,
			"JSON-RPC batch messages are not supported",
		);
	}
	if (!isObject(value)) {
		throw new ProtocolValidationError(APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST, "JSON-RPC message must be an object");
	}

	const requestId = parsePossibleId(value.id);
	if (value.jsonrpc !== "2.0") {
		throw invalidRequest("jsonrpc must be exactly '2.0'", requestId);
	}

	if ("method" in value) {
		const allowed = "id" in value ? ["jsonrpc", "id", "method", "params"] : ["jsonrpc", "method", "params"];
		requireExactKeys(value, allowed, "JSON-RPC request", requestId, APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST);
		if (typeof value.method !== "string" || value.method.length === 0) {
			throw invalidRequest("method must be a non-empty string", requestId);
		}
		if ("params" in value && !isJsonValue(value.params)) {
			throw invalidRequest("params must be a JSON value", requestId);
		}
		if ("id" in value) {
			if (requestId === null) throw invalidRequest("request id must be a string or integer", null);
			return {
				jsonrpc: "2.0",
				id: requestId,
				method: value.method,
				...(value.params === undefined ? {} : { params: value.params as JsonValue }),
			};
		}
		return {
			jsonrpc: "2.0",
			method: value.method,
			...(value.params === undefined ? {} : { params: value.params as JsonValue }),
		};
	}

	if (!("id" in value)) throw invalidRequest("response must include an id", null);
	const responseId = value.id === null ? null : requestId;
	if (responseId === null && value.id !== null)
		throw invalidRequest("response id must be a string, integer, or null", null);
	const hasResult = "result" in value;
	const hasError = "error" in value;
	if (hasResult === hasError) throw invalidRequest("response must contain exactly one of result or error", responseId);

	if (hasResult) {
		requireExactKeys(
			value,
			["jsonrpc", "id", "result"],
			"JSON-RPC success response",
			responseId,
			APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST,
		);
		if (!isJsonValue(value.result)) throw invalidRequest("result must be a JSON value", responseId);
		if (responseId === null) throw invalidRequest("success response id cannot be null", null);
		return { jsonrpc: "2.0", id: responseId, result: value.result };
	}

	requireExactKeys(
		value,
		["jsonrpc", "id", "error"],
		"JSON-RPC error response",
		responseId,
		APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST,
	);
	return { jsonrpc: "2.0", id: responseId, error: parseErrorObject(value.error, responseId) };
}

export function parseInitializeParams(value: unknown): InitializeParams {
	const object = requireObject(value, "initialize params");
	requireExactKeys(object, [
		"protocolVersion",
		"supportedProtocolVersions",
		"client",
		"capabilities",
		"requiredCapabilities",
		"limits",
		"auth",
	]);
	const protocolVersion = requireString(object.protocolVersion, "protocolVersion");
	const client = parsePeer(object.client, "client");
	const capabilities = parseCapabilities(object.capabilities);
	const supportedProtocolVersions = parseOptionalStringArray(
		object.supportedProtocolVersions,
		"supportedProtocolVersions",
	);
	const requiredCapabilities = parseRequiredCapabilities(object.requiredCapabilities);
	const limits = parseOptionalLimits(object.limits);
	let auth: { scheme: string } | undefined;
	if (object.auth !== undefined) {
		const authObject = requireObject(object.auth, "auth");
		requireExactKeys(authObject, ["scheme"], "auth");
		auth = { scheme: requireString(authObject.scheme, "auth.scheme") };
	}
	return {
		protocolVersion,
		...(supportedProtocolVersions === undefined ? {} : { supportedProtocolVersions }),
		client,
		capabilities,
		...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
		...(limits === undefined ? {} : { limits }),
		...(auth === undefined ? {} : { auth }),
	};
}

export function parseInitializedParams(value: unknown): InitializedParams {
	const object = requireObject(value, "initialized params");
	requireExactKeys(object, ["protocolVersion"], "initialized params");
	return { protocolVersion: requireString(object.protocolVersion, "protocolVersion") };
}

export function parseEventsReplayParams(value: unknown): EventsReplayParams {
	const object = requireObject(value, "events/replay params");
	requireExactKeys(object, ["afterCursor", "limit"], "events/replay params");
	return {
		afterCursor: requireNonNegativeInteger(object.afterCursor, "afterCursor"),
		...(object.limit === undefined ? {} : { limit: requirePositiveInteger(object.limit, "limit") }),
	};
}

export function parseProtocolClientRequest(request: JsonRpcRequest): ProtocolClientRequest {
	switch (request.method) {
		case "thread/start":
			return { ...request, method: "thread/start", params: parseThreadStartParams(request.params) };
		case "turn/start":
			return { ...request, method: "turn/start", params: parseTurnStartParams(request.params) };
		case "turn/steer":
			return { ...request, method: "turn/steer", params: parseTurnSteerParams(request.params) };
		case "turn/cancel":
			return { ...request, method: "turn/cancel", params: parseTurnCancelParams(request.params) };
		case "turn/interrupt":
			return { ...request, method: "turn/interrupt", params: parseTurnInterruptParams(request.params) };
		default:
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.METHOD_NOT_FOUND,
				`Unknown method: ${request.method}`,
				{
					requestId: request.id,
				},
			);
	}
}

export function parseApprovalResponseResult(value: unknown): ApprovalResponseResult {
	const object = requireObject(value, "approval response result");
	requireExactKeys(object, ["decision", "grantId"], "approval response result");
	if (object.decision !== "allow" && object.decision !== "deny") {
		throw invalidParams("approval decision must be 'allow' or 'deny'");
	}
	if (object.grantId !== undefined && typeof object.grantId !== "string") {
		throw invalidParams("grantId must be a string");
	}
	return {
		decision: object.decision,
		...(object.grantId === undefined ? {} : { grantId: object.grantId }),
	};
}

export function parseApprovalRequestParams(value: unknown): ApprovalRequestParams {
	const object = requireObject(value, "approval request params");
	requireExactKeys(object, ["threadId", "turnId", "itemId", "summary", "details"], "approval request params");
	return {
		threadId: requireString(object.threadId, "threadId"),
		turnId: requireString(object.turnId, "turnId"),
		itemId: requireString(object.itemId, "itemId"),
		summary: requireString(object.summary, "summary"),
		...(object.details === undefined ? {} : { details: requireJsonObject(object.details, "details") }),
	};
}

export function parseUserInputResponseResult(value: unknown): UserInputResponseResult {
	const object = requireObject(value, "user input response result");
	if ("value" in object) {
		requireExactKeys(object, ["value"], "user input response result");
		return { value: requireString(object.value, "value", true) };
	}
	requireExactKeys(object, ["cancelled"], "user input response result");
	if (object.cancelled !== true) throw invalidParams("cancelled must be true");
	return { cancelled: true };
}

export function parseUserInputRequestParams(value: unknown): UserInputRequestParams {
	const object = requireObject(value, "user input request params");
	requireExactKeys(object, ["threadId", "turnId", "itemId", "prompt", "placeholder"], "user input request params");
	return {
		threadId: requireString(object.threadId, "threadId"),
		turnId: requireString(object.turnId, "turnId"),
		itemId: requireString(object.itemId, "itemId"),
		prompt: requireString(object.prompt, "prompt"),
		...(object.placeholder === undefined
			? {}
			: { placeholder: requireString(object.placeholder, "placeholder", true) }),
	};
}

export function parseAppProtocolEvent(value: unknown): AppProtocolEvent {
	const object = requireObject(value, "protocol event");
	if (object.schemaVersion !== 1) throw invalidParams("event schemaVersion must be 1");
	if (typeof object.type !== "string") throw invalidParams("event type must be a string");

	switch (object.type) {
		case "thread/started":
		case "thread/completed": {
			requireExactKeys(object, ["type", "schemaVersion", "thread"], "thread event");
			return { type: object.type, schemaVersion: 1, thread: parseThread(object.thread, object.type) };
		}
		case "turn/started":
		case "turn/completed": {
			requireExactKeys(object, ["type", "schemaVersion", "turn"], "turn event");
			return { type: object.type, schemaVersion: 1, turn: parseTurn(object.turn, object.type) };
		}
		case "item/started":
		case "item/completed": {
			requireExactKeys(object, ["type", "schemaVersion", "item"], "item event");
			return { type: object.type, schemaVersion: 1, item: parseItem(object.item, object.type) };
		}
		case "item/delta": {
			requireExactKeys(
				object,
				["type", "schemaVersion", "threadId", "turnId", "itemId", "itemVersion", "deltaIndex", "delta"],
				"item delta event",
			);
			return {
				type: "item/delta",
				schemaVersion: 1,
				threadId: requireString(object.threadId, "threadId"),
				turnId: requireString(object.turnId, "turnId"),
				itemId: requireString(object.itemId, "itemId"),
				itemVersion: requirePositiveInteger(object.itemVersion, "itemVersion"),
				deltaIndex: requireNonNegativeInteger(object.deltaIndex, "deltaIndex"),
				delta: requireJsonObject(object.delta, "delta"),
			};
		}
		default:
			throw invalidParams(`Unknown event type: ${object.type}`);
	}
}

export function parseJsonRpcErrorObject(value: unknown): JsonRpcErrorObject {
	return parseErrorObject(value, null);
}

function parseThreadStartParams(value: unknown): ThreadStartParams {
	const object = requireObject(value, "thread/start params");
	requireExactKeys(object, ["schemaVersion", "cwd", "title", "metadata"], "thread/start params");
	requireSchemaVersion(object.schemaVersion);
	return {
		schemaVersion: 1,
		...(object.cwd === undefined ? {} : { cwd: requireString(object.cwd, "cwd") }),
		...(object.title === undefined ? {} : { title: requireString(object.title, "title") }),
		...(object.metadata === undefined ? {} : { metadata: requireJsonObject(object.metadata, "metadata") }),
	};
}

function parseTurnStartParams(value: unknown): TurnStartParams {
	const object = requireObject(value, "turn/start params");
	requireExactKeys(object, ["schemaVersion", "threadId", "input"], "turn/start params");
	requireSchemaVersion(object.schemaVersion);
	return {
		schemaVersion: 1,
		threadId: requireString(object.threadId, "threadId"),
		input: parseInput(object.input),
	};
}

function parseTurnSteerParams(value: unknown): TurnSteerParams {
	const object = requireObject(value, "turn/steer params");
	requireExactKeys(object, ["schemaVersion", "threadId", "turnId", "input"], "turn/steer params");
	requireSchemaVersion(object.schemaVersion);
	return {
		schemaVersion: 1,
		threadId: requireString(object.threadId, "threadId"),
		turnId: requireString(object.turnId, "turnId"),
		input: parseInput(object.input),
	};
}

function parseTurnCancelParams(value: unknown): TurnCancelParams {
	const object = requireObject(value, "turn/cancel params");
	requireExactKeys(object, ["schemaVersion", "threadId", "turnId", "reason"], "turn/cancel params");
	requireSchemaVersion(object.schemaVersion);
	return {
		schemaVersion: 1,
		threadId: requireString(object.threadId, "threadId"),
		turnId: requireString(object.turnId, "turnId"),
		...(object.reason === undefined ? {} : { reason: requireString(object.reason, "reason", true) }),
	};
}

function parseTurnInterruptParams(value: unknown): TurnInterruptParams {
	const object = requireObject(value, "turn/interrupt params");
	requireExactKeys(object, ["schemaVersion", "threadId", "turnId", "target", "reason"], "turn/interrupt params");
	requireSchemaVersion(object.schemaVersion);
	if (object.target !== "model" && object.target !== "process" && object.target !== "all") {
		throw invalidParams("interrupt target must be 'model', 'process', or 'all'");
	}
	return {
		schemaVersion: 1,
		threadId: requireString(object.threadId, "threadId"),
		turnId: requireString(object.turnId, "turnId"),
		target: object.target,
		...(object.reason === undefined ? {} : { reason: requireString(object.reason, "reason", true) }),
	};
}

function parseInput(value: unknown): ProtocolInputPart[] {
	if (!Array.isArray(value) || value.length === 0) throw invalidParams("input must be a non-empty array");
	return value.map((part, index) => {
		const object = requireObject(part, `input[${index}]`);
		if (object.type === "text") {
			requireExactKeys(object, ["type", "text"], `input[${index}]`);
			return { type: "text", text: requireString(object.text, `input[${index}].text`, true) };
		}
		if (object.type === "image") {
			requireExactKeys(object, ["type", "mimeType", "data"], `input[${index}]`);
			return {
				type: "image",
				mimeType: requireString(object.mimeType, `input[${index}].mimeType`),
				data: requireString(object.data, `input[${index}].data`),
			};
		}
		throw invalidParams(`input[${index}].type must be 'text' or 'image'`);
	});
}

function parseCapabilities(value: unknown): Partial<AppCapabilities> {
	const object = requireObject(value, "capabilities");
	requireExactKeys(object, CAPABILITY_NAMES, "capabilities");
	const result: Partial<AppCapabilities> = {};
	for (const name of CAPABILITY_NAMES) {
		if (object[name] !== undefined && typeof object[name] !== "boolean") {
			throw invalidParams(`capabilities.${name} must be a boolean`);
		}
		if (typeof object[name] === "boolean") result[name] = object[name];
	}
	return result;
}

function parseRequiredCapabilities(value: unknown): AppCapabilityName[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw invalidParams("requiredCapabilities must be an array");
	const result: AppCapabilityName[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !CAPABILITY_NAMES.includes(item as AppCapabilityName)) {
			throw invalidParams(`Unknown required capability: ${String(item)}`);
		}
		if (!result.includes(item as AppCapabilityName)) result.push(item as AppCapabilityName);
	}
	return result;
}

function parseOptionalLimits(value: unknown): Partial<AppProtocolLimits> | undefined {
	if (value === undefined) return undefined;
	const object = requireObject(value, "limits");
	requireExactKeys(object, LIMIT_NAMES, "limits");
	const result: Partial<AppProtocolLimits> = {};
	for (const name of LIMIT_NAMES) {
		if (object[name] !== undefined) result[name] = requirePositiveInteger(object[name], `limits.${name}`);
	}
	return result;
}

function parsePeer(value: unknown, label: string): { name: string; version: string } {
	const object = requireObject(value, label);
	requireExactKeys(object, ["name", "version"], label);
	return {
		name: requireString(object.name, `${label}.name`),
		version: requireString(object.version, `${label}.version`),
	};
}

function parseOptionalStringArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
		throw invalidParams(`${label} must be an array of non-empty strings`);
	}
	return [...new Set(value)];
}

function parseThread(value: unknown, eventType: "thread/started" | "thread/completed") {
	const object = requireObject(value, "thread");
	requireExactKeys(object, ["id", "version", "status", "createdAt", "updatedAt", "metadata"], "thread");
	const allowedStatuses = eventType === "thread/started" ? ["active"] : ["completed", "failed", "cancelled"];
	if (typeof object.status !== "string" || !allowedStatuses.includes(object.status)) {
		throw invalidParams(`Invalid thread status for ${eventType}`);
	}
	return {
		id: requireString(object.id, "thread.id"),
		version: requirePositiveInteger(object.version, "thread.version"),
		status: object.status as "active" | "completed" | "failed" | "cancelled",
		createdAt: requireTimestamp(object.createdAt, "thread.createdAt"),
		updatedAt: requireTimestamp(object.updatedAt, "thread.updatedAt"),
		...(object.metadata === undefined ? {} : { metadata: requireJsonObject(object.metadata, "thread.metadata") }),
	};
}

function parseTurn(value: unknown, eventType: "turn/started" | "turn/completed") {
	const object = requireObject(value, "turn");
	requireExactKeys(object, ["id", "threadId", "version", "status", "startedAt", "completedAt"], "turn");
	const allowedStatuses =
		eventType === "turn/started" ? ["running"] : ["completed", "failed", "cancelled", "interrupted"];
	if (typeof object.status !== "string" || !allowedStatuses.includes(object.status)) {
		throw invalidParams(`Invalid turn status for ${eventType}`);
	}
	if (eventType === "turn/completed" && object.completedAt === undefined) {
		throw invalidParams("completed turn must include completedAt");
	}
	return {
		id: requireString(object.id, "turn.id"),
		threadId: requireString(object.threadId, "turn.threadId"),
		version: requirePositiveInteger(object.version, "turn.version"),
		status: object.status as "running" | "completed" | "failed" | "cancelled" | "interrupted",
		startedAt: requireTimestamp(object.startedAt, "turn.startedAt"),
		...(object.completedAt === undefined
			? {}
			: { completedAt: requireTimestamp(object.completedAt, "turn.completedAt") }),
	};
}

function parseItem(value: unknown, eventType: "item/started" | "item/completed") {
	const object = requireObject(value, "item");
	requireExactKeys(object, ["id", "threadId", "turnId", "version", "kind", "status", "data"], "item");
	const allowedKinds = ["message", "tool_call", "command", "file_change", "approval", "user_input"];
	if (typeof object.kind !== "string" || !allowedKinds.includes(object.kind)) throw invalidParams("Invalid item kind");
	const allowedStatuses =
		eventType === "item/started" ? ["running"] : ["completed", "failed", "cancelled", "interrupted"];
	if (typeof object.status !== "string" || !allowedStatuses.includes(object.status)) {
		throw invalidParams(`Invalid item status for ${eventType}`);
	}
	return {
		id: requireString(object.id, "item.id"),
		threadId: requireString(object.threadId, "item.threadId"),
		turnId: requireString(object.turnId, "item.turnId"),
		version: requirePositiveInteger(object.version, "item.version"),
		kind: object.kind as "message" | "tool_call" | "command" | "file_change" | "approval" | "user_input",
		status: object.status as "running" | "completed" | "failed" | "cancelled" | "interrupted",
		...(object.data === undefined ? {} : { data: requireJsonObject(object.data, "item.data") }),
	};
}

function parseErrorObject(value: unknown, requestId: JsonRpcId | null): JsonRpcErrorObject {
	if (!isObject(value)) throw invalidRequest("error must be an object", requestId);
	const object = value;
	requireExactKeys(object, ["code", "message", "data"], "error", requestId, APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST);
	if (typeof object.code !== "number" || !Number.isInteger(object.code)) {
		throw invalidRequest("error.code must be an integer", requestId);
	}
	if (typeof object.message !== "string") throw invalidRequest("error.message must be a string", requestId);
	if (object.data !== undefined && !isJsonValue(object.data))
		throw invalidRequest("error.data must be a JSON value", requestId);
	return {
		code: object.code,
		message: object.message,
		...(object.data === undefined ? {} : { data: object.data }),
	};
}

function parsePossibleId(value: unknown): JsonRpcId | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireObject(value: unknown, label: string, requestId: JsonRpcId | null = null): Record<string, unknown> {
	if (!isObject(value)) throw invalidParams(`${label} must be an object`, requestId);
	return value;
}

function requireExactKeys(
	object: Record<string, unknown>,
	allowedKeys: readonly string[],
	label = "object",
	requestId: JsonRpcId | null = null,
	errorCode: number = APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS,
): void {
	const unknownKey = Object.keys(object).find((key) => !allowedKeys.includes(key));
	if (unknownKey !== undefined) {
		const message = `${label} contains unknown field '${unknownKey}'`;
		throw errorCode === APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST
			? invalidRequest(message, requestId)
			: invalidParams(message, requestId);
	}
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw invalidParams(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
	}
	return value;
}

function requireTimestamp(value: unknown, label: string): string {
	const timestamp = requireString(value, label);
	if (Number.isNaN(Date.parse(timestamp))) throw invalidParams(`${label} must be an ISO timestamp`);
	return timestamp;
}

function requireSchemaVersion(value: unknown): void {
	if (value !== 1) throw invalidParams("schemaVersion must be 1");
}

function requirePositiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw invalidParams(`${label} must be a positive integer`);
	}
	return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw invalidParams(`${label} must be a non-negative integer`);
	}
	return value;
}

function requireJsonObject(value: unknown, label: string): JsonObject {
	if (!isJsonObject(value)) throw invalidParams(`${label} must be a JSON object`);
	return value;
}

function invalidRequest(message: string, requestId: JsonRpcId | null): ProtocolValidationError {
	return new ProtocolValidationError(APP_PROTOCOL_ERROR_CODES.INVALID_REQUEST, message, { requestId });
}

function invalidParams(message: string, requestId: JsonRpcId | null = null): ProtocolValidationError {
	return new ProtocolValidationError(APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS, message, { requestId });
}
