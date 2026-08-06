/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	type LocalProcessRuntime,
	localProcessRuntime,
	type ThemeColor,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { SubagentProgressDisplay, type SubagentProgressEvent, type SubagentProgressMode } from "./progress-display.ts";
import {
	type AgentRuntimeConfig,
	buildRuntimeArgs,
	createChildRuntimePreflight,
	formatRuntimeDiagnostic,
	getRuntimeOverridesPath,
	loadRuntimeOverrides,
	MODEL_POLICY_VALUES,
	type ParentModelSnapshot,
	type RuntimeDiagnosticCode,
	type RuntimeModelRegistry,
	type RuntimeThinkingAdjustment,
	type RuntimeValidationResult,
	resolveAgentRuntime,
	resolveAndValidateAgentRuntime,
	THINKING_LEVELS,
	updateRuntimeOverride,
} from "./runtime-config.ts";
import { bindProcessAbort, classifyProcessCompletion, TaskControllerRegistry } from "./task-control.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const PARENT_VISIBLE_ERROR_CAP = 8 * 1024;
const CHILD_STDERR_CAP = 64 * 1024;
const MAX_TASK_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_TASK_TIMEOUT_MS = 180_000;

type AgentRoleDescriptor = Pick<
	AgentConfig,
	"name" | "provider" | "model" | "thinking" | "modelPolicy" | "runtimeErrors"
>;

interface AgentRoleGuidanceOptions {
	overrides?: Readonly<Record<string, AgentRuntimeConfig>>;
	parentModel?: ParentModelSnapshot;
	parentRegistry?: RuntimeModelRegistry;
	childRegistry?: RuntimeModelRegistry;
	preflightErrorCode?: RuntimeDiagnosticCode;
}

export function formatAvailableAgentRoles(
	agents: readonly AgentRoleDescriptor[],
	options: AgentRoleGuidanceOptions = {},
): string {
	if (agents.length === 0) return "(none discovered)";
	return agents
		.map((agent) => {
			const configured = resolveAgentRuntime(agent, options.overrides?.[agent.name], {});
			const validation =
				options.parentRegistry && options.childRegistry
					? resolveAndValidateAgentRuntime(
							agent,
							options.overrides?.[agent.name],
							{},
							agent.runtimeErrors,
							options.parentRegistry,
							{
								parentModel: options.parentModel,
								childRegistry: options.childRegistry,
							},
						)
					: undefined;
			const runtime = validation?.runtime ?? configured;
			const diagnostic = validation?.diagnostic;
			const providerModel = diagnostic
				? `${diagnostic.provider}/${diagnostic.model}`
				: runtime.modelPolicy === "child-default"
					? "child default (resolved at invocation)"
					: runtime.provider && runtime.model
						? `${runtime.provider}/${runtime.model}`
						: runtime.provider || runtime.model
							? `resolved at invocation (${runtime.provider ? `provider=${runtime.provider}` : `model=${runtime.model}`})`
							: "inherit parent (resolved at invocation)";
			const thinking = diagnostic?.thinking ?? runtime.thinking;
			const resolvedModel =
				!diagnostic && runtime.provider && runtime.model
					? options.childRegistry?.find(runtime.provider, runtime.model)
					: undefined;
			const supportedThinking =
				diagnostic?.supportedThinking ?? (resolvedModel ? getSupportedThinkingLevels(resolvedModel) : undefined);
			const status = validation?.errorCode ?? options.preflightErrorCode;
			const adjustment = validation?.adjustment?.message;
			return `${JSON.stringify(agent.name)} [provider/model=${providerModel}; effort=${thinking ?? "model default (resolved at invocation)"}; supported levels=${supportedThinking?.join(", ") || "resolved at invocation"}${adjustment ? `; adjustment=${adjustment}` : ""}${status ? `; preflight=${status}` : ""}]`;
		})
		.join("; ");
}

export function captureParentModelSnapshot(
	model: { readonly provider: string; readonly id: string } | undefined,
): ParentModelSnapshot | undefined {
	return model ? Object.freeze({ provider: model.provider, id: model.id }) : undefined;
}

export function normalizeTaskTimeout(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TASK_TIMEOUT_MS) {
		throw new Error(`timeoutMs must be a positive finite number no greater than ${MAX_TASK_TIMEOUT_MS}`);
	}
	return Math.ceil(value);
}

export interface SubagentInitialContextOptions {
	personaPrompt: string;
	role: string;
	roleSource: AgentConfig["source"];
	cwd: string;
	parentModel: ParentModelSnapshot | undefined;
	childRuntime: AgentRuntimeConfig;
	taskId: string;
	task: string;
	timeoutMs: number;
}

export function buildSubagentInitialContext(options: SubagentInitialContextOptions): {
	systemPrompt: string;
	userPrompt: string;
} {
	const parentModel = options.parentModel
		? `${options.parentModel.provider}/${options.parentModel.id}`
		: "(none active)";
	const childModel = options.childRuntime.model
		? `${options.childRuntime.provider ? `${options.childRuntime.provider}/` : ""}${options.childRuntime.model}`
		: options.childRuntime.modelPolicy === "child-default"
			? "child default"
			: "(unresolved)";
	const childRuntime = `${childModel}${options.childRuntime.thinking ? `:${options.childRuntime.thinking}` : ""}`;
	const contract = [
		"Delegated execution context:",
		`- Role: ${JSON.stringify(options.role)} (source=${JSON.stringify(options.roleSource)})`,
		`- Parent model: ${JSON.stringify(parentModel)}`,
		`- Child runtime: ${JSON.stringify(childRuntime)}`,
		`- Canonical cwd: ${JSON.stringify(options.cwd)}`,
		`- Task id: ${JSON.stringify(options.taskId)}`,
		`- Configured timeout: ${options.timeoutMs} ms`,
		"- No parent conversation is included. Use only this role prompt, the task below, applicable instruction files, and evidence you inspect.",
		"- Treat task-stated scope and explicit paths as hard boundaries. Do not inspect unrelated dirty changes or broaden into repository-wide scans unless the task explicitly requests them.",
		"- Report a nonexistent task path once, do not search for substitutes outside scope, and continue only with the remaining stated paths.",
		"- For a narrow verification task, return immediately once its stated acceptance checklist is satisfied.",
		"- If the task combines multiple independent domains or exhaustive repo, test, and asset review, return a split plan instead of attempting the whole scope.",
		"- Search before broad reads. For a likely small file, start with one default bounded read; provide offset and limit only when continuing truncated output or retrieving a task-relevant range.",
		"- For logs and large files, use targeted rg queries before bounded reads. Do not read consecutive ranges to EOF unless the task evidence requires the complete file.",
		"- If the task is read-only, do not call write, edit, or other mutating tools.",
		"- Put temporary probes under the OS temporary directory (for example /tmp), and follow applicable AGENTS.md command and test requirements.",
		"- Do not delegate recursively. Extensions and prompt templates are disabled; task-relevant skills remain available.",
		"- The first non-empty line of the final answer MUST be exactly one of: RESULT: completed, RESULT: partial, RESULT: blocked.",
		"- After RESULT, follow the role persona's response format and explicitly include evidence and unresolved issues. If the persona defines no format, use concise SUMMARY:, EVIDENCE:, and OPEN_ISSUES: sections.",
	].join("\n");
	return {
		systemPrompt: `${options.personaPrompt.trim()}\n\n${contract}`.trim(),
		userPrompt: `Task ${JSON.stringify(options.taskId)} (role ${JSON.stringify(options.role)}):\n${options.task}`,
	};
}

