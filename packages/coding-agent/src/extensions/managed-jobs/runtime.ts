import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";
import { ArtifactStore, type ArtifactStoreRecoveryReport } from "../../core/artifact-store.ts";
import {
	type ProcessOutputStream,
	ProcessSessionManager,
	type ProcessSessionRecord,
	type ProcessSessionRecoveryReport,
	type ProcessSessionState,
} from "../../core/process-session.ts";

export const MANAGED_JOBS_MAX_ACTIVE = 4;
export const MANAGED_JOBS_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MANAGED_JOBS_OUTPUT_TAIL_BYTES = 16 * 1024;
export const MANAGED_JOBS_WAIT_TAIL_BYTES = 64 * 1024;

export interface ManagedJobsRecoveryReport {
	artifacts: ArtifactStoreRecoveryReport;
	processes: ProcessSessionRecoveryReport;
}

export interface ManagedJobsRuntime {
	root: string;
	manager: ProcessSessionManager;
	recovery: ManagedJobsRecoveryReport;
}

export interface OpenManagedJobsRuntimeOptions {
	cwd: string;
	agentDir?: string;
	maxOutputBytesPerSession?: number;
}

export interface WaitForManagedJobOutputOptions {
	contains: string;
	stream?: ProcessOutputStream;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface WaitForManagedJobOutputResult {
	status: "matched" | "terminal" | "timeout" | "aborted";
	record: ProcessSessionRecord;
}

const runtimes = new Map<string, Promise<ManagedJobsRuntime>>();

export function isActiveManagedJobState(state: ProcessSessionState): boolean {
	return state === "created" || state === "running" || state === "terminating";
}

function isTerminalManagedJobState(state: ProcessSessionState): boolean {
	return state === "exited" || state === "terminated" || state === "failed" || state === "interrupted";
}

export function getManagedJobsRoot(cwd: string, agentDir = getAgentDir()): string {
	const workspaceId = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 32);
	return resolve(agentDir, "managed-jobs", workspaceId);
}

export function parseManagedJobCommand(value: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let tokenStarted = false;

	for (let index = 0; index < value.length; index++) {
		const character = value[index]!;
		if (escaped) {
			current += character;
			tokenStarted = true;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			tokenStarted = true;
			const next = value[index + 1];
			if (next && (/\s/.test(next) || next === "\\" || next === "'" || next === '"')) escaped = true;
			else current += character;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			tokenStarted = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			tokenStarted = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}
		current += character;
		tokenStarted = true;
	}

	if (quote) throw new Error("Managed job command contains an unterminated quote");
	if (tokenStarted) args.push(current);
	return args;
}

export async function openManagedJobsRuntime(options: OpenManagedJobsRuntimeOptions): Promise<ManagedJobsRuntime> {
	const root = getManagedJobsRoot(options.cwd, options.agentDir);
	const existing = runtimes.get(root);
	if (existing) return existing;

	const opened = (async () => {
		const artifacts = await ArtifactStore.open({
			root: join(root, "artifacts"),
			allowedRoots: [root],
		});
		const processes = await ProcessSessionManager.open({
			root: join(root, "processes"),
			allowedRoots: [root],
			artifactStore: artifacts.store,
			defaultCwd: options.cwd,
			maxOutputBytesPerSession: options.maxOutputBytesPerSession ?? MANAGED_JOBS_MAX_OUTPUT_BYTES,
		});
		return {
			root,
			manager: processes.manager,
			recovery: {
				artifacts: artifacts.recovery,
				processes: processes.recovery,
			},
		};
	})();
	runtimes.set(root, opened);
	try {
		return await opened;
	} catch (error) {
		runtimes.delete(root);
		throw error;
	}
}

export async function waitForManagedJobOutput(
	runtime: ManagedJobsRuntime,
	id: string,
	options: WaitForManagedJobOutputOptions,
): Promise<WaitForManagedJobOutputResult> {
	if (!options.contains) throw new Error("Managed job wait text must not be empty");
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
		throw new Error("Managed job wait timeout must be a positive safe integer");
	}
	const manager = runtime.manager;
	manager.status(id);

	return new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		let checking = false;
		let pendingCheck = false;
		let unsubscribe = () => {};
		const finish = (status: WaitForManagedJobOutputResult["status"], record: ProcessSessionRecord): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			unsubscribe();
			resolvePromise({ status, record });
		};
		const check = async (): Promise<void> => {
			if (settled) return;
			if (checking) {
				pendingCheck = true;
				return;
			}
			checking = true;
			try {
				const record = manager.status(id);
				const output = await manager.readOutputTail(id, {
					stream: options.stream,
					maxBytes: MANAGED_JOBS_WAIT_TAIL_BYTES,
				});
				if (output.toString("utf8").includes(options.contains)) {
					finish("matched", record);
				} else if (isTerminalManagedJobState(record.state)) {
					finish("terminal", record);
				}
			} catch (error) {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", abort);
					unsubscribe();
					rejectPromise(error);
				}
			} finally {
				checking = false;
				if (pendingCheck && !settled) {
					pendingCheck = false;
					void check();
				}
			}
		};
		const abort = (): void => finish("aborted", manager.status(id));
		const timer = setTimeout(() => finish("timeout", manager.status(id)), options.timeoutMs);
		unsubscribe = manager.subscribe((record, event) => {
			if (
				record.id === id &&
				(event.type === "process_output" ||
					event.type === "process_exited" ||
					event.type === "process_failed" ||
					event.type === "process_interrupted")
			) {
				void check();
			}
		});
		if (options.signal?.aborted) abort();
		else {
			options.signal?.addEventListener("abort", abort, { once: true });
			void check();
		}
	});
}
