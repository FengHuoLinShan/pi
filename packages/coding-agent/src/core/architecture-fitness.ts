import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type { CodeGraphEdge, CodeGraphSnapshot } from "./code-graph.ts";
import { IncrementalCodeGraph } from "./code-graph.ts";
import { loadVerifiedProjectFile } from "./verified-project-file.ts";

export const ARCHITECTURE_FITNESS_CONFIG_PATH = ".pi/architecture.json";
export const ARCHITECTURE_FITNESS_REPORT_VERSION = 1 as const;

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_RULES = 200;
const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 512;
const MAX_VIOLATIONS = 2_000;
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type ArchitectureFitnessSeverity = "error" | "warning";
export type ArchitectureFitnessStatus = "pass" | "warning" | "fail";

interface ArchitectureFitnessRuleBase {
	readonly id: string;
	readonly severity: ArchitectureFitnessSeverity;
	readonly edgeKinds?: readonly string[];
}

export interface ForbiddenDependencyRule extends ArchitectureFitnessRuleBase {
	readonly kind: "forbidden-dependency";
	readonly from: readonly string[];
	readonly to: readonly string[];
}

export interface DependencyBoundaryRule extends ArchitectureFitnessRuleBase {
	readonly kind: "dependency-boundary";
	readonly from: readonly string[];
	readonly allow: readonly string[];
	readonly allowExternal: boolean;
}

export interface AcyclicArchitectureRule extends ArchitectureFitnessRuleBase {
	readonly kind: "acyclic";
	readonly paths: readonly string[];
}

export interface MaxFileDependentsRule extends ArchitectureFitnessRuleBase {
	readonly kind: "max-file-dependents";
	readonly paths: readonly string[];
	readonly limit: number;
}

export type ArchitectureFitnessRule =
	| ForbiddenDependencyRule
	| DependencyBoundaryRule
	| AcyclicArchitectureRule
	| MaxFileDependentsRule;

export interface ArchitectureFitnessConfig {
	readonly version: 1;
	readonly rules: readonly ArchitectureFitnessRule[];
	readonly baselineViolationIds: readonly string[];
}

export interface ArchitectureFitnessPlan extends ArchitectureFitnessConfig {
	readonly configPath: string;
	readonly configRevision: string;
}

export interface ArchitectureFitnessViolation {
	readonly id: string;
	readonly ruleId: string;
	readonly severity: ArchitectureFitnessSeverity;
	readonly kind: ArchitectureFitnessRule["kind"];
	readonly summary: string;
	readonly paths: readonly string[];
	readonly edgeKind?: string;
	readonly suppressed: boolean;
}

export interface ArchitectureFitnessRuleResult {
	readonly ruleId: string;
	readonly kind: ArchitectureFitnessRule["kind"];
	readonly severity: ArchitectureFitnessSeverity;
	readonly status: ArchitectureFitnessStatus;
	readonly violationCount: number;
	readonly suppressedCount: number;
	readonly violations: readonly ArchitectureFitnessViolation[];
}

export interface ArchitectureFitnessReport {
	readonly version: typeof ARCHITECTURE_FITNESS_REPORT_VERSION;
	readonly id: string;
	readonly configRevision: string;
	readonly graphGeneration: number;
	readonly status: ArchitectureFitnessStatus;
	readonly violationCount: number;
	readonly suppressedCount: number;
	readonly rules: readonly ArchitectureFitnessRuleResult[];
}

export interface ArchitectureFitnessComparison {
	readonly fromReportId: string;
	readonly toReportId: string;
	readonly newViolationIds: readonly string[];
	readonly resolvedViolationIds: readonly string[];
	readonly unchangedViolationIds: readonly string[];
	readonly regressed: boolean;
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
	const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknown) throw new Error(`unknown ${label} field: ${unknown}`);
}

