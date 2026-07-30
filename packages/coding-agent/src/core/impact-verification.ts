import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CompletionReport, CompletionStatus } from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";
import type { CodeGraphPath, CodeGraphSnapshot } from "./code-graph.ts";
import { IncrementalCodeGraph } from "./code-graph.ts";
import type { GoalCompletionCheck, GoalCompletionExecutor, GoalCompletionVerification } from "./goal-completion.ts";
import { verifyGoalCompletion } from "./goal-completion.ts";
import { loadVerifiedProjectFile } from "./verified-project-file.ts";

export const IMPACT_CHECK_CATALOG_PATH = ".pi/checks.json";

const MAX_CHECKS = 100;
const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 512;
const MAX_CONFIG_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type ImpactCheckSelectionMode = "always" | "direct" | "affected" | "fallback";
export type ImpactVerificationCoverage = "complete" | "fallback" | "uncovered";

export interface ImpactCheckSelection {
	readonly mode: ImpactCheckSelectionMode;
	readonly paths?: readonly string[];
}

export interface ImpactVerificationCheck extends GoalCompletionCheck {
	readonly selection: ImpactCheckSelection;
}

export interface ImpactVerificationCatalog {
	readonly version: 1;
	readonly checks: readonly ImpactVerificationCheck[];
}

export interface ImpactVerificationCatalogPlan {
	readonly configPath: string;
	readonly configRevision: string;
	readonly checks: readonly ImpactVerificationCheck[];
}

export interface CodeImpactMap {
	readonly graphGeneration: number;
	readonly changedFiles: readonly string[];
	readonly changedNodeIds: readonly string[];
	readonly affectedFiles: readonly string[];
	readonly affectedNodeIds: readonly string[];
	readonly paths: readonly CodeGraphPath[];
	readonly unindexedChangedFiles: readonly string[];
	readonly truncated: boolean;
}

export interface ImpactCheckReason {
	readonly kind:
		| "always"
		| "direct-path"
		| "affected-path"
		| "fallback-unindexed"
		| "fallback-uncovered"
		| "fallback-truncated";
	readonly paths: readonly string[];
}

export interface PlannedImpactCheck {
	readonly check: ImpactVerificationCheck;
	readonly reasons: readonly ImpactCheckReason[];
}

export interface ImpactVerificationPlan {
	readonly catalogRevision: string;
	readonly impact: CodeImpactMap;
	readonly coverage: ImpactVerificationCoverage;
	readonly selected: readonly PlannedImpactCheck[];
	readonly uncoveredFiles: readonly string[];
}

export interface ImpactEvidenceBundle {
	readonly version: 1;
	readonly id: string;
	readonly catalogRevision: string;
	readonly graphGeneration: number;
	readonly changedFiles: readonly string[];
	readonly affectedFiles: readonly string[];
	readonly unindexedChangedFiles: readonly string[];
	readonly selectedCheckIds: readonly string[];
	readonly coverage: ImpactVerificationCoverage;
	readonly uncoveredFiles: readonly string[];
	readonly completion?: CompletionReport;
}

export interface ImpactVerificationResult {
	readonly status: CompletionStatus;
	readonly plan: ImpactVerificationPlan;
	readonly verification?: GoalCompletionVerification;
	readonly evidence: ImpactEvidenceBundle;
	readonly reason?: string;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new Error(`unknown ${label} field: ${unknownKey}`);
}

function normalizeWorkspacePath(path: string): string {
	if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
		throw new Error("Impact path must be a non-empty workspace-relative string");
	}
	const portable = path.replaceAll("\\", "/");
	const normalized = posix.normalize(portable).replace(/^\.\//, "").replace(/\/$/, "");
	if (
		normalized === "" ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("/") ||
		normalized.startsWith("../") ||
		/^[A-Za-z]:\//.test(normalized)
	) {
		throw new Error(`Impact path must be workspace-relative: ${path}`);
	}
	return normalized;
}

function parsePatterns(value: unknown, label: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_PATTERNS ||
		!value.every(
			(pattern) => typeof pattern === "string" && pattern.length > 0 && pattern.length <= MAX_PATTERN_LENGTH,
		)
	) {
		throw new Error(`${label} must contain between 1 and ${MAX_PATTERNS} bounded glob patterns`);
	}
	const patterns = value.map((pattern) => pattern.replaceAll("\\", "/"));
	for (const pattern of patterns) {
		if (
			pattern.includes("\0") ||
			pattern.startsWith("/") ||
			pattern.startsWith("../") ||
			/^[A-Za-z]:\//.test(pattern)
		) {
			throw new Error(`${label} must contain workspace-relative glob patterns`);
		}
		try {
			minimatch.makeRe(pattern, { dot: true, nonegate: true, nocomment: true });
		} catch (error) {
			throw new Error(`${label} contains an invalid glob ${pattern}: ${String(error)}`);
		}
	}
	return [...new Set(patterns)].sort(compareStrings);
}

