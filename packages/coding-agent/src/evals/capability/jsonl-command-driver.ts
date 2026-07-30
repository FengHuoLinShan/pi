import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { killProcessTree } from "../../utils/shell.ts";
import type { CapabilityEvalAttemptContext, CapabilityEvalDriver, CapabilityEvalDriverResult } from "./runner.ts";

export interface CapabilityEvalCommandSpec {
	command: string;
	args?: string[];
	cwd?: string;
	environment?: Record<string, string>;
	inheritEnvironment?: boolean;
	collectArtifacts?: string[];
	maxOutputBytes?: number;
}

export interface CapabilityEvalCommandVariables {
	[key: string]: string;
}

interface RunningChild {
	child: ChildProcessWithoutNullStreams;
	exited: Promise<void>;
	pid?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceVariables(value: string, variables: CapabilityEvalCommandVariables): string {
	return value.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/gu, (match, name: string) => variables[name] ?? match);
}

export function materializeCapabilityEvalCommand(
	spec: CapabilityEvalCommandSpec,
	context: CapabilityEvalAttemptContext,
	extraVariables: CapabilityEvalCommandVariables = {},
): Required<
	Pick<CapabilityEvalCommandSpec, "command" | "args" | "cwd" | "environment" | "collectArtifacts" | "maxOutputBytes">
> & {
	inheritEnvironment: boolean;
} {
	const variables = {
		task: context.scenario.task,
		workspace: context.cwd,
		scenario: context.scenario.id,
		attempt: String(context.attempt),
		...extraVariables,
	};
	return {
		command: replaceVariables(spec.command, variables),
		args: (spec.args ?? []).map((argument) => replaceVariables(argument, variables)),
		cwd: resolve(context.cwd, replaceVariables(spec.cwd ?? ".", variables)),
		environment: Object.fromEntries(
			Object.entries(spec.environment ?? {}).map(([name, value]) => [name, replaceVariables(value, variables)]),
		),
		inheritEnvironment: spec.inheritEnvironment ?? true,
		collectArtifacts: spec.collectArtifacts ?? [],
		maxOutputBytes: spec.maxOutputBytes ?? 10 * 1024 * 1024,
	};
}

function messageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("");
}

function eventTrace(event: Record<string, unknown>): string | undefined {
	if (typeof event.type !== "string") return undefined;
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		return `${event.type}:${String(event.toolName ?? "unknown")}`;
	}
	if ((event.type === "message_start" || event.type === "message_end") && isRecord(event.message)) {
		return `${event.type}:${String(event.message.role ?? "unknown")}`;
	}
	return event.type;
}

function parseJsonlEvents(stdout: string): {
	output: string;
	trace: string[];
	modelRequests: number;
	toolCalls: number;
	totalTokens: number;
	parseErrors: string[];
} {
	let output = "";
	let modelRequests = 0;
	let toolCalls = 0;
	let totalTokens = 0;
	const trace: string[] = [];
	const parseErrors: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			parseErrors.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		if (!isRecord(value)) continue;
		const key = eventTrace(value);
		if (key) trace.push(key);
		if (value.type === "capability_eval_output" && typeof value.output === "string") output = value.output;
		if (value.type === "tool_execution_start") toolCalls++;
		if (value.type === "message_end" && isRecord(value.message) && value.message.role === "assistant") {
			modelRequests++;
			output = messageText(value.message);
			if (isRecord(value.message.usage) && typeof value.message.usage.totalTokens === "number") {
				totalTokens += value.message.usage.totalTokens;
			}
		}
	}
	return { output, trace, modelRequests, toolCalls, totalTokens, parseErrors };
}

async function collectArtifacts(cwd: string, paths: readonly string[]): Promise<Record<string, string>> {
	const artifacts: Record<string, string> = {};
	const root = resolve(cwd);
	for (const relativePath of paths) {
		const path = resolve(root, relativePath);
		if (path !== root && !path.startsWith(`${root}/`)) {
			artifacts[relativePath] = "[artifact path escaped workspace]";
			continue;
		}
		try {
			artifacts[relativePath] = await readFile(path, "utf8");
		} catch (error) {
			artifacts[relativePath] = `[artifact unavailable: ${error instanceof Error ? error.message : String(error)}]`;
		}
	}
	return artifacts;
}

