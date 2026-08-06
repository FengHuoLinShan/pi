import { describe, expect, it, vi } from "vitest";
import { computeCodeGraphFileRevision, IncrementalCodeGraph } from "../src/core/code-graph.ts";
import {
	buildCodeImpactMap,
	collectGitChangedPaths,
	getImpactGraphProvider,
	type ImpactVerificationCatalogPlan,
	parseGitChangedPaths,
	parseImpactVerificationCatalog,
	planImpactVerification,
	registerImpactGraphProvider,
	verifyImpactPlan,
} from "../src/core/impact-verification.ts";

function createSnapshot() {
	const graph = new IncrementalCodeGraph();
	graph.upsertFile({
		path: "src/a.ts",
		previousRevision: null,
		revision: computeCodeGraphFileRevision("a"),
		extraction: {
			nodes: [{ id: "a", kind: "function", name: "a" }],
			edges: [],
		},
	});
	graph.upsertFile({
		path: "src/b.ts",
		previousRevision: null,
		revision: computeCodeGraphFileRevision("b"),
		extraction: {
			nodes: [{ id: "b", kind: "function", name: "b" }],
			edges: [{ id: "b-imports-a", kind: "imports", from: "b", to: "a" }],
		},
	});
	graph.upsertFile({
		path: "test/a.test.ts",
		previousRevision: null,
		revision: computeCodeGraphFileRevision("test"),
		extraction: {
			nodes: [{ id: "test-a", kind: "function", name: "testA" }],
			edges: [{ id: "test-calls-b", kind: "calls", from: "test-a", to: "b" }],
		},
	});
	return graph.snapshot();
}

function catalog(includeFallback = true): ImpactVerificationCatalogPlan {
	return {
		configPath: "/project/.pi/checks.json",
		configRevision: `sha256:${"a".repeat(64)}`,
		checks: [
			{
				id: "source-check",
				command: "npm",
				args: ["run", "check"],
				timeoutMs: 5_000,
				selection: { mode: "affected", paths: ["src/**"] },
			},
			{
				id: "targeted-tests",
				command: "node",
				args: ["test/a.test.ts"],
				timeoutMs: 6_000,
				selection: { mode: "affected", paths: ["test/**"] },
			},
			...(includeFallback
				? [
						{
							id: "full-suite",
							command: "./test.sh",
							args: [],
							timeoutMs: 10_000,
							selection: { mode: "fallback" as const },
						},
					]
				: []),
		],
	};
}

