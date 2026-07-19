/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	estimateContextTokens,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai/compat";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentRunBudgetReason,
	AgentRunTermination,
	AgentRunUsage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
	ToolAttemptOutcome,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	validateRunBudget(config.runBudget);
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	validateRunBudget(config.runBudget);
	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	validateRunBudget(config.runBudget);
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	validateRunBudget(config.runBudget);
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

type ToolLoopHistoryEntry = {
	requestSignature: string;
	resultSignature: string;
};

type RunControl = {
	startedAt: number;
	config: AgentLoopConfig;
	usage: Omit<AgentRunUsage, "elapsedMs">;
	toolLoopHistory: ToolLoopHistoryEntry[];
	signal?: AbortSignal;
	timingTermination?: AgentRunTermination;
	dispose: () => void;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function validateRunBudget(runBudget: AgentLoopConfig["runBudget"]): void {
	if (!runBudget) return;

	validateNonNegativeSafeInteger(runBudget.maxSteps, "maxSteps");
	validateNonNegativeSafeInteger(runBudget.maxModelCalls, "maxModelCalls");
	validateNonNegativeSafeInteger(runBudget.maxToolCalls, "maxToolCalls");
	validateFiniteNonNegativeNumber(runBudget.maxWallTimeMs, "maxWallTimeMs");
	validateFiniteNonNegativeNumber(runBudget.maxModelTokens, "maxModelTokens");
	validateFiniteNonNegativeNumber(runBudget.maxCost, "maxCost");
	validateFiniteNonNegativeNumber(runBudget.deadline, "deadline");
}

function validateNonNegativeSafeInteger(value: unknown, field: string): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Agent run budget ${field} must be a non-negative safe integer`);
	}
}

function validateFiniteNonNegativeNumber(value: unknown, field: string): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Agent run budget ${field} must be a finite non-negative number`);
	}
}

function createRunControl(config: AgentLoopConfig, signal: AbortSignal | undefined): RunControl {
	const startedAt = Date.now();
	const usage = { steps: 0, modelCalls: 0, toolCalls: 0, modelTokens: 0, cost: 0 };
	const wallDeadline =
		config.runBudget?.maxWallTimeMs === undefined ? undefined : startedAt + config.runBudget.maxWallTimeMs;
	const absoluteDeadline = config.runBudget?.deadline;
	const effectiveDeadline =
		wallDeadline === undefined
			? absoluteDeadline
			: absoluteDeadline === undefined
				? wallDeadline
				: Math.min(wallDeadline, absoluteDeadline);
	if (effectiveDeadline === undefined) {
		return {
			startedAt,
			config,
			usage,
			toolLoopHistory: [],
			signal,
			dispose: () => {},
		};
	}

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let control: RunControl;
	const abortFromCaller = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		abortFromCaller();
	} else {
		signal?.addEventListener("abort", abortFromCaller, { once: true });
	}

	const abortForTimeLimit = () => {
		if (signal?.aborted || control.timingTermination) return;
		const now = Date.now();
		if (absoluteDeadline !== undefined && absoluteDeadline <= now && absoluteDeadline <= (wallDeadline ?? Infinity)) {
			control.timingTermination = {
				status: "deadline_exceeded",
				reason: "deadline",
				deadline: absoluteDeadline,
				observedAt: now,
				partialResult: usage.steps > 0 || usage.toolCalls > 0,
			};
		} else if (wallDeadline !== undefined && wallDeadline <= now) {
			control.timingTermination = createBudgetTermination(
				"max_wall_time",
				config.runBudget?.maxWallTimeMs ?? 0,
				now - startedAt,
				usage,
			);
		} else {
			return;
		}
		controller.abort(control.timingTermination);
	};

	const scheduleTimer = () => {
		if (controller.signal.aborted) return;
		const delay = effectiveDeadline - Date.now();
		if (delay <= 0) {
			abortForTimeLimit();
			return;
		}
		timer = setTimeout(scheduleTimer, Math.min(delay, MAX_TIMER_DELAY_MS));
	};

	control = {
		startedAt,
		config,
		usage,
		toolLoopHistory: [],
		signal: controller.signal,
		dispose: () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", abortFromCaller);
		},
	};
	scheduleTimer();
	return control;
}

