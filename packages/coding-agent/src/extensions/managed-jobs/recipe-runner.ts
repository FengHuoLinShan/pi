import type { ProcessSessionRecord } from "../../core/process-session.ts";
import { getShellEnv } from "../../utils/shell.ts";
import type { ManagedJobRecipeConfig } from "./config.ts";
import {
	isActiveManagedJobState,
	type ManagedJobsRuntime,
	type WaitForManagedJobOutputResult,
	waitForManagedJobOutput,
} from "./runtime.ts";

const MINIMAL_RECIPE_ENVIRONMENT_NAMES = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CI",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"USERPROFILE",
	"USERNAME",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
] as const;

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

function createRecipeEnvironment(recipe: ManagedJobRecipeConfig, cwd: string): NodeJS.ProcessEnv {
	const shellEnvironment = getShellEnv();
	if (recipe.inheritEnv === undefined) return shellEnvironment;
	const normalizeName = (name: string): string => (process.platform === "win32" ? name.toLowerCase() : name);
	const inheritedNames = new Set([...MINIMAL_RECIPE_ENVIRONMENT_NAMES, ...recipe.inheritEnv].map(normalizeName));
	const environment = Object.fromEntries(
		Object.entries(shellEnvironment).filter(([name]) => inheritedNames.has(normalizeName(name))),
	);
	if (process.platform !== "win32") environment.PWD = cwd;
	return environment;
}

function scheduleRuntimeLimit(runtime: ManagedJobsRuntime, id: string, timeoutMs: number): void {
	let timer: NodeJS.Timeout | undefined;
	let unsubscribe = () => {};
	const cleanup = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		unsubscribe();
	};
	unsubscribe = runtime.manager.subscribe((record) => {
		if (record.id === id && !isActiveManagedJobState(record.state)) cleanup();
	});
	timer = setTimeout(() => {
		cleanup();
		const record = runtime.manager.get(id);
		if (!record || !isActiveManagedJobState(record.state)) return;
		void (async () => {
			await runtime.manager.terminate(id);
			await runtime.manager.waitForExit(id);
			await runtime.manager.flush();
		})().catch(() => {
			// ProcessSessionManager records termination failures durably when possible.
		});
	}, timeoutMs);
	timer.unref();
	const current = runtime.manager.get(id);
	if (!current || !isActiveManagedJobState(current.state)) cleanup();
}

export async function runManagedJobRecipe(options: RunManagedJobRecipeOptions): Promise<ManagedJobRecipeRunResult> {
	let started: ProcessSessionRecord;
	try {
		started = await options.runtime.manager.start({
			id: options.id,
			command: options.recipe.command,
			args: options.recipe.args,
			cwd: options.cwd,
			env: createRecipeEnvironment(options.recipe, options.cwd),
		});
	} catch (error) {
		throw new ManagedJobRecipeRunError("start", options.id, error);
	}
	if (options.recipe.maxRuntimeSeconds !== undefined) {
		scheduleRuntimeLimit(options.runtime, started.id, options.recipe.maxRuntimeSeconds * 1000);
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