describe("CodeGraph-driven impact verification", () => {
	it("maps reverse dependencies and selects the checks covering affected files", () => {
		const impact = buildCodeImpactMap(createSnapshot(), ["src/a.ts"]);
		const plan = planImpactVerification(catalog(), impact);

		expect(impact).toMatchObject({
			changedFiles: ["src/a.ts"],
			changedNodeIds: ["a"],
			affectedFiles: ["src/a.ts", "src/b.ts", "test/a.test.ts"],
			affectedNodeIds: ["a", "b", "test-a"],
			unindexedChangedFiles: [],
			truncated: false,
		});
		expect(plan.coverage).toBe("complete");
		expect(plan.selected.map(({ check }) => check.id)).toEqual(["source-check", "targeted-tests"]);
		expect(plan.uncoveredFiles).toEqual([]);
	});

	it("selects an explicit fallback for unindexed or otherwise uncovered paths", () => {
		const impact = buildCodeImpactMap(createSnapshot(), ["docs/design.md"]);
		const plan = planImpactVerification(catalog(), impact);

		expect(plan.coverage).toBe("fallback");
		expect(plan.selected).toEqual([
			expect.objectContaining({
				check: expect.objectContaining({ id: "full-suite" }),
				reasons: expect.arrayContaining([
					{ kind: "fallback-unindexed", paths: ["docs/design.md"] },
					{ kind: "fallback-uncovered", paths: ["docs/design.md"] },
				]),
			}),
		]);
	});

	it("fails closed when graph traversal is truncated without a fallback check", async () => {
		const impact = {
			...buildCodeImpactMap(createSnapshot(), ["src/a.ts"]),
			truncated: true,
		};
		const plan = planImpactVerification(catalog(false), impact);
		expect(plan).toMatchObject({
			coverage: "uncovered",
			uncoveredFiles: [],
		});

		const execute = vi.fn();
		const result = await verifyImpactPlan("verify truncated impact", catalog(false), impact, "/logical", execute);
		expect(result).toMatchObject({
			status: "blocked",
			reason: expect.stringContaining("truncated"),
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("fails closed on uncovered changes and executes only a covered plan", async () => {
		const uncoveredImpact = buildCodeImpactMap(createSnapshot(), ["docs/design.md"]);
		const execute = vi.fn();
		const blocked = await verifyImpactPlan("verify impact", catalog(false), uncoveredImpact, "/logical", execute);
		expect(blocked).toMatchObject({
			status: "blocked",
			reason: "No configured check covers: docs/design.md",
			evidence: {
				id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				coverage: "uncovered",
				uncoveredFiles: ["docs/design.md"],
			},
		});
		expect(execute).not.toHaveBeenCalled();

		execute
			.mockResolvedValueOnce({ stdout: "source output", stderr: "", code: 0, killed: false })
			.mockResolvedValueOnce({ stdout: "test output", stderr: "", code: 0, killed: false });
		const impact = buildCodeImpactMap(createSnapshot(), ["src/a.ts"]);
		const verified = await verifyImpactPlan("verify impact", catalog(), impact, "/logical", execute);
		expect(verified.status).toBe("pass");
		expect(verified.evidence).toMatchObject({
			id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			selectedCheckIds: ["source-check", "targeted-tests"],
			coverage: "complete",
			completion: { status: "pass" },
		});
		expect(JSON.stringify(verified.evidence)).not.toContain("source output");
		expect(execute).toHaveBeenNthCalledWith(
			2,
			"node",
			["test/a.test.ts"],
			expect.objectContaining({ cwd: "/logical", timeout: 6_000 }),
		);
	});

	it("strictly parses direct-command catalog entries", () => {
		expect(
			parseImpactVerificationCatalog({
				version: 1,
				checks: [
					{
						id: "tests",
						command: "node",
						args: ["test.mjs"],
						selection: { mode: "direct", paths: ["src/**"] },
					},
				],
			}),
		).toEqual({
			version: 1,
			checks: [
				{
					id: "tests",
					command: "node",
					args: ["test.mjs"],
					timeoutMs: 120_000,
					selection: { mode: "direct", paths: ["src/**"] },
				},
			],
		});
		expect(() =>
			parseImpactVerificationCatalog({
				version: 1,
				checks: [
					{
						id: "tests",
						command: "node",
						selection: { mode: "fallback", paths: ["**"] },
					},
				],
			}),
		).toThrow("paths is not allowed for fallback checks");
	});

	it("discovers changed paths from NUL-delimited Git status and exposes a scoped live graph provider", async () => {
		expect(parseGitChangedPaths(" M src/a.ts\0?? docs/new.md\0R  src/new-name.ts\0src/old-name.ts\0")).toEqual([
			"docs/new.md",
			"src/a.ts",
			"src/new-name.ts",
			"src/old-name.ts",
		]);
		const execute = vi.fn(async () => ({
			stdout: " M src/a.ts\0?? docs/new.md\0",
			stderr: "",
			code: 0,
			killed: false,
		}));
		await expect(collectGitChangedPaths("/logical", execute)).resolves.toEqual(["docs/new.md", "src/a.ts"]);
		expect(execute).toHaveBeenCalledWith(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			expect.objectContaining({ cwd: "/logical" }),
		);

		const provider = {
			sync: vi.fn(async () => undefined),
			impactMap: vi.fn(() => buildCodeImpactMap(createSnapshot(), ["src/a.ts"])),
		};
		const unregister = registerImpactGraphProvider("/logical", provider);
		expect(getImpactGraphProvider("/logical")).toBe(provider);
		unregister();
		expect(getImpactGraphProvider("/logical")).toBeUndefined();
	});
});
