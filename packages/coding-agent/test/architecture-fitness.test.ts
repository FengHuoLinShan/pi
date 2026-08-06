import { describe, expect, it } from "vitest";
import {
	type ArchitectureFitnessPlan,
	compareArchitectureFitness,
	evaluateArchitectureFitness,
	parseArchitectureFitnessConfig,
} from "../src/core/architecture-fitness.ts";
import {
	type CodeGraphExtraction,
	computeCodeGraphFileRevision,
	IncrementalCodeGraph,
} from "../src/core/code-graph.ts";

interface TestFile {
	path: string;
	nodeId: string;
	dependencies?: readonly string[];
}

function buildGraph(files: readonly TestFile[]): IncrementalCodeGraph {
	const graph = new IncrementalCodeGraph();
	for (const file of files) {
		const extraction: CodeGraphExtraction = {
			nodes: [{ id: file.nodeId, kind: "module", name: file.nodeId }],
			edges: (file.dependencies ?? []).map((target, index) => ({
				id: `${file.nodeId}:imports:${index}`,
				kind: "imports",
				from: file.nodeId,
				to: target,
			})),
		};
		graph.upsertFile({
			path: file.path,
			previousRevision: null,
			revision: computeCodeGraphFileRevision(JSON.stringify(file)),
			extraction,
		});
	}
	return graph;
}

function plan(baselineViolationIds: readonly string[] = []): ArchitectureFitnessPlan {
	return {
		...parseArchitectureFitnessConfig({
			version: 1,
			rules: [
				{
					id: "core-must-not-use-ui",
					kind: "forbidden-dependency",
					from: ["src/core/**"],
					to: ["src/ui/**"],
				},
				{
					id: "ui-boundary",
					kind: "dependency-boundary",
					severity: "warning",
					from: ["src/ui/**"],
					allow: ["src/shared/**"],
				},
				{
					id: "layer-cycles",
					kind: "acyclic",
					paths: ["src/core/**", "src/ui/**"],
				},
				{
					id: "core-fan-in",
					kind: "max-file-dependents",
					severity: "warning",
					paths: ["src/core/**"],
					limit: 1,
				},
			],
			baselineViolationIds,
		}),
		configPath: "/workspace/.pi/architecture.json",
		configRevision: "sha256:config",
	};
}

const filesWithoutCycle: readonly TestFile[] = [
	{ path: "src/core/a.ts", nodeId: "core-a" },
	{ path: "src/ui/a.ts", nodeId: "ui-a", dependencies: ["core-a"] },
	{ path: "src/feature/a.ts", nodeId: "feature-a", dependencies: ["core-a"] },
];

const filesWithCycle: readonly TestFile[] = [
	{ path: "src/core/a.ts", nodeId: "core-a", dependencies: ["ui-a"] },
	{ path: "src/ui/a.ts", nodeId: "ui-a", dependencies: ["core-a"] },
	{ path: "src/feature/a.ts", nodeId: "feature-a", dependencies: ["core-a"] },
];