function parseSelection(value: unknown, index: number): ImpactCheckSelection {
	const label = `checks[${index}].selection`;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	assertAllowedKeys(value, ["mode", "paths"], label);
	if (value.mode !== "always" && value.mode !== "direct" && value.mode !== "affected" && value.mode !== "fallback") {
		throw new Error(`${label}.mode is invalid`);
	}
	if (value.mode === "always" || value.mode === "fallback") {
		if (value.paths !== undefined) throw new Error(`${label}.paths is not allowed for ${value.mode} checks`);
		return { mode: value.mode };
	}
	return { mode: value.mode, paths: parsePatterns(value.paths, `${label}.paths`) };
}

function parseCheck(value: unknown, index: number): ImpactVerificationCheck {
	const label = `checks[${index}]`;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	assertAllowedKeys(value, ["id", "command", "args", "timeoutMs", "selection"], label);
	if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
		throw new Error(`${label}.id must be a portable non-empty identifier`);
	}
	if (typeof value.command !== "string" || value.command.trim() === "") {
		throw new Error(`${label}.command must be a non-empty string`);
	}
	const args = value.args ?? [];
	if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string")) {
		throw new Error(`${label}.args must be an array of strings`);
	}
	for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
		if (!(argumentIndex in args)) throw new Error(`${label}.args must not contain sparse entries`);
	}
	const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > MAX_TIMEOUT_MS) {
		throw new Error(`${label}.timeoutMs must be a safe integer between 1000 and ${MAX_TIMEOUT_MS}`);
	}
	return {
		id: value.id,
		command: value.command,
		args: [...args],
		timeoutMs: timeoutMs as number,
		selection: parseSelection(value.selection, index),
	};
}

export function parseImpactVerificationCatalog(value: unknown): ImpactVerificationCatalog {
	if (!isRecord(value)) throw new Error("impact verification catalog must be an object");
	assertAllowedKeys(value, ["version", "checks"], "impact verification catalog");
	if (value.version !== 1) throw new Error("impact verification catalog version must be 1");
	if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > MAX_CHECKS) {
		throw new Error(`checks must contain between 1 and ${MAX_CHECKS} entries`);
	}
	for (let index = 0; index < value.checks.length; index++) {
		if (!(index in value.checks)) throw new Error("checks must not contain sparse entries");
	}
	const checks = value.checks.map(parseCheck);
	if (new Set(checks.map((check) => check.id)).size !== checks.length) {
		throw new Error("impact verification check ids must be unique");
	}
	return { version: 1, checks };
}

