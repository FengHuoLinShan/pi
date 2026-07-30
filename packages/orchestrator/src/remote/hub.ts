import { randomUUID } from "node:crypto";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { InstanceSummary } from "../ipc/protocol.ts";
import type { IpcRequestHandler } from "../ipc/server.ts";
import type { RemoteActivity, RemoteEvent, RemoteSnapshot } from "./protocol.ts";

const DEFAULT_JOURNAL_SIZE = 2_000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;

type RpcStreamHandle = NonNullable<ReturnType<IpcRequestHandler["openRpcStream"]>>;

interface PendingCommand {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export class RemoteInstanceHub {
	private readonly instance: InstanceSummary;
	private readonly stream: RpcStreamHandle;
	private readonly journalSize: number;
	private readonly journal: RemoteEvent[] = [];
	private readonly subscribers = new Set<(event: RemoteEvent) => void>();
	private readonly pendingCommands = new Map<string, PendingCommand>();
	private readonly pendingUiRequests = new Map<string, RpcExtensionUIRequest>();
	private sequence = 0;
	private closed = false;

	constructor(instance: InstanceSummary, handler: IpcRequestHandler, journalSize = DEFAULT_JOURNAL_SIZE) {
		this.instance = instance;
		this.journalSize = journalSize;
		const stream = handler.openRpcStream(
			instance.id,
			(response) => this.handleRpcResponse(response),
			(event) => this.emit("session_event", event),
			(request) => this.handleUiRequest(request),
		);
		if (!stream) {
			throw new Error(`Unknown or offline instance: ${instance.id}`);
		}
		this.stream = stream;
	}

	private emit(kind: RemoteEvent["kind"], payload: RemoteEvent["payload"]): void {
		if (this.closed) {
			return;
		}
		const event: RemoteEvent = {
			sequence: ++this.sequence,
			timestamp: new Date().toISOString(),
			instanceId: this.instance.id,
			kind,
			payload,
		};
		this.journal.push(event);
		if (this.journal.length > this.journalSize) {
			this.journal.splice(0, this.journal.length - this.journalSize);
		}
		for (const subscriber of this.subscribers) {
			subscriber(event);
		}
	}

	private handleRpcResponse(response: RpcResponse): void {
		this.emit("rpc_response", response);
		if (!response.id) {
			return;
		}
		const pending = this.pendingCommands.get(response.id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingCommands.delete(response.id);
		pending.resolve(response);
	}

	private handleUiRequest(request: RpcExtensionUIRequest): void {
		if (
			request.method === "select" ||
			request.method === "confirm" ||
			request.method === "input" ||
			request.method === "editor"
		) {
			this.pendingUiRequests.set(request.id, request);
		}
		this.emit("ui_request", request);
	}

	async sendCommand(command: RpcCommand): Promise<RpcResponse> {
		if (this.closed) {
			throw new Error(`Remote stream is closed for instance ${this.instance.id}`);
		}
		const id = command.id ?? `remote_${randomUUID()}`;
		const request = { ...command, id } as RpcCommand;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCommands.delete(id);
				reject(new Error(`RPC command timed out: ${command.type}`));
			}, COMMAND_TIMEOUT_MS);
			this.pendingCommands.set(id, { resolve, reject, timer });
			void this.stream.handleRequest(request).catch((error: unknown) => {
				clearTimeout(timer);
				this.pendingCommands.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async sendUiResponse(response: RpcExtensionUIResponse): Promise<void> {
		if (this.closed) {
			throw new Error(`Remote stream is closed for instance ${this.instance.id}`);
		}
		await this.stream.handleRequest(response);
		this.pendingUiRequests.delete(response.id);
		this.emit("ui_response", response);
	}

	subscribe(afterSequence: number, subscriber: (event: RemoteEvent) => void): () => void {
		for (const event of this.journal) {
			if (event.sequence > afterSequence) {
				subscriber(event);
			}
		}
		this.subscribers.add(subscriber);
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	async getSnapshot(): Promise<RemoteSnapshot> {
		const state = await this.sendCommand({ type: "get_state" });
		const messages = await this.sendCommand({ type: "get_messages" });
		const tree = await this.sendCommand({ type: "get_tree" });
		const stats = await this.sendCommand({ type: "get_session_stats" });
		const models = await this.sendCommand({ type: "get_available_models" });
		return {
			instance: this.instance,
			state,
			messages,
			tree,
			stats,
			models,
			pendingUiRequests: [...this.pendingUiRequests.values()],
			latestSequence: this.sequence,
		};
	}

	async getActivity(): Promise<RemoteActivity> {
		return {
			instance: this.instance,
			state: await this.sendCommand({ type: "get_state" }),
			pendingUiRequests: [...this.pendingUiRequests.values()],
			latestSequence: this.sequence,
		};
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.stream.close();
		for (const [id, pending] of this.pendingCommands) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`Remote stream closed before RPC response: ${id}`));
		}
		this.pendingCommands.clear();
		this.subscribers.clear();
		this.pendingUiRequests.clear();
	}
}
