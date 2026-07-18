import type {
	AgentHarnessEvent,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	BeforeAgentStartEvent,
	BeforeAgentStartResult,
	BeforeMessagePersistEvent,
	BeforeMessagePersistResult,
	BeforeProviderPayloadEvent,
	BeforeProviderPayloadResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestResult,
	ContextEvent,
	ContextResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	ToolCallEvent,
	ToolCallResult,
	ToolResultEvent,
	ToolResultPatch,
} from "./types.ts";

/** Type-only result marker carried by hook event interfaces. */
export const HookResult: unique symbol = Symbol("AgentHarnessHookResult");

/** Event whose own type declares the result handlers may produce. */
export interface HookEvent<TType extends string, TResult = void> {
	type: TType;
	readonly [HookResult]?: TResult;
}

/** Extract the result declared by a hook event. */
export type ResultOf<TEvent> = typeof HookResult extends keyof TEvent
	? Exclude<TEvent[typeof HookResult], undefined>
	: undefined;

export type HookHandler<TEvent, TContext> = (
	event: TEvent,
	context: TContext,
	signal?: AbortSignal,
) => ResultOf<TEvent> | undefined | Promise<ResultOf<TEvent> | undefined>;

export type HookObserver<TEvent, TContext> = (
	event: TEvent,
	context: TContext,
	signal?: AbortSignal,
) => void | Promise<void>;

export interface HookRegistrationOptions<TSource = unknown> {
	source?: TSource;
	cleanup?: () => void | Promise<void>;
}

export interface AgentHarnessHookScope<TEvent extends { type: string }, TContext, TSource> {
	observe(
		observer: HookObserver<TEvent, TContext>,
		options?: Omit<HookRegistrationOptions<TSource>, "source">,
	): () => void;
	on<TType extends TEvent["type"]>(
		type: TType,
		handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
		options?: Omit<HookRegistrationOptions<TSource>, "source">,
	): () => void;
	addCleanup(cleanup: () => void | Promise<void>): () => void;
}

export interface AgentHarnessHooks<TEvent extends { type: string }, TContext, TSource = unknown> {
	readonly context: TContext;
	setContext(context: TContext): void;
	observe(observer: HookObserver<TEvent, TContext>, options?: HookRegistrationOptions<TSource>): () => void;
	on<TType extends TEvent["type"]>(
		type: TType,
		handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
		options?: HookRegistrationOptions<TSource>,
	): () => void;
	emit<TType extends TEvent["type"]>(
		event: Extract<TEvent, { type: TType }>,
		signal?: AbortSignal,
	): Promise<ResultOf<Extract<TEvent, { type: TType }>> | undefined>;
	createScope(source: TSource): AgentHarnessHookScope<TEvent, TContext, TSource>;
	addCleanup(cleanup: () => void | Promise<void>): () => void;
	clear(): Promise<void>;
	dispose(): Promise<void>;
}

export interface AgentHarnessHookError<TEvent, TSource> {
	error: Error;
	event: TEvent;
	source?: TSource;
}

export interface DefaultAgentHarnessHooksOptions<TContext, TEvent, TSource> {
	context: TContext;
	errorMode?: "throw" | "continue";
	onError?: (error: AgentHarnessHookError<TEvent, TSource>) => void | Promise<void>;
}

interface HookRegistration<THandler, TSource> {
	handler: THandler;
	source?: TSource;
	cleanup?: () => void | Promise<void>;
}

function cloneStreamOptions(options: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...options,
		headers: options.headers ? { ...options.headers } : undefined,
		metadata: options.metadata ? { ...options.metadata } : undefined,
		env: options.env ? { ...options.env } : undefined,
		thinkingBudgets: options.thinkingBudgets ? { ...options.thinkingBudgets } : undefined,
	};
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

