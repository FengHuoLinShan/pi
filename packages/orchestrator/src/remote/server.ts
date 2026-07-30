import { timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { getOrchestratorDir } from "../config.ts";
import type {
	ErrorResponse,
	InstanceSummary,
	ListResponse,
	SpawnResponse,
	StatusResponse,
	StopResponse,
} from "../ipc/protocol.ts";
import type { IpcRequestHandler } from "../ipc/server.ts";
import { RemoteInstanceHub } from "./hub.ts";
import type {
	RemoteCommandRequest,
	RemoteErrorResponse,
	RemoteFileUploadRequest,
	RemoteFileUploadResponse,
	RemoteHealthResponse,
	RemoteResumeRequest,
	RemoteSpawnRequest,
	RemoteUiResponseRequest,
} from "./protocol.ts";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

export interface RemoteServerOptions {
	host: string;
	port: number;
	token: string;
	maxBodyBytes?: number;
	maxUploadBytes?: number;
}

export interface RunningRemoteServer {
	readonly server: Server;
	readonly host: string;
	readonly port: number;
	close(): Promise<void>;
}

class RemoteHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RemoteHttpError";
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secureTokenMatches(expected: string, provided: string): boolean {
	const expectedBuffer = Buffer.from(expected);
	const providedBuffer = Buffer.from(provided);
	return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireAuthorization(request: IncomingMessage, token: string): void {
	const authorization = request.headers.authorization;
	const provided = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
	if (!provided || !secureTokenMatches(token, provided)) {
		throw new RemoteHttpError(401, "Unauthorized");
	}
}

function setCommonHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	setCommonHeaders(response);
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.setHeader("Content-Length", Buffer.byteLength(body));
	response.end(body);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
	const contentLength = Number(request.headers["content-length"] ?? 0);
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new RemoteHttpError(413, "Request body is too large");
	}
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > maxBytes) {
			throw new RemoteHttpError(413, "Request body is too large");
		}
		chunks.push(buffer);
	}
	if (chunks.length === 0) {
		return {};
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new RemoteHttpError(400, "Request body must be valid JSON");
	}
}

function parseSpawnRequest(value: unknown): RemoteSpawnRequest {
	if (!isRecord(value) || typeof value.cwd !== "string" || !value.cwd.trim()) {
		throw new RemoteHttpError(400, "cwd is required");
	}
	if (value.label !== undefined && typeof value.label !== "string") {
		throw new RemoteHttpError(400, "label must be a string");
	}
	if (value.approveProject !== undefined && typeof value.approveProject !== "boolean") {
		throw new RemoteHttpError(400, "approveProject must be a boolean");
	}
	return { cwd: value.cwd, label: value.label, approveProject: value.approveProject };
}

function parseResumeRequest(value: unknown): RemoteResumeRequest {
	if (!isRecord(value)) {
		throw new RemoteHttpError(400, "Request body must be an object");
	}
	if (value.approveProject !== undefined && typeof value.approveProject !== "boolean") {
		throw new RemoteHttpError(400, "approveProject must be a boolean");
	}
	return { approveProject: value.approveProject };
}

function parseCommandRequest(value: unknown): RemoteCommandRequest {
	if (!isRecord(value) || !isRecord(value.command) || typeof value.command.type !== "string") {
		throw new RemoteHttpError(400, "command is required");
	}
	return { command: value.command as RpcCommand };
}

function parseUiResponseRequest(value: unknown): RemoteUiResponseRequest {
	if (
		!isRecord(value) ||
		!isRecord(value.response) ||
		value.response.type !== "extension_ui_response" ||
		typeof value.response.id !== "string"
	) {
		throw new RemoteHttpError(400, "response must be an extension_ui_response");
	}
	return { response: value.response as RpcExtensionUIResponse };
}