export function formatSubagentTimeoutDiagnostic(options: {
	taskId: string;
	role: string;
	elapsedMs: number;
	timeoutMs: number;
}): string {
	return [
		`Subagent timed out: task=${options.taskId} role=${options.role} elapsed=${Math.max(0, Math.round(options.elapsedMs))}ms configuredTimeout=${options.timeoutMs}ms.`,
		"Split the work into narrower independent tasks, then retry with an explicit timeoutMs sized for each bounded task.",
	].join(" ");
}

export function resolveTaskCwd(workspaceRoot: string, requestedCwd: string | undefined): string {
	const canonicalRoot = fs.realpathSync(workspaceRoot);
	const candidate = path.resolve(workspaceRoot, requestedCwd ?? ".");
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync(candidate);
	} catch {
		throw new Error(`Task cwd must be an existing directory inside workspace: ${candidate}`);
	}
	if (!fs.statSync(canonicalCwd).isDirectory()) {
		throw new Error(`Task cwd must be an existing directory inside workspace: ${candidate}`);
	}
	const relative = path.relative(canonicalRoot, canonicalCwd);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Task cwd is outside workspace ${canonicalRoot}: ${canonicalCwd}`);
	}
	return canonicalCwd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextContent(value: unknown): boolean {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): boolean {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function isMessage(value: unknown): value is Message {
	if (!isRecord(value)) return false;
	if (value.role === "user") {
		return (
			typeof value.content === "string" ||
			(Array.isArray(value.content) && value.content.every((part) => isTextContent(part) || isImageContent(part)))
		);
	}
	if (value.role === "toolResult") {
		return Array.isArray(value.content) && value.content.every((part) => isTextContent(part) || isImageContent(part));
	}
	if (value.role !== "assistant" || !Array.isArray(value.content)) return false;
	return value.content.every((part) => {
		if (!isRecord(part)) return false;
		if (part.type === "text") return typeof part.text === "string";
		if (part.type === "thinking") return typeof part.thinking === "string";
		return (
			part.type === "toolCall" &&
			typeof part.id === "string" &&
			typeof part.name === "string" &&
			isRecord(part.arguments)
		);
	});
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatResolvedRuntime(result: Pick<SingleResult, "provider" | "model" | "thinking">): string | undefined {
	if (!result.model && !result.provider && !result.thinking) return undefined;
	const model = result.model ? `${result.provider ? `${result.provider}/` : ""}${result.model}` : result.provider;
	return `${model ?? "default"}${result.thinking ? `:${result.thinking}` : ""}`;
}

function formatPreflightFailure(result: SingleResult): string | undefined {
	if (!result.errorCode) return undefined;
	const lines = [
		`Error code: ${result.errorCode}`,
		`Message: ${result.errorMessage ?? "Subagent runtime preflight failed."}`,
	];
	const runtime = formatResolvedRuntime(result);
	if (runtime) lines.push(`Resolved runtime: ${runtime}`);
	if (result.supportedThinking) lines.push(`Supported thinking: ${result.supportedThinking.join(", ")}`);
	if (result.cwd) lines.push(`Canonical cwd: ${result.cwd}`);
	if (result.timeoutMs !== undefined) lines.push(`Effective timeout: ${result.timeoutMs} ms`);
	return lines.join("\n");
}

function getRedactedToolArgumentMetadata(part: unknown): { count?: number } {
	if (!isRecord(part)) return {};
	const metadata = part.argumentMetadata;
	if (
		isRecord(metadata) &&
		metadata.visibility === "redacted" &&
		typeof metadata.count === "number" &&
		Number.isSafeInteger(metadata.count) &&
		metadata.count >= 0
	) {
		return { count: metadata.count };
	}
	const legacyArguments = part.arguments;
	if (
		isRecord(legacyArguments) &&
		legacyArguments.argumentsRedacted === true &&
		typeof legacyArguments.argumentCount === "number" &&
		Number.isSafeInteger(legacyArguments.argumentCount) &&
		legacyArguments.argumentCount >= 0
	) {
		return { count: legacyArguments.argumentCount };
	}
	return {};
}

function formatToolCall(
	toolName: string,
	argumentCount: number | undefined,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const count = argumentCount === undefined ? "count unknown" : `${argumentCount} supplied`;
	return themeFg("accent", `tool call ${toolName}`) + themeFg("dim", ` — arguments redacted (${count})`);
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type ChildReportedOutcome = "completed" | "partial" | "blocked";

export function parseChildReportedOutcome(output: string): ChildReportedOutcome | undefined {
	const firstLine = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	const outcome = /^RESULT: (completed|partial|blocked)$/.exec(firstLine ?? "")?.[1];
	return outcome === "completed" || outcome === "partial" || outcome === "blocked" ? outcome : undefined;
}

export interface SingleResult {
	taskId: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	taskSummary: string;
	exitCode: number;
	status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | "skipped";
	cwd?: string;
	timeoutMs?: number;
	activityOutput?: string;
	lastActivityAt?: number;
	phase?: string;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	thinkingAdjustment?: RuntimeThinkingAdjustment;
	supportedThinking?: readonly ThinkingLevel[];
	errorCode?: RuntimeDiagnosticCode;
	stopReason?: string;
	errorMessage?: string;
	reportedOutcome?: ChildReportedOutcome;
	step?: number;
}

export interface SubagentDetails {
	toolCallId: string;
	mode: "single" | "parallel" | "chain";
	revision: number;
	expectedTasks: number;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(
			/((?:["']?)authorization(?:["']?)\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
			"$1[redacted]",
		)
		.replace(/\b(Bearer)\s+(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1 [redacted]")
		.replace(
			/((?:["']?)(?:api[_-]?key|token|secret|password)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
			"$1[redacted]",
		)
		.replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g, "[redacted]")
		.replace(/:\/\/[^@\s]+@/g, "://[redacted]@");
}

export function summarizeTaskForStatus(task: string): string {
	return redactSensitiveText(task).replace(/\s+/g, " ").trim().slice(0, 160);
}

export interface SubagentActivity {
	output: string;
	lastActivityAt: number;
	phase: string;
}

export function updateSubagentActivity(
	current: SubagentActivity | undefined,
	line: string,
	now = Date.now(),
): SubagentActivity | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch {
		return current;
	}
	if (!isRecord(parsed) || parsed.type !== "message_update" || !isRecord(parsed.assistantMessageEvent)) return current;
	const event = parsed.assistantMessageEvent;
	let addition: string | undefined;
	let phase: string | undefined;
	if (event.type === "text_delta" && typeof event.delta === "string") {
		addition = "[responding]";
		phase = "responding";
	} else if (event.type === "toolcall_start") {
		const partial = isRecord(event.partial) ? event.partial : undefined;
		const candidateName =
			typeof event.toolName === "string"
				? event.toolName
				: typeof partial?.name === "string"
					? partial.name
					: "tool";
		const name = /^[A-Za-z0-9_.:-]{1,80}$/.test(candidateName) ? redactSensitiveText(candidateName) : "tool";
		addition = `[tool: ${name}]`;
		phase = `tool:${name}`;
	}
	if (!addition || !phase) return current;
	return {
		output: addition,
		lastActivityAt: now,
		phase,
	};
}

export type ParsedSubagentMessageEvent =
	| { type: "message_end"; message: Extract<Message, { role: "assistant" }> }
	| { type: "tool_result_end"; message: Extract<Message, { role: "toolResult" }> };

export function parseSubagentMessageEvent(line: string): ParsedSubagentMessageEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isMessage(parsed.message)) return undefined;
	if (parsed.type === "message_end" && parsed.message.role === "assistant") {
		const content: typeof parsed.message.content = [];
		for (const part of parsed.message.content) {
			if (part.type === "text") content.push(part);
			else if (part.type === "toolCall") {
				const sanitizedToolCall = {
					type: "toolCall" as const,
					id: part.id,
					name: part.name,
					arguments: {},
					argumentMetadata: {
						visibility: "redacted" as const,
						count: Object.keys(part.arguments).length,
					},
				};
				content.push(sanitizedToolCall);
			}
		}
		return {
			type: "message_end",
			message: { ...parsed.message, content },
		};
	}
	if (parsed.type === "tool_result_end" && parsed.message.role === "toolResult") {
		return { type: "tool_result_end", message: parsed.message };
	}
	return undefined;
}

function getStatusActivity(messages: Message[]): string | undefined {
	const items = getDisplayItems(messages);
	const last = items.at(-1);
	if (!last) return undefined;
	return last.type === "toolCall" ? last.name : "responding";
}

export function createSubagentStateEvent(details: SubagentDetails): SubagentProgressEvent {
	if (details.results.length !== details.expectedTasks) {
		throw new Error(
			`Subagent snapshot expectedTasks=${details.expectedTasks} but received ${details.results.length} results`,
		);
	}
	const results = details.results.map((result) =>
		Object.freeze({
			taskId: result.taskId,
			agent: result.agent,
			taskSummary: summarizeTaskForStatus(result.taskSummary),
			status: result.status,
			cwd: result.cwd,
			timeoutMs: result.timeoutMs,
			activityOutput: result.activityOutput,
			lastActivityAt: result.lastActivityAt,
			phase: result.phase,
			inactivityMs: result.lastActivityAt ? Math.max(0, Date.now() - result.lastActivityAt) : undefined,
			inactivityWarning:
				result.status === "running" && result.lastActivityAt && Date.now() - result.lastActivityAt >= 60_000
					? "No child activity for at least 60 seconds"
					: undefined,
			lastActivity: result.phase?.startsWith("tool:")
				? result.phase
				: (result.activityOutput?.trim().split("\n").at(-1) ?? result.phase ?? getStatusActivity(result.messages)),
			usage: Object.freeze({ ...result.usage }),
			provider: result.provider,
			model: result.model,
			thinking: result.thinking,
			thinkingAdjustment: result.thinkingAdjustment,
		}),
	);
	return Object.freeze({
		toolCallId: details.toolCallId,
		mode: details.mode,
		revision: details.revision,
		expectedTasks: details.expectedTasks,
		results: Object.freeze(results),
	});
}

function createRuntimeFailure(
	taskId: string,
	agent: string,
	task: string,
	taskSummary: string,
	error: string,
	step?: number,
	cwd?: string,
	timeoutMs?: number,
	validation?: RuntimeValidationResult,
	thinkingAdjustment?: RuntimeThinkingAdjustment,
): SingleResult {
	return {
		taskId,
		agent,
		agentSource: "unknown",
		task,
		taskSummary: summarizeTaskForStatus(taskSummary),
		exitCode: 1,
		status: "failed",
		cwd,
		timeoutMs,
		messages: [],
		stderr: error,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		provider: validation?.runtime?.provider ?? validation?.diagnostic?.provider,
		model: validation?.runtime?.model ?? validation?.diagnostic?.model,
		thinking: validation?.runtime?.thinking ?? validation?.diagnostic?.thinking,
		thinkingAdjustment,
		supportedThinking: validation?.diagnostic?.supportedThinking,
		errorCode: validation?.errorCode,
		errorMessage: validation?.error ?? error,
		step,
	};
}

function createCancelledResult(
	taskId: string,
	agent: string,
	task: string,
	taskSummary: string,
	runtime: AgentRuntimeConfig,
	step?: number,
	cwd?: string,
	timeoutMs?: number,
): SingleResult {
	return {
		taskId,
		agent,
		agentSource: "unknown",
		task,
		taskSummary: summarizeTaskForStatus(taskSummary),
		exitCode: 130,
		status: "cancelled",
		cwd,
		timeoutMs,
		messages: [],
		stderr: "Canceled before start",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		provider: runtime.provider,
		model: runtime.model,
		thinking: runtime.thinking,
		stopReason: "aborted",
		errorMessage: "Canceled by user",
		step,
	};
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		const preflightFailure = formatPreflightFailure(result);
		if (preflightFailure) return preflightFailure;
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function formatParentVisibleField(value: string | number | undefined): string {
	return JSON.stringify(value ?? null);
}

function formatParentVisibleError(value: string): string {
	const redacted = redactSensitiveText(value);
	const encoded = JSON.stringify(redacted);
	if (Buffer.byteLength(encoded, "utf8") <= PARENT_VISIBLE_ERROR_CAP) return encoded;
	const marker = `\n[Error truncated: ${Buffer.byteLength(redacted, "utf8")} bytes total]`;
	let prefix = redacted.slice(0, PARENT_VISIBLE_ERROR_CAP);
	let capped = JSON.stringify(`${prefix}${marker}`);
	while (Buffer.byteLength(capped, "utf8") > PARENT_VISIBLE_ERROR_CAP) {
		prefix = prefix.slice(0, -1);
		capped = JSON.stringify(`${prefix}${marker}`);
	}
	return capped;
}

export function formatParentVisibleResult(result: SingleResult): string {
	const errorMessage = isFailedResult(result)
		? (formatPreflightFailure(result) ?? result.errorMessage ?? getResultOutput(result))
		: result.errorMessage;
	return [
		[
			`taskId=${formatParentVisibleField(result.taskId)}`,
			`role=${formatParentVisibleField(result.agent)}`,
			`status=${formatParentVisibleField(result.status)}`,
			`cwd=${formatParentVisibleField(result.cwd)}`,
			`timeoutMs=${formatParentVisibleField(result.timeoutMs)}`,
			`provider=${formatParentVisibleField(result.provider)}`,
			`model=${formatParentVisibleField(result.model)}`,
			`thinking=${formatParentVisibleField(result.thinking)}`,
			`reportedOutcome=${formatParentVisibleField(result.reportedOutcome)}`,
		].join(" "),
		[
			`outcome exitCode=${formatParentVisibleField(result.exitCode)}`,
			`stopReason=${formatParentVisibleField(result.stopReason)}`,
			`errorMessage=${errorMessage === undefined ? formatParentVisibleField(undefined) : formatParentVisibleError(errorMessage)}`,
		].join(" "),
		...(result.thinkingAdjustment ? [`runtime adjustment: ${result.thinkingAdjustment.message}`] : []),
		[
			`usage turns=${result.usage.turns}`,
			`input=${result.usage.input}`,
			`output=${result.usage.output}`,
			`cacheRead=${result.usage.cacheRead}`,
			`cacheWrite=${result.usage.cacheWrite}`,
			`contextTokens=${result.usage.contextTokens}`,
			`cost=${result.usage.cost}`,
		].join(" "),
		`output: ${truncateParallelOutput(getFinalOutput(result.messages) || "(no output)")}`,
	].join("\n");
}

function formatParentVisibleResults(results: readonly SingleResult[]): string {
	return results.map(formatParentVisibleResult).join("\n\n---\n\n");
}

export function formatChainTerminalHeader(results: readonly Pick<SingleResult, "status">[]): string {
	const completed = results.filter((result) => result.status === "completed").length;
	const failed = results.filter(
		(result) => result.status === "failed" || result.status === "cancelled" || result.status === "timed_out",
	).length;
	return `Chain: completed=${completed} failed=${failed} attempted=${completed + failed} total=${results.length}`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; argumentCount?: number };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") {
					const metadata = getRedactedToolArgumentMetadata(part);
					items.push({ type: "toolCall", name: part.name, argumentCount: metadata.count });
				}
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export interface PiInvocationRuntime {
	currentScript: string | undefined;
	execPath: string;
	execArgv: string[];
	cwd: string;
	environment: NodeJS.ProcessEnv;
}

export interface PiInvocation {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
}

function getTsxExecArgs(execArgv: string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < execArgv.length; index++) {
		const argument = execArgv[index];
		if (argument === "--require" || argument === "--import" || argument === "--loader") {
			const value = execArgv[index + 1];
			if (value && /(?:^|[/\\])tsx[/\\]dist[/\\]/.test(value)) {
				result.push(argument, value);
				index++;
			}
			continue;
		}
		if (
			(argument.startsWith("--require=") || argument.startsWith("--import=") || argument.startsWith("--loader=")) &&
			/(?:^|[/\\])tsx[/\\]dist[/\\]/.test(argument)
		) {
			result.push(argument);
		}
	}
	return result;
}

export function getPiInvocation(
	args: string[],
	runtime: PiInvocationRuntime = {
		currentScript: process.argv[1],
		execPath: process.execPath,
		execArgv: process.execArgv,
		cwd: process.cwd(),
		environment: process.env,
	},
): PiInvocation {
	const { currentScript, execPath } = runtime;
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		const tsxExecArgs = /\.(?:cts|mts|ts|tsx)$/.test(currentScript) ? getTsxExecArgs(runtime.execArgv) : [];
		if (tsxExecArgs.length > 0) {
			const tsconfigPath = runtime.environment.TSX_TSCONFIG_PATH;
			const env =
				tsconfigPath && !path.isAbsolute(tsconfigPath)
					? { ...runtime.environment, TSX_TSCONFIG_PATH: path.resolve(runtime.cwd, tsconfigPath) }
					: undefined;
			return { command: execPath, args: [...tsxExecArgs, currentScript, ...args], env };
		}
		return { command: execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export function buildSubagentRuntimeArgs(runtime: AgentRuntimeConfig, tools: string[] | undefined): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-prompt-templates",
		...buildRuntimeArgs(runtime),
	];
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	return args;
}

async function runSingleAgent(
	agents: AgentConfig[],
	taskId: string,
	agentName: string,
	task: string,
	taskSummary: string,
	runtime: AgentRuntimeConfig,
	thinkingAdjustment: RuntimeThinkingAdjustment | undefined,
	cwd: string,
	timeoutMs: number,
	parentModel: ParentModelSnapshot | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	taskSignal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	processRuntime: Pick<LocalProcessRuntime, "start">,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	const safeTaskSummary = summarizeTaskForStatus(taskSummary);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const errorMessage = `Unknown agent: "${agentName}". Available agents: ${available}.`;
		return {
			taskId,
			agent: agentName,
			agentSource: "unknown",
			task,
			taskSummary: safeTaskSummary,
			exitCode: 1,
			status: "failed",
			messages: [],
			stderr: errorMessage,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			provider: runtime.provider,
			model: runtime.model,
			thinking: runtime.thinking,
			thinkingAdjustment,
			errorMessage,
			step,
		};
	}
	const args = buildSubagentRuntimeArgs(runtime, agent.tools);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let inactivityTimer: ReturnType<typeof setInterval> | undefined;

	const currentResult: SingleResult = {
		taskId,
		agent: agentName,
		agentSource: agent.source,
		task,
		taskSummary: safeTaskSummary,
		exitCode: 0,
		status: "running",
		cwd,
		timeoutMs,
		lastActivityAt: Date.now(),
		phase: "starting",
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		provider: runtime.provider,
		model: runtime.model,
		thinking: runtime.thinking,
		thinkingAdjustment,
		step,
	};

	const emitUpdate = () => {
		const details = makeDetails([currentResult]);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details,
			});
		}
	};

	if (agent.configError) {
		const errorMessage = redactSensitiveText(agent.configError);
		currentResult.exitCode = 1;
		currentResult.status = "failed";
		currentResult.stderr = errorMessage;
		currentResult.errorMessage = errorMessage;
		emitUpdate();
		return currentResult;
	}

	try {
		const initialContext = buildSubagentInitialContext({
			personaPrompt: agent.systemPrompt,
			role: agent.name,
			roleSource: agent.source,
			cwd,
			parentModel,
			childRuntime: runtime,
			taskId,
			task,
			timeoutMs,
		});
		const tmp = await writePromptToTempFile(agent.name, initialContext.systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath, initialContext.userPrompt);
		emitUpdate();
		let abortSource: "parent" | "task" | "timeout" | undefined;

		const invocation = getPiInvocation(args);
		let buffer = "";
		let stderrBytesSeen = 0;
		let stderrTail = Buffer.alloc(0);
		const appendStderr = (data: Buffer | string) => {
			const chunk = typeof data === "string" ? Buffer.from(data) : data;
			stderrBytesSeen += chunk.length;
			stderrTail = Buffer.concat([stderrTail, chunk]);
			const tailCap = CHILD_STDERR_CAP - 128;
			if (stderrTail.length > tailCap) {
				stderrTail = stderrTail.subarray(stderrTail.length - tailCap);
			}
			const omittedBytes = Math.max(0, stderrBytesSeen - stderrTail.length);
			const prefix = omittedBytes > 0 ? `[stderr truncated: ${omittedBytes} bytes omitted]\n` : "";
			currentResult.stderr = redactSensitiveText(`${prefix}${stderrTail.toString("utf8")}`);
		};
		const processLine = (line: string) => {
			if (!line.trim()) return;
			const activity = updateSubagentActivity(
				currentResult.lastActivityAt
					? {
							output: currentResult.activityOutput ?? "",
							lastActivityAt: currentResult.lastActivityAt,
							phase: currentResult.phase ?? "running",
						}
					: undefined,
				line,
			);
			if (activity && activity.lastActivityAt !== currentResult.lastActivityAt) {
				currentResult.activityOutput = activity.output;
				currentResult.lastActivityAt = activity.lastActivityAt;
				currentResult.phase = activity.phase;
				emitUpdate();
			}
			const parsed = parseSubagentMessageEvent(line);
			if (!parsed) return;

			if (parsed.type === "message_end") {
				const msg = parsed.message;
				currentResult.messages.push(msg);
				currentResult.usage.turns++;
				const usage = msg.usage;
				if (usage) {
					currentResult.usage.input += usage.input || 0;
					currentResult.usage.output += usage.output || 0;
					currentResult.usage.cacheRead += usage.cacheRead || 0;
					currentResult.usage.cacheWrite += usage.cacheWrite || 0;
					currentResult.usage.cost += usage.cost?.total || 0;
					currentResult.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!currentResult.model && msg.model) currentResult.model = msg.model;
				if (msg.stopReason) currentResult.stopReason = msg.stopReason;
				if (msg.errorMessage) currentResult.errorMessage = redactSensitiveText(msg.errorMessage);
				emitUpdate();
			} else {
				currentResult.messages.push(parsed.message);
				emitUpdate();
			}
		};
		const startedAt = Date.now();
		const processHandle = processRuntime.start({
			command: invocation.command,
			args: invocation.args,
			cwd,
			env: invocation.env,
			onOutput: (stream, data) => {
				if (stream === "stderr") {
					appendStderr(data);
					return;
				}
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			},
		});
		inactivityTimer = setInterval(emitUpdate, 30_000);
		const abortBinding = bindProcessAbort(
			{
				kill: (childSignal) => processHandle.terminate("aborted", childSignal),
			},
			signal,
			taskSignal,
			5_000,
			timeoutMs,
		);
		const processExit = await processHandle.wait();
		if (inactivityTimer) clearInterval(inactivityTimer);
		abortSource = abortBinding.getSource();
		abortBinding.close();
		if (buffer.trim()) processLine(buffer);
		if (processExit.reason === "failed") {
			const errorMessage = redactSensitiveText(processExit.error ?? "Subagent process failed");
			currentResult.errorMessage = errorMessage;
			appendStderr(`${errorMessage}\n`);
		}
		const exitCode = processExit.exitCode ?? (processExit.reason === "failed" ? 1 : 0);

		currentResult.exitCode = exitCode;
		currentResult.reportedOutcome = parseChildReportedOutcome(getFinalOutput(currentResult.messages));
		const completionStatus = classifyProcessCompletion(exitCode, abortSource);
		if (completionStatus === "timed_out") {
			currentResult.exitCode = exitCode === 0 ? 124 : exitCode;
			currentResult.stopReason = "timed-out";
			currentResult.errorMessage = formatSubagentTimeoutDiagnostic({
				taskId,
				role: agent.name,
				elapsedMs: Date.now() - startedAt,
				timeoutMs,
			});
			currentResult.status = "timed_out";
			currentResult.phase = "timed-out";
			emitUpdate();
		} else if (completionStatus === "cancelled") {
			currentResult.exitCode = exitCode === 0 ? 130 : exitCode;
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = abortSource === "parent" ? "Canceled with parent request" : "Canceled by user";
			currentResult.status = "cancelled";
			currentResult.phase = "cancelled";
			emitUpdate();
		} else {
			currentResult.status = isFailedResult(currentResult) ? "failed" : completionStatus;
			emitUpdate();
		}
		return currentResult;
	} finally {
		if (inactivityTimer) clearInterval(inactivityTimer);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const ThinkingSchema = StringEnum(THINKING_LEVELS, {
	description: "Reasoning effort for this subagent",
});
const ModelPolicySchema = StringEnum(MODEL_POLICY_VALUES, {
	description: "Model fallback policy when provider/model are not explicitly configured",
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "One bounded task with a specific deliverable; split broad multi-domain work" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_TASK_TIMEOUT_MS,
			description: "Per-task wall-clock timeout override. The call-level explicit timeoutMs applies when omitted.",
		}),
	),
	provider: Type.Optional(Type.String({ description: "Provider override for this task" })),
	model: Type.Optional(Type.String({ description: "Model override for this task" })),
	thinking: Type.Optional(ThinkingSchema),
	modelPolicy: Type.Optional(ModelPolicySchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "One bounded step with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_TASK_TIMEOUT_MS,
			description: "Per-step wall-clock timeout override. The call-level explicit timeoutMs applies when omitted.",
		}),
	),
	provider: Type.Optional(Type.String({ description: "Provider override for this step" })),
	model: Type.Optional(Type.String({ description: "Model override for this step" })),
	thinking: Type.Optional(ThinkingSchema),
	modelPolicy: Type.Optional(ModelPolicySchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	timeoutMs: Type.Integer({
		minimum: 1,
		maximum: MAX_TASK_TIMEOUT_MS,
		description: "Explicit wall-clock timeout shared by tasks unless an item overrides it.",
	}),
	provider: Type.Optional(Type.String({ description: "Provider override for single mode" })),
	model: Type.Optional(Type.String({ description: "Model override for single mode" })),
	thinking: Type.Optional(ThinkingSchema),
	modelPolicy: Type.Optional(ModelPolicySchema),
});

async function showAgentConfig(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user");
	if (discovery.agents.length === 0) {
		ctx.ui.notify(`No agents found in ${getAgentDir()}/agents`, "warning");
		return;
	}

	const loaded = loadRuntimeOverrides();
	if (loaded.error) {
		ctx.ui.notify(`Cannot edit ${getRuntimeOverridesPath()}: ${loaded.error}`, "error");
		return;
	}

	const agentOptions = discovery.agents.map((agent) => `${agent.name} [${agent.source}]`);
	const selectedAgentLabel = await ctx.ui.select("Configure subagent", agentOptions);
	if (!selectedAgentLabel) return;
	const selectedIndex = agentOptions.indexOf(selectedAgentLabel);
	const agent = discovery.agents[selectedIndex];
	if (!agent) return;

	const action = await ctx.ui.select(`Runtime for ${agent.name}`, [
		"Choose provider/model/effort",
		"Inherit parent model",
		"Use child default model",
		"Use agent defaults",
	]);
	if (!action) return;
	if (action === "Use agent defaults") {
		await updateRuntimeOverride(agent.name, undefined);
		ctx.ui.notify(`Cleared personal runtime override for ${agent.name}`, "info");
		return;
	}
	if (action === "Inherit parent model" || action === "Use child default model") {
		const modelPolicy = action === "Inherit parent model" ? "inherit-parent" : "child-default";
		await updateRuntimeOverride(agent.name, { modelPolicy });
		ctx.ui.notify(`Saved ${agent.name}: ${modelPolicy}`, "info");
		return;
	}

	const availableModels = ctx.modelRegistry.getAvailable();
	const providers = Array.from(new Set(availableModels.map((model) => model.provider))).sort();
	const provider = await ctx.ui.select("Provider", providers);
	if (!provider) return;
	const providerModels = availableModels.filter((model) => model.provider === provider);
	const modelOptions = providerModels.map((model) => `${model.name} (${model.id})`);
	const selectedModelLabel = await ctx.ui.select(`Model from ${provider}`, modelOptions);
	if (!selectedModelLabel) return;
	const selectedModel = providerModels[modelOptions.indexOf(selectedModelLabel)];
	if (!selectedModel) return;

	const effortOptions = getSupportedThinkingLevels(selectedModel) as ThinkingLevel[];
	const thinking = await ctx.ui.select("Effort", effortOptions);
	if (!thinking) return;
	await updateRuntimeOverride(agent.name, { provider, model: selectedModel.id, thinking: thinking as ThinkingLevel });
	ctx.ui.notify(`Saved ${agent.name}: ${provider}/${selectedModel.id} · ${thinking}`, "info");
	pi.events.emit("pi:subagent-config-changed", { agent: agent.name });
}

export interface SubagentExtensionDependencies {
	discoverAgents?: typeof discoverAgents;
	loadRuntimeOverrides?: typeof loadRuntimeOverrides;
	createChildRuntimePreflight?: typeof createChildRuntimePreflight;
	processRuntime?: Pick<LocalProcessRuntime, "start">;
}

export default function subagentExtension(pi: ExtensionAPI) {
	registerSubagentExtension(pi);
}

export function registerSubagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
	const discoverAgentsImpl = dependencies.discoverAgents ?? discoverAgents;
	const loadRuntimeOverridesImpl = dependencies.loadRuntimeOverrides ?? loadRuntimeOverrides;
	const createChildRuntimePreflightImpl = dependencies.createChildRuntimePreflight ?? createChildRuntimePreflight;
	const processRuntime = dependencies.processRuntime ?? localProcessRuntime;
	const activeTasks = new TaskControllerRegistry();
	const progressDisplay = new SubagentProgressDisplay();
	let availableUserRoles = formatAvailableAgentRoles(discoverAgentsImpl(process.cwd(), "user").agents);
	let currentCtx: ExtensionContext | undefined;

	const updateProgressUi = () => {
		if (!currentCtx) return;
		currentCtx.ui.setStatus("subagent-progress", progressDisplay.getStatusText());
		const lines = progressDisplay.getLines();
		if (!lines) {
			currentCtx.ui.setWidget("subagent-progress", undefined);
			return;
		}
		currentCtx.ui.setWidget("subagent-progress", (_tui, theme) => ({
			render: (width: number) =>
				lines.map((line, index) =>
					truncateToWidth(index === 0 ? theme.fg("accent", line) : line, Math.max(1, width), "…", true),
				),
			invalidate: () => {},
		}));
	};
	const trackProgress = async <T>(
		toolCallId: string,
		mode: SubagentProgressMode,
		expectedTasks: number,
		run: () => Promise<T>,
	): Promise<T> => {
		progressDisplay.begin(toolCallId, mode, expectedTasks);
		updateProgressUi();
		try {
			return await run();
		} finally {
			progressDisplay.finish(toolCallId);
			updateProgressUi();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		progressDisplay.clear();
		updateProgressUi();
		const discovery = discoverAgentsImpl(ctx.cwd, "user");
		const overrides = loadRuntimeOverridesImpl();
		const preflight = await createChildRuntimePreflightImpl();
		availableUserRoles = formatAvailableAgentRoles(discovery.agents, {
			overrides: overrides.error ? undefined : overrides.config.agents,
			parentModel: captureParentModelSnapshot(ctx.model),
			parentRegistry: ctx.modelRegistry,
			childRegistry: preflight.registry,
			preflightErrorCode: preflight.errorCode,
		});
	});
	pi.on("session_shutdown", async () => {
		progressDisplay.clear();
		updateProgressUi();
		currentCtx = undefined;
		activeTasks.cancelAll();
		disposeCancelListener();
		disposeConfigureListener();
	});

	const disposeCancelListener = pi.events.on("pi:subagent-cancel", (data) => {
		if (!data || typeof data !== "object") return;
		const taskId = (data as { taskId?: unknown }).taskId;
		if (typeof taskId !== "string") return;
		activeTasks.cancel(taskId);
	});
	const disposeConfigureListener = pi.events.on("pi:subagent-configure", () => {
		if (currentCtx) void showAgentConfig(pi, currentCtx);
	});

	pi.registerCommand("agent-config", {
		description: "Configure per-agent provider, model, and effort overrides",
		handler: async (_args, ctx) => {
			await showAgentConfig(pi, ctx);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		promptSnippet: "Delegate bounded tasks to isolated subagents with explicit deadlines",
		promptGuidelines: [
			"Split broad repository, test, and artifact reviews into independent bounded tasks before delegation.",
			"Treat task-stated scope and explicit paths as hard boundaries; do not inspect unrelated dirty changes or run broad repository scans unless explicitly requested.",
			"Report nonexistent paths once without searching outside scope, and make narrow verification tasks return immediately after their acceptance checklist is satisfied.",
			"Choose an explicit timeoutMs for every subagent call; do not rely on an implicit deadline.",
			"Use at least 180000 ms for a focused single-file task and 300000 ms for a bounded multi-file review; split broader independent work instead of using a short deadline.",
		],
		get description() {
			return [
				"Delegate tasks to specialized subagents with isolated context.",
				`Available user roles and runtimes: ${availableUserRoles}. Choose only a listed role unless intentionally enabling project roles with agentScope; unknown roles are rejected with the current available-role list.`,
				"Modes: single (agent + task), parallel (independent bounded tasks), chain (bounded sequential steps with {previous}). An explicit call-level timeoutMs is required.",
				"Child tool-call arguments are deliberately redacted from parent-visible activity and details. Sanitized records carry explicit redaction metadata outside an empty ordinary arguments payload; legacy empty payloads mean redacted with unknown count, not omitted arguments.",
				`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
				`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			].join(" ");
		},
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const parentModelSnapshot = captureParentModelSnapshot(ctx.model);
			const childRuntimePreflight = createChildRuntimePreflightImpl();
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgentsImpl(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const loadedOverrides = loadRuntimeOverridesImpl();
			if (loadedOverrides.error) {
				return {
					content: [{ type: "text", text: `Invalid ${getRuntimeOverridesPath()}: ${loadedOverrides.error}` }],
					details: {
						toolCallId,
						mode: "single" as const,
						revision: 0,
						expectedTasks: 0,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [],
					},
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const expectedTasks = hasChain
				? (params.chain?.length ?? 0)
				: hasTasks
					? (params.tasks?.length ?? 0)
					: hasSingle
						? 1
						: 0;
			let revision = 0;
			const createDetails = (
				mode: "single" | "parallel" | "chain",
				results: SingleResult[],
				currentRevision: number,
			): SubagentDetails => ({
				toolCallId,
				mode,
				revision: currentRevision,
				expectedTasks,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results: [...results],
			});
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => {
					if (results.length !== expectedTasks) return createDetails(mode, results, revision);
					const details = createDetails(mode, results, ++revision);
					const stateEvent = createSubagentStateEvent(details);
					progressDisplay.update(stateEvent);
					updateProgressUi();
					pi.events.emit("pi:subagent-state", stateEvent);
					return details;
				};
			const makeChildDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails =>
					createDetails(mode, results, revision);

			const getRuntime = async (
				agentName: string,
				taskOverride: AgentRuntimeConfig,
			): Promise<RuntimeValidationResult> => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				const personalOverride = loadedOverrides.config.agents[agentName];
				const defaults: AgentRuntimeConfig = agent
					? {
							provider: agent.provider,
							model: agent.model,
							thinking: agent.thinking,
							modelPolicy: agent.modelPolicy,
						}
					: {};
				const preflight = await childRuntimePreflight;
				if (!preflight.registry) return preflight;
				return resolveAndValidateAgentRuntime(
					defaults,
					personalOverride,
					taskOverride,
					agent?.runtimeErrors,
					ctx.modelRegistry,
					{ parentModel: parentModelSnapshot, childRegistry: preflight.registry },
				);
			};

			const getExecution = (requestedCwd: string | undefined, requestedTimeoutMs: number | undefined) => {
				try {
					return {
						cwd: resolveTaskCwd(ctx.cwd, requestedCwd),
						timeoutMs: normalizeTaskTimeout(requestedTimeoutMs),
					};
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			};

			const runTrackedAgent = async (
				taskId: string,
				agentName: string,
				task: string,
				taskSummary: string,
				runtime: AgentRuntimeConfig,
				thinkingAdjustment: RuntimeThinkingAdjustment | undefined,
				cwd: string,
				timeoutMs: number,
				step: number | undefined,
				update: OnUpdateCallback | undefined,
				detailsFactory: (results: SingleResult[]) => SubagentDetails,
				reservedController?: AbortController,
			): Promise<SingleResult> => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				const controller = reservedController ?? activeTasks.start(taskId);
				const safeTaskSummary = summarizeTaskForStatus(taskSummary);
				const queuedResult: SingleResult = {
					taskId,
					agent: agentName,
					agentSource: agent?.source ?? "unknown",
					task,
					taskSummary: safeTaskSummary,
					exitCode: -1,
					status: "queued",
					cwd,
					timeoutMs,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					provider: runtime.provider,
					model: runtime.model,
					thinking: runtime.thinking,
					thinkingAdjustment,
					step,
				};
				const queuedDetails = detailsFactory([queuedResult]);
				update?.({ content: [{ type: "text", text: "(queued...)" }], details: queuedDetails });
				try {
					if (signal?.aborted || controller.signal.aborted) {
						const cancelled = createCancelledResult(
							taskId,
							agentName,
							task,
							safeTaskSummary,
							runtime,
							step,
							cwd,
							timeoutMs,
						);
						cancelled.agentSource = agent?.source ?? "unknown";
						cancelled.thinkingAdjustment = thinkingAdjustment;
						const details = detailsFactory([cancelled]);
						update?.({ content: [{ type: "text", text: "(cancelled)" }], details });
						return cancelled;
					}
					const result = await runSingleAgent(
						agents,
						taskId,
						agentName,
						task,
						safeTaskSummary,
						runtime,
						thinkingAdjustment,
						cwd,
						timeoutMs,
						parentModelSnapshot,
						step,
						signal,
						controller.signal,
						update,
						detailsFactory,
						processRuntime,
					);
					return result;
				} finally {
					activeTasks.finish(taskId);
				}
			};

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const chain = params.chain;
				return await trackProgress(toolCallId, "chain", chain.length, async () => {
					const resolvedRuntimes = await Promise.all(
						chain.map((step) =>
							getRuntime(step.agent, {
								provider: step.provider,
								model: step.model,
								thinking: step.thinking,
								modelPolicy: step.modelPolicy,
							}),
						),
					);
					const executions = chain.map((step) => getExecution(step.cwd, step.timeoutMs ?? params.timeoutMs));
					const allResults: SingleResult[] = chain.map((step, index) => {
						const resolved = resolvedRuntimes[index];
						const execution = executions[index];
						const taskSummary = summarizeTaskForStatus(step.task.replace(/\{previous\}/g, "[previous output]"));
						return resolved.runtime && execution.cwd && execution.timeoutMs
							? {
									taskId: `${toolCallId}:${index}`,
									agent: step.agent,
									agentSource: agents.find((agent) => agent.name === step.agent)?.source ?? "unknown",
									task: step.task,
									taskSummary,
									exitCode: -1,
									status: "queued",
									cwd: execution.cwd,
									timeoutMs: execution.timeoutMs,
									messages: [],
									stderr: "",
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0,
										contextTokens: 0,
										turns: 0,
									},
									provider: resolved.runtime.provider,
									model: resolved.runtime.model,
									thinking: resolved.runtime.thinking,
									thinkingAdjustment: resolved.adjustment,
									step: index + 1,
								}
							: createRuntimeFailure(
									`${toolCallId}:${index}`,
									step.agent,
									step.task,
									taskSummary,
									execution.error ??
										(resolved.error ? formatRuntimeDiagnostic(resolved) : "Invalid task configuration"),
									index + 1,
									execution.cwd,
									execution.timeoutMs,
									resolved.runtime || (!execution.error && resolved.errorCode) ? resolved : undefined,
									resolved.adjustment,
								);
					});
					makeDetails("chain")(allResults);
					let previousOutput = "";

					for (let i = 0; i < chain.length; i++) {
						const step = chain[i];
						const execution = executions[i];
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
						const taskSummary = step.task.replace(/\{previous\}/g, "[previous output]");
						const taskId = `${toolCallId}:${i}`;
						const resolved = resolvedRuntimes[i];
						const chainUpdate: OnUpdateCallback = (partial) => {
							const currentResult = partial.details?.results[0];
							if (!currentResult) return;
							allResults[i] = currentResult;
							const details = makeDetails("chain")(allResults);
							onUpdate?.({ content: partial.content, details });
						};

						const result =
							resolved.runtime && execution.cwd && execution.timeoutMs
								? await runTrackedAgent(
										taskId,
										step.agent,
										taskWithContext,
										taskSummary,
										resolved.runtime,
										resolved.adjustment,
										execution.cwd,
										execution.timeoutMs,
										i + 1,
										chainUpdate,
										makeChildDetails("chain"),
									)
								: createRuntimeFailure(
										taskId,
										step.agent,
										taskWithContext,
										taskSummary,
										execution.error ??
											(resolved.error ? formatRuntimeDiagnostic(resolved) : "Invalid task configuration"),
										i + 1,
										execution.cwd,
										execution.timeoutMs,
										resolved.runtime || (!execution.error && resolved.errorCode) ? resolved : undefined,
										resolved.adjustment,
									);
						allResults[i] = result;

						if (isFailedResult(result)) {
							for (let next = i + 1; next < allResults.length; next++) {
								allResults[next] = {
									...allResults[next],
									exitCode: 1,
									status: "skipped",
									stderr: "Skipped because an earlier chain step did not complete",
									errorMessage: "Skipped because an earlier chain step did not complete",
								};
							}
							return {
								content: [
									{
										type: "text",
										text: `${formatChainTerminalHeader(allResults)}\n\n${formatParentVisibleResults(allResults)}`,
									},
								],
								details: makeDetails("chain")(allResults),
							};
						}
						previousOutput = getFinalOutput(result.messages);
					}
					return {
						content: [
							{
								type: "text",
								text: `${formatChainTerminalHeader(allResults)}\n\n${formatParentVisibleResults(allResults)}`,
							},
						],
						details: makeDetails("chain")(allResults),
					};
				});
			}

			if (params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks;
				if (tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				return await trackProgress(toolCallId, "parallel", tasks.length, async () => {
					// Track all results for streaming updates
					const allResults: SingleResult[] = new Array(tasks.length);
					const resolvedRuntimes = await Promise.all(
						tasks.map((task) =>
							getRuntime(task.agent, {
								provider: task.provider,
								model: task.model,
								thinking: task.thinking,
								modelPolicy: task.modelPolicy,
							}),
						),
					);
					const executions = tasks.map((task) => getExecution(task.cwd, task.timeoutMs ?? params.timeoutMs));
					const taskControllers = resolvedRuntimes.map((runtime, index) =>
						runtime.runtime && executions[index].cwd ? activeTasks.start(`${toolCallId}:${index}`) : undefined,
					);

					// Initialize placeholder results
					for (let i = 0; i < tasks.length; i++) {
						const runtime = resolvedRuntimes[i];
						const execution = executions[i];
						allResults[i] =
							runtime.runtime && execution.cwd && execution.timeoutMs
								? {
										taskId: `${toolCallId}:${i}`,
										agent: tasks[i].agent,
										agentSource: "unknown",
										task: tasks[i].task,
										taskSummary: summarizeTaskForStatus(tasks[i].task),
										exitCode: -1,
										status: "queued",
										cwd: execution.cwd,
										timeoutMs: execution.timeoutMs,
										messages: [],
										stderr: "",
										usage: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											cost: 0,
											contextTokens: 0,
											turns: 0,
										},
										provider: runtime.runtime.provider,
										model: runtime.runtime.model,
										thinking: runtime.runtime.thinking,
										thinkingAdjustment: runtime.adjustment,
									}
								: createRuntimeFailure(
										`${toolCallId}:${i}`,
										tasks[i].agent,
										tasks[i].task,
										tasks[i].task,
										execution.error ??
											(runtime.error ? formatRuntimeDiagnostic(runtime) : "Invalid task configuration"),
										undefined,
										execution.cwd,
										execution.timeoutMs,
										runtime.runtime || (!execution.error && runtime.errorCode) ? runtime : undefined,
										runtime.adjustment,
									);
					}

					const emitParallelUpdate = () => {
						const details = makeDetails("parallel")([...allResults]);
						if (onUpdate) {
							const queued = allResults.filter((result) => result.status === "queued").length;
							const running = allResults.filter((result) => result.status === "running").length;
							const done = allResults.filter(
								(result) => result.status !== "queued" && result.status !== "running",
							).length;
							onUpdate({
								content: [
									{
										type: "text",
										text: `Parallel: ${done}/${expectedTasks} done, ${running} running, ${queued} queued...`,
									},
								],
								details,
							});
						}
					};
					emitParallelUpdate();

					const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
						const taskId = `${toolCallId}:${index}`;
						const resolved = resolvedRuntimes[index];
						const execution = executions[index];
						const result =
							resolved.runtime && execution.cwd && execution.timeoutMs
								? await runTrackedAgent(
										taskId,
										t.agent,
										t.task,
										t.task,
										resolved.runtime,
										resolved.adjustment,
										execution.cwd,
										execution.timeoutMs,
										undefined,
										(partial) => {
											if (partial.details?.results[0]) {
												allResults[index] = partial.details.results[0];
												emitParallelUpdate();
											}
										},
										makeChildDetails("parallel"),
										taskControllers[index],
									)
								: allResults[index];
						if (allResults[index] !== result) {
							allResults[index] = result;
							emitParallelUpdate();
						}
						return result;
					});

					const successCount = results.filter((result) => result.status === "completed").length;
					return {
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${expectedTasks} succeeded\n\n${formatParentVisibleResults(results)}`,
							},
						],
						details: makeDetails("parallel")(results),
					};
				});
			}

			if (params.agent && params.task) {
				const agentName = params.agent;
				const task = params.task;
				return await trackProgress(toolCallId, "single", 1, async () => {
					const taskId = `${toolCallId}:0`;
					const resolved = await getRuntime(agentName, {
						provider: params.provider,
						model: params.model,
						thinking: params.thinking,
						modelPolicy: params.modelPolicy,
					});
					const execution = getExecution(params.cwd, params.timeoutMs);
					const result =
						resolved.runtime && execution.cwd && execution.timeoutMs
							? await runTrackedAgent(
									taskId,
									agentName,
									task,
									task,
									resolved.runtime,
									resolved.adjustment,
									execution.cwd,
									execution.timeoutMs,
									undefined,
									(partial) => {
										const current = partial.details?.results[0];
										if (!current) return;
										const details = makeDetails("single")([current]);
										onUpdate?.({ content: partial.content, details });
									},
									makeChildDetails("single"),
								)
							: createRuntimeFailure(
									taskId,
									agentName,
									task,
									task,
									execution.error ??
										(resolved.error ? formatRuntimeDiagnostic(resolved) : "Invalid task configuration"),
									undefined,
									execution.cwd,
									execution.timeoutMs,
									resolved.runtime || (!execution.error && resolved.errorCode) ? resolved : undefined,
									resolved.adjustment,
								);
					return {
						content: [{ type: "text", text: formatParentVisibleResult(result) }],
						details: makeDetails("single")([result]),
					};
				});
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.argumentCount, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const isPending = r.status === "queued" || r.status === "running";
				const icon = isPending
					? theme.fg("warning", "⏳")
					: r.status === "cancelled"
						? theme.fg("warning", "◼")
						: isError
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					const preflightFailure = formatPreflightFailure(r);
					if (preflightFailure) container.addChild(new Text(theme.fg("error", preflightFailure), 0, 0));
					else if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						const emptyLabel = isPending ? `(${r.status}...)` : "(no output)";
						container.addChild(new Text(theme.fg("muted", emptyLabel), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.argumentCount, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, formatResolvedRuntime(r));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				const preflightFailure = formatPreflightFailure(r);
				if (preflightFailure) text += `\n${theme.fg("error", preflightFailure)}`;
				else if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) {
					text += `\n${theme.fg("muted", isPending ? `(${r.status}...)` : "(no output)")}`;
				} else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, formatResolvedRuntime(r));
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((result) => result.status === "completed").length;
				const chainPending = details.results.some(
					(result) => result.status === "queued" || result.status === "running",
				);
				const icon = chainPending
					? theme.fg("warning", "⏳")
					: successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.status === "queued" || r.status === "running"
								? theme.fg("warning", "⏳")
								: r.status === "completed"
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const preflightFailure = formatPreflightFailure(r);
						if (preflightFailure) container.addChild(new Text(theme.fg("error", preflightFailure), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.argumentCount, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, formatResolvedRuntime(r));
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon =
						r.status === "queued" || r.status === "running"
							? theme.fg("warning", "⏳")
							: r.status === "completed"
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const preflightFailure = formatPreflightFailure(r);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (preflightFailure) text += `\n${theme.fg("error", preflightFailure)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const queued = details.results.filter((result) => result.status === "queued").length;
				const running = details.results.filter((result) => result.status === "running").length;
				const expectedTasks = Math.max(0, Math.floor(details.expectedTasks));
				const successCount = Math.min(
					expectedTasks,
					details.results.filter((result) => result.status === "completed").length,
				);
				const terminalCount = Math.min(
					expectedTasks,
					details.results.filter((result) => result.status !== "queued" && result.status !== "running").length,
				);
				const unsuccessfulCount = Math.min(
					expectedTasks,
					details.results.filter(
						(result) =>
							result.status !== "queued" && result.status !== "running" && result.status !== "completed",
					).length,
				);
				const isRunning = queued > 0 || running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: unsuccessfulCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${terminalCount}/${expectedTasks} done, ${running} running, ${queued} queued`
					: `${successCount}/${expectedTasks} succeeded`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const preflightFailure = formatPreflightFailure(r);
						if (preflightFailure) container.addChild(new Text(theme.fg("error", preflightFailure), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.argumentCount, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, formatResolvedRuntime(r));
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.status === "queued"
							? theme.fg("muted", "○")
							: r.status === "running"
								? theme.fg("warning", "⏳")
								: r.status === "completed"
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const preflightFailure = formatPreflightFailure(r);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (preflightFailure) text += `\n${theme.fg("error", preflightFailure)}`;
					else if (displayItems.length === 0) {
						const emptyLabel =
							r.status === "queued" ? "(queued...)" : r.status === "running" ? "(running...)" : "(no output)";
						text += `\n${theme.fg("muted", emptyLabel)}`;
					} else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
