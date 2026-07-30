import { appendFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface MockMcpServerJournalEvent {
	timestamp: string;
	event: string;
	data?: unknown;
}

export interface MockMcpHttpServerHandle {
	url: string;
	journal: MockMcpServerJournalEvent[];
	close(): Promise<void>;
}

const tools = [
	{
		name: "echo",
		description: "Echo text for deterministic MCP evaluation",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
			additionalProperties: false,
		},
	},
	{
		name: "fail",
		description: "Return a deterministic MCP tool error",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "wait",
		description: "Wait briefly for cancellation and timeout evaluation",
		inputSchema: {
			type: "object",
			properties: { milliseconds: { type: "integer", minimum: 0, maximum: 10_000 } },
			additionalProperties: false,
		},
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function response(id: string | number | undefined, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, result };
}

function errorResponse(id: string | number | undefined, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
	if (request.method.startsWith("notifications/")) return undefined;
	if (request.method === "initialize") {
		return response(request.id, {
			protocolVersion: "2025-06-18",
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: "pi-capability-eval-mock", version: "1.0.0" },
		});
	}
	if (request.method === "ping") return response(request.id, {});
	if (request.method === "tools/list") {
		const cursor =
			isRecord(request.params) && typeof request.params.cursor === "string" ? request.params.cursor : undefined;
		if (cursor === undefined) return response(request.id, { tools: tools.slice(0, 1), nextCursor: "page-2" });
		if (cursor === "page-2") return response(request.id, { tools: tools.slice(1) });
		return errorResponse(request.id, -32_602, `Unknown cursor: ${cursor}`);
	}
	if (request.method === "tools/call") {
		if (!isRecord(request.params) || typeof request.params.name !== "string") {
			return errorResponse(request.id, -32_602, "tools/call requires name");
		}
		const args = isRecord(request.params.arguments) ? request.params.arguments : {};
		if (request.params.name === "echo") {
			return response(request.id, {
				content: [{ type: "text", text: String(args.text ?? "") }],
				structuredContent: { echo: String(args.text ?? "") },
				isError: false,
			});
		}
		if (request.params.name === "fail") {
			return response(request.id, {
				content: [{ type: "text", text: "deterministic mock failure" }],
				isError: true,
			});
		}
		if (request.params.name === "wait") {
			const milliseconds =
				typeof args.milliseconds === "number" ? Math.min(10_000, Math.max(0, args.milliseconds)) : 10;
			await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
			return response(request.id, { content: [{ type: "text", text: `waited ${milliseconds}ms` }], isError: false });
		}
		return errorResponse(request.id, -32_601, `Unknown tool: ${request.params.name}`);
	}
	return errorResponse(request.id, -32_601, `Unknown method: ${request.method}`);
}

function parseRequest(value: unknown): JsonRpcRequest {
	if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
		throw new Error("Invalid JSON-RPC request");
	}
	if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number") {
		throw new Error("Invalid JSON-RPC request id");
	}
	return {
		jsonrpc: "2.0",
		...(value.id === undefined ? {} : { id: value.id }),
		method: value.method,
		...(value.params === undefined ? {} : { params: value.params }),
	};
}

async function appendStandaloneJournal(path: string | undefined, event: MockMcpServerJournalEvent): Promise<void> {
	if (!path) return;
	await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export async function runMockMcpStdioServer(journalPath?: string): Promise<void> {
	const writeEvent = async (event: string, data?: unknown): Promise<void> => {
		await appendStandaloneJournal(journalPath, {
			timestamp: new Date().toISOString(),
			event,
			...(data === undefined ? {} : { data }),
		});
	};
	await writeEvent("server.started", { transport: "stdio", pid: process.pid });
	const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of lines) {
		if (line.trim().length === 0) continue;
		let request: JsonRpcRequest;
		try {
			request = parseRequest(JSON.parse(line));
		} catch (error) {
			process.stdout.write(
				`${JSON.stringify(errorResponse(undefined, -32_700, error instanceof Error ? error.message : String(error)))}\n`,
			);
			continue;
		}
		await writeEvent("request.received", { method: request.method, id: request.id });
		const result = await handleRequest(request);
		if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
	}
	await writeEvent("server.stopped", { transport: "stdio", pid: process.pid });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	return body;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolveClose, reject) => {
		server.close((error) => (error ? reject(error) : resolveClose()));
	});
}

export async function startMockMcpHttpServer(): Promise<MockMcpHttpServerHandle> {
	const journal: MockMcpServerJournalEvent[] = [];
	const record = (event: string, data?: unknown): void => {
		journal.push({ timestamp: new Date().toISOString(), event, ...(data === undefined ? {} : { data }) });
	};
	const server = createServer(async (request, result) => {
		if (request.method === "GET" && request.url === "/health") {
			result.writeHead(200, { "content-type": "application/json" });
			result.end('{"ok":true}');
			return;
		}
		if (request.method !== "POST" || request.url !== "/mcp") {
			result.writeHead(404).end();
			return;
		}
		try {
			const rpcRequest = parseRequest(JSON.parse(await readRequestBody(request)));
			record("request.received", { method: rpcRequest.method, id: rpcRequest.id });
			const rpcResponse = await handleRequest(rpcRequest);
			if (!rpcResponse) {
				result.writeHead(202).end();
				return;
			}
			result.writeHead(200, { "content-type": "application/json" });
			result.end(JSON.stringify(rpcResponse));
		} catch (error) {
			result.writeHead(400, { "content-type": "application/json" });
			result.end(
				JSON.stringify(errorResponse(undefined, -32_700, error instanceof Error ? error.message : String(error))),
			);
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock MCP server did not expose a TCP address");
	record("server.started", { transport: "http", port: address.port });
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		journal,
		async close() {
			await closeServer(server);
			record("server.stopped", { transport: "http" });
		},
	};
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
	const journalIndex = process.argv.indexOf("--journal");
	const journalPath = journalIndex === -1 ? undefined : process.argv[journalIndex + 1];
	runMockMcpStdioServer(journalPath).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
