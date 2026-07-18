/** Transport-independent application protocol contracts for daemon and UI clients. */

export type JsonRpcId = string | number;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface JsonRpcRequest<P = unknown> {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: P;
}

export interface JsonRpcNotification<P = unknown> {
	jsonrpc: "2.0";
	method: string;
	params?: P;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: JsonValue;
}

export interface JsonRpcSuccessResponse<R = unknown> {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: R;
}

export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccessResponse<R> | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const APP_PROTOCOL_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	NOT_INITIALIZED: -32002,
	ALREADY_INITIALIZED: -32003,
	INCOMPATIBLE_PROTOCOL: -32004,
	CAPABILITY_UNAVAILABLE: -32005,
	REPLAY_GAP: -32006,
	DUPLICATE_REQUEST: -32007,
	OVERLOADED: -32008,
} as const;

export type AppCapabilityName = keyof AppCapabilities;

export interface AppCapabilities {
	streaming: boolean;
	approvals: boolean;
	userInput: boolean;
	images: boolean;
	dynamicTools: boolean;
	terminal: boolean;
	replay: boolean;
}

export interface AppProtocolLimits {
	maxPendingRequests: number;
	maxQueuedTurns: number;
	maxEventReplayEvents: number;
	maxItemDeltaBytes: number;
}

export interface ProtocolPeerInfo {
	name: string;
	version: string;
}

export interface InitializeParams {
	protocolVersion: string;
	supportedProtocolVersions?: string[];
	client: ProtocolPeerInfo;
	capabilities: Partial<AppCapabilities>;
	requiredCapabilities?: AppCapabilityName[];
	limits?: Partial<AppProtocolLimits>;
	auth?: { scheme: string };
}

export interface InitializeResult {
	protocolVersion: string;
	server: ProtocolPeerInfo;
	capabilities: AppCapabilities;
	limits: AppProtocolLimits;
	featureFlags: string[];
	resume: {
		supported: boolean;
		earliestCursor: number;
		latestCursor: number;
	};
}

export interface InitializedParams {
	protocolVersion: string;
}

export type ProtocolInputPart = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

export interface ThreadStartParams {
	schemaVersion: 1;
	cwd?: string;
	title?: string;
	metadata?: JsonObject;
}

export interface TurnStartParams {
	schemaVersion: 1;
	threadId: string;
	input: ProtocolInputPart[];
}

export interface TurnSteerParams {
	schemaVersion: 1;
	threadId: string;
	turnId: string;
	input: ProtocolInputPart[];
}

export interface TurnCancelParams {
	schemaVersion: 1;
	threadId: string;
	turnId: string;
	reason?: string;
}

export interface TurnInterruptParams {
	schemaVersion: 1;
	threadId: string;
	turnId: string;
	target: "model" | "process" | "all";
	reason?: string;
}

export interface EventsReplayParams {
	afterCursor: number;
	limit?: number;
}

export type ProtocolClientRequest =
	| (JsonRpcRequest<ThreadStartParams> & { method: "thread/start"; params: ThreadStartParams })
	| (JsonRpcRequest<TurnStartParams> & { method: "turn/start"; params: TurnStartParams })
	| (JsonRpcRequest<TurnSteerParams> & { method: "turn/steer"; params: TurnSteerParams })
	| (JsonRpcRequest<TurnCancelParams> & { method: "turn/cancel"; params: TurnCancelParams })
	| (JsonRpcRequest<TurnInterruptParams> & { method: "turn/interrupt"; params: TurnInterruptParams });

export type ProtocolThreadStatus = "active" | "completed" | "failed" | "cancelled";
export type ProtocolTurnStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ProtocolItemStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ProtocolItemKind = "message" | "tool_call" | "command" | "file_change" | "approval" | "user_input";

export interface ProtocolThread {
	id: string;
	version: number;
	status: ProtocolThreadStatus;
	createdAt: string;
	updatedAt: string;
	metadata?: JsonObject;
}