function contextKey(context: CapabilityEvalAttemptContext): string {
	return `${context.suiteName}:${context.scenario.id}:${context.attempt}`;
}

function processTreeIsAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(process.platform === "win32" ? pid : -pid, 0);
		return true;
	} catch {
		return false;
	}
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	if (process.platform === "win32" || signal === "SIGKILL") {
		killProcessTree(pid);
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The process tree already exited.
		}
	}
}

export function createJsonlCommandCapabilityDriver(
	specOrFactory:
		| CapabilityEvalCommandSpec
		| ((context: CapabilityEvalAttemptContext) => CapabilityEvalCommandSpec | Promise<CapabilityEvalCommandSpec>),
): CapabilityEvalDriver {
	const running = new Map<string, RunningChild>();
	return {
		async runAttempt(context): Promise<CapabilityEvalDriverResult> {
			const rawSpec = typeof specOrFactory === "function" ? await specOrFactory(context) : specOrFactory;
			const spec = materializeCapabilityEvalCommand(rawSpec, context);
			context.journal.write({
				scenario: context.scenario.id,
				attempt: context.attempt,
				event: "process.spawning",
				data: { command: spec.command, args: spec.args, cwd: spec.cwd },
			});
			const child = spawn(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.inheritEnvironment ? { ...process.env, ...spec.environment } : spec.environment,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
			const lifecycle = ["process.spawned"];
			const exited = once(child, "close").then(() => undefined);
			const pid = child.pid;
			running.set(contextKey(context), { child, exited, pid });
			context.journal.write({
				scenario: context.scenario.id,
				attempt: context.attempt,
				event: "process.spawned",
				data: { pid: child.pid },
			});
			let stdout = "";
			let stderr = "";
			let outputExceeded = false;
			const append = (current: string, chunk: Buffer): string => {
				if (Buffer.byteLength(current) + chunk.byteLength > spec.maxOutputBytes) {
					outputExceeded = true;
					terminateProcessTree(pid, "SIGTERM");
					return current;
				}
				return current + chunk.toString("utf8");
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = append(stdout, chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = append(stderr, chunk);
			});
			const abort = () => {
				if (child.exitCode === null && child.signalCode === null) terminateProcessTree(pid, "SIGTERM");
			};
			context.signal.addEventListener("abort", abort, { once: true });
			let spawnError: string | undefined;
			child.once("error", (error) => {
				spawnError = error.message;
			});
			const [exitCode, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
			context.signal.removeEventListener("abort", abort);
			lifecycle.push("process.exited");
			context.journal.write({
				scenario: context.scenario.id,
				attempt: context.attempt,
				event: "process.exited",
				data: { exitCode, signal },
			});
			const parsed = parseJsonlEvents(stdout);
			const artifacts = await collectArtifacts(spec.cwd, spec.collectArtifacts);
			const orphanProcesses = processTreeIsAlive(pid) ? 1 : 0;
			const status = context.signal.aborted
				? "aborted"
				: exitCode === 0 && !spawnError && !outputExceeded
					? "completed"
					: "failed";
			return {
				status,
				output: parsed.output,
				metrics: {
					modelRequests: parsed.modelRequests,
					toolCalls: parsed.toolCalls,
					totalTokens: parsed.totalTokens,
					orphanProcesses,
				},
				trace: parsed.trace,
				lifecycle,
				artifacts,
				details: { exitCode, signal, stderr, parseErrors: parsed.parseErrors },
				...(spawnError || outputExceeded || exitCode !== 0
					? {
							error:
								spawnError ??
								(outputExceeded ? "JSONL command output limit exceeded" : `Process exited ${exitCode}`),
						}
					: {}),
			};
		},
		async cleanupAttempt(context): Promise<void> {
			const active = running.get(contextKey(context));
			if (!active) return;
			if (processTreeIsAlive(active.pid)) terminateProcessTree(active.pid, "SIGTERM");
			const forceKill = setTimeout(() => {
				if (processTreeIsAlive(active.pid)) terminateProcessTree(active.pid, "SIGKILL");
			}, 4_000);
			try {
				await active.exited;
			} finally {
				clearTimeout(forceKill);
				if (processTreeIsAlive(active.pid)) terminateProcessTree(active.pid, "SIGKILL");
				running.delete(contextKey(context));
			}
		},
	};
}