describe("architecture fitness", () => {
	it("evaluates deterministic boundary, cycle, and fan-in violations", () => {
		const graph = buildGraph(filesWithCycle);
		const first = evaluateArchitectureFitness(plan(), graph.snapshot());
		const second = evaluateArchitectureFitness(plan(), graph.snapshot());

		expect(first).toEqual(second);
		expect(first.status).toBe("fail");
		expect(first.rules).toEqual([
			expect.objectContaining({ ruleId: "core-must-not-use-ui", status: "fail", violationCount: 1 }),
			expect.objectContaining({ ruleId: "ui-boundary", status: "warning", violationCount: 1 }),
			expect.objectContaining({ ruleId: "layer-cycles", status: "fail", violationCount: 1 }),
			expect.objectContaining({ ruleId: "core-fan-in", status: "warning", violationCount: 1 }),
		]);
		expect(
			first.rules.flatMap((rule) => rule.violations).every((violation) => violation.id.startsWith("sha256:")),
		).toBe(true);
	});

	it("suppresses only matching baseline violations and compares regressions", () => {
		const previous = evaluateArchitectureFitness(plan(), buildGraph(filesWithoutCycle).snapshot());
		const current = evaluateArchitectureFitness(plan(), buildGraph(filesWithCycle).snapshot());
		const comparison = compareArchitectureFitness(previous, current);

		expect(comparison.regressed).toBe(true);
		expect(comparison.newViolationIds).toHaveLength(2);
		expect(comparison.resolvedViolationIds).toEqual([]);

		const forbiddenId = current.rules[0].violations[0].id;
		const suppressed = evaluateArchitectureFitness(plan([forbiddenId]), buildGraph(filesWithCycle).snapshot());
		expect(suppressed.rules[0]).toMatchObject({ status: "pass", violationCount: 0, suppressedCount: 1 });
		expect(suppressed.rules[2].status).toBe("fail");
	});

	it("detects self-dependencies and changes a cycle baseline when its component changes", () => {
		const selfCycle = buildGraph([{ path: "src/core/a.ts", nodeId: "core-a", dependencies: ["core-a"] }]);
		const selfReport = evaluateArchitectureFitness(plan(), selfCycle.snapshot());
		expect(selfReport.rules[2]).toMatchObject({ status: "fail", violationCount: 1 });

		const original = evaluateArchitectureFitness(
			plan(),
			buildGraph([
				{ path: "src/core/a.ts", nodeId: "core-a", dependencies: ["core-b"] },
				{ path: "src/core/b.ts", nodeId: "core-b", dependencies: ["core-a"] },
			]).snapshot(),
		);
		const baselineId = original.rules[2].violations[0].id;
		const expanded = evaluateArchitectureFitness(
			plan([baselineId]),
			buildGraph([
				{ path: "src/core/a.ts", nodeId: "core-a", dependencies: ["core-b", "core-c"] },
				{ path: "src/core/b.ts", nodeId: "core-b", dependencies: ["core-a"] },
				{ path: "src/core/c.ts", nodeId: "core-c", dependencies: ["core-a"] },
			]).snapshot(),
		);
		expect(expanded.rules[2]).toMatchObject({ status: "fail", violationCount: 1, suppressedCount: 0 });
		expect(expanded.rules[2].violations[0].id).not.toBe(baselineId);
	});

	it("rejects unknown fields, duplicate rule ids, and sparse configuration arrays", () => {
		expect(() =>
			parseArchitectureFitnessConfig({
				version: 1,
				rules: [{ id: "valid", kind: "acyclic", paths: ["src/**"], unknown: true }],
			}),
		).toThrow(/unknown/);
		expect(() =>
			parseArchitectureFitnessConfig({
				version: 1,
				rules: [
					{ id: "duplicate", kind: "acyclic", paths: ["src/**"] },
					{ id: "duplicate", kind: "acyclic", paths: ["test/**"] },
				],
			}),
		).toThrow(/unique/);
		const sparseRules = new Array<unknown>(1);
		expect(() => parseArchitectureFitnessConfig({ version: 1, rules: sparseRules })).toThrow(/dense/);
	});

	it("does not hide active violations when report details exceed the limit", () => {
		const files: TestFile[] = [{ path: "src/ui/target.ts", nodeId: "ui-target" }];
		for (let index = 0; index <= 2_000; index++) {
			files.push({
				path: `src/core/source-${index.toString().padStart(4, "0")}.ts`,
				nodeId: `core-source-${index}`,
				dependencies: ["ui-target"],
			});
		}
		const graph = buildGraph(files);
		const initial = evaluateArchitectureFitness(plan(), graph.snapshot());
		const baseline = initial.rules[0].violations.map((entry) => entry.id);
		const report = evaluateArchitectureFitness(plan(baseline), graph.snapshot());

		expect(report.rules[0]).toMatchObject({ status: "fail", violationCount: 1, suppressedCount: 2_000 });
		expect(report.rules[0].violations).toHaveLength(2_000);
		expect(report.rules[0].violations[0].suppressed).toBe(false);
	});
});