export async function loadImpactVerificationCatalog(
	sourceRoot: string,
): Promise<ImpactVerificationCatalogPlan | undefined> {
	const file = await loadVerifiedProjectFile(sourceRoot, IMPACT_CHECK_CATALOG_PATH, MAX_CONFIG_BYTES);
	if (!file) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.content.toString("utf8"));
	} catch (error) {
		throw new Error(
			`${IMPACT_CHECK_CATALOG_PATH} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const catalog = parseImpactVerificationCatalog(parsed);
	return {
		configPath: file.path,
		configRevision: file.revision,
		checks: catalog.checks,
	};
}

export function buildCodeImpactMap(
	snapshot: CodeGraphSnapshot,
	changedPaths: readonly string[],
	options: { maxDepth?: number; maxPaths?: number; edgeKinds?: readonly string[] } = {},
): CodeImpactMap {
	if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
		throw new Error("At least one changed path is required for impact verification");
	}
	const changedFiles = [...new Set(changedPaths.map(normalizeWorkspacePath))].sort(compareStrings);
	const graph = IncrementalCodeGraph.restore(snapshot);
	const changedNodeIds = snapshot.nodes
		.filter((node) => changedFiles.includes(node.filePath))
		.map((node) => node.id)
		.sort(compareStrings);
	const indexedChangedFiles = new Set(
		snapshot.nodes.filter((node) => changedNodeIds.includes(node.id)).map((node) => node.filePath),
	);
	const unindexedChangedFiles = changedFiles.filter((path) => !indexedChangedFiles.has(path));
	const query =
		changedNodeIds.length === 0
			? { paths: [], truncated: false }
			: graph.findImpactPaths(changedNodeIds, {
					maxDepth: options.maxDepth ?? 4,
					maxPaths: options.maxPaths ?? 1_000,
					edgeKinds: options.edgeKinds,
				});
	const nodeOwners = new Map(snapshot.nodes.map((node) => [node.id, node.filePath]));
	const affectedNodeIds = new Set(changedNodeIds);
	for (const path of query.paths) {
		for (const nodeId of path.nodeIds) affectedNodeIds.add(nodeId);
	}
	const affectedFiles = new Set(changedFiles);
	for (const nodeId of affectedNodeIds) {
		const owner = nodeOwners.get(nodeId);
		if (owner) affectedFiles.add(owner);
	}
	return {
		graphGeneration: snapshot.generation,
		changedFiles,
		changedNodeIds,
		affectedFiles: [...affectedFiles].sort(compareStrings),
		affectedNodeIds: [...affectedNodeIds].sort(compareStrings),
		paths: query.paths,
		unindexedChangedFiles,
		truncated: query.truncated,
	};
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) =>
		minimatch(path, pattern, {
			dot: true,
			nonegate: true,
			nocomment: true,
			optimizationLevel: 2,
		}),
	);
}

function checkReasons(check: ImpactVerificationCheck, impact: CodeImpactMap): ImpactCheckReason[] {
	if (check.selection.mode === "always") return [{ kind: "always", paths: [] }];
	if (check.selection.mode === "fallback") return [];
	const candidates = check.selection.mode === "direct" ? impact.changedFiles : impact.affectedFiles;
	const matched = candidates.filter((path) => matchesAny(path, check.selection.paths ?? []));
	if (matched.length === 0) return [];
	return [{ kind: check.selection.mode === "direct" ? "direct-path" : "affected-path", paths: matched }];
}

function coveredFiles(selected: readonly PlannedImpactCheck[], affectedFiles: readonly string[]): Set<string> {
	const covered = new Set<string>();
	for (const selectedCheck of selected) {
		const { selection } = selectedCheck.check;
		if (selection.mode === "always" || selection.mode === "fallback") {
			for (const path of affectedFiles) covered.add(path);
			continue;
		}
		for (const path of affectedFiles) {
			if (matchesAny(path, selection.paths ?? [])) covered.add(path);
		}
	}
	return covered;
}

export function planImpactVerification(
	catalog: ImpactVerificationCatalogPlan,
	impact: CodeImpactMap,
): ImpactVerificationPlan {
	const selected = catalog.checks
		.map((check): PlannedImpactCheck | undefined => {
			const reasons = checkReasons(check, impact);
			return reasons.length > 0 ? { check, reasons } : undefined;
		})
		.filter((value): value is PlannedImpactCheck => value !== undefined);
	const initiallyCovered = coveredFiles(selected, impact.affectedFiles);
	const initiallyUncovered = impact.affectedFiles.filter((path) => !initiallyCovered.has(path));
	const fallbackReasons: ImpactCheckReason[] = [];
	if (impact.truncated) fallbackReasons.push({ kind: "fallback-truncated", paths: [] });
	if (impact.unindexedChangedFiles.length > 0) {
		fallbackReasons.push({ kind: "fallback-unindexed", paths: impact.unindexedChangedFiles });
	}
	if (initiallyUncovered.length > 0) {
		fallbackReasons.push({ kind: "fallback-uncovered", paths: initiallyUncovered });
	}
	if (fallbackReasons.length > 0) {
		for (const check of catalog.checks) {
			if (check.selection.mode === "fallback") selected.push({ check, reasons: fallbackReasons });
		}
	}
	const covered = coveredFiles(selected, impact.affectedFiles);
	const uncoveredFiles = impact.affectedFiles.filter((path) => !covered.has(path));
	const usedFallback = selected.some((check) => check.check.selection.mode === "fallback");
	return {
		catalogRevision: catalog.configRevision,
		impact,
		coverage: uncoveredFiles.length > 0 ? "uncovered" : usedFallback ? "fallback" : "complete",
		selected,
		uncoveredFiles,
	};
}

function evidenceBundle(plan: ImpactVerificationPlan, completion?: CompletionReport): ImpactEvidenceBundle {
	const content = {
		version: 1 as const,
		catalogRevision: plan.catalogRevision,
		graphGeneration: plan.impact.graphGeneration,
		changedFiles: [...plan.impact.changedFiles],
		affectedFiles: [...plan.impact.affectedFiles],
		unindexedChangedFiles: [...plan.impact.unindexedChangedFiles],
		selectedCheckIds: plan.selected.map((selected) => selected.check.id),
		coverage: plan.coverage,
		uncoveredFiles: [...plan.uncoveredFiles],
		...(completion ? { completion } : {}),
	};
	return {
		...content,
		id: `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`,
	};
}

export async function verifyImpactPlan(
	objective: string,
	catalog: ImpactVerificationCatalogPlan,
	impact: CodeImpactMap,
	logicalRoot: string,
	execute: GoalCompletionExecutor,
	signal?: AbortSignal,
): Promise<ImpactVerificationResult> {
	const plan = planImpactVerification(catalog, impact);
	if (plan.coverage === "uncovered") {
		return {
			status: "blocked",
			plan,
			evidence: evidenceBundle(plan),
			reason: `No configured check covers: ${plan.uncoveredFiles.join(", ")}`,
		};
	}
	if (plan.selected.length === 0) {
		return {
			status: "blocked",
			plan,
			evidence: evidenceBundle(plan),
			reason: "Impact verification selected no checks",
		};
	}
	const verification = await verifyGoalCompletion(
		objective,
		{
			configPath: catalog.configPath,
			configRevision: catalog.configRevision,
			checks: plan.selected.map(({ check }) => ({
				id: check.id,
				command: check.command,
				args: check.args,
				timeoutMs: check.timeoutMs,
			})),
		},
		logicalRoot,
		execute,
		signal,
	);
	return {
		status: verification.report.status,
		plan,
		verification,
		evidence: evidenceBundle(plan, verification.report),
	};
}
