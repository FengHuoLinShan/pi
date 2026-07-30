import {
	COMPLETION_CONTRACT_VERSION,
	type CompletionReport,
	type CompletionStatus,
	type CompletionVerifier,
	verifyCompletionContract,
} from "@earendil-works/pi-agent-core";
import type { ExecOptions, ExecResult } from "./exec.ts";
import { truncateTail } from "./tools/truncate.ts";
import { loadVerifiedProjectFile } from "./verified-project-file.ts";

export const GOAL_COMPLETION_CONFIG_PATH = ".pi/goal.json";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_CHECKS = 10;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_LINES = 80;
const MAX_DIAGNOSTIC_BYTES = 12 * 1024;
const CHECK_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface GoalCompletionCheck {
	readonly id: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
}

export interface GoalCompletionConfig {
	readonly version: 1;
	readonly checks: readonly GoalCompletionCheck[];
}

export interface GoalCompletionPlan {
	readonly configPath: string;
	readonly configRevision: string;
	readonly checks: readonly GoalCompletionCheck[];
}

export interface GoalCompletionCheckResult {
	readonly id: string;
	readonly status: CompletionStatus;
	readonly exitCode: number | null;
	readonly killed: boolean;
	readonly diagnostic?: string;
}

export interface GoalCompletionVerification {
	readonly report: CompletionReport;
	readonly checks: readonly GoalCompletionCheckResult[];
}

export type GoalCompletionExecutor = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function parseCheck(value: unknown, index: number): GoalCompletionCheck {
	if (!isPlainObject(value)) throw new Error(`checks[${index}] must be an object`);
	const allowedKeys = new Set(["id", "command", "args", "timeoutMs"]);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new Error(`unknown checks[${index}] field: ${unknownKey}`);
	if (typeof value.id !== "string" || !CHECK_ID_PATTERN.test(value.id)) {
		throw new Error(`checks[${index}].id must be a portable non-empty identifier`);
	}
	if (typeof value.command !== "string" || value.command.trim() === "") {
		throw new Error(`checks[${index}].command must be a non-empty string`);
	}
	const args = value.args ?? [];
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
		throw new Error(`checks[${index}].args must be an array of strings`);
	}
	for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
		if (!(argumentIndex in args)) throw new Error(`checks[${index}].args must not contain sparse entries`);
	}
	const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > MAX_TIMEOUT_MS) {
		throw new Error(`checks[${index}].timeoutMs must be a safe integer between 1000 and ${MAX_TIMEOUT_MS}`);
	}
	return {
		id: value.id,
		command: value.command,
		args: [...args],
		timeoutMs: timeoutMs as number,
	};
}

export function parseGoalCompletionConfig(value: unknown): GoalCompletionConfig {
	if (!isPlainObject(value)) throw new Error("goal completion config must be an object");
	const allowedKeys = new Set(["version", "checks"]);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new Error(`unknown goal completion config field: ${unknownKey}`);
	if (value.version !== 1) throw new Error("goal completion config version must be 1");
	if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > MAX_CHECKS) {
		throw new Error(`checks must contain between 1 and ${MAX_CHECKS} entries`);
	}
	for (let index = 0; index < value.checks.length; index++) {
		if (!(index in value.checks)) throw new Error("checks must not contain sparse entries");
	}
	const checks = value.checks.map(parseCheck);
	if (new Set(checks.map((check) => check.id)).size !== checks.length) {
		throw new Error("goal completion check ids must be unique");
	}
	return { version: 1, checks };
}

export async function loadGoalCompletionPlan(sourceRoot: string): Promise<GoalCompletionPlan | undefined> {
	const file = await loadVerifiedProjectFile(sourceRoot, GOAL_COMPLETION_CONFIG_PATH, MAX_CONFIG_BYTES);
	if (!file) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.content.toString("utf8"));
	} catch (error) {
		throw new Error(
			`${GOAL_COMPLETION_CONFIG_PATH} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const config = parseGoalCompletionConfig(parsed);
	return {
		configPath: file.path,
		configRevision: file.revision,
		checks: config.checks,
	};
}

function diagnostic(result: ExecResult): string | undefined {
	const sections: string[] = [];
	if (result.stdout.trim()) sections.push(`stdout:\n${result.stdout.trimEnd()}`);
	if (result.stderr.trim()) sections.push(`stderr:\n${result.stderr.trimEnd()}`);
	if (sections.length === 0) return undefined;
	const truncated = truncateTail(sections.join("\n\n"), {
		maxLines: MAX_DIAGNOSTIC_LINES,
		maxBytes: MAX_DIAGNOSTIC_BYTES,
	});
	return truncated.truncated ? `[Earlier output truncated]\n${truncated.content}` : truncated.content;
}

export async function verifyGoalCompletion(
	objective: string,
	plan: GoalCompletionPlan,
	logicalRoot: string,
	execute: GoalCompletionExecutor,
	signal?: AbortSignal,
): Promise<GoalCompletionVerification> {
	const executions = new Map<string, { exitCode: number | null; killed: boolean; diagnostic?: string }>();
	const verifiers: CompletionVerifier<undefined>[] = plan.checks.map((check) => ({
		id: check.id,
		verify: async (_input, verifierSignal) => {
			let result: ExecResult;
			try {
				result = await execute(check.command, [...check.args], {
					cwd: logicalRoot,
					timeout: check.timeoutMs,
					signal: verifierSignal,
				});
			} catch (error) {
				result = {
					stdout: "",
					stderr: error instanceof Error ? error.message : String(error),
					code: 1,
					killed: false,
				};
			}
			const status: CompletionStatus = result.killed ? "blocked" : result.code === 0 ? "pass" : "fail";
			executions.set(check.id, {
				exitCode: result.code,
				killed: result.killed,
				diagnostic: status === "pass" ? undefined : diagnostic(result),
			});
			return {
				status,
				summary:
					status === "pass"
						? `Check ${check.id} passed`
						: status === "blocked"
							? `Check ${check.id} was interrupted`
							: `Check ${check.id} exited with code ${result.code}`,
				evidence: [
					{
						id: `goal-check:${check.id}`,
						kind: "process",
						summary: `Goal completion check ${check.id}`,
						data: { exitCode: result.code, killed: result.killed },
					},
				],
			};
		},
	}));
	const report = await verifyCompletionContract(
		{
			version: COMPLETION_CONTRACT_VERSION,
			id: `goal:${plan.configRevision}`,
			objective,
			conditions: plan.checks.map((check) => ({
				id: check.id,
				description: `Completion check ${check.id}`,
				verifierIds: [check.id],
			})),
			metadata: {
				configRevision: plan.configRevision,
			},
		},
		verifiers,
		{ context: undefined, signal },
	);
	const checks = plan.checks.map((check, index): GoalCompletionCheckResult => {
		const verifier = report.conditions[index]?.verifiers[0];
		const execution = executions.get(check.id);
		return {
			id: check.id,
			status: verifier?.status ?? "error",
			exitCode: execution?.exitCode ?? null,
			killed: execution?.killed ?? false,
			diagnostic: execution?.diagnostic,
		};
	});
	return { report, checks };
}
