import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";

export type ProcessRuntimeOutputStream = "stdout" | "stderr";
export type ProcessRuntimeTerminationReason = "aborted" | "timed-out" | "terminated";
export type ProcessRuntimeExitReason = "exited" | ProcessRuntimeTerminationReason | "failed";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ProcessRuntimeStartRequest {
	command: string;
	args: readonly string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stdin?: string | Buffer;
	signal?: AbortSignal;
	timeoutMs?: number;
	detached?: boolean;
	onOutput?: (stream: ProcessRuntimeOutputStream, chunk: Buffer) => void;
}

export interface ProcessRuntimeExit {
	exitCode: number | null;
	signal?: string;
	reason: ProcessRuntimeExitReason;
	error?: string;
}

export interface ProcessRuntimeHandle {
	readonly id: string;
	readonly pid: number | undefined;
	wait(): Promise<ProcessRuntimeExit>;
	terminate(reason?: ProcessRuntimeTerminationReason, signal?: NodeJS.Signals): boolean;
}

function terminateChild(child: ChildProcess, detached: boolean, signal: NodeJS.Signals): boolean {
	if (!child.pid) {
		return child.kill(signal);
	}
	if (signal === "SIGKILL" && (detached || process.platform === "win32")) {
		killProcessTree(child.pid);
		return true;
	}
	if (detached && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return true;
		} catch {
			// Fall back to the direct child if the process group has already exited.
		}
	}
	return child.kill(signal);
}

/**
 * Shared local process lifecycle used by foreground commands and durable
 * process-session backends. Persistence remains a policy of the caller.
 */
export class LocalProcessRuntime {
	start(request: ProcessRuntimeStartRequest): ProcessRuntimeHandle {
		if (!request.command.trim()) throw new Error("Process command must not be empty");
		if (!request.cwd.trim()) throw new Error("Process cwd must not be empty");
		if (
			request.timeoutMs !== undefined &&
			(!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > MAX_TIMEOUT_MS)
		) {
			throw new Error(`Process timeout must be a positive finite number no greater than ${MAX_TIMEOUT_MS}`);
		}
		if (request.signal?.aborted) throw new Error("Process start aborted");

		const timeoutMs = request.timeoutMs === undefined ? undefined : Math.ceil(request.timeoutMs);
		const detached = request.detached ?? process.platform !== "win32";
		const child = spawnProcess(request.command, [...request.args], {
			cwd: request.cwd,
			detached,
			env: request.env,
			stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		if (request.stdin !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(request.stdin);
		}
		child.stdout?.on("data", (chunk: Buffer) => request.onOutput?.("stdout", Buffer.from(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => request.onOutput?.("stderr", Buffer.from(chunk)));
		if (child.pid && detached) trackDetachedChildPid(child.pid);

		let exitSignal: string | undefined;
		let terminationReason: ProcessRuntimeTerminationReason | undefined;
		let timeoutHandle: NodeJS.Timeout | undefined;
		child.once("exit", (_code, signal) => {
			exitSignal = signal ?? undefined;
		});
		const terminate = (
			reason: ProcessRuntimeTerminationReason = "terminated",
			signal: NodeJS.Signals = "SIGKILL",
		): boolean => {
			const terminated = terminateChild(child, detached, signal);
			if (terminated) terminationReason ??= reason;
			return terminated;
		};
		const abort = (): void => {
			terminate("aborted");
		};
		if (request.signal) request.signal.addEventListener("abort", abort, { once: true });
		if (timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => terminate("timed-out"), timeoutMs);
		}

		const completion = waitForChildProcess(child)
			.then(
				(exitCode): ProcessRuntimeExit => ({
					exitCode,
					signal: exitSignal,
					reason: terminationReason ?? "exited",
				}),
				(error: unknown): ProcessRuntimeExit => ({
					exitCode: null,
					reason: "failed",
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.finally(() => {
				if (child.pid && detached) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				request.signal?.removeEventListener("abort", abort);
			});

		return {
			id: randomUUID(),
			pid: child.pid,
			wait: () => completion,
			terminate,
		};
	}
}

export const localProcessRuntime = new LocalProcessRuntime();
