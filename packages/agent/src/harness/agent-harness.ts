import type {
	AssistantMessage,
	ImageContent,
	Model,
	Models,
	ModelsSimpleStreamOptions,
	UserMessage,
} from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "../agent-loop.ts";
import type { ToolPolicyAdapter } from "../tool-policy.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopDetection,
	AgentMessage,
	AgentRunBudget,
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction/compaction.ts";
import { type AgentHarnessHooks, DefaultAgentHarnessHooks, type HookHandler, type ResultOf } from "./hooks.ts";
import { convertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { type RuntimeQueueName, type RuntimeRecoveryResult, SessionRuntimeEventStore } from "./runtime-events/index.ts";
import { uuidv7 } from "./session/uuid.ts";
import { formatSkillInvocation } from "./skills.ts";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessHookContext,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	PromptTemplate,
	Session,
	SessionTreeEntry,
	Skill,
} from "./types.ts";
import { AgentHarnessError, BranchSummaryError, CompactionError, SessionError, toError } from "./types.ts";

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
		env: streamOptions?.env ? { ...streamOptions.env } : undefined,
		thinkingBudgets: streamOptions?.thinkingBudgets ? { ...streamOptions.thinkingBudgets } : undefined,
	};
}

function findDuplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (Object.hasOwn(patch, "temperature")) result.temperature = patch.temperature;
	if (Object.hasOwn(patch, "maxTokens")) result.maxTokens = patch.maxTokens;
	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "websocketConnectTimeoutMs")) {
		result.websocketConnectTimeoutMs = patch.websocketConnectTimeoutMs;
	}
	if (Object.hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (Object.hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;
	if (Object.hasOwn(patch, "env")) result.env = patch.env ? { ...patch.env } : undefined;
	if (Object.hasOwn(patch, "thinkingBudgets")) {
		result.thinkingBudgets = patch.thinkingBudgets ? { ...patch.thinkingBudgets } : undefined;
	}
	if (Object.hasOwn(patch, "transformHeaders")) result.transformHeaders = patch.transformHeaders;

	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}

function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}

function normalizeHookError(error: unknown): AgentHarnessError {
	return normalizeHarnessError(error, "hook");
}

interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
	runBudget?: AgentRunBudget;
	loopDetection?: AgentLoopDetection;
}

interface DurableQueuedMessage<TMessage extends AgentMessage = AgentMessage> {
	message: TMessage;
	queueItemId?: string;
}

interface DurablePendingWrite {
	write: PendingSessionWrite;
	pendingWriteId?: string;
	targetEntryId?: string;
}

function isRestorableQueueMessage(value: unknown): value is AgentMessage {
	if (typeof value !== "object" || value === null || !("role" in value)) return false;
	const role = (value as { role?: unknown }).role;
	return (role === "user" || role === "custom") && "content" in value;
}

function isPendingSessionWrite(value: unknown): value is PendingSessionWrite {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	return [
		"message",
		"model_change",
		"thinking_level_change",
		"active_tools_change",
		"custom",
		"custom_message",
		"label",
		"session_info",
		"leaf",
	].includes(String((value as { type?: unknown }).type));
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

export interface RestoredAgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	harness: AgentHarness<TSkill, TPromptTemplate, TTool>;
	recovery: RuntimeRecoveryResult;
}

