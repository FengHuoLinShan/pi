import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	compareAgentHarnessEvalReport,
	createAgentHarnessEvalBaseline,
	parseAgentHarnessEvalBaseline,
	parseAgentHarnessEvalSuite,
	runAgentHarnessEvalSuite,
} from "../../src/evals/index.ts";

async function loadCoreSuite() {
	const path = new URL("../../evals/scenarios/core.json", import.meta.url);
	return parseAgentHarnessEvalSuite(JSON.parse(await readFile(path, "utf8")));
}

describe("AgentHarness eval runner", () => {
	it("validates scenario structure and declared tools", () => {
		expect(() =>
			parseAgentHarnessEvalSuite({
				version: 1,
				name: "invalid",
				scenarios: [
					{
						version: 1,
						id: "undeclared-tool",
						prompt: "run",
						responses: [
							{
								content: [{ type: "toolCall", id: "call-1", name: "missing", arguments: {} }],
							},
						],
						assertions: {},
					},
				],
			}),
		).toThrow("calls undeclared tool missing");
	});

	it("runs deterministic tool, recovery, parallel, budget, and loop scenarios without provider credentials", async () => {
		const report = await runAgentHarnessEvalSuite(await loadCoreSuite());

		expect(report.passed).toBe(true);
		expect(report.passRate).toBe(1);
		expect(report.scenarios.map((scenario) => [scenario.id, scenario.termination.status])).toEqual([
			["tool-roundtrip", "completed"],
			["model-call-budget", "budget_exhausted"],
			["tool-error-recovery", "completed"],
			["parallel-tool-batch", "completed"],
			["tool-call-budget", "budget_exhausted"],
			["repeated-tool-loop", "loop_detected"],
		]);
		expect(report.scenarios.every((scenario) => scenario.replay.deterministic)).toBe(true);
	});

	it("gates semantic signature changes against explicit baseline thresholds", async () => {
		const report = await runAgentHarnessEvalSuite(await loadCoreSuite());
		const baseline = createAgentHarnessEvalBaseline(report);
		const unchanged = compareAgentHarnessEvalReport(report, baseline);
		expect(unchanged).toMatchObject({ passed: true, regressions: [], violations: [] });

		const changedReport = structuredClone(report);
		changedReport.scenarios[0]!.signature = "changed";
		const changed = compareAgentHarnessEvalReport(changedReport, baseline);
		expect(changed.passed).toBe(false);
		expect(changed.regressions).toEqual(["tool-roundtrip"]);
		expect(changed.violations).toContain("Regressions 1 exceed 0");
	});

	it("rejects malformed baselines and treats disabled replay as a gate failure", async () => {
		expect(() =>
			parseAgentHarnessEvalBaseline({
				version: 1,
				suiteName: "invalid",
				createdAt: new Date().toISOString(),
				thresholds: {
					minimumPassRate: 2,
					maximumFailedScenarios: 0,
					maximumRegressions: 0,
					maximumUnbaselinedScenarios: 0,
					requireReplayDeterminism: true,
				},
				scenarios: {},
			}),
		).toThrow("minimumPassRate must be between 0 and 1");

		const report = await runAgentHarnessEvalSuite(await loadCoreSuite());
		const baseline = createAgentHarnessEvalBaseline(report);
		report.scenarios[0]!.replay.enabled = false;
		const comparison = compareAgentHarnessEvalReport(report, baseline);
		expect(comparison.passed).toBe(false);
		expect(comparison.replayFailures).toEqual(["tool-roundtrip"]);
	});

	it("refuses to create a baseline that would fail its own replay gate", async () => {
		const report = await runAgentHarnessEvalSuite(await loadCoreSuite());
		report.scenarios[0]!.replay.enabled = false;

		expect(() => createAgentHarnessEvalBaseline(report)).toThrow(
			"Refusing to create an eval baseline without deterministic replay for: tool-roundtrip",
		);

		const baseline = createAgentHarnessEvalBaseline(report, {
			minimumPassRate: 1,
			maximumFailedScenarios: 0,
			maximumRegressions: 0,
			maximumUnbaselinedScenarios: 0,
			requireReplayDeterminism: false,
		});
		expect(baseline.thresholds.requireReplayDeterminism).toBe(false);
	});
});