function diffStreamOptions(
	base: AgentHarnessStreamOptions,
	current: AgentHarnessStreamOptions,
): AgentHarnessStreamOptionsPatch {
	const patch: AgentHarnessStreamOptionsPatch = {};
	if (base.temperature !== current.temperature) patch.temperature = current.temperature;
	if (base.maxTokens !== current.maxTokens) patch.maxTokens = current.maxTokens;
	if (base.transport !== current.transport) patch.transport = current.transport;
	if (base.timeoutMs !== current.timeoutMs) patch.timeoutMs = current.timeoutMs;
	if (base.maxRetries !== current.maxRetries) patch.maxRetries = current.maxRetries;
	if (base.websocketConnectTimeoutMs !== current.websocketConnectTimeoutMs) {
		patch.websocketConnectTimeoutMs = current.websocketConnectTimeoutMs;
	}
	if (base.maxRetryDelayMs !== current.maxRetryDelayMs) patch.maxRetryDelayMs = current.maxRetryDelayMs;
	if (base.cacheRetention !== current.cacheRetention) patch.cacheRetention = current.cacheRetention;
	if (base.env !== current.env) patch.env = current.env ? { ...current.env } : undefined;
	if (base.thinkingBudgets !== current.thinkingBudgets) {
		patch.thinkingBudgets = current.thinkingBudgets ? { ...current.thinkingBudgets } : undefined;
	}
	if (base.transformHeaders !== current.transformHeaders) patch.transformHeaders = current.transformHeaders;

	if (current.headers === undefined) {
		if (base.headers !== undefined) patch.headers = undefined;
	} else {
		const headers: Record<string, string | undefined> = {};
		for (const key of new Set([...Object.keys(base.headers ?? {}), ...Object.keys(current.headers)])) {
			if (base.headers?.[key] !== current.headers[key]) headers[key] = current.headers[key];
		}
		if (Object.keys(headers).length > 0) patch.headers = headers;
	}

	if (current.metadata === undefined) {
		if (base.metadata !== undefined) patch.metadata = undefined;
	} else {
		const metadata: Record<string, unknown | undefined> = {};
		for (const key of new Set([...Object.keys(base.metadata ?? {}), ...Object.keys(current.metadata)])) {
			if (!Object.is(base.metadata?.[key], current.metadata[key])) metadata[key] = current.metadata[key];
		}
		if (Object.keys(metadata).length > 0) patch.metadata = metadata;
	}

	return patch;
}

/** Default ordered hook implementation for AgentHarness events. */
export class DefaultAgentHarnessHooks<
	TEvent extends AgentHarnessEvent = AgentHarnessEvent,
	TContext = undefined,
	TSource = unknown,
