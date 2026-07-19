import type { CompletionEvidence, CompletionVerifier, CompletionVerifierOutcome } from "@earendil-works/pi-agent-core";
import type { ProcessSessionManager, ProcessSessionRecord } from "./process-session.ts";

export interface ProcessSessionCompletionVerifierOptions {
	/** Stable verifier id referenced by a CompletionContract condition. */
	id: string;
	manager: ProcessSessionManager;
	command: string;
	args?: readonly string[];
	cwd?: string;
	/** Values are delegated to the process backend but never copied into completion evidence. */
	env?: NodeJS.ProcessEnv;
	/** Exit codes considered successful. Default: [0]. */
	expectedExitCodes?: readonly number[];
}

function validateOptions(options: ProcessSessionCompletionVerifierOptions): void {
	if (!options.id.trim()) throw new Error("Process completion verifier id must not be empty");
	if (!options.command.trim()) throw new Error("Process completion verifier command must not be empty");
	const expectedExitCodes = options.expectedExitCodes ?? [0];
	if (expectedExitCodes.length === 0) throw new Error("Process completion verifier requires an expected exit code");
	if (!expectedExitCodes.every((exitCode) => Number.isSafeInteger(exitCode))) {
		throw new Error("Process completion verifier exit codes must be safe integers");
	}
}

async function waitForProcess(
	manager: ProcessSessionManager,
	processSessionId: string,
	signal: AbortSignal,
): Promise<ProcessSessionRecord> {
	let abortStarted = false;
	let onAbort = () => undefined;
	const aborted = new Promise<ProcessSessionRecord>((resolve, reject) => {
		onAbort = () => {
			if (abortStarted) return;
			abortStarted = true;
			void manager
				.terminate(processSessionId)
				.then(async () => await manager.waitForExit(processSessionId))
				.then(resolve, reject);
		};
	});
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		return await Promise.race([manager.waitForExit(processSessionId), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function createEvidence(verifierId: string, record: ProcessSessionRecord): CompletionEvidence[] {
	const outputBytes = record.outputs.reduce((total, output) => total + output.byteLength, 0);
	return [
		{
			id: `${verifierId}:process`,
			kind: "process",
			summary: `Process session ${record.state}`,
			reference: `process-session:${record.id}`,
			data: {
				state: record.state,
				exitCode: record.exit?.exitCode ?? null,
				signal: record.exit?.signal ?? null,
				outputCount: record.outputs.length,
				outputBytes,
			},
		},
		...record.outputs.map((output) => ({
			id: `${verifierId}:output:${output.sequence}`,
			kind: "artifact",
			summary: `${output.stream} output chunk (${output.byteLength} bytes)`,
			reference: output.artifact,
			data: { sequence: output.sequence, stream: output.stream, byteLength: output.byteLength },
		})),
	];
}

function createOutcome(
	record: ProcessSessionRecord,
	expectedExitCodes: ReadonlySet<number>,
	evidence: CompletionEvidence[],
	aborted: boolean,
): CompletionVerifierOutcome {
	if (aborted || record.state === "terminated") {
		return { status: "blocked", summary: "Process verification was interrupted", evidence };
	}
	if (record.state === "interrupted") {
		return { status: "blocked", summary: "Process backend could not complete verification", evidence };
	}
	if (record.state === "failed") {
		return {
			status: "error",
			summary: "Process verification failed to execute",
			error: { name: "ProcessSessionFailed", message: "Process session failed" },
			evidence,
		};
	}
	if (record.state !== "exited") {
		return {
			status: "error",
			summary: "Process verification ended in an invalid state",
			error: { name: "ProcessSessionIncomplete", message: `Unexpected process state: ${record.state}` },
			evidence,
		};
	}
	const exitCode = record.exit?.exitCode;
	if (exitCode !== null && exitCode !== undefined && expectedExitCodes.has(exitCode)) {
		return { status: "pass", summary: `Process exited with expected code ${exitCode}`, evidence };
	}
	return { status: "fail", summary: `Process exited with unexpected code ${exitCode ?? "null"}`, evidence };
}

/**
 * Build an explicit foreground completion verifier backed by a durable process session.
 *
 * Output bytes stay in ArtifactStore. Completion evidence contains only process state,
 * byte counts, and opaque process/artifact references. This does not alter the default
 * interactive bash tool or start work until a host invokes completion verification.
 */
export function createProcessSessionCompletionVerifier<TContext = unknown>(
	options: ProcessSessionCompletionVerifierOptions,
): CompletionVerifier<TContext> {
	validateOptions(options);
	const id = options.id;
	const manager = options.manager;
	const command = options.command;
	const args = [...(options.args ?? [])];
	const cwd = options.cwd;
	const env = options.env ? { ...options.env } : undefined;
	const expectedExitCodes = new Set(options.expectedExitCodes ?? [0]);
	return {
		id,
		verify: async (_input, signal) => {
			if (signal.aborted) {
				return { status: "blocked", summary: "Process verification was interrupted before start" };
			}
			const started = await manager.start({ command, args, cwd, env });
			const completed = await waitForProcess(manager, started.id, signal);
			await manager.flush();
			const record = manager.status(completed.id);
			return createOutcome(record, expectedExitCodes, createEvidence(id, record), signal.aborted);
		},
	};
}
