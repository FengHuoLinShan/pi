import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";
import { ArtifactStore, type ArtifactStoreRecoveryReport } from "../../core/artifact-store.ts";
import {
	ProcessSessionManager,
	type ProcessSessionRecoveryReport,
	type ProcessSessionState,
} from "../../core/process-session.ts";

export const MANAGED_JOBS_MAX_ACTIVE = 4;
export const MANAGED_JOBS_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MANAGED_JOBS_OUTPUT_TAIL_BYTES = 16 * 1024;

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

const runtimes = new Map<string, Promise<ManagedJobsRuntime>>();

export function isActiveManagedJobState(state: ProcessSessionState): boolean {
	return state === "created" || state === "running" || state === "terminating";
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
