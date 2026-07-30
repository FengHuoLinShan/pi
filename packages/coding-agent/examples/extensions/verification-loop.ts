/**
 * Verification Loop Extension
 *
 * Runs an explicit project verification command after successful built-in edit,
 * write, or bash calls. Bash is conservatively treated as mutation-capable.
 * Failed checks trigger a bounded agent follow-up so the model can repair the
 * change. The command is executed directly without a shell.
 *
 * Configure a trusted project in .pi/verify.json:
 * {
 *   "command": "npm",
 *   "args": ["run", "check"],
 *   "timeoutMs": 120000,
 *   "maxAttempts": 3
 * }
 *
 * Start pi with `--verify-loop` to opt in.
 *
 * Bounded stdout and stderr from failed commands are sent to the model.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
	isBashToolResult,
	isEditToolResult,
	isWriteToolResult,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = ".pi/verify.json";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_ATTEMPTS = 10;
const MAX_OUTPUT_LINES = 80;
const MAX_OUTPUT_BYTES = 12 * 1024;

interface VerificationConfig {
	command: string;
	args: string[];
	timeoutMs: number;
	maxAttempts: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function parseVerificationConfig(value: unknown): VerificationConfig {
	if (!isPlainObject(value)) throw new Error("verification config must be an object");
	const allowedKeys = new Set(["command", "args", "timeoutMs", "maxAttempts"]);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new Error(`unknown verification config field: ${unknownKey}`);

	if (typeof value.command !== "string" || value.command.trim() === "") {
		throw new Error("command must be a non-empty string");
	}
	const args = value.args ?? [];
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
		throw new Error("args must be an array of strings");
	}
	for (let index = 0; index < args.length; index++) {
		if (!(index in args)) throw new Error("args must not contain sparse entries");
	}

	const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > MAX_TIMEOUT_MS) {
		throw new Error(`timeoutMs must be a safe integer between 1000 and ${MAX_TIMEOUT_MS}`);
	}
	const maxAttempts = value.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > MAX_ATTEMPTS) {
		throw new Error(`maxAttempts must be a safe integer between 1 and ${MAX_ATTEMPTS}`);
	}

	return {
		command: value.command,
		args: [...args],
		timeoutMs: timeoutMs as number,
		maxAttempts: maxAttempts as number,
	};
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function loadVerificationConfig(ctx: ExtensionContext): VerificationConfig | undefined {
	if (!ctx.isProjectTrusted()) return undefined;
	const configPath = join(ctx.cwd, CONFIG_PATH);
	try {
		return parseVerificationConfig(JSON.parse(readFileSync(configPath, "utf8")));
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`verification-loop: invalid ${CONFIG_PATH}: ${message}`, "error");
		return undefined;
	}
}

function formatCommand(config: VerificationConfig): string {
	return [config.command, ...config.args.map((arg) => JSON.stringify(arg))].join(" ");
}

function formatFailureOutput(result: ExecResult): string {
	const sections: string[] = [];
	if (result.stdout.trim()) sections.push(`stdout:\n${result.stdout.trimEnd()}`);
	if (result.stderr.trim()) sections.push(`stderr:\n${result.stderr.trimEnd()}`);
	if (sections.length === 0) sections.push("(no command output)");
	const output = truncateTail(sections.join("\n\n"), {
		maxLines: MAX_OUTPUT_LINES,
		maxBytes: MAX_OUTPUT_BYTES,
	});
	return output.truncated ? `[Earlier output truncated]\n${output.content}` : output.content;
}

function executionFailure(error: unknown): ExecResult {
	return {
		stdout: "",
		stderr: error instanceof Error ? error.message : String(error),
		code: 1,
		killed: false,
	};
}

export default function verificationLoop(pi: ExtensionAPI): void {
	let config: VerificationConfig | undefined;
	let pending = false;
	let attempts = 0;
	let running = false;

	pi.registerFlag("verify-loop", {
		description: `Run the trusted ${CONFIG_PATH} command after mutation-capable built-in tools`,
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		config = pi.getFlag("verify-loop") === true ? loadVerificationConfig(ctx) : undefined;
		pending = false;
		attempts = 0;
		running = false;
	});

	pi.on("tool_result", async (event) => {
		if (
			!config ||
			event.isError ||
			(!isBashToolResult(event) && !isEditToolResult(event) && !isWriteToolResult(event))
		) {
			return;
		}
		if (!pending) {
			pending = true;
			attempts = 0;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!config || !pending || running) return;

		running = true;
		attempts++;
		let result: ExecResult;
		try {
			result = await pi.exec(config.command, config.args, {
				cwd: ctx.cwd,
				timeout: config.timeoutMs,
			});
		} catch (error) {
			result = executionFailure(error);
		} finally {
			running = false;
		}

		if (!result.killed && result.code === 0) {
			pending = false;
			attempts = 0;
			ctx.ui.notify(`verification-loop: passed ${formatCommand(config)}`, "info");
			return;
		}

		const failure = `Verification attempt ${attempts}/${config.maxAttempts} failed for ${formatCommand(config)} (exit ${result.killed ? "timeout" : result.code}).`;
		if (attempts >= config.maxAttempts) {
			pending = false;
			ctx.ui.notify(`verification-loop: ${failure}`, "error");
			return;
		}

		pi.sendUserMessage(
			`${failure}

Fix the implementation and run the verification loop again.

${formatFailureOutput(result)}`,
			{ deliverAs: "followUp" },
		);
	});
}
