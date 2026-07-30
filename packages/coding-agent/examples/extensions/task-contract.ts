/**
 * Task Contract Extension
 *
 * Enforces an explicit, committed task contract for a clean Git baseline.
 * Built-in file tools are checked before execution. The complete Git change
 * set, including bash mutations, is checked before configured verification
 * commands run. Results are persisted as custom session entries.
 *
 * Configure .pi/task-contract.json at the repository root:
 * {
 *   "allowedPaths": ["packages/app/**", "packages/app/test/**"],
 *   "deniedPaths": ["packages/app/src/generated/**"],
 *   "minChangedFiles": 1,
 *   "maxChangedFiles": 20,
 *   "checks": [
 *     {
 *       "id": "check",
 *       "command": "npm",
 *       "args": ["run", "check"],
 *       "timeoutMs": 120000
 *     }
 *   ],
 *   "maxAttempts": 3
 * }
 *
 * Start pi with `--task-contract` to opt in.
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	computeFileRevision,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
	isBashToolResult,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
	type SessionEntry,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

const CONFIG_PATH = ".pi/task-contract.json";
const CUSTOM_TYPE = "task-contract-v1";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_ATTEMPTS = 10;
const MAX_CHANGED_FILES = 10_000;
const MAX_CHECKS = 10;
const MAX_STATUS_BYTES = 5 * 1024 * 1024;
const MAX_REPORTED_PATHS = 50;
const MAX_OUTPUT_LINES = 100;
const MAX_OUTPUT_BYTES = 16 * 1024;
const HASH_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GLOB_OPTIONS = {
	dot: true,
	nocase: false,
	nocomment: true,
	nonegate: true,
} as const;

interface TaskCheck {
	id: string;
	command: string;
	args: string[];
	timeoutMs: number;
}

export interface TaskContractConfig {
	allowedPaths: string[];
	deniedPaths: string[];
	minChangedFiles: number;
	maxChangedFiles: number;
	checks: TaskCheck[];
	maxAttempts: number;
}

interface BaselineData {
	version: 1;
	kind: "baseline";
	repositoryRoot: string;
	configRevision: string;
	head: string;
	createdAt: string;
}

interface CheckEvidence {
	id: string;
	code: number;
	killed: boolean;
}

interface AttemptData {
	version: 1;
	kind: "attempt";
	status: "pass" | "fail";
	baselineHead: string;
	changedPathCount: number;
	changedPaths: string[];
	pathsTruncated: boolean;
	violations: string[];
	checks: CheckEvidence[];
	attempt: number;
	completedAt: string;
}

interface ReadyState {
	kind: "ready";
	config: TaskContractConfig;
	configRevision: string;
	baseline: BaselineData;
}

type ContractState = { kind: "disabled" } | { kind: "invalid"; reason: string } | ReadyState;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function parseStringArray(value: unknown, field: string, allowEmpty: boolean): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${field} must be an array of strings`);
	}
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new Error(`${field} must not contain sparse entries`);
	}
	if (!allowEmpty && value.length === 0) throw new Error(`${field} must not be empty`);
	return [...value];
}

function parseBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${field} must be a safe integer between ${minimum} and ${maximum}`);
	}
	return value as number;
}

function validatePattern(pattern: string, field: string): void {
	if (
		pattern === "" ||
		pattern.includes("\0") ||
		pattern.includes("\\") ||
		pattern.startsWith("/") ||
		pattern.split("/").includes("..")
	) {
		throw new Error(`${field} contains an unsafe repository-relative glob: ${JSON.stringify(pattern)}`);
	}
	try {
		minimatch("", pattern, GLOB_OPTIONS);
	} catch (error) {
		throw new Error(
			`${field} contains an invalid glob ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseCheck(value: unknown, index: number): TaskCheck {
	if (!isPlainObject(value)) throw new Error(`checks[${index}] must be an object`);
	const allowedKeys = new Set(["id", "command", "args", "timeoutMs"]);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new Error(`unknown checks[${index}] field: ${unknownKey}`);

	if (typeof value.id !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value.id)) {
		throw new Error(`checks[${index}].id must be a portable non-empty identifier`);
	}
	if (typeof value.command !== "string" || value.command.trim() === "") {
		throw new Error(`checks[${index}].command must be a non-empty string`);
	}
	const args = parseStringArray(value.args ?? [], `checks[${index}].args`, true);
	const timeoutMs = parseBoundedInteger(
		value.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		`checks[${index}].timeoutMs`,
		1_000,
		MAX_TIMEOUT_MS,
	);
	return { id: value.id, command: value.command, args, timeoutMs };
}

export function parseTaskContractConfig(value: unknown): TaskContractConfig {
	if (!isPlainObject(value)) throw new Error("task contract must be an object");
	const allowedKeys = new Set([
		"allowedPaths",
		"deniedPaths",
		"minChangedFiles",
		"maxChangedFiles",
		"checks",
		"maxAttempts",
	]);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new Error(`unknown task contract field: ${unknownKey}`);

	const allowedPaths = parseStringArray(value.allowedPaths, "allowedPaths", false);
	const deniedPaths = parseStringArray(value.deniedPaths ?? [], "deniedPaths", true);
	for (const pattern of allowedPaths) validatePattern(pattern, "allowedPaths");
	for (const pattern of deniedPaths) validatePattern(pattern, "deniedPaths");

	const maxChangedFiles = parseBoundedInteger(value.maxChangedFiles, "maxChangedFiles", 1, MAX_CHANGED_FILES);
	const minChangedFiles = parseBoundedInteger(value.minChangedFiles ?? 1, "minChangedFiles", 0, maxChangedFiles);

	if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > MAX_CHECKS) {
		throw new Error(`checks must contain between 1 and ${MAX_CHECKS} entries`);
	}
	for (let index = 0; index < value.checks.length; index++) {
		if (!(index in value.checks)) throw new Error("checks must not contain sparse entries");
	}
	const checks = value.checks.map(parseCheck);
	const checkIds = new Set(checks.map((check) => check.id));
	if (checkIds.size !== checks.length) throw new Error("check ids must be unique");

	const maxAttempts = parseBoundedInteger(value.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts", 1, MAX_ATTEMPTS);

	return {
		allowedPaths,
		deniedPaths,
		minChangedFiles,
		maxChangedFiles,
		checks,
		maxAttempts,
	};
}

export function parseTaskContractStatus(output: string): Set<string> {
	if (Buffer.byteLength(output) > MAX_STATUS_BYTES) {
		throw new Error(`git status output exceeds ${MAX_STATUS_BYTES} bytes`);
	}
	const fields = output.split("\0");
	const paths = new Set<string>();

	for (let index = 0; index < fields.length; index++) {
		const record = fields[index]!;
		if (record === "") continue;
		if (record.length < 4 || record[2] !== " ") throw new Error("malformed git status record");

		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (!path) throw new Error("git status record has an empty path");
		paths.add(path);

		if (status.includes("R") || status.includes("C")) {
			const sourcePath = fields[++index];
			if (!sourcePath) throw new Error("git rename or copy record is missing its source path");
			paths.add(sourcePath);
		}
	}
	return paths;
}

function isBaselineData(value: unknown): value is BaselineData {
	if (!isPlainObject(value)) return false;
	return (
		value.version === 1 &&
		value.kind === "baseline" &&
		typeof value.repositoryRoot === "string" &&
		typeof value.configRevision === "string" &&
		typeof value.head === "string" &&
		HASH_PATTERN.test(value.head) &&
		typeof value.createdAt === "string"
	);
}

function findBaseline(entries: SessionEntry[]): BaselineData | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && isBaselineData(entry.data)) {
			return entry.data;
		}
	}
	return undefined;
}

function toRepositoryRelativePath(repositoryRoot: string, cwd: string, inputPath: string): string | undefined {
	const canonicalCwd = canonicalizePath(cwd);
	if (!canonicalCwd) return undefined;
	const absolutePath = canonicalizePath(isAbsolute(inputPath) ? resolve(inputPath) : resolve(canonicalCwd, inputPath));
	if (!absolutePath) return undefined;
	const relativePath = relative(repositoryRoot, absolutePath);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return undefined;
	}
	return relativePath.replaceAll("\\", "/");
}

function canonicalizePath(path: string): string | undefined {
	let existingAncestor = resolve(path);
	const missingSegments: string[] = [];

	while (true) {
		try {
			return resolve(realpathSync(existingAncestor), ...missingSegments);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				return undefined;
			}
		}

		const parent = dirname(existingAncestor);
		if (parent === existingAncestor) return undefined;
		missingSegments.unshift(basename(existingAncestor));
		existingAncestor = parent;
	}
}

function isPathAllowed(config: TaskContractConfig, path: string): boolean {
	return (
		config.allowedPaths.some((pattern) => minimatch(path, pattern, GLOB_OPTIONS)) &&
		!config.deniedPaths.some((pattern) => minimatch(path, pattern, GLOB_OPTIONS))
	);
}

function formatCommand(check: TaskCheck): string {
	return [check.command, ...check.args.map((arg) => JSON.stringify(arg))].join(" ");
}

function formatFailureOutput(check: TaskCheck, result: ExecResult): string {
	const sections = [`[${check.id}] ${formatCommand(check)}`];
	if (result.stdout.trim()) sections.push(`stdout:\n${result.stdout.trimEnd()}`);
	if (result.stderr.trim()) sections.push(`stderr:\n${result.stderr.trimEnd()}`);
	if (sections.length === 1) sections.push("(no command output)");
	const output = truncateTail(sections.join("\n\n"), {
		maxLines: MAX_OUTPUT_LINES,
		maxBytes: MAX_OUTPUT_BYTES,
	});
	return output.truncated ? `[Earlier output truncated]\n${output.content}` : output.content;
}

function executionFailure(error: unknown): ExecResult {
	return {
		stdout: "",
		stderr: error instanceof Error ? error.message : String(error),
		code: 1,
		killed: false,
	};
}

export default function taskContract(pi: ExtensionAPI): void {
	let state: ContractState = { kind: "disabled" };
	let pending = false;
	let attempts = 0;
	let running = false;

	async function git(
		args: string[],
		cwd: string,
	): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
		return pi.exec("git", args, { cwd, timeout: 5_000 });
	}

	async function readChangedPaths(repositoryRoot: string): Promise<Set<string>> {
		const result = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repositoryRoot);
		if (result.code !== 0 || result.killed) {
			throw new Error(result.stderr.trim() || "git status failed");
		}
		return parseTaskContractStatus(result.stdout);
	}

	async function evaluateWorkspace(contract: ReadyState): Promise<{ changedPaths: string[]; violations: string[] }> {
		const violations: string[] = [];
		const currentConfigRevision = computeFileRevision(
			readFileSync(join(contract.baseline.repositoryRoot, CONFIG_PATH)),
		);
		if (currentConfigRevision !== contract.configRevision) {
			violations.push(`${CONFIG_PATH} changed after the task baseline`);
		}

		const headResult = await git(["rev-parse", "HEAD"], contract.baseline.repositoryRoot);
		if (headResult.code !== 0 || headResult.killed || headResult.stdout.trim() !== contract.baseline.head) {
			violations.push("Git HEAD changed after the task baseline");
		}

		const changedPaths = [...(await readChangedPaths(contract.baseline.repositoryRoot))].sort();
		if (changedPaths.length < contract.config.minChangedFiles) {
			violations.push(
				`changed file count ${changedPaths.length} is below minimum ${contract.config.minChangedFiles}`,
			);
		}
		if (changedPaths.length > contract.config.maxChangedFiles) {
			violations.push(
				`changed file count ${changedPaths.length} exceeds maximum ${contract.config.maxChangedFiles}`,
			);
		}

		const outOfScope = changedPaths.filter((path) => path === CONFIG_PATH || !isPathAllowed(contract.config, path));
		if (outOfScope.length > 0) {
			const displayed = outOfScope.slice(0, MAX_REPORTED_PATHS);
			const suffix = outOfScope.length > displayed.length ? ` and ${outOfScope.length - displayed.length} more` : "";
			violations.push(`out-of-scope changed paths: ${displayed.join(", ")}${suffix}`);
		}

		return { changedPaths, violations };
	}

	async function initialize(ctx: ExtensionContext): Promise<ContractState> {
		if (!ctx.isProjectTrusted()) return { kind: "invalid", reason: "project is not trusted" };

		const rootResult = await git(["rev-parse", "--show-toplevel"], ctx.cwd);
		if (rootResult.code !== 0 || rootResult.killed) {
			return { kind: "invalid", reason: "task contracts require a Git repository" };
		}
		const repositoryRoot = canonicalizePath(rootResult.stdout.trim());
		if (!repositoryRoot) {
			return { kind: "invalid", reason: "unable to canonicalize the Git repository root" };
		}
		const configPath = join(repositoryRoot, CONFIG_PATH);

		let config: TaskContractConfig;
		let configRevision: string;
		try {
			const configContent = readFileSync(configPath);
			configRevision = computeFileRevision(configContent);
			config = parseTaskContractConfig(JSON.parse(configContent.toString("utf8")));
		} catch (error) {
			return {
				kind: "invalid",
				reason: `invalid ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const headResult = await git(["rev-parse", "HEAD"], repositoryRoot);
		const head = headResult.stdout.trim();
		if (headResult.code !== 0 || headResult.killed || !HASH_PATTERN.test(head)) {
			return { kind: "invalid", reason: "unable to capture the Git HEAD baseline" };
		}

		const existing = findBaseline(ctx.sessionManager.getBranch());
		if (existing) {
			if (existing.repositoryRoot !== repositoryRoot) {
				return { kind: "invalid", reason: "session task contract belongs to another repository" };
			}
			if (existing.configRevision !== configRevision) {
				return { kind: "invalid", reason: `${CONFIG_PATH} changed after the task baseline` };
			}
			if (existing.head !== head) {
				return { kind: "invalid", reason: "Git HEAD changed after the task baseline" };
			}
			return { kind: "ready", config, configRevision, baseline: existing };
		}

		let changedPaths: Set<string>;
		try {
			changedPaths = await readChangedPaths(repositoryRoot);
		} catch (error) {
			return {
				kind: "invalid",
				reason: `unable to capture the clean Git baseline: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (changedPaths.size > 0) {
			return {
				kind: "invalid",
				reason: `task contracts require a clean Git baseline; found ${changedPaths.size} changed path(s)`,
			};
		}

		const baseline: BaselineData = {
			version: 1,
			kind: "baseline",
			repositoryRoot,
			configRevision,
			head,
			createdAt: new Date().toISOString(),
		};
		pi.appendEntry(CUSTOM_TYPE, baseline);
		return { kind: "ready", config, configRevision, baseline };
	}

	pi.registerFlag("task-contract", {
		description: `Enforce the trusted ${CONFIG_PATH} scope and completion checks`,
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		pending = false;
		attempts = 0;
		running = false;
		state = pi.getFlag("task-contract") === true ? await initialize(ctx) : { kind: "disabled" };

		if (state.kind === "invalid") {
			if (ctx.hasUI) ctx.ui.notify(`task-contract: ${state.reason}`, "error");
			return;
		}
		if (state.kind === "ready") {
			try {
				pending = (await readChangedPaths(state.baseline.repositoryRoot)).size > 0;
			} catch (error) {
				state = {
					kind: "invalid",
					reason: `unable to inspect task changes: ${error instanceof Error ? error.message : String(error)}`,
				};
				if (ctx.hasUI) ctx.ui.notify(`task-contract: ${state.reason}`, "error");
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (state.kind === "disabled") return;
		if (state.kind === "invalid") {
			return {
				systemPrompt: `${event.systemPrompt}

## Task contract unavailable

The explicitly enabled task contract is unavailable: ${state.reason}. Built-in mutation-capable tools are blocked. Resolve the contract or repository baseline with the user before changing files.`,
			};
		}

		const checks = state.config.checks.map((check) => `- ${check.id}: ${formatCommand(check)}`).join("\n");
		return {
			systemPrompt: `${event.systemPrompt}

## Enforced task contract

Repository-relative allowed paths: ${state.config.allowedPaths.join(", ")}
Denied paths: ${state.config.deniedPaths.length > 0 ? state.config.deniedPaths.join(", ") : "(none)"}
Required changed-file count: ${state.config.minChangedFiles}-${state.config.maxChangedFiles}
Completion checks:
${checks}

Built-in edit and write calls are checked before execution. Bash changes are checked against the complete Git change set before completion, so do not use bash to bypass path policy. Do not change ${CONFIG_PATH} or Git HEAD.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const mutationCapable =
			isToolCallEventType("bash", event) ||
			isToolCallEventType("edit", event) ||
			isToolCallEventType("write", event);
		if (!mutationCapable || state.kind === "disabled") return;
		if (state.kind === "invalid") {
			return { block: true, reason: `Task contract unavailable: ${state.reason}` };
		}
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;

		const path = toRepositoryRelativePath(state.baseline.repositoryRoot, ctx.cwd, event.input.path);
		if (!path) {
			return { block: true, reason: "Task contract blocks paths outside the Git repository" };
		}
		if (path === CONFIG_PATH) {
			return { block: true, reason: `Task contract blocks changes to ${CONFIG_PATH}` };
		}
		if (!isPathAllowed(state.config, path)) {
			return { block: true, reason: `Task contract blocks out-of-scope path "${path}"` };
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (
			state.kind !== "ready" ||
			event.isError ||
			(!isBashToolResult(event) && !isEditToolResult(event) && !isWriteToolResult(event))
		) {
			return;
		}
		if (!pending) {
			pending = true;
			attempts = 0;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (state.kind !== "ready" || !pending || running) return;
		const contract = state;
		running = true;
		attempts++;

		const violations: string[] = [];
		const checkEvidence: CheckEvidence[] = [];
		const failureOutputs: string[] = [];
		let changedPaths: string[] = [];

		try {
			const preflight = await evaluateWorkspace(contract);
			changedPaths = preflight.changedPaths;
			violations.push(...preflight.violations);

			if (violations.length === 0) {
				for (const check of contract.config.checks) {
					let result: ExecResult;
					try {
						result = await pi.exec(check.command, check.args, {
							cwd: contract.baseline.repositoryRoot,
							timeout: check.timeoutMs,
						});
					} catch (error) {
						result = executionFailure(error);
					}
					checkEvidence.push({ id: check.id, code: result.code, killed: result.killed });
					if (result.killed || result.code !== 0) {
						violations.push(`check ${check.id} failed with ${result.killed ? "timeout" : `exit ${result.code}`}`);
						failureOutputs.push(formatFailureOutput(check, result));
					}
				}

				const postflight = await evaluateWorkspace(contract);
				if (postflight.changedPaths.join("\0") !== changedPaths.join("\0")) {
					violations.push("verification checks changed the Git workspace");
				}
				for (const violation of postflight.violations) {
					if (!violations.includes(violation)) violations.push(violation);
				}
				changedPaths = postflight.changedPaths;
			}
		} catch (error) {
			violations.push(`contract evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			running = false;
		}

		const recordedPaths = changedPaths.slice(0, MAX_REPORTED_PATHS);
		const passed = violations.length === 0;
		const attemptData: AttemptData = {
			version: 1,
			kind: "attempt",
			status: passed ? "pass" : "fail",
			baselineHead: contract.baseline.head,
			changedPathCount: changedPaths.length,
			changedPaths: recordedPaths,
			pathsTruncated: recordedPaths.length < changedPaths.length,
			violations,
			checks: checkEvidence,
			attempt: attempts,
			completedAt: new Date().toISOString(),
		};
		pi.appendEntry(CUSTOM_TYPE, attemptData);

		if (passed) {
			pending = false;
			attempts = 0;
			ctx.ui.notify(
				`task-contract: passed for ${changedPaths.length} changed path(s) and ${checkEvidence.length} check(s)`,
				"info",
			);
			return;
		}

		const failure = `Task contract attempt ${attempts}/${contract.config.maxAttempts} failed:\n${violations
			.map((violation) => `- ${violation}`)
			.join("\n")}`;
		if (attempts >= contract.config.maxAttempts) {
			pending = false;
			ctx.ui.notify(`task-contract: ${failure}`, "error");
			return;
		}

		pi.sendUserMessage(
			`${failure}

Repair only changes made after this task's clean baseline. Keep Git HEAD and ${CONFIG_PATH} unchanged, then let the task contract run again.${failureOutputs.length > 0 ? `\n\n${failureOutputs.join("\n\n")}` : ""}`,
			{ deliverAs: "followUp" },
		);
	});
}
