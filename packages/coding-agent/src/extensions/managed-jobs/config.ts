import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { captureFilePathSnapshot, revalidateFilePathSnapshot } from "../../core/tools/file-transaction.ts";

export const MANAGED_JOBS_CONFIG_VERSION = 1 as const;
export const MANAGED_JOBS_CONFIG_PATH = ".pi/managed-jobs.json";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_RECIPES = 16;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 8_192;
const MAX_ARGUMENT_BYTES_PER_RECIPE = 65_536;
const MAX_READINESS_TEXT_LENGTH = 512;
const MAX_READINESS_TIMEOUT_SECONDS = 30;

export interface ManagedJobReadinessConfig {
	contains: string;
	stream: "stdout" | "stderr" | "all";
	timeoutSeconds: number;
}

export interface ManagedJobRecipeConfig {
	id: string;
	command: string;
	args: string[];
	readiness?: ManagedJobReadinessConfig;
}

export interface ManagedJobsConfig {
	version: typeof MANAGED_JOBS_CONFIG_VERSION;
	recipes: ManagedJobRecipeConfig[];
}

export interface LoadedManagedJobsConfig {
	config: ManagedJobsConfig;
	revision: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedFields = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !allowedFields.has(key));
	if (unknown) throw new Error(`unknown ${label} field: ${unknown}`);
}

function parsePortableId(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(value)) {
		throw new Error(`${label} must be a portable identifier with 1-64 characters`);
	}
	return value;
}

function parseText(value: unknown, label: string, maximumLength: number): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must not be empty`);
	if (value.includes("\0")) throw new Error(`${label} must not contain NUL bytes`);
	if (value.length > maximumLength) throw new Error(`${label} exceeds ${maximumLength} characters`);
	return value;
}

function assertDenseArray(value: readonly unknown[], label: string): void {
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new Error(`${label} must not contain sparse entries`);
	}
}

function parseReadiness(value: unknown, recipeIndex: number): ManagedJobReadinessConfig {
	const label = `recipes[${recipeIndex}].readiness`;
	if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
	rejectUnknownFields(value, ["contains", "stream", "timeoutSeconds"], label);
	const contains = parseText(value.contains, `${label}.contains`, MAX_READINESS_TEXT_LENGTH);
	const stream = value.stream ?? "all";
	if (stream !== "stdout" && stream !== "stderr" && stream !== "all") {
		throw new Error(`${label}.stream must be stdout, stderr, or all`);
	}
	const timeoutSeconds = value.timeoutSeconds ?? MAX_READINESS_TIMEOUT_SECONDS;
	if (
		!Number.isSafeInteger(timeoutSeconds) ||
		(timeoutSeconds as number) < 1 ||
		(timeoutSeconds as number) > MAX_READINESS_TIMEOUT_SECONDS
	) {
		throw new Error(`${label}.timeoutSeconds must be a safe integer between 1 and 30`);
	}
	return { contains, stream, timeoutSeconds: timeoutSeconds as number };
}

function parseRecipe(value: unknown, index: number): ManagedJobRecipeConfig {
	const label = `recipes[${index}]`;
	if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
	rejectUnknownFields(value, ["id", "command", "args", "readiness"], label);
	const id = parsePortableId(value.id, `${label}.id`);
	const command = parseText(value.command, `${label}.command`, MAX_COMMAND_LENGTH);
	const rawArguments = value.args ?? [];
	if (!Array.isArray(rawArguments) || rawArguments.length > MAX_ARGUMENTS) {
		throw new Error(`${label}.args must be an array with at most ${MAX_ARGUMENTS} entries`);
	}
	assertDenseArray(rawArguments, `${label}.args`);
	const args = rawArguments.map((argument, argumentIndex) => {
		if (typeof argument !== "string") throw new Error(`${label}.args[${argumentIndex}] must be a string`);
		if (argument.includes("\0")) throw new Error(`${label}.args[${argumentIndex}] must not contain NUL bytes`);
		if (Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES) {
			throw new Error(`${label}.args[${argumentIndex}] exceeds ${MAX_ARGUMENT_BYTES} bytes`);
		}
		return argument;
	});
	if (args.reduce((total, argument) => total + Buffer.byteLength(argument), 0) > MAX_ARGUMENT_BYTES_PER_RECIPE) {
		throw new Error(`${label}.args exceeds ${MAX_ARGUMENT_BYTES_PER_RECIPE} total bytes`);
	}
	return {
		id,
		command,
		args,
		...(value.readiness === undefined ? {} : { readiness: parseReadiness(value.readiness, index) }),
	};
}

export function parseManagedJobsConfig(value: unknown): ManagedJobsConfig {
	if (!isPlainObject(value)) throw new Error("managed jobs config must be an object");
	rejectUnknownFields(value, ["version", "recipes"], "managed jobs config");
	if (value.version !== MANAGED_JOBS_CONFIG_VERSION) {
		throw new Error(`managed jobs config version must be ${MANAGED_JOBS_CONFIG_VERSION}`);
	}
	if (!Array.isArray(value.recipes) || value.recipes.length === 0 || value.recipes.length > MAX_RECIPES) {
		throw new Error(`recipes must contain between 1 and ${MAX_RECIPES} entries`);
	}
	assertDenseArray(value.recipes, "recipes");
	const recipes = value.recipes.map(parseRecipe);
	if (new Set(recipes.map((recipe) => recipe.id)).size !== recipes.length) {
		throw new Error("recipe ids must be unique");
	}
	return { version: MANAGED_JOBS_CONFIG_VERSION, recipes };
}

export async function loadManagedJobsConfig(cwd: string): Promise<LoadedManagedJobsConfig> {
	const path = join(cwd, MANAGED_JOBS_CONFIG_PATH);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(`${MANAGED_JOBS_CONFIG_PATH} must be a regular non-symbolic-link file`);
	}
	if (info.size > MAX_CONFIG_BYTES) {
		throw new Error(`${MANAGED_JOBS_CONFIG_PATH} exceeds ${MAX_CONFIG_BYTES} bytes`);
	}
	const snapshot = await captureFilePathSnapshot(path, MANAGED_JOBS_CONFIG_PATH, [cwd], realpath, true);
	await revalidateFilePathSnapshot(snapshot, MANAGED_JOBS_CONFIG_PATH, [cwd], realpath);
	const source = await readFile(snapshot.targetPath);
	await revalidateFilePathSnapshot(snapshot, MANAGED_JOBS_CONFIG_PATH, [cwd], realpath);
	if (source.byteLength > MAX_CONFIG_BYTES) {
		throw new Error(`${MANAGED_JOBS_CONFIG_PATH} exceeds ${MAX_CONFIG_BYTES} bytes`);
	}
	let value: unknown;
	try {
		value = JSON.parse(source.toString("utf8")) as unknown;
	} catch (error) {
		throw new Error(
			`cannot parse ${MANAGED_JOBS_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		config: parseManagedJobsConfig(value),
		revision: createHash("sha256").update(source).digest("hex"),
	};
}
