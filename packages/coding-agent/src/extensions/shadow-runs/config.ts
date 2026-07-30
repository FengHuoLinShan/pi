import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const SHADOW_RUNS_CONFIG_VERSION = 1 as const;
export const SHADOW_RUNS_CONFIG_PATH = ".pi/shadow-runs.json";

const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 4;
const MAX_CHECKS = 8;
const MAX_INSTRUCTIONS_LENGTH = 8_000;
const MAX_LABEL_LENGTH = 120;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_ARGUMENT_LENGTH = 65_536;
const MAX_ARGUMENTS = 100;
const MAX_MODEL_CALLS = 64;
const MAX_TOOL_CALLS = 1_000;
const MAX_WALL_TIME_MS = 30 * 60_000;
const MAX_MODEL_TOKENS = 10_000_000;
const MAX_COST = 10_000;
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface ShadowRunsCandidateConfig {
	id: string;
	label?: string;
	instructions: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ShadowRunsCheckConfig {
	id: string;
	command: string;
	args: string[];
	timeoutMs: number;
}

export interface ShadowRunsBudgetConfig {
	maxModelCalls: number;
	maxToolCalls: number;
	maxWallTimeMs: number;
	maxModelTokens?: number;
	maxCost?: number;
}

export interface ShadowRunsConfig {
	version: typeof SHADOW_RUNS_CONFIG_VERSION;
	execution: "sequential" | "parallel";
	candidates: ShadowRunsCandidateConfig[];
	checks: ShadowRunsCheckConfig[];
	budget: ShadowRunsBudgetConfig;
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

function parseBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be a safe integer between ${minimum} and ${maximum}`);
	}
	return value as number;
}

function parseBoundedNumber(value: unknown, label: string, minimumExclusive: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= minimumExclusive || value > maximum) {
		throw new Error(`${label} must be a finite number greater than ${minimumExclusive} and at most ${maximum}`);
	}
	return value;
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

function parseArgument(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	if (value.includes("\0")) throw new Error(`${label} must not contain NUL bytes`);
	if (value.length > MAX_ARGUMENT_LENGTH) throw new Error(`${label} exceeds ${MAX_ARGUMENT_LENGTH} characters`);
	return value;
}

function assertDenseArray(value: readonly unknown[], label: string): void {
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new Error(`${label} must not contain sparse entries`);
	}
}

function parseCandidate(value: unknown, index: number): ShadowRunsCandidateConfig {
	if (!isPlainObject(value)) throw new Error(`candidates[${index}] must be an object`);
	rejectUnknownFields(value, ["id", "label", "instructions", "thinkingLevel"], `candidates[${index}]`);
	const id = parsePortableId(value.id, `candidates[${index}].id`);
	const instructions = parseText(value.instructions, `candidates[${index}].instructions`, MAX_INSTRUCTIONS_LENGTH);
	const label =
		value.label === undefined ? undefined : parseText(value.label, `candidates[${index}].label`, MAX_LABEL_LENGTH);
	let thinkingLevel: ThinkingLevel | undefined;
	if (value.thinkingLevel !== undefined) {
		if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevel)) {
			throw new Error(`candidates[${index}].thinkingLevel is invalid`);
		}
		thinkingLevel = value.thinkingLevel as ThinkingLevel;
	}
	return { id, instructions, ...(label === undefined ? {} : { label }), ...(thinkingLevel ? { thinkingLevel } : {}) };
}

function parseCheck(value: unknown, index: number): ShadowRunsCheckConfig {
	if (!isPlainObject(value)) throw new Error(`checks[${index}] must be an object`);
	rejectUnknownFields(value, ["id", "command", "args", "timeoutMs"], `checks[${index}]`);
	const id = parsePortableId(value.id, `checks[${index}].id`);
	const command = parseText(value.command, `checks[${index}].command`, MAX_COMMAND_LENGTH);
	if (!Array.isArray(value.args) || value.args.length > MAX_ARGUMENTS) {
		throw new Error(`checks[${index}].args must be an array with at most ${MAX_ARGUMENTS} entries`);
	}
	assertDenseArray(value.args, `checks[${index}].args`);
	const args = value.args.map((argument, argumentIndex) =>
		parseArgument(argument, `checks[${index}].args[${argumentIndex}]`),
	);
	return {
		id,
		command,
		args,
		timeoutMs: parseBoundedInteger(
			value.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
			`checks[${index}].timeoutMs`,
			1_000,
			MAX_WALL_TIME_MS,
		),
	};
}

function parseBudget(value: unknown): ShadowRunsBudgetConfig {
	if (!isPlainObject(value)) throw new Error("budget must be an object");
	rejectUnknownFields(
		value,
		["maxModelCalls", "maxToolCalls", "maxWallTimeMs", "maxModelTokens", "maxCost"],
		"budget",
	);
	return {
		maxModelCalls: parseBoundedInteger(value.maxModelCalls, "budget.maxModelCalls", 1, MAX_MODEL_CALLS),
		maxToolCalls: parseBoundedInteger(value.maxToolCalls, "budget.maxToolCalls", 1, MAX_TOOL_CALLS),
		maxWallTimeMs: parseBoundedInteger(value.maxWallTimeMs, "budget.maxWallTimeMs", 1_000, MAX_WALL_TIME_MS),
		...(value.maxModelTokens === undefined
			? {}
			: {
					maxModelTokens: parseBoundedInteger(value.maxModelTokens, "budget.maxModelTokens", 1, MAX_MODEL_TOKENS),
				}),
		...(value.maxCost === undefined
			? {}
			: { maxCost: parseBoundedNumber(value.maxCost, "budget.maxCost", 0, MAX_COST) }),
	};
}

export function parseShadowRunsConfig(value: unknown): ShadowRunsConfig {
	if (!isPlainObject(value)) throw new Error("shadow runs config must be an object");
	rejectUnknownFields(value, ["version", "execution", "candidates", "checks", "budget"], "shadow runs config");
	if (value.version !== SHADOW_RUNS_CONFIG_VERSION) {
		throw new Error(`shadow runs config version must be ${SHADOW_RUNS_CONFIG_VERSION}`);
	}
	const execution = value.execution ?? "sequential";
	if (execution !== "sequential" && execution !== "parallel") {
		throw new Error("execution must be sequential or parallel");
	}
	if (
		!Array.isArray(value.candidates) ||
		value.candidates.length < MIN_CANDIDATES ||
		value.candidates.length > MAX_CANDIDATES
	) {
		throw new Error(`candidates must contain between ${MIN_CANDIDATES} and ${MAX_CANDIDATES} entries`);
	}
	assertDenseArray(value.candidates, "candidates");
	const candidates = value.candidates.map(parseCandidate);
	if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
		throw new Error("candidate ids must be unique");
	}
	if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > MAX_CHECKS) {
		throw new Error(`checks must contain between 1 and ${MAX_CHECKS} entries`);
	}
	assertDenseArray(value.checks, "checks");
	const checks = value.checks.map(parseCheck);
	if (new Set(checks.map((check) => check.id)).size !== checks.length) {
		throw new Error("check ids must be unique");
	}
	return {
		version: SHADOW_RUNS_CONFIG_VERSION,
		execution,
		candidates,
		checks,
		budget: parseBudget(value.budget),
	};
}
