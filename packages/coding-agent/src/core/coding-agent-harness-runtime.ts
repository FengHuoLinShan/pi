import {
	type AfterToolCallContext,
	Agent,
	type AgentContext,
	type AgentEvent,
	type AgentHarness,
	type AgentHarnessEvent,
	type AgentHarnessStreamOptions,
	type AgentLoopDetection,
	type AgentMessage,
	type AgentOptions,
	type AgentRunBudget,
	type AgentState,
	type BeforeToolCallContext,
	type PrepareNextTurnContext,
	type QueueMode,
	restoreAgentHarness,
	Session,
	type ToolPolicyAdapter,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ImageContent, Models, TextContent } from "@earendil-works/pi-ai";
import { AgentHarnessSessionStorageAdapter } from "./agent-harness-session-adapter.ts";
import type { SessionManager } from "./session-manager.ts";

export interface CodingAgentHarnessRuntimeOptions extends AgentOptions {
	models: Models;
	sessionManager: SessionManager;
	cwd: string;
	getStreamOptions?: () => AgentHarnessStreamOptions;
	runBudget?: AgentRunBudget;
	loopDetection?: AgentLoopDetection;
	toolPolicy?: ToolPolicyAdapter;
}

function createUserMessage(text: string, images?: ImageContent[]): AgentMessage {
	const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

function isAgentEvent(event: AgentHarnessEvent): event is AgentEvent {
	return (
		event.type === "agent_start" ||
		event.type === "agent_end" ||
		event.type === "agent_termination" ||
		event.type === "turn_start" ||
		event.type === "turn_end" ||
		event.type === "message_start" ||
		event.type === "message_update" ||
		event.type === "message_end" ||
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	);
}

/**
 * Compatibility facade that keeps the public `Agent` surface while delegating turns,
 * queues, persistence, and recovery to the production AgentHarness.
 */
export class CodingAgentHarnessRuntime extends Agent {
	private readonly projectedState: AgentState;
	private readonly harnessListeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly models: Models;
	private readonly sessionManager: SessionManager;
	private readonly cwd: string;
	private readonly getStreamOptions?: () => AgentHarnessStreamOptions;
	private readonly runBudget?: AgentRunBudget;
	private readonly loopDetection?: AgentLoopDetection;
	private readonly toolPolicy?: ToolPolicyAdapter;
	private harnessRuntime?: AgentHarness;
	private unsubscribeHarness?: () => void;
	private streaming = false;
	private streamingMessage?: AgentMessage;
	private pendingToolCalls = new Set<string>();
	private lastErrorMessage?: string;
	private pendingControl: Promise<void> = Promise.resolve();
	private pendingControlError?: Error;
	private nextScheduledQueueItemId = 0;
	private scheduledQueueItems = new Map<number, "steer" | "follow_up">();
	private lastTurnEnd?: Extract<AgentEvent, { type: "turn_end" }>;

	constructor(options: CodingAgentHarnessRuntimeOptions) {
		super(options);
		this.models = options.models;
		this.sessionManager = options.sessionManager;
		this.cwd = options.cwd;
		this.getStreamOptions = options.getStreamOptions;
		this.runBudget = options.runBudget ? { ...options.runBudget } : undefined;
		this.loopDetection = options.loopDetection ? { ...options.loopDetection } : undefined;
		this.toolPolicy = options.toolPolicy;
		const baseState = super.state;
		const owner = this;
		this.projectedState = {
			get systemPrompt() {
				return baseState.systemPrompt;
			},
			set systemPrompt(value) {
				baseState.systemPrompt = value;
			},
			get model() {
				return baseState.model;
			},
			set model(value) {
				baseState.model = value;
			},
			get thinkingLevel() {
				return baseState.thinkingLevel;
			},
			set thinkingLevel(value) {
				baseState.thinkingLevel = value;
			},
			get tools() {
				return baseState.tools;
			},
			set tools(value) {
				baseState.tools = value;
			},
			get messages() {
				return baseState.messages;
			},
			set messages(value) {
				baseState.messages = value;
			},
			get isStreaming() {
				return owner.streaming;
			},
			get streamingMessage() {
				return owner.streamingMessage;
			},
			get pendingToolCalls() {
				return owner.pendingToolCalls;
			},
			get errorMessage() {
				return owner.lastErrorMessage;
			},
		};
	}

	override get state(): AgentState {
		return this.projectedState;
	}

	get harness(): AgentHarness {
		if (!this.harnessRuntime) throw new Error("CodingAgentHarnessRuntime has not been initialized");
		return this.harnessRuntime;
	}

	async initialize(): Promise<void> {
		if (this.harnessRuntime) return;
		const session = new Session(new AgentHarnessSessionStorageAdapter(this.sessionManager));
		const restored = await restoreAgentHarness({
			env: new NodeExecutionEnv({ cwd: this.cwd }),
			session,
			models: this.models,
			model: this.state.model,
			thinkingLevel: this.state.thinkingLevel,
			tools: this.state.tools,
			activeToolNames: this.state.tools.map((tool) => tool.name),
			systemPrompt: () => this.state.systemPrompt,
			convertToLlm: this.convertToLlm,
			streamFn: async (model, context, options) => await this.streamFn(model, context, options),
			streamOptions: this.getStreamOptions?.(),
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			runBudget: this.runBudget,
			loopDetection: this.loopDetection,
			toolPolicy: this.toolPolicy,
		});
		this.harnessRuntime = restored.harness;
		this.state.model = this.harness.getModel();
		this.state.thinkingLevel = this.harness.getThinkingLevel();
		this.state.tools = this.harness.getActiveTools();
		this.state.messages = (await session.buildContext()).messages;
		this.installHarnessHooks();
	}

	private installHarnessHooks(): void {
		this.unsubscribeHarness = this.harness.subscribe(async (event, signal) => {
			if (!isAgentEvent(event) || event.type === "message_end") return;
			await this.dispatch(event, signal ?? this.harness.signal ?? new AbortController().signal);
		});
		this.harness.on("before_message_persist", async (event, _context, signal) => {
			const index = this.state.messages.length;
			this.state.messages.push(event.message);
			try {
				await this.dispatch(
					{ type: "message_end", message: event.message },
					signal ?? this.harness.signal ?? new AbortController().signal,
				);
			} catch (error) {
				this.state.messages = this.state.messages.slice(0, index);
				throw error;
			}
			const message = this.state.messages[index] ?? event.message;
			return message === event.message ? undefined : { message };
		});
		this.harness.on("context", async (event, _context, signal) => {
			if (!this.transformContext) return undefined;
			return { messages: await this.transformContext(event.messages, signal) };
		});
		this.harness.on("before_provider_payload", async (event) => {
			const payload = await this.onPayload?.(event.payload, event.model);
			return payload === undefined ? undefined : { payload };
		});
		this.harness.on("after_provider_response", async (event) => {
			await this.onResponse?.({ status: event.status, headers: event.headers }, this.state.model);
		});
		this.harness.on("tool_call", async (event, _context, signal) => {
			if (!this.beforeToolCall) return undefined;
			return await this.beforeToolCall(
				this.createBeforeToolCallContext(event.toolCallId, event.toolName, event.input),
				signal,
			);
		});
		this.harness.on("tool_result", async (event, _context, signal) => {
			if (!this.afterToolCall) return undefined;
			return await this.afterToolCall(
				{
					...this.createBeforeToolCallContext(event.toolCallId, event.toolName, event.input),
					result: { content: event.content, details: event.details },
					isError: event.isError,
				} satisfies AfterToolCallContext,
				signal,
			);
		});
		this.harness.on("save_point", async (_event, _context, signal) => {
			await this.refreshNextTurn(signal);
		});
	}

	private createBeforeToolCallContext(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
	): BeforeToolCallContext {
		const assistantMessage = [...this.state.messages]
			.reverse()
			.find((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall"));
		if (!assistantMessage || assistantMessage.role !== "assistant") {
			throw new Error(`Assistant message for tool call ${toolCallId} was not found`);
		}
		const toolCall = assistantMessage.content.find(
			(part) => part.type === "toolCall" && part.id === toolCallId && part.name === toolName,
		);
		if (!toolCall || toolCall.type !== "toolCall") throw new Error(`Tool call ${toolCallId} was not found`);
		return {
			assistantMessage,
			toolCall,
			args,
			context: this.createContext(),
		};
	}

	private createContext(): AgentContext {
		return {
			systemPrompt: this.state.systemPrompt,
			messages: [...this.state.messages],
			tools: [...this.state.tools],
		};
	}

	private async refreshNextTurn(signal?: AbortSignal): Promise<void> {
		if ((!this.prepareNextTurnWithContext && !this.prepareNextTurn) || !this.lastTurnEnd) return;
		if (this.lastTurnEnd.message.role !== "assistant") return;
		const turn: PrepareNextTurnContext = {
			message: this.lastTurnEnd.message,
			toolResults: this.lastTurnEnd.toolResults,
			context: this.createContext(),
			newMessages: [],
		};
		const update = this.prepareNextTurnWithContext
			? await this.prepareNextTurnWithContext(turn, signal)
			: await this.prepareNextTurn?.(signal);
		if (update?.context?.systemPrompt !== undefined) this.state.systemPrompt = update.context.systemPrompt;
		if (update?.context?.tools) this.state.tools = update.context.tools;
		if (update?.model) this.state.model = update.model;
		if (update?.thinkingLevel) this.state.thinkingLevel = update.thinkingLevel;
		this.synchronizeHarness();
	}

	private synchronizeHarness(): void {
		this.harness.synchronizeRuntimeState({
			model: this.state.model,
			thinkingLevel: this.state.thinkingLevel,
			tools: this.state.tools,
		});
	}

	private async prepareHarness(): Promise<void> {
		await this.flushControl();
		this.synchronizeHarness();
		await this.harness.setStreamOptions(this.getStreamOptions?.() ?? {});
		await this.harness.setSteeringMode(this.steeringMode);
		await this.harness.setFollowUpMode(this.followUpMode);
	}

	private async dispatch(event: AgentEvent, signal: AbortSignal): Promise<void> {
		if (event.type === "message_start" || event.type === "message_update") {
			this.streamingMessage = event.message;
		} else if (event.type === "tool_execution_start") {
			this.pendingToolCalls = new Set(this.pendingToolCalls).add(event.toolCallId);
		} else if (event.type === "tool_execution_end") {
			const pending = new Set(this.pendingToolCalls);
			pending.delete(event.toolCallId);
			this.pendingToolCalls = pending;
		} else if (event.type === "turn_end") {
			this.lastTurnEnd = event;
			if (event.message.role === "assistant" && event.message.errorMessage) {
				this.lastErrorMessage = event.message.errorMessage;
			}
		} else if (event.type === "agent_end") {
			this.streamingMessage = undefined;
		}
		for (const listener of this.harnessListeners) await listener(event, signal);
	}

	override subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.harnessListeners.add(listener);
		return () => this.harnessListeners.delete(listener);
	}

	override async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	override async prompt(input: string, images?: ImageContent[]): Promise<void>;
	override async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.streaming) throw new Error("Agent is already processing a prompt");
		await this.prepareHarness();
		const messages = Array.isArray(input)
			? input
			: typeof input === "string"
				? [createUserMessage(input, images)]
				: [input];
		this.streaming = true;
		this.lastErrorMessage = undefined;
		try {
			await this.harness.promptMessages(messages);
		} finally {
			this.streaming = false;
			this.streamingMessage = undefined;
			this.pendingToolCalls = new Set();
		}
	}

	override async continue(): Promise<void> {
		if (this.streaming) throw new Error("Agent is already processing");
		await this.prepareHarness();
		this.streaming = true;
		this.lastErrorMessage = undefined;
		try {
			await this.harness.continue(this.state.messages);
		} finally {
			this.streaming = false;
			this.streamingMessage = undefined;
			this.pendingToolCalls = new Set();
		}
	}

	override steer(message: AgentMessage): void {
		this.scheduleQueue(message, "steer");
	}

	override followUp(message: AgentMessage): void {
		this.scheduleQueue(message, "follow_up");
	}

	private scheduleQueue(message: AgentMessage, queue: "steer" | "follow_up"): void {
		const queueItemId = this.nextScheduledQueueItemId++;
		this.scheduledQueueItems.set(queueItemId, queue);
		this.scheduleControl(async () => {
			try {
				if (!this.scheduledQueueItems.has(queueItemId)) return;
				if (queue === "steer") await this.harness.queueSteeringMessage(message);
				else await this.harness.queueFollowUpMessage(message);
			} finally {
				this.scheduledQueueItems.delete(queueItemId);
			}
		});
	}

	private scheduleControl(operation: () => Promise<void>): void {
		this.pendingControl = this.pendingControl.then(operation).catch((error: unknown) => {
			this.pendingControlError = error instanceof Error ? error : new Error(String(error));
		});
	}

	private async flushControl(): Promise<void> {
		await this.pendingControl;
		if (!this.pendingControlError) return;
		const error = this.pendingControlError;
		this.pendingControlError = undefined;
		throw error;
	}

	override clearSteeringQueue(): void {
		this.clearScheduledQueue("steer");
		this.scheduleControl(async () => {
			await this.harness.clearSteeringQueue();
		});
	}

	override clearFollowUpQueue(): void {
		this.clearScheduledQueue("follow_up");
		this.scheduleControl(async () => {
			await this.harness.clearFollowUpQueue();
		});
	}

	override clearAllQueues(): void {
		this.scheduledQueueItems.clear();
		this.scheduleControl(async () => {
			await this.harness.clearQueues();
		});
	}

	private clearScheduledQueue(queue: "steer" | "follow_up"): void {
		for (const [queueItemId, scheduledQueue] of this.scheduledQueueItems) {
			if (scheduledQueue === queue) this.scheduledQueueItems.delete(queueItemId);
		}
	}

	override hasQueuedMessages(): boolean {
		return this.scheduledQueueItems.size > 0 || this.harness.hasQueuedMessages();
	}

	override get signal(): AbortSignal | undefined {
		return this.harnessRuntime?.signal;
	}

	override abort(): void {
		if (!this.harnessRuntime) return;
		this.scheduleControl(async () => {
			await this.harness.abort();
		});
	}

	override async waitForIdle(): Promise<void> {
		await this.harnessRuntime?.waitForIdle();
		await this.flushControl();
	}

	override reset(): void {
		this.state.messages = [];
		this.streaming = false;
		this.streamingMessage = undefined;
		this.pendingToolCalls = new Set();
		this.lastErrorMessage = undefined;
		this.clearAllQueues();
	}

	override set steeringMode(mode: QueueMode) {
		super.steeringMode = mode;
		if (this.harnessRuntime) void this.harnessRuntime.setSteeringMode(mode);
	}

	override get steeringMode(): QueueMode {
		return super.steeringMode;
	}

	override set followUpMode(mode: QueueMode) {
		super.followUpMode = mode;
		if (this.harnessRuntime) void this.harnessRuntime.setFollowUpMode(mode);
	}

	override get followUpMode(): QueueMode {
		return super.followUpMode;
	}

	disposeHarness(): void {
		this.unsubscribeHarness?.();
		this.unsubscribeHarness = undefined;
	}
}