function parsePatterns(value: unknown, label: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_PATTERNS ||
		!value.every(
			(pattern) => typeof pattern === "string" && pattern.trim() !== "" && pattern.length <= MAX_PATTERN_LENGTH,
		)
	) {
		throw new Error(`${label} must contain between 1 and ${MAX_PATTERNS} non-empty glob patterns`);
	}
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new Error(`${label} must be dense`);
	}
	const patterns = [...new Set(value as string[])].sort(compareStrings);
	for (const pattern of patterns) {
		if (pattern.includes("\0") || pattern.startsWith("/") || pattern.startsWith("../")) {
			throw new Error(`${label} must contain workspace-relative glob patterns`);
		}
		if (!minimatch.makeRe(pattern, { dot: true, nonegate: true, nocomment: true })) {
			throw new Error(`${label} contains an invalid glob: ${pattern}`);
		}
	}
	return patterns;
}

function parseEdgeKinds(value: unknown, label: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_PATTERNS ||
		!value.every((kind) => typeof kind === "string" && kind.trim() !== "" && kind.length <= MAX_PATTERN_LENGTH)
	) {
		throw new Error(`${label} must contain non-empty edge kinds`);
	}
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new Error(`${label} must be dense`);
	}
	return [...new Set(value as string[])].sort(compareStrings);
}

function parseRule(value: unknown, index: number): ArchitectureFitnessRule {
	const label = `rules[${index}]`;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (typeof value.id !== "string" || value.id.length > MAX_ID_LENGTH || !ID_PATTERN.test(value.id)) {
		throw new Error(`${label}.id must be a portable identifier`);
	}
	const severity = value.severity ?? "error";
	if (severity !== "error" && severity !== "warning") throw new Error(`${label}.severity is invalid`);
	const edgeKinds = parseEdgeKinds(value.edgeKinds, `${label}.edgeKinds`);
	if (value.kind === "forbidden-dependency") {
		assertAllowedKeys(value, ["id", "kind", "severity", "edgeKinds", "from", "to"], label);
		return {
			id: value.id,
			kind: value.kind,
			severity,
			from: parsePatterns(value.from, `${label}.from`),
			to: parsePatterns(value.to, `${label}.to`),
			...(edgeKinds ? { edgeKinds } : {}),
		};
	}
	if (value.kind === "dependency-boundary") {
		assertAllowedKeys(value, ["id", "kind", "severity", "edgeKinds", "from", "allow", "allowExternal"], label);
		if (value.allowExternal !== undefined && typeof value.allowExternal !== "boolean") {
			throw new Error(`${label}.allowExternal must be a boolean`);
		}
		return {
			id: value.id,
			kind: value.kind,
			severity,
			from: parsePatterns(value.from, `${label}.from`),
			allow: parsePatterns(value.allow, `${label}.allow`),
			allowExternal: value.allowExternal ?? true,
			...(edgeKinds ? { edgeKinds } : {}),
		};
	}
	if (value.kind === "acyclic") {
		assertAllowedKeys(value, ["id", "kind", "severity", "edgeKinds", "paths"], label);
		return {
			id: value.id,
			kind: value.kind,
			severity,
			paths: parsePatterns(value.paths, `${label}.paths`),
			...(edgeKinds ? { edgeKinds } : {}),
		};
	}
	if (value.kind === "max-file-dependents") {
		assertAllowedKeys(value, ["id", "kind", "severity", "edgeKinds", "paths", "limit"], label);
		if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 0 || (value.limit as number) > 100_000) {
			throw new Error(`${label}.limit must be a non-negative bounded integer`);
		}
		return {
			id: value.id,
			kind: value.kind,
			severity,
			paths: parsePatterns(value.paths, `${label}.paths`),
			limit: value.limit as number,
			...(edgeKinds ? { edgeKinds } : {}),
		};
	}
	throw new Error(`${label}.kind is invalid`);
}

