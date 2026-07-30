import type { ProcessSessionRecord } from "../../core/process-session.ts";
import { getShellEnv } from "../../utils/shell.ts";
import type { ManagedJobRecipeConfig } from "./config.ts";
import { type ManagedJobsRuntime, type WaitForManagedJobOutputResult, waitForManagedJobOutput } from "./runtime.ts";

export type ManagedJobRecipeRunStage = "start" | "readiness check";
export type ManagedJobRecipeReadinessStatus = "not_configured" | WaitForManagedJobOutputResult["status"];

export class ManagedJobRecipeRunError extends Error {
	readonly stage: ManagedJobRecipeRunStage;
	readonly jobId: string | undefined;

	constructor(stage: ManagedJobRecipeRunStage, jobId: string | undefined, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "ManagedJobRecipeRunError";
		this.stage = stage;
		this.jobId = jobId;
	}
}

export interface RunManagedJobRecipeOptions {
	runtime: ManagedJobsRuntime;
	recipe: ManagedJobRecipeConfig;
	cwd: string;
	id?: string;
	signal?: AbortSignal;
}

export interface ManagedJobRecipeRunResult {
	record: ProcessSessionRecord;
	readinessStatus: ManagedJobRecipeReadinessStatus;
}

export async function runManagedJobRecipe(options: RunManagedJobRecipeOptions): Promise<ManagedJobRecipeRunResult> {
	let started: ProcessSessionRecord;
	try {
		started = await options.runtime.manager.start({
			id: options.id,
			command: options.recipe.command,
			args: options.recipe.args,
			cwd: options.cwd,
			env: getShellEnv(),
		});
	} catch (error) {
		throw new ManagedJobRecipeRunError("start", options.id, error);
	}
	if (!options.recipe.readiness) return { record: started, readinessStatus: "not_configured" };

	try {
		const readiness = await waitForManagedJobOutput(options.runtime, started.id, {
			contains: options.recipe.readiness.contains,
			stream:
				options.recipe.readiness.stream === "stdout" || options.recipe.readiness.stream === "stderr"
					? options.recipe.readiness.stream
					: undefined,
			timeoutMs: options.recipe.readiness.timeoutSeconds * 1000,
			signal: options.signal,
		});
		return { record: readiness.record, readinessStatus: readiness.status };
	} catch (error) {
		throw new ManagedJobRecipeRunError("readiness check", started.id, error);
	}
}
