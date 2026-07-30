import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockMcpHttpServer } from "./mock-mcp-server.ts";
import type { CapabilityEvalAttemptContext, CapabilityEvalDriver, CapabilityEvalDriverResult } from "./runner.ts";

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
}

interface PendingResponse {
	resolve(value: JsonRpcResponse): void;
	reject(error: Error): void;
}

interface ActiveStdioProcess {
	child: ChildProcessWithoutNullStreams;
	exited: Promise<void>;
	tempDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attemptKey(context: CapabilityEvalAttemptContext): string {
	return `${context.suiteName}:${context.scenario.id}:${context.attempt}`;
}

function mockServerPath(): string {
	const currentPath = fileURLToPath(import.meta.url);
	const extension = extname(currentPath);
	return resolve(dirname(currentPath), `mock-mcp-server${extension}`);
}

async function readJournalEvents(path: string): Promise<string[]> {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.flatMap((line) => {
				const value: unknown = JSON.parse(line);
				return isRecord(value) && typeof value.event === "string" ? [value.event] : [];
			});
	} catch {
		return [];
	}
}

export function createMockMcpStdioCapabilityDriver(): CapabilityEvalDriver {
	const active = new Map<string, ActiveStdioProcess>();
	return {
		async runAttempt(context): Promise<CapabilityEvalDriverResult> {
			const tempDir = await mkdtemp(join(tmpdir(), "pi-capability-mcp-"));
			const journalPath = join(tempDir, "server.jsonl");
			const child = spawn(process.execPath, [mockServerPath(), "--journal", journalPath], {
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			const exited = once(child, "close").then(() => undefined);
			active.set(attemptKey(context), { child, exited, tempDir });
			const pending = new Map<string | number, PendingResponse>();
			let buffer = "";
			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline === -1) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim().length === 0) continue;
					const value = JSON.parse(line) as JsonRpcResponse;
					if (value.id === null) continue;
					const waiter = pending.get(value.id);
					if (waiter) {
						pending.delete(value.id);
						waiter.resolve(value);
					}
				}
			});
			const request = async (id: number, method: string, params?: unknown): Promise<JsonRpcResponse> => {
				const responsePromise = new Promise<JsonRpcResponse>((resolveResponse, rejectResponse) => {
					pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
				});
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
				);
				return responsePromise;
			};
			const abort = () => child.kill("SIGTERM");
			context.signal.addEventListener("abort", abort, { once: true });
			const trace = ["mcp:process_started"];
			try {
				const initialize = await request(1, "initialize", {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "pi-capability-eval", version: "1.0.0" },
				});
				trace.push("mcp:initialized");
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
				const firstPage = await request(2, "tools/list", {});
				trace.push("mcp:tools_page_1");
				const secondPage = await request(3, "tools/list", { cursor: "page-2" });
				trace.push("mcp:tools_page_2");
				const echo = await request(4, "tools/call", { name: "echo", arguments: { text: "stdio-ok" } });
				trace.push("mcp:echo_called");
				const failure = await request(5, "tools/call", { name: "fail", arguments: {} });
				trace.push("mcp:error_returned");
				child.stdin.end();
				await exited;
				trace.push("mcp:process_exited");
				const lifecycle = await readJournalEvents(journalPath);
				active.delete(attemptKey(context));
				await rm(tempDir, { recursive: true, force: true });
				return {
					status: child.exitCode === 0 ? "completed" : "failed",
					output: "stdio MCP probe completed",
					metrics: { modelRequests: 0, toolCalls: 2, totalTokens: 0, orphanProcesses: 0 },
					trace,
					lifecycle,
					details: { initialize, firstPage, secondPage, echo, failure, stderr },
					...(child.exitCode === 0 ? {} : { error: `Mock MCP stdio server exited ${child.exitCode}` }),
				};
			} finally {
				context.signal.removeEventListener("abort", abort);
			}
		},
		async cleanupAttempt(context): Promise<void> {
			const processState = active.get(attemptKey(context));
			if (!processState) return;
			if (processState.child.exitCode === null && processState.child.signalCode === null)
				processState.child.kill("SIGTERM");
			await processState.exited;
			await rm(processState.tempDir, { recursive: true, force: true });
			active.delete(attemptKey(context));
		},
	};
}

async function postJson(url: string, body: unknown, signal: AbortSignal): Promise<JsonRpcResponse> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	return (await response.json()) as JsonRpcResponse;
}

export function createMockMcpHttpCapabilityDriver(): CapabilityEvalDriver {
	return {
		async runAttempt(context): Promise<CapabilityEvalDriverResult> {
			const server = await startMockMcpHttpServer();
			try {
				const initialize = await postJson(
					server.url,
					{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
					context.signal,
				);
				const firstPage = await postJson(
					server.url,
					{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
					context.signal,
				);
				const secondPage = await postJson(
					server.url,
					{ jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: "page-2" } },
					context.signal,
				);
				const echo = await postJson(
					server.url,
					{
						jsonrpc: "2.0",
						id: 4,
						method: "tools/call",
						params: { name: "echo", arguments: { text: "http-ok" } },
					},
					context.signal,
				);
				return {
					status: "completed",
					output: "HTTP MCP probe completed",
					metrics: { modelRequests: 0, toolCalls: 1, totalTokens: 0, orphanProcesses: 0 },
					trace: ["mcp:initialized", "mcp:tools_page_1", "mcp:tools_page_2", "mcp:echo_called"],
					details: { initialize, firstPage, secondPage, echo },
				};
			} finally {
				await server.close();
			}
		},
	};
}

export function createOfflineCapabilityEvalDrivers(): Record<string, CapabilityEvalDriver> {
	return {
		"mock-mcp-stdio": createMockMcpStdioCapabilityDriver(),
		"mock-mcp-http": createMockMcpHttpCapabilityDriver(),
	};
}