function createBudgetTermination(
	reason: AgentRunBudgetReason,
	limit: number,
	observed: number,
	usage: RunControl["usage"],
): AgentRunTermination {
	return {
		status: "budget_exhausted",
		reason,
		limit,
		observed,
		partialResult: usage.steps > 0 || usage.toolCalls > 0,
	};
}

function refreshTimingTermination(control: RunControl): AgentRunTermination | undefined {
	if (control.timingTermination || control.signal?.aborted) return control.timingTermination;
	const now = Date.now();
	const budget = control.config.runBudget;
	const wallDeadline = budget?.maxWallTimeMs === undefined ? undefined : control.startedAt + budget.maxWallTimeMs;
	if (budget?.deadline !== undefined && now >= budget.deadline && budget.deadline <= (wallDeadline ?? Infinity)) {
		control.timingTermination = {
			status: "deadline_exceeded",
			reason: "deadline",
			deadline: budget.deadline,
			observedAt: now,
			partialResult: control.usage.steps > 0 || control.usage.toolCalls > 0,
		};
	} else if (budget?.maxWallTimeMs !== undefined && now - control.startedAt >= budget.maxWallTimeMs) {
		control.timingTermination = createBudgetTermination(
			"max_wall_time",
			budget.maxWallTimeMs,
			now - control.startedAt,
			control.usage,
		);
	}
	return control.timingTermination;
}

function getBeforeModelTermination(control: RunControl): AgentRunTermination | undefined {
	const timingTermination = refreshTimingTermination(control);
	if (timingTermination) return timingTermination;
	const budget = control.config.runBudget;
	if (!budget) return undefined;
	if (budget.maxSteps !== undefined && control.usage.steps >= budget.maxSteps) {
		return createBudgetTermination("max_steps", budget.maxSteps, control.usage.steps, control.usage);
	}
	if (budget.maxModelCalls !== undefined && control.usage.modelCalls >= budget.maxModelCalls) {
		return createBudgetTermination("max_model_calls", budget.maxModelCalls, control.usage.modelCalls, control.usage);
	}
	if (budget.maxModelTokens !== undefined && control.usage.modelTokens >= budget.maxModelTokens) {
		return createBudgetTermination(
			"max_model_tokens",
			budget.maxModelTokens,
			control.usage.modelTokens,
			control.usage,
		);
	}
	if (budget.maxCost !== undefined && control.usage.cost >= budget.maxCost) {
		return createBudgetTermination("max_cost", budget.maxCost, control.usage.cost, control.usage);
	}
	return undefined;
}

function getPostModelTermination(control: RunControl): AgentRunTermination | undefined {
	const timingTermination = refreshTimingTermination(control);
	if (timingTermination) return timingTermination;
	const budget = control.config.runBudget;
	if (budget?.maxModelTokens !== undefined && control.usage.modelTokens > budget.maxModelTokens) {
		return createBudgetTermination(
			"max_model_tokens",
			budget.maxModelTokens,
			control.usage.modelTokens,
			control.usage,
		);
	}
	if (budget?.maxCost !== undefined && control.usage.cost > budget.maxCost) {
		return createBudgetTermination("max_cost", budget.maxCost, control.usage.cost, control.usage);
	}
	return undefined;
}

function getRunUsage(control: RunControl): AgentRunUsage {
	return { ...control.usage, elapsedMs: Math.max(0, Date.now() - control.startedAt) };
}

