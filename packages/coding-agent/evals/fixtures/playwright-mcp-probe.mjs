#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureUrl = process.argv[2];
if (!fixtureUrl) throw new Error("fixture URL required");

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(packageDir, "../..");
const mcpCli = resolve(repoRoot, "node_modules/@playwright/mcp/cli.js");
const child = spawn(
	process.execPath,
	[
		mcpCli,
		"--headless",
		"--isolated",
		"--browser",
		"chromium",
		"--image-responses",
		"omit",
		"--block-service-workers",
		"--allowed-origins",
		"http://127.0.0.1:*",
		"--output-dir",
		resolve(packageDir, ".artifacts/capability-evals/browser-probe", `mcp-${process.pid}`),
	],
	{ cwd: packageDir, stdio: ["pipe", "pipe", "pipe"] },
);

const pending = new Map();
let requestId = 0;
let stderr = "";
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString("utf8");
});
createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.id === undefined || message.id === null) return;
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
	else waiter.resolve(message.result);
});

function request(method, params = {}) {
	const id = ++requestId;
	return new Promise((resolveRequest, rejectRequest) => {
		const timeout = setTimeout(() => {
			pending.delete(id);
			rejectRequest(new Error(`MCP request timed out: ${method}`));
		}, 30_000);
		pending.set(id, {
			resolve(value) {
				clearTimeout(timeout);
				resolveRequest(value);
			},
			reject(error) {
				clearTimeout(timeout);
				rejectRequest(error);
			},
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

function notify(method, params = {}) {
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function emitToolEvent(type, name, result) {
	process.stdout.write(
		`${JSON.stringify({
			type,
			toolCallId: `probe-${name}`,
			toolName: name,
			...(type === "tool_execution_end" ? { result, isError: false } : { args: {} }),
		})}\n`,
	);
}

async function callTool(name, args) {
	emitToolEvent("tool_execution_start", name);
	const result = await request("tools/call", { name, arguments: args });
	if (result?.isError) throw new Error(`Playwright MCP tool failed: ${name}`);
	emitToolEvent("tool_execution_end", name, result);
	return result;
}

try {
	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "pi-capability-eval", version: "1.0.0" },
	});
	notify("notifications/initialized");
	await request("tools/list");
	await callTool("browser_navigate", { url: `${fixtureUrl}/todo` });
	await callTool("browser_type", { target: "#new-todo", text: "playwright mcp probe" });
	await callTool("browser_click", { target: "#add-form button" });
	await callTool("browser_click", { target: "#todos button" });
	await callTool("browser_snapshot", {});
	await callTool("browser_close", {});
	process.stdout.write(`${JSON.stringify({ type: "capability_eval_output", output: "EVAL_OK" })}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
	process.exitCode = 1;
} finally {
	child.stdin.end();
	const exitTimeout = setTimeout(() => child.kill("SIGTERM"), 2_000);
	await new Promise((resolveExit) => child.once("close", resolveExit));
	clearTimeout(exitTimeout);
}