export function parseArchitectureFitnessConfig(value: unknown): ArchitectureFitnessConfig {
	if (!isRecord(value)) throw new Error("architecture fitness config must be an object");
	assertAllowedKeys(value, ["version", "rules", "baselineViolationIds"], "architecture fitness config");
	if (value.version !== 1) throw new Error("architecture fitness config version must be 1");
	if (!Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > MAX_RULES) {
		throw new Error(`rules must contain between 1 and ${MAX_RULES} entries`);
	}
	for (let index = 0; index < value.rules.length; index++) {
		if (!(index in value.rules)) throw new Error("rules must be dense");
	}
	const rules = value.rules.map(parseRule);
	if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
		throw new Error("architecture fitness rule ids must be unique");
	}
	const baseline = value.baselineViolationIds ?? [];
	if (
		!Array.isArray(baseline) ||
		baseline.length > MAX_VIOLATIONS ||
		!baseline.every((id) => typeof id === "string" && /^sha256:[0-9a-f]{64}$/.test(id))
	) {
		throw new Error("baselineViolationIds must contain bounded SHA-256 violation ids");
	}
	for (let index = 0; index < baseline.length; index++) {
		if (!(index in baseline)) throw new Error("baselineViolationIds must be dense");
	}
	return {
		version: 1,
		rules,
		baselineViolationIds: [...new Set(baseline as string[])].sort(compareStrings),
	};
}

