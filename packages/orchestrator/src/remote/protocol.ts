import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { InstanceSummary } from "../ipc/protocol.ts";

export type RemoteEventKind = "session_event" | "rpc_response" | "ui_request" | "ui_response";

export interface RemoteEvent {
	sequence: number;
	timestamp: string;
	instanceId: string;
	kind: RemoteEventKind;
	payload: AgentSessionEvent | RpcResponse | RpcExtensionUIRequest | RpcExtensionUIResponse;
}

export interface RemoteSnapshot {
	instance: InstanceSummary;
	state: RpcResponse;
	messages: RpcResponse;
	tree: RpcResponse;
	stats: RpcResponse;
	models: RpcResponse;
	pendingUiRequests: RpcExtensionUIRequest[];
	latestSequence: number;
}

export interface RemoteActivity {
	instance: InstanceSummary;
	state: RpcResponse;
	pendingUiRequests: RpcExtensionUIRequest[];
	latestSequence: number;
}

export interface RemoteCommandRequest {
	command: RpcCommand;
}

export interface RemoteUiResponseRequest {
	response: RpcExtensionUIResponse;
}

export interface RemoteSpawnRequest {
	cwd: string;
	label?: string;
	approveProject?: boolean;
}

export interface RemoteResumeRequest {
	approveProject?: boolean;
}

export interface RemoteResumeResponse {
	type: "spawn_result";
	ok: true;
	instance: InstanceSummary;
	resumeSessionFile: string;
	sourceInstanceId: string;
}

export interface RemoteFileUploadRequest {
	filename: string;
	mimeType?: string;
	dataBase64: string;
}

export interface RemoteFileUploadResponse {
	path: string;
	filename: string;
	mimeType?: string;
	size: number;
}

export interface RemoteHealthResponse {
	ok: true;
	protocolVersion: 1;
}

export interface RemoteErrorResponse {
	ok: false;
	error: string;
}
