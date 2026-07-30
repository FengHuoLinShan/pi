/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { localProcessRuntime } from "./process-runtime.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	if (options?.signal?.aborted) {
		return { stdout: "", stderr: "", code: 0, killed: true };
	}
	let stdout = "";
	let stderr = "";
	const handle = localProcessRuntime.start({
		command,
		args,
		cwd,
		signal: options?.signal,
		timeoutMs: options?.timeout && options.timeout > 0 ? options.timeout : undefined,
		onOutput: (stream, chunk) => {
			if (stream === "stdout") stdout += chunk.toString();
			else stderr += chunk.toString();
		},
	});
	const result = await handle.wait();
	return {
		stdout,
		stderr,
		code: result.exitCode ?? (result.reason === "failed" ? 1 : 0),
		killed: result.reason === "aborted" || result.reason === "timed-out" || result.reason === "terminated",
	};
}