export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly env: ExecutionEnv;
	private session: Session;
	readonly models: Models;
	readonly runtimeEvents?: SessionRuntimeEventStore;
	readonly toolPolicy?: ToolPolicyAdapter;
	private phase: AgentHarnessPhase = "idle";
	private acceptsTurnInput = false;
	private runAbortController?: AbortController;
	private runPromise?: Promise<void>;
	private pendingSessionWrites: DurablePendingWrite[] = [];
	private pendingSessionWriteBarrier: Promise<void> = Promise.resolve();
	private sessionWritesSealed = false;
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private convertMessages: NonNullable<AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["convertToLlm"]>;
	private streamOptions: AgentHarnessStreamOptions;
	private streamFn?: StreamFn;
	private runBudget?: AgentRunBudget;
	private loopDetection?: AgentLoopDetection;
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private tools = new Map<string, TTool>();
	private activeToolNames: string[];
	private steerQueue: DurableQueuedMessage[] = [];
	private steeringQueueMode: QueueMode;
	private followUpQueue: DurableQueuedMessage[] = [];
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: DurableQueuedMessage[] = [];
	private nextTurnContext?: AgentContext;
	private consumedQueueItemIds: string[] = [];
	private activeOperationId?: string;
	private activeTurnId?: string;
	private activeProviderRequestId?: string;
	readonly hooks: AgentHarnessHooks<AgentHarnessEvent<TSkill, TPromptTemplate>, AgentHarnessHookContext>;

	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
		this.env = options.env;
		this.session = options.session;
		this.models = options.models;
		this.runtimeEvents = options.runtimeEvents;
		this.toolPolicy = options.toolPolicy;
		const hookContext: AgentHarnessHookContext = {
			env: this.env,
			getSession: () => this.session,
			getPhase: () => this.getPhase(),
			isIdle: () => this.isIdle(),
			appendMessage: async (message) => await this.appendMessage(message),
			getPendingWrites: () => this.getPendingWrites(),
		};
		this.hooks =
			options.hooks ??
			new DefaultAgentHarnessHooks<AgentHarnessEvent<TSkill, TPromptTemplate>, AgentHarnessHookContext>({
				context: hookContext,
			});
		if (options.hooks) this.hooks.setContext(hookContext);
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.streamFn = options.streamFn;
		this.systemPrompt = options.systemPrompt;
		this.convertMessages = options.convertToLlm ?? convertToLlm;
		this.runBudget = options.runBudget ? { ...options.runBudget } : undefined;
		this.loopDetection = options.loopDetection ? { ...options.loopDetection } : undefined;
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(this.activeToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(this.activeToolNames);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
		this.restoreRuntimeQueues();
		this.restoreRuntimePendingWrites();
	}

	private restoreRuntimePendingWrites(): void {
		if (!this.runtimeEvents) return;
		const pendingWrites = Object.values(this.runtimeEvents.getState().pendingWrites)
			.filter((write) => write.status === "pending")
			.sort((left, right) => left.enqueuedSequence - right.enqueuedSequence);
		for (const pending of pendingWrites) {
			if (!isPendingSessionWrite(pending.write)) continue;
			this.pendingSessionWrites.push({
				write: pending.write,
				pendingWriteId: pending.pendingWriteId,
				targetEntryId: pending.targetEntryId,
			});
		}
	}

	private restoreRuntimeQueues(): void {
		if (!this.runtimeEvents) return;
		const items = Object.values(this.runtimeEvents.getState().queueItems)
			.filter((item) => item.status === "queued")
			.sort((left, right) => left.enqueuedSequence - right.enqueuedSequence);
		for (const item of items) {
			if (!isRestorableQueueMessage(item.message)) continue;
			if (item.queue === "steer") {
				this.steerQueue.push({ message: item.message, queueItemId: item.queueItemId });
			} else if (item.queue === "follow_up") {
				this.followUpQueue.push({ message: item.message, queueItemId: item.queueItemId });
			} else if (item.queue === "next_turn") {
				this.nextTurnQueue.push({ message: item.message, queueItemId: item.queueItemId });
			}
		}
	}

	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		await this.emitHook(event, signal);
	}

	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		try {
			await this.hooks.emit(event, signal);
		} catch (error) {
			throw normalizeHookError(error);
		}
	}

	private async emitHook<TType extends AgentHarnessOwnEvent<TSkill, TPromptTemplate>["type"]>(
		event: Extract<AgentHarnessOwnEvent<TSkill, TPromptTemplate>, { type: TType }>,
		signal?: AbortSignal,
	): Promise<ResultOf<Extract<AgentHarnessOwnEvent<TSkill, TPromptTemplate>, { type: TType }>> | undefined> {
		try {
			return await this.hooks.emit(event, signal);
		} catch (error) {
			throw normalizeHookError(error);
		}
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const result = await this.emitHook({
			type: "before_provider_request",
			model,
			sessionId,
			streamOptions: cloneStreamOptions(streamOptions),
		});
		return applyStreamOptionsPatch(streamOptions, result?.streamOptions);
	}

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const result = await this.emitHook({ type: "before_provider_payload", model, payload });
		return result?.payload ?? payload;
	}

	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: this.steerQueue.map((item) => item.message),
			followUp: this.followUpQueue.map((item) => item.message),
			nextTurn: this.nextTurnQueue.map((item) => item.message),
		});
	}

	private async enqueueMessage(
		queue: RuntimeQueueName,
		messages: Array<DurableQueuedMessage>,
		message: AgentMessage,
	): Promise<void> {
		const queuedMessage: DurableQueuedMessage = this.runtimeEvents ? { message, queueItemId: uuidv7() } : { message };
		messages.push(queuedMessage);
		try {
			if (this.runtimeEvents && queuedMessage.queueItemId) {
				await this.runtimeEvents.append({
					type: "queue_enqueued",
					queueItemId: queuedMessage.queueItemId,
					queue,
					message,
				});
			}
		} catch (error) {
			const index = messages.indexOf(queuedMessage);
			if (index >= 0) messages.splice(index, 1);
			throw error;
		}
		await this.emitQueueUpdate();
	}

	private async startRuntimeOperation(kind: "turn" | "compaction" | "branch_summary" | "retry"): Promise<void> {
		if (!this.runtimeEvents) return;
		const operationId = uuidv7();
		await this.runtimeEvents.append({ type: "operation_started", operationId, kind });
		this.activeOperationId = operationId;
	}

	private async finishRuntimeOperation(): Promise<void> {
		if (!this.runtimeEvents || !this.activeOperationId) return;
		const operationId = this.activeOperationId;
		await this.runtimeEvents.append({ type: "operation_finished", operationId });
		this.activeOperationId = undefined;
	}

	private async interruptRuntimeOperation(reason: string): Promise<void> {
		if (!this.runtimeEvents || !this.activeOperationId) return;
		const operationId = this.activeOperationId;
		if (this.activeProviderRequestId) {
			await this.runtimeEvents.append({
				type: "provider_request_interrupted",
				requestId: this.activeProviderRequestId,
				reason,
			});
			this.activeProviderRequestId = undefined;
		}
		if (this.activeTurnId) {
			const state = this.runtimeEvents.getState();
			for (const toolCall of Object.values(state.toolCalls)) {
				if (toolCall.turnId === this.activeTurnId && toolCall.status === "active") {
					await this.runtimeEvents.append({
						type: "tool_call_interrupted",
						toolCallId: toolCall.toolCallId,
						reason,
					});
				}
			}
			await this.runtimeEvents.append({ type: "turn_interrupted", turnId: this.activeTurnId, reason });
			this.activeTurnId = undefined;
		}
		await this.runtimeEvents.append({ type: "operation_interrupted", operationId, reason });
		this.activeOperationId = undefined;
	}

	private async normalizeOperationFailure(
		error: unknown,
		fallbackCode: AgentHarnessError["code"],
	): Promise<AgentHarnessError> {
		try {
			await this.interruptRuntimeOperation(toError(error).message);
			return normalizeHarnessError(error, fallbackCode);
		} catch (runtimeError) {
			const cause = new AggregateError(
				[toError(error), toError(runtimeError)],
				"Operation failed and runtime interruption could not be persisted",
			);
			return new AgentHarnessError(fallbackCode, cause.message, cause);
		}
	}

	private startRunPromise(): () => void {
		this.runAbortController = new AbortController();
		this.acceptsTurnInput = false;
		this.sessionWritesSealed = false;
		let finish = () => {};
		this.runPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		return () => {
			this.runPromise = undefined;
			this.runAbortController = undefined;
			this.acceptsTurnInput = false;
			this.sessionWritesSealed = false;
			finish();
		};
	}

	private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		const context = await this.session.buildContext();
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				env: this.env,
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
				resources,
			});
		}
		return {
			messages: context.messages,
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
			runBudget: this.runBudget ? { ...this.runBudget } : undefined,
			loopDetection: this.loopDetection ? { ...this.loopDetection } : undefined,
		};
	}

	private createContext(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		systemPrompt?: string,
	): AgentContext {
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.slice(),
		};
	}

	private createStreamFn(getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>): StreamFn {
		return async (model, context, streamOptions) => {
			const turnState = getTurnState();
			if (this.runtimeEvents && this.activeTurnId) {
				const requestId = uuidv7();
				await this.runtimeEvents.append({
					type: "provider_request_started",
					requestId,
					turnId: this.activeTurnId,
					provider: model.provider,
					modelId: model.id,
				});
				this.activeProviderRequestId = requestId;
			}
			const snapshotOptions: AgentHarnessStreamOptions = { ...turnState.streamOptions };
			const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);
			const options: ModelsSimpleStreamOptions = {
				cacheRetention: requestOptions.cacheRetention,
				env: requestOptions.env,
				headers: requestOptions.headers,
				maxTokens: requestOptions.maxTokens,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn(
						{ type: "after_provider_response", status: response.status, headers },
						streamOptions?.signal,
					);
				},
				reasoning: streamOptions?.reasoning,
				signal: streamOptions?.signal,
				sessionId: turnState.sessionId,
				temperature: requestOptions.temperature,
				thinkingBudgets: requestOptions.thinkingBudgets,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
				transformHeaders: requestOptions.transformHeaders,
				websocketConnectTimeoutMs: requestOptions.websocketConnectTimeoutMs,
			};
			if (this.streamFn) {
				const { transformHeaders: _transformHeaders, ...streamOptionsWithoutTransforms } = options;
				return this.streamFn(model, context, streamOptionsWithoutTransforms);
			}
			return this.models.streamSimple(model, context, options);
		};
	}

	private async drainQueuedMessages<TMessage extends AgentMessage>(
		queue: Array<DurableQueuedMessage<TMessage>>,
		mode: QueueMode,
	): Promise<TMessage[]> {
		const queued = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (queued.length === 0) return [];
		try {
			await this.emitQueueUpdate();
			this.consumedQueueItemIds.push(...queued.flatMap((item) => (item.queueItemId ? [item.queueItemId] : [])));
			return queued.map((item) => item.message);
		} catch (error) {
			queue.unshift(...queued);
			throw normalizeHookError(error);
		}
	}

	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
	): AgentLoopConfig {
		const turnState = getTurnState();
		return {
			model: turnState.model,
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
			convertToLlm: this.convertMessages,
			runBudget: turnState.runBudget,
			loopDetection: turnState.loopDetection,
			transformContext: async (messages) => {
				const result = await this.emitHook({ type: "context", messages: [...messages] });
				return result?.messages ?? messages;
			},
			beforeToolCall: async (context, signal) => {
				const { toolCall, args } = context;
				const result = await this.emitHook(
					{
						type: "tool_call",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						input: args as Record<string, unknown>,
					},
					signal,
				);
				if (result?.block) return { block: true, reason: result.reason };
				if (!this.toolPolicy) return undefined;
				const authorization = await this.toolPolicy.authorize(context, signal, {
					sessionId: getTurnState().sessionId,
				});
				if (authorization.allowed) return undefined;
				return { block: true, reason: authorization.reason ?? authorization.decision.reason };
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				});
				return patch
					? { content: patch.content, details: patch.details, isError: patch.isError, terminate: patch.terminate }
					: undefined;
			},
			prepareNextTurn: async () => {
				await this.flushPendingSessionWrites();
				const nextTurnState = await this.createTurnState();
				setTurnState(nextTurnState);
				const context = this.nextTurnContext ?? this.createContext(nextTurnState);
				this.nextTurnContext = undefined;
				return {
					context,
					model: nextTurnState.model,
					thinkingLevel: nextTurnState.thinkingLevel,
				};
			},
			getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
			getFollowUpMessages: async () => {
				if (this.followUpQueue.length === 0) {
					this.acceptsTurnInput = false;
					return [];
				}
				return await this.drainQueuedMessages(this.followUpQueue, this.followUpQueueMode);
			},
		};
	}

	private validateUniqueNames(names: string[], message: string): void {
		const duplicates = findDuplicateNames(names);
		if (duplicates.length > 0)
			throw new AgentHarnessError("invalid_argument", `${message}: ${duplicates.join(", ")}`);
	}

	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		this.validateUniqueNames(toolNames, "Duplicate active tool name(s)");
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	private async flushPendingSessionWrites(): Promise<void> {
		await this.pendingSessionWriteBarrier;
		while (this.pendingSessionWrites.length > 0) {
			const pending = this.pendingSessionWrites[0]!;
			await this.applyPendingSessionWrite(pending);
			this.pendingSessionWrites.shift();
		}
	}

	/**
	 * Apply durable writes left by a previous process and restore session-selected runtime state.
	 * Prefer {@link restoreAgentHarness}; this method is public for hosts that own event-store opening.
	 */
	async reconcileRecoveredState(): Promise<void> {
		if (this.phase !== "idle") {
			throw new AgentHarnessError("busy", "reconcileRecoveredState() requires idle harness");
		}
		await this.flushPendingSessionWrites();
		const branch = await this.session.getBranch();
		const context = await this.session.buildContext();
		const previousModel = this.model;
		const previousThinkingLevel = this.thinkingLevel;
		const previousActiveToolNames = [...this.activeToolNames];

		if (context.model) {
			const restoredModel =
				this.models.getModel(context.model.provider, context.model.modelId) ??
				(this.model.provider === context.model.provider && this.model.id === context.model.modelId
					? this.model
					: undefined);
			if (!restoredModel) {
				throw new AgentHarnessError(
					"invalid_state",
					`Session model is unavailable: ${context.model.provider}/${context.model.modelId}`,
				);
			}
			this.model = restoredModel;
		}

		if (branch.some((entry) => entry.type === "thinking_level_change")) {
			if (!isThinkingLevel(context.thinkingLevel)) {
				throw new AgentHarnessError(
					"invalid_state",
					`Session thinking level is unsupported: ${context.thinkingLevel}`,
				);
			}
			this.thinkingLevel = context.thinkingLevel;
		}

		if (context.activeToolNames) {
			this.validateToolNames(context.activeToolNames);
			this.activeToolNames = [...context.activeToolNames];
		}

		if (this.model !== previousModel) {
			await this.emitOwn({ type: "model_update", model: this.model, previousModel, source: "restore" });
		}
		if (this.thinkingLevel !== previousThinkingLevel) {
			await this.emitOwn({
				type: "thinking_level_update",
				level: this.thinkingLevel,
				previousLevel: previousThinkingLevel,
			});
		}
		if (
			this.activeToolNames.length !== previousActiveToolNames.length ||
			this.activeToolNames.some((name, index) => name !== previousActiveToolNames[index])
		) {
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames: [...this.tools.keys()],
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "restore",
			});
		}
		await this.emitQueueUpdate();
	}

	private async queuePendingSessionWrite(write: PendingSessionWrite): Promise<void> {
		if (this.sessionWritesSealed) {
			throw new AgentHarnessError("invalid_state", "Session writes are sealed for terminal run cleanup");
		}
		const enqueue = async () => {
			if (!this.runtimeEvents) {
				this.pendingSessionWrites.push({ write });
				return;
			}
			const pendingWriteId = uuidv7();
			const targetEntryId = await this.session.getStorage().createEntryId();
			await this.runtimeEvents.append({
				type: "pending_write_enqueued",
				pendingWriteId,
				targetEntryId,
				write,
			});
			this.pendingSessionWrites.push({ write, pendingWriteId, targetEntryId });
		};
		const operation = this.pendingSessionWriteBarrier.then(enqueue, enqueue);
		this.pendingSessionWriteBarrier = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
	}

	private async applyPendingSessionWrite(pending: DurablePendingWrite): Promise<void> {
		const storage = this.session.getStorage();
		if (pending.targetEntryId) {
			const existing = await storage.getEntry(pending.targetEntryId);
			if (!existing) {
				await storage.appendEntry({
					...pending.write,
					id: pending.targetEntryId,
					parentId: await storage.getLeafId(),
					timestamp: new Date().toISOString(),
				} as SessionTreeEntry);
			}
			if (this.runtimeEvents && pending.pendingWriteId) {
				await this.runtimeEvents.append({
					type: "pending_write_applied",
					pendingWriteId: pending.pendingWriteId,
					targetEntryId: pending.targetEntryId,
				});
			}
			return;
		}

		const write = pending.write;
		if (write.type === "message") await this.session.appendMessage(write.message);
		else if (write.type === "model_change") await this.session.appendModelChange(write.provider, write.modelId);
		else if (write.type === "thinking_level_change") {
			await this.session.appendThinkingLevelChange(write.thinkingLevel);
		} else if (write.type === "active_tools_change") {
			await this.session.appendActiveToolsChange(write.activeToolNames);
		} else if (write.type === "custom") await this.session.appendCustomEntry(write.customType, write.data);
		else if (write.type === "custom_message") {
			await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
		} else if (write.type === "label") await this.session.appendLabel(write.targetId, write.label);
		else if (write.type === "session_info") await this.session.appendSessionName(write.name ?? "");
		else if (write.type === "leaf") await storage.setLeafId(write.targetId);
	}

	private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		if (event.type === "turn_start" && this.runtimeEvents && this.activeOperationId) {
			const turnId = uuidv7();
			await this.runtimeEvents.append({
				type: "turn_started",
				turnId,
				operationId: this.activeOperationId,
				consumedQueueItemIds: this.consumedQueueItemIds.splice(0),
			});
			this.activeTurnId = turnId;
		}
		if (event.type === "tool_execution_start" && this.runtimeEvents && this.activeTurnId) {
			await this.runtimeEvents.append({
				type: "tool_call_started",
				toolCallId: event.toolCallId,
				turnId: this.activeTurnId,
				toolName: event.toolName,
				retrySafe: this.toolPolicy?.getSpec(event.toolName)?.retrySafe ?? false,
			});
		}
		if (event.type === "tool_execution_end" && this.runtimeEvents) {
			const toolCall = this.runtimeEvents.getState().toolCalls[event.toolCallId];
			if (toolCall?.status === "active") {
				await this.runtimeEvents.append({ type: "tool_call_finished", toolCallId: event.toolCallId });
			}
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant" && this.runtimeEvents && this.activeProviderRequestId) {
				if (event.message.stopReason === "error") {
					await this.runtimeEvents.append({
						type: "provider_request_failed",
						requestId: this.activeProviderRequestId,
						reason: event.message.errorMessage ?? "Provider request failed",
					});
				} else if (event.message.stopReason === "aborted") {
					await this.runtimeEvents.append({
						type: "provider_request_interrupted",
						requestId: this.activeProviderRequestId,
						reason: event.message.errorMessage ?? "Provider request aborted",
					});
				} else {
					await this.runtimeEvents.append({
						type: "provider_request_finished",
						requestId: this.activeProviderRequestId,
					});
				}
				this.activeProviderRequestId = undefined;
			}
			const persistResult = await this.emitHook({ type: "before_message_persist", message: event.message }, signal);
			const message = persistResult?.message ?? event.message;
			await this.session.appendMessage(message);
			await this.emitAny({ ...event, message }, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
				await this.interruptRuntimeOperation(event.message.errorMessage ?? "Provider request aborted");
			} else if (event.message.role === "assistant" && event.message.stopReason === "error") {
				await this.interruptRuntimeOperation(event.message.errorMessage ?? "Provider request failed");
			} else if (this.runtimeEvents && this.activeTurnId) {
				await this.runtimeEvents.append({ type: "turn_finished", turnId: this.activeTurnId });
				this.activeTurnId = undefined;
			}
			if (eventError) throw eventError;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			this.acceptsTurnInput = false;
			this.runAbortController = undefined;
			await this.flushPendingSessionWrites();
			await this.emitAny(event, signal);
			return;
		}
		await this.emitAny(event, signal);
	}

	private async settleRun(signal: AbortSignal): Promise<void> {
		await this.flushPendingSessionWrites();
		await this.finishRuntimeOperation();
		const errors: Error[] = [];
		try {
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
		} catch (error) {
			errors.push(toError(error));
		}
		this.sessionWritesSealed = true;
		try {
			await this.flushPendingSessionWrites();
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Agent run settlement failed");
			throw normalizeHarnessError(cause, "hook");
		}
	}

	private async emitRunFailure(
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
	): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal);
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
		return [failureMessage];
	}

	private async drainNextTurnMessages(): Promise<AgentMessage[]> {
		const queuedMessages = this.nextTurnQueue.splice(0);
		if (queuedMessages.length === 0) return [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			this.nextTurnQueue.unshift(...queuedMessages);
			throw normalizeHookError(error);
		}
		this.consumedQueueItemIds.push(...queuedMessages.flatMap((item) => (item.queueItemId ? [item.queueItemId] : [])));
		return queuedMessages.map((item) => item.message);
	}

	private async executeRun(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		messages: AgentMessage[],
		options: { continuation?: boolean; contextMessages?: AgentMessage[]; systemPrompt?: string } = {},
	): Promise<AssistantMessage> {
		let activeTurnState = turnState;
		let terminalSettlementStarted = false;
		const abortController = this.runAbortController;
		if (!abortController) {
			throw new AgentHarnessError("invalid_state", "AgentHarness run abort barrier is unavailable");
		}
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		this.acceptsTurnInput = true;
		const runResultPromise = (async () => {
			try {
				const context = this.createContext(turnState, options.systemPrompt);
				if (options.contextMessages) context.messages = [...options.contextMessages];
				const emit = (event: AgentEvent) => {
					if (event.type === "agent_end") terminalSettlementStarted = true;
					return this.handleAgentEvent(event, abortController.signal);
				};
				return options.continuation
					? await runAgentLoopContinue(
							context,
							this.createLoopConfig(getTurnState, setTurnState),
							emit,
							abortController.signal,
							this.createStreamFn(getTurnState),
						)
					: await runAgentLoop(
							messages,
							context,
							this.createLoopConfig(getTurnState, setTurnState),
							emit,
							abortController.signal,
							this.createStreamFn(getTurnState),
						);
			} catch (error) {
				if (terminalSettlementStarted) throw error;
				try {
					return await this.emitRunFailure(
						activeTurnState.model,
						error,
						abortController.signal.aborted,
						abortController.signal,
					);
				} catch (failureError) {
					const cause = new AggregateError(
						[toError(error), toError(failureError)],
						"Agent run failed and failure reporting failed",
					);
					throw new AgentHarnessError("unknown", cause.message, cause);
				}
			}
		})();
		try {
			const newMessages = await runResultPromise;
			let assistantMessage: AssistantMessage | undefined;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					assistantMessage = message;
					break;
				}
			}
			if (!assistantMessage) {
				throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
			}
			await this.settleRun(abortController.signal);
			return assistantMessage;
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.nextTurnContext = undefined;
				this.acceptsTurnInput = false;
				this.runAbortController = undefined;
			}
		}
	}

	private async executeTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<AssistantMessage> {
		let messages: AgentMessage[] = [
			...(await this.drainNextTurnMessages()),
			createUserMessage(text, options?.images),
		];
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];
		return this.executeRun(turnState, messages, { systemPrompt: beforeResult?.systemPrompt });
	}

	async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			await this.startRuntimeOperation("turn");
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			throw await this.normalizeOperationFailure(error, "unknown");
		} finally {
			this.phase = "idle";
			finishRunPromise();
		}
	}

	/** Run an application-prepared message batch without re-running text expansion hooks. */
	async promptMessages(messages: AgentMessage[], contextMessages?: AgentMessage[]): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		if (messages.length === 0) throw new AgentHarnessError("invalid_argument", "promptMessages() requires messages");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			await this.startRuntimeOperation("turn");
			const turnState = await this.createTurnState();
			return await this.executeRun(turnState, [...(await this.drainNextTurnMessages()), ...messages], {
				contextMessages,
			});
		} catch (error) {
			throw await this.normalizeOperationFailure(error, "unknown");
		} finally {
			this.phase = "idle";
			finishRunPromise();
		}
	}

	/** Continue from caller-projected context, typically after retry or compaction. */
	async continue(contextMessages?: AgentMessage[]): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "retry";
		const finishRunPromise = this.startRunPromise();
		try {
			await this.startRuntimeOperation("retry");
			const turnState = await this.createTurnState();
			const queuedMessages = await this.drainNextTurnMessages();
			return queuedMessages.length > 0
				? await this.executeRun(turnState, queuedMessages, { contextMessages })
				: await this.executeRun(turnState, [], { continuation: true, contextMessages });
		} catch (error) {
			throw await this.normalizeOperationFailure(error, "unknown");
		} finally {
			this.phase = "idle";
			finishRunPromise();
		}
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			await this.startRuntimeOperation("turn");
			const turnState = await this.createTurnState();
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
		} catch (error) {
			throw await this.normalizeOperationFailure(error, "unknown");
		} finally {
			this.phase = "idle";
			finishRunPromise();
		}
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			await this.startRuntimeOperation("turn");
			const turnState = await this.createTurnState();
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
		} catch (error) {
			throw await this.normalizeOperationFailure(error, "unknown");
		} finally {
			this.phase = "idle";
			finishRunPromise();
		}
	}

	async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		await this.steerMessage(createUserMessage(text, options?.images));
	}

	async steerMessage(message: AgentMessage): Promise<void> {
		if (!this.canAcceptTurnInput()) {
			throw new AgentHarnessError("invalid_state", "Cannot steer outside an active agent turn");
		}
		await this.queueSteeringMessage(message);
	}

	/** Queue steering input even when the host has not started a turn yet. */
	async queueSteeringMessage(message: AgentMessage): Promise<void> {
		await this.enqueueMessage("steer", this.steerQueue, message);
	}

	async followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		await this.followUpMessage(createUserMessage(text, options?.images));
	}

	async followUpMessage(message: AgentMessage): Promise<void> {
		if (!this.canAcceptTurnInput()) {
			throw new AgentHarnessError("invalid_state", "Cannot follow up outside an active agent turn");
		}
		await this.queueFollowUpMessage(message);
	}

	/** Queue follow-up input even when the host has not started a turn yet. */
	async queueFollowUpMessage(message: AgentMessage): Promise<void> {
		await this.enqueueMessage("follow_up", this.followUpQueue, message);
	}

	async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		await this.nextTurnMessage(createUserMessage(text, options?.images));
	}

	async nextTurnMessage(message: AgentMessage): Promise<void> {
		await this.enqueueMessage("next_turn", this.nextTurnQueue, message);
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		try {
			if (this.phase === "idle") {
				await this.session.appendMessage(message);
			} else {
				await this.queuePendingSessionWrite({ type: "message", message });
			}
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async compact(
		customInstructions?: string,
	): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "compact() requires idle harness");
		this.phase = "compaction";
		try {
			await this.startRuntimeOperation("compaction");
			const model = this.model;
			if (!model) throw new AgentHarnessError("invalid_state", "No model set for compaction");
			const branchEntries = await this.session.getBranch();
			const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
			if (!preparationResult.ok) throw preparationResult.error;
			const preparation = preparationResult.value;
			if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
			const hookResult = await this.emitHook({
				type: "session_before_compact",
				preparation,
				branchEntries,
				customInstructions,
				signal: new AbortController().signal,
			});
			if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled");
			const provided = hookResult?.compaction;
			const compactResult = provided
				? { ok: true as const, value: provided }
				: await compact(preparation, this.models, model, customInstructions, undefined, this.thinkingLevel);
			if (!compactResult.ok) throw compactResult.error;
			const result = compactResult.value;
			const entryId = await this.session.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				result.tokensBefore,
				result.details,
				provided !== undefined,
			);
			const entry = await this.session.getEntry(entryId);
			if (entry?.type === "compaction") {
				await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook: provided !== undefined });
			}
			await this.finishRuntimeOperation();
			return result;
		} catch (error) {
			throw await this.normalizeOperationFailure(error, "compaction");
		} finally {
			this.phase = "idle";
		}
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
		this.phase = "branch_summary";
		try {
			await this.startRuntimeOperation("branch_summary");
			const oldLeafId = await this.session.getLeafId();
			if (oldLeafId === targetId) {
				await this.finishRuntimeOperation();
				return { cancelled: false };
			}
			const targetEntry = await this.session.getEntry(targetId);
			if (!targetEntry) throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
			const { entries, commonAncestorId } = await collectEntriesForBranchSummary(this.session, oldLeafId, targetId);
			const preparation = {
				targetId,
				oldLeafId,
				commonAncestorId,
				entriesToSummarize: entries,
				userWantsSummary: options?.summarize ?? false,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			};
			const signal = new AbortController().signal;
			const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
			if (hookResult?.cancel) {
				await this.finishRuntimeOperation();
				return { cancelled: true };
			}
			let summaryEntry: NavigateTreeResult["summaryEntry"];
			let summaryText: string | undefined = hookResult?.summary?.summary;
			let summaryDetails: unknown = hookResult?.summary?.details;
			if (!summaryText && options?.summarize && entries.length > 0) {
				const model = this.model;
				if (!model) throw new AgentHarnessError("invalid_state", "No model set for branch summary");
				const branchSummary = await generateBranchSummary(entries, {
					models: this.models,
					model,
					signal: new AbortController().signal,
					customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
					replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
				});
				if (!branchSummary.ok) {
					if (branchSummary.error.code === "aborted") {
						await this.finishRuntimeOperation();
						return { cancelled: true };
					}
					throw new AgentHarnessError("branch_summary", branchSummary.error.message, branchSummary.error);
				}
				summaryText = branchSummary.value.summary;
				summaryDetails = {
					readFiles: branchSummary.value.readFiles,
					modifiedFiles: branchSummary.value.modifiedFiles,
				};
			}
			let editorText: string | undefined;
			let newLeafId: string | null;
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				const content = targetEntry.message.content;
				editorText =
					typeof content === "string"
						? content
						: content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}
			const summaryId = await this.session.moveTo(
				newLeafId,
				summaryText
					? { summary: summaryText, details: summaryDetails, fromHook: hookResult?.summary !== undefined }
					: undefined,
			);
			if (summaryId) {
				const entry = await this.session.getEntry(summaryId);
				if (entry?.type === "branch_summary") summaryEntry = entry;
			}
			await this.emitOwn({
				type: "session_tree",
				newLeafId: await this.session.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromHook: hookResult?.summary !== undefined,
			});
			await this.finishRuntimeOperation();
			return { cancelled: false, editorText, summaryEntry };
		} catch (error) {
			throw await this.normalizeOperationFailure(error, "branch_summary");
		} finally {
			this.phase = "idle";
		}
	}

	getModel(): Model<any> {
		return this.model;
	}

	getPhase(): AgentHarnessPhase {
		return this.phase;
	}

	isIdle(): boolean {
		return this.phase === "idle";
	}

	canAcceptTurnInput(): boolean {
		return (this.phase === "turn" || this.phase === "retry") && this.acceptsTurnInput;
	}

	get signal(): AbortSignal | undefined {
		return this.runAbortController?.signal;
	}

	getPendingWrites(): readonly PendingSessionWrite[] {
		return this.pendingSessionWrites.map((pending) => pending.write);
	}

	/** Replace the context returned at the next in-run save point. */
	setNextTurnContext(context: AgentContext): void {
		this.nextTurnContext = {
			systemPrompt: context.systemPrompt,
			messages: [...context.messages],
			tools: context.tools ? [...context.tools] : undefined,
		};
	}

	/** Update host-owned runtime projections without creating duplicate session entries. */
	synchronizeRuntimeState(state: {
		model: Model<any>;
		thinkingLevel: ThinkingLevel;
		tools: TTool[];
		activeToolNames?: string[];
	}): void {
		this.validateUniqueNames(
			state.tools.map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		const tools = new Map(state.tools.map((tool) => [tool.name, tool]));
		const activeToolNames = state.activeToolNames ? [...state.activeToolNames] : state.tools.map((tool) => tool.name);
		this.validateToolNames(activeToolNames, tools);
		this.model = state.model;
		this.thinkingLevel = state.thinkingLevel;
		this.tools = tools;
		this.activeToolNames = activeToolNames;
	}

	async setModel(model: Model<any>): Promise<void> {
		try {
			const previousModel = this.model;
			if (this.phase === "idle") {
				await this.session.appendModelChange(model.provider, model.id);
			} else {
				await this.queuePendingSessionWrite({
					type: "model_change",
					provider: model.provider,
					modelId: model.id,
				});
			}
			this.model = model;
			await this.emitOwn({ type: "model_update", model, previousModel, source: "set" });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		try {
			const previousLevel = this.thinkingLevel;
			if (this.phase === "idle") {
				await this.session.appendThinkingLevelChange(level);
			} else {
				await this.queuePendingSessionWrite({ type: "thinking_level_change", thinkingLevel: level });
			}
			this.thinkingLevel = level;
			await this.emitOwn({ type: "thinking_level_update", level, previousLevel });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getTools(): TTool[] {
		return [...this.tools.values()];
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		try {
			this.validateUniqueNames(
				tools.map((tool) => tool.name),
				"Duplicate tool name(s)",
			);
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
			this.validateToolNames(nextActiveToolNames, nextTools);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			if (this.phase === "idle") {
				await this.session.appendActiveToolsChange(nextActiveToolNames);
			} else {
				await this.queuePendingSessionWrite({
					type: "active_tools_change",
					activeToolNames: [...nextActiveToolNames],
				});
			}
			this.tools = nextTools;
			this.activeToolNames = [...nextActiveToolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getActiveTools(): TTool[] {
		return this.activeToolNames.map((name) => this.tools.get(name)!);
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		try {
			this.validateToolNames(toolNames);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			if (this.phase === "idle") {
				await this.session.appendActiveToolsChange(toolNames);
			} else {
				await this.queuePendingSessionWrite({
					type: "active_tools_change",
					activeToolNames: [...toolNames],
				});
			}
			this.activeToolNames = [...toolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpQueueMode = mode;
	}

	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
		const previousResources = this.getResources();
		this.resources = {
			skills: resources.skills?.slice(),
			promptTemplates: resources.promptTemplates?.slice(),
		};
		await this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources });
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	getQueueSnapshot(): { steer: AgentMessage[]; followUp: AgentMessage[]; nextTurn: AgentMessage[] } {
		return {
			steer: this.steerQueue.map((item) => item.message),
			followUp: this.followUpQueue.map((item) => item.message),
			nextTurn: this.nextTurnQueue.map((item) => item.message),
		};
	}

	hasQueuedMessages(): boolean {
		return this.steerQueue.length > 0 || this.followUpQueue.length > 0 || this.nextTurnQueue.length > 0;
	}

	private async discardQueuedMessages<TMessage extends AgentMessage>(
		queue: Array<DurableQueuedMessage<TMessage>>,
		reason: string,
		errors: Error[],
	): Promise<TMessage[]> {
		const cleared: TMessage[] = [];
		const retained: Array<DurableQueuedMessage<TMessage>> = [];
		for (const item of queue) {
			try {
				if (this.runtimeEvents && item.queueItemId) {
					await this.runtimeEvents.append({
						type: "queue_discarded",
						queueItemId: item.queueItemId,
						reason,
					});
				}
				cleared.push(item.message);
			} catch (error) {
				errors.push(toError(error));
				retained.push(item);
			}
		}
		queue.splice(0, queue.length, ...retained);
		return cleared;
	}

	private async clearQueue(queue: Array<DurableQueuedMessage>, reason: string): Promise<AgentMessage[]> {
		const errors: Error[] = [];
		const cleared = await this.discardQueuedMessages(queue, reason, errors);
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Queue clearing failed");
			throw normalizeHarnessError(cause, "hook");
		}
		return cleared;
	}

	async clearSteeringQueue(reason = "host_clear"): Promise<AgentMessage[]> {
		return await this.clearQueue(this.steerQueue, reason);
	}

	async clearFollowUpQueue(reason = "host_clear"): Promise<AgentMessage[]> {
		return await this.clearQueue(this.followUpQueue, reason);
	}

	async clearQueues(reason = "host_clear"): Promise<{
		steer: AgentMessage[];
		followUp: AgentMessage[];
		nextTurn: AgentMessage[];
	}> {
		const errors: Error[] = [];
		const steer = await this.discardQueuedMessages(this.steerQueue, reason, errors);
		const followUp = await this.discardQueuedMessages(this.followUpQueue, reason, errors);
		const nextTurn = await this.discardQueuedMessages(this.nextTurnQueue, reason, errors);
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Queue clearing failed");
			throw normalizeHarnessError(cause, "hook");
		}
		return { steer, followUp, nextTurn };
	}

	async abort(): Promise<AbortResult> {
		const activeRun = this.runAbortController;
		const activeRunPromise = activeRun ? this.runPromise : undefined;
		this.requestAbort();
		const errors: Error[] = [];
		const clearedSteer = await this.discardQueuedMessages(this.steerQueue, "abort", errors);
		const clearedFollowUp = await this.discardQueuedMessages(this.followUpQueue, "abort", errors);
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		if (activeRunPromise) {
			try {
				await activeRunPromise;
			} catch (error) {
				errors.push(toError(error));
			}
		}
		try {
			await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	/** Abort the active model/tool run synchronously; asynchronous cleanup remains owned by {@link abort}. */
	requestAbort(): void {
		this.runAbortController?.abort();
	}

	async waitForIdle(): Promise<void> {
		await this.runPromise;
	}

	subscribe(
		listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		return this.hooks.observe(async (event, _context, signal) => await listener(event, signal));
	}

	on<TType extends AgentHarnessOwnEvent<TSkill, TPromptTemplate>["type"]>(
		type: TType,
		handler: HookHandler<
			Extract<AgentHarnessOwnEvent<TSkill, TPromptTemplate>, { type: TType }>,
			AgentHarnessHookContext
		>,
	): () => void {
		return this.hooks.on(type, handler);
	}
}

/** Open the canonical journal, conservatively recover interrupted work, and rebuild a usable harness. */
export async function restoreAgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
>(
	options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>,
	recoveryOptions: { reason?: string; recoveryId?: string } = {},
): Promise<RestoredAgentHarness<TSkill, TPromptTemplate, TTool>> {
	const runtimeEvents = options.runtimeEvents ?? (await SessionRuntimeEventStore.open(options.session));
	const recovery = await runtimeEvents.recover(recoveryOptions);
	const harness = new AgentHarness({ ...options, runtimeEvents });
	await harness.reconcileRecoveredState();
	return { harness, recovery };
}