> implements AgentHarnessHooks<TEvent, TContext, TSource>
{
	private currentContext: TContext;
	private readonly errorMode: "throw" | "continue";
	private readonly onError?: (error: AgentHarnessHookError<TEvent, TSource>) => void | Promise<void>;
	private readonly observers = new Set<HookRegistration<HookObserver<TEvent, TContext>, TSource>>();
	private readonly handlers = new Map<string, Set<HookRegistration<HookHandler<TEvent, TContext>, TSource>>>();
	private readonly cleanups = new Set<() => void | Promise<void>>();
	private disposed = false;

	constructor(options: DefaultAgentHarnessHooksOptions<TContext, TEvent, TSource>) {
		this.currentContext = options.context;
		this.errorMode = options.errorMode ?? "throw";
		this.onError = options.onError;
	}

	get context(): TContext {
		return this.currentContext;
	}

	setContext(context: TContext): void {
		this.assertActive();
		this.currentContext = context;
	}

	observe(observer: HookObserver<TEvent, TContext>, options?: HookRegistrationOptions<TSource>): () => void {
		this.assertActive();
		const registration = { handler: observer, source: options?.source, cleanup: options?.cleanup };
		this.observers.add(registration);
		if (options?.cleanup) this.cleanups.add(options.cleanup);
		return () => this.removeRegistration(this.observers, registration);
	}

	on<TType extends TEvent["type"]>(
		type: TType,
		handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
		options?: HookRegistrationOptions<TSource>,
	): () => void {
		this.assertActive();
		let registrations = this.handlers.get(type);
		if (!registrations) {
			registrations = new Set();
			this.handlers.set(type, registrations);
		}
		const registration: HookRegistration<HookHandler<TEvent, TContext>, TSource> = {
			handler: handler as unknown as HookHandler<TEvent, TContext>,
			source: options?.source,
			cleanup: options?.cleanup,
		};
		registrations.add(registration);
		if (options?.cleanup) this.cleanups.add(options.cleanup);
		return () => this.removeRegistration(registrations, registration);
	}

	async emit<TType extends TEvent["type"]>(
		event: Extract<TEvent, { type: TType }>,
		signal?: AbortSignal,
	): Promise<ResultOf<Extract<TEvent, { type: TType }>> | undefined> {
		this.assertActive();
		for (const observer of [...this.observers]) {
			await this.callRegistration(observer, event, signal);
		}
		const registrations = [...(this.handlers.get(event.type) ?? [])];
		const result = await this.reduceEvent(event, registrations, signal);
		return result as ResultOf<Extract<TEvent, { type: TType }>> | undefined;
	}

	createScope(source: TSource): AgentHarnessHookScope<TEvent, TContext, TSource> {
		return {
			observe: (observer, options) => this.observe(observer, { ...options, source }),
			on: (type, handler, options) => this.on(type, handler, { ...options, source }),
			addCleanup: (cleanup) => this.addCleanup(cleanup),
		};
	}

	addCleanup(cleanup: () => void | Promise<void>): () => void {
		this.assertActive();
		this.cleanups.add(cleanup);
		return () => this.cleanups.delete(cleanup);
	}

	async clear(): Promise<void> {
		const cleanups = [...this.cleanups];
		this.observers.clear();
		this.handlers.clear();
		this.cleanups.clear();
		const errors: Error[] = [];
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup();
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "AgentHarness hook cleanup failed");
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		try {
			await this.clear();
		} finally {
			this.disposed = true;
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("AgentHarness hooks are disposed");
	}

	private removeRegistration<THandler>(
		registrations: Set<HookRegistration<THandler, TSource>>,
		registration: HookRegistration<THandler, TSource>,
	): void {
		registrations.delete(registration);
		if (registration.cleanup) this.cleanups.delete(registration.cleanup);
	}

	private async reportError(error: unknown, event: TEvent, source?: TSource): Promise<void> {
		const normalized = error instanceof Error ? error : new Error(String(error));
		await this.onError?.({ error: normalized, event, source });
		if (this.errorMode === "throw") throw normalized;
	}

	private async callRegistration<TValue>(
		registration: HookRegistration<(event: TEvent, context: TContext, signal?: AbortSignal) => TValue, TSource>,
		event: TEvent,
		signal?: AbortSignal,
	): Promise<Awaited<TValue> | undefined> {
		try {
			return await registration.handler(event, this.currentContext, signal);
		} catch (error) {
			await this.reportError(error, event, registration.source);
			return undefined;
		}
	}

	private async reduceEvent(
		event: TEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<unknown> {
		switch (event.type) {
			case "context":
				return this.reduceContext(event as ContextEvent, registrations, signal);
			case "before_message_persist":
				return this.reduceBeforeMessagePersist(event as BeforeMessagePersistEvent, registrations, signal);
			case "before_provider_request":
				return this.reduceProviderRequest(event as BeforeProviderRequestEvent, registrations, signal);
			case "before_provider_payload":
				return this.reduceProviderPayload(event as BeforeProviderPayloadEvent, registrations, signal);
			case "before_agent_start":
				return this.reduceBeforeAgentStart(event as BeforeAgentStartEvent, registrations, signal);
			case "tool_call":
				return this.reduceToolCall(event as ToolCallEvent, registrations, signal);
			case "tool_result":
				return this.reduceToolResult(event as ToolResultEvent, registrations, signal);
			case "session_before_compact":
				return this.reduceFirstCancelOrLast<SessionBeforeCompactEvent, SessionBeforeCompactResult>(
					event as SessionBeforeCompactEvent,
					registrations,
					signal,
				);
			case "session_before_tree":
				return this.reduceFirstCancelOrLast<SessionBeforeTreeEvent, SessionBeforeTreeResult>(
					event as SessionBeforeTreeEvent,
					registrations,
					signal,
				);
			default:
				for (const registration of registrations) await this.callRegistration(registration, event, signal);
				return undefined;
		}
	}

	private async reduceContext(
		event: ContextEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<ContextResult | undefined> {
		let current = event;
		for (const registration of registrations) {
			const result = (await this.callRegistration(registration, current as TEvent, signal)) as
				| ContextResult
				| undefined;
			if (result?.messages) current = { ...current, messages: result.messages };
		}
		return current.messages === event.messages ? undefined : { messages: current.messages };
	}

	private async reduceBeforeMessagePersist(
		event: BeforeMessagePersistEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<BeforeMessagePersistResult | undefined> {
		let message = event.message;
		for (const registration of registrations) {
			const result = (await this.callRegistration(registration, { ...event, message } as TEvent, signal)) as
				| BeforeMessagePersistResult
				| undefined;
			if (result?.message) message = result.message;
		}
		return message === event.message ? undefined : { message };
	}

	private async reduceProviderRequest(
		event: BeforeProviderRequestEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<BeforeProviderRequestResult | undefined> {
		let current = cloneStreamOptions(event.streamOptions);
		let changed = false;
		for (const registration of registrations) {
			const result = (await this.callRegistration(
				registration,
				{ ...event, streamOptions: cloneStreamOptions(current) } as TEvent,
				signal,
			)) as BeforeProviderRequestResult | undefined;
			if (result?.streamOptions) {
				current = applyStreamOptionsPatch(current, result.streamOptions);
				changed = true;
			}
		}
		return changed ? { streamOptions: diffStreamOptions(event.streamOptions, current) } : undefined;
	}

	private async reduceProviderPayload(
		event: BeforeProviderPayloadEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<BeforeProviderPayloadResult | undefined> {
		let current = event.payload;
		let changed = false;
		for (const registration of registrations) {
			const result = (await this.callRegistration(registration, { ...event, payload: current } as TEvent, signal)) as
				| BeforeProviderPayloadResult
				| undefined;
			if (result !== undefined) {
				current = result.payload;
				changed = true;
			}
		}
		return changed ? { payload: current } : undefined;
	}

	private async reduceBeforeAgentStart(
		event: BeforeAgentStartEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<BeforeAgentStartResult | undefined> {
		let systemPrompt = event.systemPrompt;
		const messages: BeforeAgentStartResult["messages"] = [];
		for (const registration of registrations) {
			const result = (await this.callRegistration(registration, { ...event, systemPrompt } as TEvent, signal)) as
				| BeforeAgentStartResult
				| undefined;
			if (result?.messages) messages.push(...result.messages);
			if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
		}
		return messages.length > 0 || systemPrompt !== event.systemPrompt ? { messages, systemPrompt } : undefined;
	}

	private async reduceToolCall(
		event: ToolCallEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<ToolCallResult | undefined> {
		for (const registration of registrations) {
			const result = (await this.callRegistration(registration, event as TEvent, signal)) as
				| ToolCallResult
				| undefined;
			if (result?.block) return result;
		}
		return undefined;
	}

	private async reduceToolResult(
		event: ToolResultEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<ToolResultPatch | undefined> {
		let current = event;
		let terminate: boolean | undefined;
		let changed = false;
		for (const registration of registrations) {
			const result = (await this.callRegistration(registration, current as TEvent, signal)) as
				| ToolResultPatch
				| undefined;
			if (!result) continue;
			current = {
				...current,
				content: result.content ?? current.content,
				details: result.details ?? current.details,
				isError: result.isError ?? current.isError,
			};
			if (result.terminate !== undefined) terminate = result.terminate;
			changed = true;
		}
		return changed
			? { content: current.content, details: current.details, isError: current.isError, terminate }
			: undefined;
	}

	private async reduceFirstCancelOrLast<
		TSpecificEvent extends AgentHarnessEvent,
		TResult extends { cancel?: boolean },
	>(
		event: TSpecificEvent,
		registrations: Array<HookRegistration<HookHandler<TEvent, TContext>, TSource>>,
		signal?: AbortSignal,
	): Promise<TResult | undefined> {
		let last: TResult | undefined;
		for (const registration of registrations) {
			const result = (await this.callRegistration(registration, event as unknown as TEvent, signal)) as
				| TResult
				| undefined;
			if (!result) continue;
			last = result;
			if (result.cancel) return result;
		}
		return last;
	}
}