export interface ProtocolTurn {
	id: string;
	threadId: string;
	version: number;
	status: ProtocolTurnStatus;
	startedAt: string;
	completedAt?: string;
}

export interface ProtocolItem {
	id: string;
	threadId: string;
	turnId: string;
	version: number;
	kind: ProtocolItemKind;
	status: ProtocolItemStatus;
	data?: JsonObject;
}

export type AppProtocolEvent =
	| { type: "thread/started"; schemaVersion: 1; thread: ProtocolThread }
	| { type: "thread/completed"; schemaVersion: 1; thread: ProtocolThread }
	| { type: "turn/started"; schemaVersion: 1; turn: ProtocolTurn }
	| { type: "turn/completed"; schemaVersion: 1; turn: ProtocolTurn }
	| { type: "item/started"; schemaVersion: 1; item: ProtocolItem }
	| {
			type: "item/delta";
			schemaVersion: 1;
			threadId: string;
			turnId: string;
			itemId: string;
			itemVersion: number;
			deltaIndex: number;
			delta: JsonObject;
	  }
	| { type: "item/completed"; schemaVersion: 1; item: ProtocolItem };

export interface AppEventParams {
	protocolVersion: string;
	cursor: number;
	timestamp: string;
	event: AppProtocolEvent;
}

export type AppEventNotification = JsonRpcNotification<AppEventParams> & {
	method: AppProtocolEvent["type"];
	params: AppEventParams;
};

export interface EventsReplayResult {
	events: AppEventNotification[];
	earliestCursor: number;
	latestCursor: number;
	nextCursor: number;
	hasMore: boolean;
}

export interface ApprovalRequestParams {
	threadId: string;
	turnId: string;
	itemId: string;
	summary: string;
	details?: JsonObject;
}

export interface ApprovalResponseResult {
	decision: "allow" | "deny";
	grantId?: string;
}

export interface UserInputRequestParams {
	threadId: string;
	turnId: string;
	itemId: string;
	prompt: string;
	placeholder?: string;
}

export type UserInputResponseResult = { value: string } | { cancelled: true };

export type ServerReverseRequest =
	| (JsonRpcRequest<ApprovalRequestParams> & {
			method: "approval/request";
			params: ApprovalRequestParams;
	  })
	| (JsonRpcRequest<UserInputRequestParams> & {
			method: "userInput/request";
			params: UserInputRequestParams;
	  });

export type ServerReverseRequestSpec =
	| { method: "approval/request"; params: ApprovalRequestParams }
	| { method: "userInput/request"; params: UserInputRequestParams };

export type ReverseResponseAction =
	| {
			kind: "reverse_response";
			id: JsonRpcId;
			method: "approval/request";
			result: ApprovalResponseResult;
	  }
	| {
			kind: "reverse_response";
			id: JsonRpcId;
			method: "userInput/request";
			result: UserInputResponseResult;
	  }
	| {
			kind: "reverse_error";
			id: JsonRpcId;
			method: ServerReverseRequest["method"];
			error: JsonRpcErrorObject;
	  };

export type AppProtocolAction =
	| { kind: "initialized"; protocolVersion: string }
	| { kind: "request"; request: ProtocolClientRequest }
	| ReverseResponseAction;

export interface AppProtocolIssue {
	code: number;
	message: string;
	data?: JsonValue;
}

export interface AppProtocolReceiveResult {
	outbound: JsonRpcMessage[];
	actions: AppProtocolAction[];
	issues: AppProtocolIssue[];
}

export type AppProtocolConnectionState = "awaiting_initialize" | "awaiting_initialized" | "ready";

export interface AppProtocolServerOptions {
	server: ProtocolPeerInfo;
	protocolVersions: string[];
	capabilities: AppCapabilities;
	limits: AppProtocolLimits;
	featureFlags?: string[];
	allowedAuthSchemes?: string[];
}