function parseFileUploadRequest(value: unknown): RemoteFileUploadRequest {
	if (
		!isRecord(value) ||
		typeof value.filename !== "string" ||
		!value.filename.trim() ||
		typeof value.dataBase64 !== "string"
	) {
		throw new RemoteHttpError(400, "filename and dataBase64 are required");
	}
	if (value.mimeType !== undefined && typeof value.mimeType !== "string") {
		throw new RemoteHttpError(400, "mimeType must be a string");
	}
	return {
		filename: value.filename,
		mimeType: value.mimeType,
		dataBase64: value.dataBase64,
	};
}

function requireSuccessfulInstance(response: SpawnResponse | StatusResponse | ErrorResponse): InstanceSummary {
	if (!response.ok || !("instance" in response) || !response.instance) {
		throw new RemoteHttpError(404, response.error ?? "Instance not found");
	}
	return response.instance;
}

function parseAfterSequence(request: IncomingMessage, url: URL): number {
	const raw = url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
	const value = Number(Array.isArray(raw) ? raw[0] : raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeSse(response: ServerResponse, event: unknown, sequence: number): void {
	response.write(`id: ${sequence}\n`);
	response.write("event: remote\n");
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function startRemoteServer(
	options: RemoteServerOptions,
	handler: IpcRequestHandler,
): Promise<RunningRemoteServer> {
	if (options.token.length < 32) {
		throw new Error("Remote token must contain at least 32 characters");
	}
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
	const hubs = new Map<string, RemoteInstanceHub>();
	const eventStreams = new Set<ServerResponse>();

	const getInstance = async (instanceId: string): Promise<InstanceSummary> => {
		const response = await handler({ type: "status", instanceId });
		return requireSuccessfulInstance(response);
	};

	const getHub = async (instanceId: string): Promise<RemoteInstanceHub> => {
		const existing = hubs.get(instanceId);
		if (existing) {
			return existing;
		}
		const instance = await getInstance(instanceId);
		if (instance.status !== "online") {
			throw new RemoteHttpError(409, `Instance is not online: ${instanceId}`);
		}
		const hub = new RemoteInstanceHub(instance, handler);
		hubs.set(instanceId, hub);
		return hub;
	};

	const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const method = request.method ?? "GET";
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const parts = url.pathname
			.split("/")
			.filter(Boolean)
			.map((part) => decodeURIComponent(part));

		if (method === "GET" && url.pathname === "/v1/health") {
			const health: RemoteHealthResponse = { ok: true, protocolVersion: 1 };
			sendJson(response, 200, health);
			return;
		}

		requireAuthorization(request, options.token);

		if (method === "GET" && url.pathname === "/v1/instances") {
			const result: ListResponse | ErrorResponse = await handler({ type: "list" });
			sendJson(response, result.ok ? 200 : 500, result);
			return;
		}

		if (method === "POST" && url.pathname === "/v1/instances") {
			const body = parseSpawnRequest(await readJson(request, maxBodyBytes));
			const result: SpawnResponse | ErrorResponse = await handler({
				type: "spawn",
				cwd: body.cwd,
				label: body.label,
				approveProject: body.approveProject,
			});
			sendJson(response, result.ok ? 201 : 500, result);
			return;
		}

		if (parts.length === 3 && parts[0] === "v1" && parts[1] === "instances" && method === "DELETE") {
			const instanceId = parts[2];
			const result: StopResponse | ErrorResponse = await handler({ type: "stop", instanceId });
			hubs.get(instanceId)?.close();
			hubs.delete(instanceId);
			sendJson(response, result.ok ? 200 : 404, result);
			return;
		}

		if (parts.length === 4 && parts[0] === "v1" && parts[1] === "instances") {
			const instanceId = parts[2];
			const action = parts[3];

			if (method === "GET" && action === "snapshot") {
				sendJson(response, 200, await (await getHub(instanceId)).getSnapshot());
				return;
			}

			if (method === "GET" && action === "activity") {
				sendJson(response, 200, await (await getHub(instanceId)).getActivity());
				return;
			}

			if (method === "POST" && action === "resume") {
				const original = await getInstance(instanceId);
				if (original.status === "online") {
					throw new RemoteHttpError(409, `Instance is already online: ${instanceId}`);
				}
				if (!original.sessionFile) {
					throw new RemoteHttpError(409, "Instance has no session file to resume");
				}
				const body = parseResumeRequest(await readJson(request, maxBodyBytes));
				const spawnResult: SpawnResponse | ErrorResponse = await handler({
					type: "spawn",
					cwd: original.cwd,
					label: original.label,
					approveProject: body.approveProject,
				});
				if (!spawnResult.ok || !spawnResult.instance) {
					throw new RemoteHttpError(500, spawnResult.error ?? "Failed to start resumed instance");
				}
				sendJson(response, 201, {
					...spawnResult,
					resumeSessionFile: original.sessionFile,
					sourceInstanceId: instanceId,
				});
				return;
			}

			if (method === "POST" && action === "command") {
				const body = parseCommandRequest(await readJson(request, maxBodyBytes));
				sendJson(response, 200, await (await getHub(instanceId)).sendCommand(body.command));
				return;
			}

			if (method === "POST" && action === "ui-response") {
				const body = parseUiResponseRequest(await readJson(request, maxBodyBytes));
				await (await getHub(instanceId)).sendUiResponse(body.response);
				sendJson(response, 200, { ok: true });
				return;
			}

			if (method === "POST" && action === "files") {
				const body = parseFileUploadRequest(await readJson(request, maxBodyBytes));
				const data = Buffer.from(body.dataBase64, "base64");
				if (data.length > maxUploadBytes) {
					throw new RemoteHttpError(413, "Uploaded file is too large");
				}
				const safeName = basename(body.filename).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
				if (!safeName || safeName === "." || safeName === "..") {
					throw new RemoteHttpError(400, "Invalid filename");
				}
				await getInstance(instanceId);
				const uploadDir = join(getOrchestratorDir(), "remote-uploads", instanceId);
				await mkdir(uploadDir, { recursive: true, mode: 0o700 });
				const path = join(uploadDir, `${Date.now()}-${safeName}`);
				await writeFile(path, data, { mode: 0o600 });
				const result: RemoteFileUploadResponse = {
					path,
					filename: safeName,
					mimeType: body.mimeType,
					size: data.length,
				};
				sendJson(response, 201, result);
				return;
			}

			if (method === "GET" && action === "events") {
				const hub = await getHub(instanceId);
				setCommonHeaders(response);
				response.statusCode = 200;
				response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
				response.setHeader("Connection", "keep-alive");
				response.setHeader("X-Accel-Buffering", "no");
				response.flushHeaders();
				response.write(": connected\n\n");
				eventStreams.add(response);
				const unsubscribe = hub.subscribe(parseAfterSequence(request, url), (event) => {
					writeSse(response, event, event.sequence);
				});
				const heartbeat = setInterval(() => {
					response.write(`: heartbeat ${Date.now()}\n\n`);
				}, SSE_HEARTBEAT_MS);
				request.once("close", () => {
					clearInterval(heartbeat);
					unsubscribe();
					eventStreams.delete(response);
				});
				return;
			}
		}

		throw new RemoteHttpError(404, "Not found");
	};

	const server = createServer((request, response) => {
		void handleRequest(request, response).catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			const status = error instanceof RemoteHttpError ? error.status : 500;
			const body: RemoteErrorResponse = {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
			sendJson(response, status, body);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Remote server did not expose a TCP address");
	}

	return {
		server,
		host: options.host,
		port: address.port,
		async close(): Promise<void> {
			for (const response of eventStreams) {
				response.end();
			}
			eventStreams.clear();
			for (const hub of hubs.values()) {
				hub.close();
			}
			hubs.clear();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
	};
}