export async function loadArchitectureFitnessPlan(sourceRoot: string): Promise<ArchitectureFitnessPlan | undefined> {
	const file = await loadVerifiedProjectFile(sourceRoot, ARCHITECTURE_FITNESS_CONFIG_PATH, MAX_CONFIG_BYTES);
	if (!file) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.content.toString("utf8"));
	} catch (error) {
		throw new Error(
			`${ARCHITECTURE_FITNESS_CONFIG_PATH} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		...parseArchitectureFitnessConfig(parsed),
		configPath: file.path,
		configRevision: file.revision,
	};
}

function matches(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) =>
		minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true, optimizationLevel: 2 }),
	);
}

function edgeAllowed(rule: ArchitectureFitnessRule, edge: CodeGraphEdge): boolean {
	return !rule.edgeKinds || rule.edgeKinds.includes(edge.kind);
}

function violation(
	rule: ArchitectureFitnessRule,
	summary: string,
	paths: readonly string[],
	baseline: ReadonlySet<string>,
	edgeKind?: string,
	identityDetails?: unknown,
): ArchitectureFitnessViolation {
	const identity = JSON.stringify({ ruleId: rule.id, kind: rule.kind, paths, edgeKind, identityDetails });
	const id = `sha256:${createHash("sha256").update(identity).digest("hex")}`;
	return {
		id,
		ruleId: rule.id,
		severity: rule.severity,
		kind: rule.kind,
		summary,
		paths,
		...(edgeKind ? { edgeKind } : {}),
		suppressed: baseline.has(id),
	};
}

function edgeRuleViolations(
	rule: ForbiddenDependencyRule | DependencyBoundaryRule,
	snapshot: CodeGraphSnapshot,
	nodeOwners: ReadonlyMap<string, string>,
	baseline: ReadonlySet<string>,
): ArchitectureFitnessViolation[] {
	const violations: ArchitectureFitnessViolation[] = [];
	for (const edge of snapshot.edges) {
		if (!edgeAllowed(rule, edge) || !matches(edge.filePath, rule.from)) continue;
		const targetPath = nodeOwners.get(edge.to);
		if (rule.kind === "forbidden-dependency") {
			if (!targetPath || !matches(targetPath, rule.to)) continue;
			violations.push(
				violation(
					rule,
					`${edge.filePath} must not depend on ${targetPath}`,
					[edge.filePath, targetPath],
					baseline,
					edge.kind,
				),
			);
			continue;
		}
		if (!targetPath) {
			if (!rule.allowExternal) {
				violations.push(
					violation(
						rule,
						`${edge.filePath} has an unresolved external dependency`,
						[edge.filePath, "<external>"],
						baseline,
						edge.kind,
					),
				);
			}
			continue;
		}
		if (matches(targetPath, rule.from) || matches(targetPath, rule.allow)) continue;
		violations.push(
			violation(
				rule,
				`${edge.filePath} crosses its dependency boundary into ${targetPath}`,
				[edge.filePath, targetPath],
				baseline,
				edge.kind,
			),
		);
	}
	return violations;
}

function cycleViolations(
	rule: AcyclicArchitectureRule,
	snapshot: CodeGraphSnapshot,
	nodeOwners: ReadonlyMap<string, string>,
	baseline: ReadonlySet<string>,
): ArchitectureFitnessViolation[] {
	const adjacency = new Map<string, Set<string>>();
	const graphEdges: Array<{ source: string; target: string; kind: string }> = [];
	for (const edge of snapshot.edges) {
		if (!edgeAllowed(rule, edge)) continue;
		const target = nodeOwners.get(edge.to);
		if (!target || !matches(edge.filePath, rule.paths) || !matches(target, rule.paths)) {
			continue;
		}
		const targets = adjacency.get(edge.filePath) ?? new Set<string>();
		targets.add(target);
		adjacency.set(edge.filePath, targets);
		if (!adjacency.has(target)) adjacency.set(target, new Set());
		graphEdges.push({ source: edge.filePath, target, kind: edge.kind });
	}

	let nextIndex = 0;
	const indices = new Map<string, number>();
	const lowlinks = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const components: string[][] = [];
	const visit = (path: string): void => {
		const index = nextIndex++;
		indices.set(path, index);
		lowlinks.set(path, index);
		stack.push(path);
		onStack.add(path);
		for (const target of [...(adjacency.get(path) ?? [])].sort(compareStrings)) {
			if (!indices.has(target)) {
				visit(target);
				lowlinks.set(path, Math.min(lowlinks.get(path)!, lowlinks.get(target)!));
			} else if (onStack.has(target)) {
				lowlinks.set(path, Math.min(lowlinks.get(path)!, indices.get(target)!));
			}
		}
		if (lowlinks.get(path) !== indices.get(path)) return;
		const component: string[] = [];
		while (stack.length > 0) {
			const member = stack.pop()!;
			onStack.delete(member);
			component.push(member);
			if (member === path) break;
		}
		components.push(component.sort(compareStrings));
	};
	for (const path of [...adjacency.keys()].sort(compareStrings)) {
		if (!indices.has(path)) visit(path);
	}
	return components
		.filter(
			(component) =>
				component.length > 1 ||
				graphEdges.some((edge) => edge.source === component[0] && edge.target === component[0]),
		)
		.map((component) => {
			const componentSet = new Set(component);
			const internalEdges = graphEdges
				.filter((edge) => componentSet.has(edge.source) && componentSet.has(edge.target))
				.map((edge) => `${edge.source}\0${edge.target}\0${edge.kind}`)
				.sort(compareStrings);
			const paths = [...component, component[0]!];
			return violation(rule, `Dependency cycle component: ${component.join(" <-> ")}`, paths, baseline, undefined, {
				internalEdges,
			});
		});
}

function dependentViolations(
	rule: MaxFileDependentsRule,
	snapshot: CodeGraphSnapshot,
	nodeOwners: ReadonlyMap<string, string>,
	baseline: ReadonlySet<string>,
): ArchitectureFitnessViolation[] {
	const dependents = new Map<string, Set<string>>();
	for (const edge of snapshot.edges) {
		if (!edgeAllowed(rule, edge)) continue;
		const target = nodeOwners.get(edge.to);
		if (!target || !matches(target, rule.paths) || target === edge.filePath) continue;
		const sources = dependents.get(target) ?? new Set<string>();
		sources.add(edge.filePath);
		dependents.set(target, sources);
	}
	const violations: ArchitectureFitnessViolation[] = [];
	for (const [path, sources] of [...dependents.entries()].sort(([left], [right]) => compareStrings(left, right))) {
		if (sources.size <= rule.limit) continue;
		violations.push(
			violation(
				rule,
				`${path} has ${sources.size} dependent files; limit is ${rule.limit}`,
				[path, ...[...sources].sort(compareStrings)],
				baseline,
			),
		);
	}
	return violations;
}

function ruleStatus(
	rule: ArchitectureFitnessRule,
	violations: readonly ArchitectureFitnessViolation[],
): ArchitectureFitnessStatus {
	const active = violations.filter((entry) => !entry.suppressed);
	if (active.length === 0) return "pass";
	return rule.severity === "error" ? "fail" : "warning";
}

function normalizeViolations(violations: readonly ArchitectureFitnessViolation[]): ArchitectureFitnessViolation[] {
	const unique = new Map<string, ArchitectureFitnessViolation>();
	for (const entry of violations) unique.set(entry.id, entry);
	return [...unique.values()].sort((left, right) => compareStrings(left.id, right.id));
}

export function evaluateArchitectureFitness(
	plan: ArchitectureFitnessPlan,
	value: CodeGraphSnapshot,
): ArchitectureFitnessReport {
	const snapshot = IncrementalCodeGraph.restore(value).snapshot();
	const baseline = new Set(plan.baselineViolationIds);
	const nodeOwners = new Map(snapshot.nodes.map((node) => [node.id, node.filePath]));
	const rules = plan.rules.map((rule): ArchitectureFitnessRuleResult => {
		let violations: ArchitectureFitnessViolation[];
		switch (rule.kind) {
			case "forbidden-dependency":
			case "dependency-boundary":
				violations = edgeRuleViolations(rule, snapshot, nodeOwners, baseline);
				break;
			case "acyclic":
				violations = cycleViolations(rule, snapshot, nodeOwners, baseline);
				break;
			case "max-file-dependents":
				violations = dependentViolations(rule, snapshot, nodeOwners, baseline);
				break;
		}
		violations = normalizeViolations(violations);
		const reportedViolations = [...violations]
			.sort((left, right) => Number(left.suppressed) - Number(right.suppressed) || compareStrings(left.id, right.id))
			.slice(0, MAX_VIOLATIONS);
		return {
			ruleId: rule.id,
			kind: rule.kind,
			severity: rule.severity,
			status: ruleStatus(rule, violations),
			violationCount: violations.filter((entry) => !entry.suppressed).length,
			suppressedCount: violations.filter((entry) => entry.suppressed).length,
			violations: reportedViolations,
		};
	});
	const status: ArchitectureFitnessStatus = rules.some((rule) => rule.status === "fail")
		? "fail"
		: rules.some((rule) => rule.status === "warning")
			? "warning"
			: "pass";
	const content = {
		version: ARCHITECTURE_FITNESS_REPORT_VERSION,
		configRevision: plan.configRevision,
		graphGeneration: snapshot.generation,
		status,
		violationCount: rules.reduce((sum, rule) => sum + rule.violationCount, 0),
		suppressedCount: rules.reduce((sum, rule) => sum + rule.suppressedCount, 0),
		rules,
	};
	return {
		...content,
		id: `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`,
	};
}

export function compareArchitectureFitness(
	previous: ArchitectureFitnessReport,
	current: ArchitectureFitnessReport,
): ArchitectureFitnessComparison {
	const previousIds = new Set(
		previous.rules.flatMap((rule) => rule.violations.filter((entry) => !entry.suppressed).map((entry) => entry.id)),
	);
	const currentIds = new Set(
		current.rules.flatMap((rule) => rule.violations.filter((entry) => !entry.suppressed).map((entry) => entry.id)),
	);
	const newViolationIds = [...currentIds].filter((id) => !previousIds.has(id)).sort(compareStrings);
	const resolvedViolationIds = [...previousIds].filter((id) => !currentIds.has(id)).sort(compareStrings);
	const unchangedViolationIds = [...currentIds].filter((id) => previousIds.has(id)).sort(compareStrings);
	return {
		fromReportId: previous.id,
		toReportId: current.id,
		newViolationIds,
		resolvedViolationIds,
		unchangedViolationIds,
		regressed: newViolationIds.length > 0,
	};
}
