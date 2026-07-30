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

import { spawn } from "node:child_process";
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
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	type AgentRuntimeConfig,
	buildRuntimeArgs,
	getRuntimeOverridesPath,
	loadRuntimeOverrides,
	resolveAndValidateAgentRuntime,
	THINKING_LEVELS,
	updateRuntimeOverride,
} from "./runtime-config.ts";
import { bindProcessAbort, TaskControllerRegistry } from "./task-control.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
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

export interface SingleResult {
	taskId: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	taskSummary: string;
	exitCode: number;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetails {
	toolCallId: string;
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export function summarizeTaskForStatus(task: string): string {
	return task
		.replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
		.replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)\S+/gi, "$1[redacted]")
		.replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g, "[redacted]")
		.replace(/:\/\/[^@\s]+@/g, "://[redacted]@")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}

function getStatusActivity(messages: Message[]): string | undefined {
	const items = getDisplayItems(messages);
	const last = items.at(-1);
	if (!last) return undefined;
	return last.type === "toolCall" ? last.name : "responding";
}

export function createSubagentStateEvent(details: SubagentDetails) {
	return {
		toolCallId: details.toolCallId,
		mode: details.mode,
		results: details.results.map((result) => ({
			taskId: result.taskId,
			agent: result.agent,
			taskSummary: summarizeTaskForStatus(result.taskSummary),
			status: result.status,
			lastActivity: getStatusActivity(result.messages),
			usage: { ...result.usage },
			provider: result.provider,
			model: result.model,
			thinking: result.thinking,
		})),
	};
}

