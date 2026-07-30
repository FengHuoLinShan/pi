#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureUrl = process.argv[2];
if (!fixtureUrl) throw new Error("fixture URL required");

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(packageDir, "../..");
const cli = resolve(repoRoot, "node_modules/@playwright/cli/playwright-cli.js");
const session = `pi-capability-probe-${process.pid}`;
const environment = {
	...process.env,
	PATH: `${resolve(repoRoot, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
	PLAYWRIGHT_CLI_SESSION: session,
	PLAYWRIGHT_MCP_OUTPUT_DIR: resolve(packageDir, ".artifacts/capability-evals/browser-probe", session),
};

function run(args, allowFailure = false) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, [cli, `-s=${session}`, ...args], {
			cwd: packageDir,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", rejectRun);
		child.once("close", (code) => {
			if (code !== 0 && !allowFailure) rejectRun(new Error(`playwright-cli ${args[0]} failed: ${stderr || stdout}`));
			else resolveRun({ stdout, stderr, code });
		});
	});
}

function emitToolEvent(type, name, result) {
	process.stdout.write(
		`${JSON.stringify({
			type,
			toolCallId: `probe-${name}`,
			toolName: `playwright_cli_${name}`,
			...(type === "tool_execution_end" ? { result, isError: false } : { args: {} }),
		})}\n`,
	);
}

async function command(name, args) {
	emitToolEvent("tool_execution_start", name);
	const result = await run([name, ...args]);
	emitToolEvent("tool_execution_end", name, result.stdout);
}

try {
	await command("open", [`${fixtureUrl}/todo`]);
	await command("fill", ["#new-todo", "playwright cli probe"]);
	await command("click", ["#add-form button"]);
	await command("click", ["#todos button"]);
	await command("snapshot", []);
	process.stdout.write(`${JSON.stringify({ type: "capability_eval_output", output: "EVAL_OK" })}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	await run(["close"], true);
}