async function emitTermination(
	termination: AgentRunTermination,
	control: RunControl,
	emit: AgentEventSink,
): Promise<void> {
	await emit({ type: "agent_termination", termination, usage: getRunUsage(control) });
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	const control = createRunControl(initialConfig, signal);
	try {
		let currentContext = initialContext;
		let config = initialConfig;
		let firstTurn = true;
		const initialTermination = getBeforeModelTermination(control);
		if (initialTermination) {
			await emitTermination(initialTermination, control, emit);
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		// Check for steering messages at start (user may have typed while waiting).
		let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

		// Outer loop: continues when queued follow-up messages arrive after agent would stop.
		while (true) {
			let hasMoreToolCalls = true;

			// Inner loop: process tool calls and steering messages.
			while (hasMoreToolCalls || pendingMessages.length > 0) {
				const beforeModelTermination = getBeforeModelTermination(control);
				if (beforeModelTermination) {
					await emitTermination(beforeModelTermination, control, emit);
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				if (!firstTurn) {
					await emit({ type: "turn_start" });
				} else {
					firstTurn = false;
				}

				// New user input is new evidence, so repeated-tool history does not cross this boundary.
				if (pendingMessages.length > 0) {
					control.toolLoopHistory = [];
					for (const message of pendingMessages) {
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				const llmContext = await prepareLlmContext(currentContext, config, control.signal);
				if (
					await config.shouldStopBeforeModelRequest?.({ model: config.model, context: llmContext }, control.signal)
				) {
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				control.usage.steps++;
				control.usage.modelCalls++;
				const message = await streamAssistantResponse(
					currentContext,
					llmContext,
					config,
					control.signal,
					emit,
					streamFn,
				);
				newMessages.push(message);
				recordAssistantUsage(message, control);

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					await emit({ type: "turn_end", message, toolResults: [] });
					const timingTermination = refreshTimingTermination(control);
					if (timingTermination) await emitTermination(timingTermination, control, emit);
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				const toolCalls = message.content.filter((content) => content.type === "toolCall");
				const postModelTermination = getPostModelTermination(control);
				if (postModelTermination) {
					const toolResults = await failToolCallsWithoutExecution(
						toolCalls,
						`Run terminated before tool execution: ${postModelTermination.reason}`,
						terminationToToolAttemptOutcome(postModelTermination),
						emit,
					);
					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
					await emit({ type: "turn_end", message, toolResults });
					await emitTermination(postModelTermination, control, emit);
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				const toolResults: ToolResultMessage[] = [];
				let toolBatchTermination: AgentRunTermination | undefined;
				hasMoreToolCalls = false;
				if (toolCalls.length > 0) {
					// A "length" stop means the output was cut off by the token limit, so
					// every tool call in the message may carry truncated arguments. Fail
					// them all instead of executing potentially borked calls.
					const executedToolBatch =
						message.stopReason === "length"
							? await failToolCallsFromTruncatedMessage(toolCalls, control, emit)
							: await executeToolCalls(currentContext, message, config, control, emit);
					toolResults.push(...executedToolBatch.messages);
					toolBatchTermination = executedToolBatch.termination;
					hasMoreToolCalls = !executedToolBatch.terminate;

					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				await emit({ type: "turn_end", message, toolResults });
				const timingTermination = refreshTimingTermination(control);
				const immediateTermination = timingTermination ?? toolBatchTermination;
				if (immediateTermination) {
					await emitTermination(immediateTermination, control, emit);
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				const nextTurnContext = {
					message,
					toolResults,
					context: currentContext,
					newMessages,
				};
				const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
					control.config = config;
				}

				if (
					await config.shouldStopAfterTurn?.({
						message,
						toolResults,
						context: currentContext,
						newMessages,
					})
				) {
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				if (hasMoreToolCalls) {
					const nextModelTermination = getBeforeModelTermination(control);
					if (nextModelTermination) {
						await emitTermination(nextModelTermination, control, emit);
						await emit({ type: "agent_end", messages: newMessages });
						return;
					}
				}

				// Do not drain steering if no additional model request can start.
				if (!hasMoreToolCalls && getBeforeModelTermination(control)) {
					pendingMessages = [];
				} else {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
			}

			// Do not drain follow-ups if the run has no remaining provider budget.
			if (getBeforeModelTermination(control)) break;
			const followUpMessages = (await config.getFollowUpMessages?.()) || [];
			if (followUpMessages.length > 0) {
				pendingMessages = followUpMessages;
				continue;
			}
			break;
		}

		await emit({ type: "agent_end", messages: newMessages });
	} finally {
		control.dispose();
	}
}

function recordAssistantUsage(message: AssistantMessage, control: RunControl): void {
	const usage = message.usage;
	const tokenParts = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const costParts = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	control.usage.modelTokens += Math.max(0, usage.totalTokens || tokenParts);
	control.usage.cost += Math.max(0, usage.cost.total || costParts);
}

async function prepareLlmContext(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<Context> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: await config.convertToLlm(messages),
		tools: context.tools,
	};
	return config.transformModelRequestContext
		? await config.transformModelRequestContext(llmContext, signal)
		: llmContext;
}

/**
 * Stream an assistant response from the LLM.
 * The provider-ready context has already passed request guards.
 */
async function streamAssistantResponse(
	context: AgentContext,
	llmContext: Context,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	const streamFunction = streamFn || streamSimple;
	const requestContextEstimate = {
		version: 1 as const,
		heuristicInputTokens: estimateContextTokens(llmContext, { calibrate: false }).rawTokens,
	};
	const finalizeMessage = (message: AssistantMessage): AssistantMessage => ({ ...message, requestContextEstimate });

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = finalizeMessage(await response.result());
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = finalizeMessage(await response.result());
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

type ToolCallPlan = {
	admitted: AgentToolCall[];
	blocked: AgentToolCall[];
	termination?: AgentRunTermination;
};

function planToolCalls(toolCalls: AgentToolCall[], control: RunControl): ToolCallPlan {
	const admitted: AgentToolCall[] = [];
	let termination: AgentRunTermination | undefined;

	for (const toolCall of toolCalls) {
		const maxToolCalls = control.config.runBudget?.maxToolCalls;
		if (maxToolCalls !== undefined && control.usage.toolCalls + admitted.length >= maxToolCalls) {
			termination = createBudgetTermination(
				"max_tool_calls",
				maxToolCalls,
				control.usage.toolCalls + admitted.length,
				control.usage,
			);
			break;
		}

		const loopTermination = detectRepeatedToolCall(toolCall, admitted, control);
		if (loopTermination) {
			termination = loopTermination;
			break;
		}
		admitted.push(toolCall);
	}

	return {
		admitted,
		blocked: toolCalls.slice(admitted.length),
		termination,
	};
}

function terminationToToolAttemptOutcome(
	termination: AgentRunTermination,
): Extract<ToolAttemptOutcome, "not_executed_budget" | "not_executed_deadline" | "not_executed_loop"> {
	switch (termination.status) {
		case "budget_exhausted":
			return "not_executed_budget";
		case "deadline_exceeded":
			return "not_executed_deadline";
		case "loop_detected":
			return "not_executed_loop";
	}
	const exhaustive: never = termination;
	return exhaustive;
}

function detectRepeatedToolCall(
	toolCall: AgentToolCall,
	admittedInBatch: AgentToolCall[],
	control: RunControl,
): AgentRunTermination | undefined {
	const detection = control.config.loopDetection;
	if (!detection || !Number.isInteger(detection.maxConsecutiveToolCalls) || detection.maxConsecutiveToolCalls < 2) {
		return undefined;
	}
	if (detection.includeToolResult !== false) return undefined;

	const requestSignature = createToolRequestSignature(toolCall);
	let repetitions = 1;
	const requestSignatures = [
		...control.toolLoopHistory.map((entry) => entry.requestSignature),
		...admittedInBatch.map(createToolRequestSignature),
	];
	for (let index = requestSignatures.length - 1; index >= 0; index--) {
		if (requestSignatures[index] !== requestSignature) break;
		repetitions++;
	}

	if (repetitions < detection.maxConsecutiveToolCalls) return undefined;
	return {
		status: "loop_detected",
		reason: "repeated_tool_call",
		toolName: toolCall.name,
		arguments: toolCall.arguments,
		repetitions,
		threshold: detection.maxConsecutiveToolCalls,
		partialResult: control.usage.steps > 0 || control.usage.toolCalls > 0,
	};
}

function createToolRequestSignature(toolCall: AgentToolCall): string {
	return `${toolCall.name}\0${stableValueSignature(toolCall.arguments)}`;
}

function stableValueSignature(value: unknown): string {
	const seen = new WeakSet<object>();
	const normalize = (current: unknown): unknown => {
		if (current === null || typeof current === "string" || typeof current === "boolean") return current;
		if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
		if (typeof current === "bigint") return `${current}n`;
		if (current === undefined) return "[undefined]";
		if (typeof current === "function") return "[function]";
		if (typeof current === "symbol") return String(current);
		if (Array.isArray(current)) return current.map(normalize);
		if (typeof current === "object") {
			if (seen.has(current)) return "[circular]";
			seen.add(current);
			const normalized: Record<string, unknown> = {};
			for (const key of Object.keys(current).sort()) {
				normalized[key] = normalize((current as Record<string, unknown>)[key]);
			}
			seen.delete(current);
			return normalized;
		}
		return String(current);
	};

	try {
		return JSON.stringify(normalize(value));
	} catch (error) {
		return `[unserializable:${errorMessage(error)}]`;
	}
}

function recordToolLoopHistory(
	finalizedCalls: FinalizedToolCallOutcome[],
	control: RunControl,
): AgentRunTermination | undefined {
	const detection = control.config.loopDetection;
	if (!detection) return undefined;
	let termination: AgentRunTermination | undefined;
	for (const finalized of finalizedCalls) {
		const entry = {
			requestSignature: createToolRequestSignature(finalized.toolCall),
			resultSignature: stableValueSignature({ result: finalized.result, isError: finalized.isError }),
		};
		control.toolLoopHistory.push(entry);
		if (
			!termination &&
			detection.includeToolResult !== false &&
			Number.isInteger(detection.maxConsecutiveToolCalls) &&
			detection.maxConsecutiveToolCalls >= 2
		) {
			let repetitions = 0;
			for (let index = control.toolLoopHistory.length - 1; index >= 0; index--) {
				const previous = control.toolLoopHistory[index];
				if (
					previous.requestSignature !== entry.requestSignature ||
					previous.resultSignature !== entry.resultSignature
				) {
					break;
				}
				repetitions++;
			}
			if (repetitions >= detection.maxConsecutiveToolCalls) {
				termination = {
					status: "loop_detected",
					reason: "repeated_tool_call",
					toolName: finalized.toolCall.name,
					arguments: finalized.toolCall.arguments,
					repetitions,
					threshold: detection.maxConsecutiveToolCalls,
					partialResult: control.usage.steps > 0 || control.usage.toolCalls > 0,
				};
			}
		}
	}
	const historyLimit = Math.max(1, detection.maxConsecutiveToolCalls);
	if (control.toolLoopHistory.length > historyLimit) {
		control.toolLoopHistory = control.toolLoopHistory.slice(-historyLimit);
	}
	return termination;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	control: RunControl,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const plan = planToolCalls(toolCalls, control);
	const messages: ToolResultMessage[] = [];
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	for (const toolCall of plan.admitted) {
		control.usage.toolCalls++;
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
			attemptOutcome: "not_executed_truncated",
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);
	}
	const resultLoopTermination = recordToolLoopHistory(finalizedCalls, control);
	if (plan.termination && !control.signal?.aborted) {
		messages.push(
			...(await failToolCallsWithoutExecution(
				plan.blocked,
				`Tool call was not executed: ${plan.termination.reason}`,
				terminationToToolAttemptOutcome(plan.termination),
				emit,
			)),
		);
	}
	const termination = plan.termination ?? resultLoopTermination;
	return { messages, terminate: termination !== undefined, termination };
}

async function failToolCallsWithoutExecution(
	toolCalls: AgentToolCall[],
	reason: string,
	attemptOutcome: Extract<ToolAttemptOutcome, "not_executed_budget" | "not_executed_deadline" | "not_executed_loop">,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(reason),
			isError: true,
			attemptOutcome,
		};
		await emitToolExecutionEnd(finalized, emit);
		const message = createToolResultMessage(finalized);
		await emitToolResultMessage(message, emit);
		messages.push(message);
	}
	return messages;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	control: RunControl,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const plan = planToolCalls(toolCalls, control);
	const hasSequentialToolCall = plan.admitted.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	const executed =
		config.toolExecution === "sequential" || hasSequentialToolCall
			? await executeToolCallsSequential(currentContext, assistantMessage, plan.admitted, config, control, emit)
			: await executeToolCallsParallel(currentContext, assistantMessage, plan.admitted, config, control, emit);
	if (plan.termination && !control.signal?.aborted) {
		executed.messages.push(
			...(await failToolCallsWithoutExecution(
				plan.blocked,
				`Tool call was not executed: ${plan.termination.reason}`,
				terminationToToolAttemptOutcome(plan.termination),
				emit,
			)),
		);
		executed.terminate = true;
		executed.termination = plan.termination;
	}
	return executed;
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	termination?: AgentRunTermination;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	control: RunControl,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		control.usage.toolCalls++;
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, control.signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
				attemptOutcome: preparation.attemptOutcome,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, control.signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				control.signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);
		const loopTermination = recordToolLoopHistory([finalized], control);
		if (loopTermination) {
			messages.push(
				...(await failToolCallsWithoutExecution(
					toolCalls.slice(index + 1),
					`Tool call was not executed: ${loopTermination.reason}`,
					"not_executed_loop",
					emit,
				)),
			);
			return { messages, terminate: true, termination: loopTermination };
		}

		if (control.signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	control: RunControl,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		control.usage.toolCalls++;
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, control.signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
				attemptOutcome: preparation.attemptOutcome,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (control.signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, control.signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				control.signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (control.signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const loopTermination = recordToolLoopHistory(orderedFinalizedCalls, control);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: loopTermination !== undefined || shouldTerminateToolBatch(orderedFinalizedCalls),
		termination: loopTermination,
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
	attemptOutcome: Extract<
		ToolAttemptOutcome,
		| "not_executed_missing_tool"
		| "not_executed_preparation_error"
		| "not_executed_before_hook_error"
		| "not_executed_blocked"
		| "not_executed_aborted_before_body"
	>;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	attemptOutcome: Extract<ToolAttemptOutcome, "not_executed_aborted_before_body" | "body_success" | "body_error">;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	attemptOutcome: ToolAttemptOutcome;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

function createImmediateToolCallOutcome(
	message: string,
	attemptOutcome: ImmediateToolCallOutcome["attemptOutcome"],
): ImmediateToolCallOutcome {
	return { kind: "immediate", result: createErrorToolResult(message), isError: true, attemptOutcome };
}

function errorMessage(error: unknown): string {
	try {
		const message = error instanceof Error ? error.message : String(error);
		return typeof message === "string" ? message : "Unknown error";
	} catch {
		return "Unknown error";
	}
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	if (signal?.aborted) {
		return createImmediateToolCallOutcome("Operation aborted", "not_executed_aborted_before_body");
	}

	let tool: AgentTool<any> | undefined;
	try {
		tool = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
	} catch (error) {
		return createImmediateToolCallOutcome(errorMessage(error), "not_executed_preparation_error");
	}
	if (!tool) {
		return createImmediateToolCallOutcome(`Tool ${toolCall.name} not found`, "not_executed_missing_tool");
	}

	let validatedArgs: unknown;
	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		validatedArgs = validateToolArguments(tool, preparedToolCall);
	} catch (error) {
		return createImmediateToolCallOutcome(errorMessage(error), "not_executed_preparation_error");
	}

	if (config.beforeToolCall) {
		try {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return createImmediateToolCallOutcome("Operation aborted", "not_executed_aborted_before_body");
			}
			if (beforeResult?.block) {
				return createImmediateToolCallOutcome(
					beforeResult.reason || "Tool execution was blocked",
					"not_executed_blocked",
				);
			}
		} catch (error) {
			if (signal?.aborted) {
				return createImmediateToolCallOutcome("Operation aborted", "not_executed_aborted_before_body");
			}
			return createImmediateToolCallOutcome(errorMessage(error), "not_executed_before_hook_error");
		}
	}
	if (signal?.aborted) {
		return createImmediateToolCallOutcome("Operation aborted", "not_executed_aborted_before_body");
	}
	return { kind: "prepared", toolCall, tool, args: validatedArgs };
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	if (signal?.aborted) {
		return {
			result: createErrorToolResult("Operation aborted"),
			isError: true,
			attemptOutcome: "not_executed_aborted_before_body",
		};
	}

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		const updateResult = await settleToolUpdates(updateEvents);
		if (!updateResult.ok) {
			return {
				result: createErrorToolResult(errorMessage(updateResult.error)),
				isError: true,
				attemptOutcome: "body_error",
			};
		}
		return { result, isError: false, attemptOutcome: "body_success" };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.allSettled(updateEvents);
		return {
			result: createErrorToolResult(errorMessage(error)),
			isError: true,
			attemptOutcome: "body_error",
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function settleToolUpdates(
	updateEvents: readonly Promise<void>[],
): Promise<{ ok: true } | { ok: false; error: unknown }> {
	const settlements = await Promise.allSettled(updateEvents);
	const rejected = settlements.find(
		(settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
	);
	return rejected ? { ok: false, error: rejected.reason } : { ok: true };
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;
	let attemptOutcome: ToolAttemptOutcome = executed.attemptOutcome;

	if (attemptOutcome === "not_executed_aborted_before_body") {
		return { toolCall: prepared.toolCall, result, isError, attemptOutcome };
	}

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(errorMessage(error));
			isError = true;
			attemptOutcome = "after_hook_error";
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
		attemptOutcome,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
		attemptOutcome: finalized.attemptOutcome,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