function createRuntimeFailure(
	taskId: string,
	agent: string,
	task: string,
	taskSummary: string,
	error: string,
	step?: number,
): SingleResult {
	return {
		taskId,
		agent,
		agentSource: "unknown",
		task,
		taskSummary: summarizeTaskForStatus(taskSummary),
		exitCode: 1,
		status: "failed",
		messages: [],
		stderr: error,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		errorMessage: error,
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
): SingleResult {
	return {
		taskId,
		agent,
		agentSource: "unknown",
		task,
		taskSummary: summarizeTaskForStatus(taskSummary),
		exitCode: 130,
		status: "cancelled",
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
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
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

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	taskId: string,
	agentName: string,
	task: string,
	taskSummary: string,
	runtime: AgentRuntimeConfig,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	taskSignal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
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
			errorMessage,
			step,
		};
	}
	if (agent.configError) {
		return {
			taskId,
			agent: agentName,
			agentSource: agent.source,
			task,
			taskSummary: safeTaskSummary,
			exitCode: 1,
			status: "failed",
			messages: [],
			stderr: agent.configError,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			provider: runtime.provider,
			model: runtime.model,
			thinking: runtime.thinking,
			errorMessage: agent.configError,
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session", ...buildRuntimeArgs(runtime)];
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		taskId,
		agent: agentName,
		agentSource: agent.source,
		task,
		taskSummary: safeTaskSummary,
		exitCode: 0,
		status: "running",
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		provider: runtime.provider,
		model: runtime.model,
		thinking: runtime.thinking,
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

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		emitUpdate();
		let abortSource: "parent" | "task" | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			const abortBinding = bindProcessAbort(
				{
					kill: (childSignal) => {
						if (process.platform !== "win32" && proc.pid) {
							try {
								process.kill(-proc.pid, childSignal);
								return true;
							} catch {
								// Fall back to the direct child if its process group has already exited.
							}
						}
						return proc.kill(childSignal);
					},
				},
				signal,
				taskSignal,
			);

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
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
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				abortSource = abortBinding.getSource();
				abortBinding.close();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				abortSource = abortBinding.getSource();
				abortBinding.close();
				currentResult.errorMessage = error.message;
				currentResult.stderr += `${error.message}\n`;
				resolve(1);
			});
		});

		currentResult.exitCode = exitCode;
		if (abortSource) {
			currentResult.exitCode = exitCode === 0 ? 130 : exitCode;
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = abortSource === "parent" ? "Canceled with parent request" : "Canceled by user";
			currentResult.status = "cancelled";
			emitUpdate();
		} else {
			currentResult.status = isFailedResult(currentResult) ? "failed" : "completed";
			emitUpdate();
		}
		return currentResult;
	} finally {
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

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	provider: Type.Optional(Type.String({ description: "Provider override for this task" })),
	model: Type.Optional(Type.String({ description: "Model override for this task" })),
	thinking: Type.Optional(ThinkingSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	provider: Type.Optional(Type.String({ description: "Provider override for this step" })),
	model: Type.Optional(Type.String({ description: "Model override for this step" })),
	thinking: Type.Optional(ThinkingSchema),
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
	provider: Type.Optional(Type.String({ description: "Provider override for single mode" })),
	model: Type.Optional(Type.String({ description: "Model override for single mode" })),
	thinking: Type.Optional(ThinkingSchema),
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
		"Use agent defaults",
	]);
	if (!action) return;
	if (action === "Use agent defaults") {
		await updateRuntimeOverride(agent.name, undefined);
		ctx.ui.notify(`Cleared personal runtime override for ${agent.name}`, "info");
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

export default function (pi: ExtensionAPI) {
	const activeTasks = new TaskControllerRegistry();
	let currentCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
	});
	pi.on("session_shutdown", async () => {
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
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const loadedOverrides = loadRuntimeOverrides();
			if (loadedOverrides.error) {
				return {
					content: [{ type: "text", text: `Invalid ${getRuntimeOverridesPath()}: ${loadedOverrides.error}` }],
					details: {
						toolCallId,
						mode: "single" as const,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [],
					},
					isError: true,
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => {
					const details = {
						toolCallId,
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
					};
					pi.events.emit("pi:subagent-state", createSubagentStateEvent(details));
					return details;
				};

			const getRuntime = (agentName: string, taskOverride: AgentRuntimeConfig) => {
				const agent = agents.find((candidate) => candidate.name === agentName);
				const personalOverride = loadedOverrides.config.agents[agentName];
				const defaults: AgentRuntimeConfig = agent
					? { provider: agent.provider, model: agent.model, thinking: agent.thinking }
					: {};
				return resolveAndValidateAgentRuntime(
					defaults,
					personalOverride,
					taskOverride,
					agent?.runtimeErrors,
					ctx.modelRegistry,
				);
			};

			const runTrackedAgent = async (
				taskId: string,
				agentName: string,
				task: string,
				taskSummary: string,
				runtime: AgentRuntimeConfig,
				cwd: string | undefined,
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
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					provider: runtime.provider,
					model: runtime.model,
					thinking: runtime.thinking,
					step,
				};
				const queuedDetails = detailsFactory([queuedResult]);
				update?.({ content: [{ type: "text", text: "(queued...)" }], details: queuedDetails });
				try {
					if (signal?.aborted || controller.signal.aborted) {
						const cancelled = createCancelledResult(taskId, agentName, task, safeTaskSummary, runtime, step);
						cancelled.agentSource = agent?.source ?? "unknown";
						const details = detailsFactory([cancelled]);
						update?.({ content: [{ type: "text", text: "(cancelled)" }], details });
						return cancelled;
					}
					return await runSingleAgent(
						ctx.cwd,
						agents,
						taskId,
						agentName,
						task,
						safeTaskSummary,
						runtime,
						cwd,
						step,
						signal,
						controller.signal,
						update,
						detailsFactory,
					);
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
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const taskSummary = step.task.replace(/\{previous\}/g, "[previous output]");
					const taskId = `${toolCallId}:${i}`;
					const resolved = getRuntime(step.agent, {
						provider: step.provider,
						model: step.model,
						thinking: step.thinking,
					});

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = resolved.runtime
						? await runTrackedAgent(
								taskId,
								step.agent,
								taskWithContext,
								taskSummary,
								resolved.runtime,
								step.cwd,
								i + 1,
								chainUpdate,
								makeDetails("chain"),
							)
						: createRuntimeFailure(
								taskId,
								step.agent,
								taskWithContext,
								taskSummary,
								resolved.error ?? "Invalid runtime",
								i + 1,
							);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);
				const resolvedRuntimes = params.tasks.map((task) =>
					getRuntime(task.agent, { provider: task.provider, model: task.model, thinking: task.thinking }),
				);
				const taskControllers = resolvedRuntimes.map((runtime, index) =>
					runtime.runtime ? activeTasks.start(`${toolCallId}:${index}`) : undefined,
				);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					const runtime = resolvedRuntimes[i];
					allResults[i] = runtime.runtime
						? {
								taskId: `${toolCallId}:${i}`,
								agent: params.tasks[i].agent,
								agentSource: "unknown",
								task: params.tasks[i].task,
								taskSummary: summarizeTaskForStatus(params.tasks[i].task),
								exitCode: -1,
								status: "queued",
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
							}
						: createRuntimeFailure(
								`${toolCallId}:${i}`,
								params.tasks[i].agent,
								params.tasks[i].task,
								params.tasks[i].task,
								runtime.error ?? "Invalid runtime",
							);
				}

				const emitParallelUpdate = () => {
					const details = makeDetails("parallel")([...allResults]);
					if (onUpdate) {
						const queued = allResults.filter((result) => result.status === "queued").length;
						const running = allResults.filter((result) => result.status === "running").length;
						const done = allResults.length - queued - running;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running, ${queued} queued...`,
								},
							],
							details,
						});
					}
				};
				emitParallelUpdate();

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const taskId = `${toolCallId}:${index}`;
					const resolved = resolvedRuntimes[index];
					const result = resolved.runtime
						? await runTrackedAgent(
								taskId,
								t.agent,
								t.task,
								t.task,
								resolved.runtime,
								t.cwd,
								undefined,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
								taskControllers[index],
							)
						: allResults[index];
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status =
						r.status === "cancelled"
							? "cancelled"
							: isFailedResult(r)
								? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
								: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const taskId = `${toolCallId}:0`;
				const resolved = getRuntime(params.agent, {
					provider: params.provider,
					model: params.model,
					thinking: params.thinking,
				});
				const result = resolved.runtime
					? await runTrackedAgent(
							taskId,
							params.agent,
							params.task,
							params.task,
							resolved.runtime,
							params.cwd,
							undefined,
							onUpdate,
							makeDetails("single"),
						)
					: createRuntimeFailure(
							taskId,
							params.agent,
							params.task,
							params.task,
							resolved.error ?? "Invalid runtime",
						);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
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
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
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
					if (isError && r.errorMessage)
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
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
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
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
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

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
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
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
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
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = queued > 0 || running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running, ${queued} queued`
					: `${successCount}/${details.results.length} tasks`;

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
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
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
								: isFailedResult(r)
									? theme.fg("error", "✗")
									: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) {
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
