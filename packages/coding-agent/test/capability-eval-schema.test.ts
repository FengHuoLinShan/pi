import { describe, expect, it } from "vitest";
import { selectCapabilityEvalScenarios } from "../src/evals/capability/cli.ts";
import { parseCapabilityEvalSuite } from "../src/evals/capability/schema.ts";

function validSuite(): unknown {
	return {
		version: 1,
		name: "capability-test",
		defaults: {
			budgets: { maxWallTimeMs: 1_000, maxModelRequests: 2, maxToolCalls: 3, maxTotalTokens: 100 },
			attempts: { count: 3, minimumPassing: 2 },
		},
		scenarios: [
			{
				version: 1,
				id: "offline-probe",
				layer: "offline",
				task: "Probe the local server",
				driver: { id: "mock" },
				verifiers: [{ type: "output", operator: "contains", expected: "ok" }],
			},
		],
	};
}

describe("parseCapabilityEvalSuite", () => {
	it("accepts a versioned suite", () => {
		const suite = parseCapabilityEvalSuite(validSuite());
		expect(suite.version).toBe(1);
		expect(suite.scenarios[0].layer).toBe("offline");
	});

	it("rejects duplicate scenario ids", () => {
		const suite = validSuite() as { scenarios: unknown[] };
		suite.scenarios.push(structuredClone(suite.scenarios[0]));
		expect(() => parseCapabilityEvalSuite(suite)).toThrow("Duplicate capability eval scenario id");
	});

	it("rejects impossible attempt thresholds", () => {
		const suite = validSuite() as { defaults: { attempts: { count: number; minimumPassing: number } } };
		suite.defaults.attempts = { count: 2, minimumPassing: 3 };
		expect(() => parseCapabilityEvalSuite(suite)).toThrow("minimumPassing exceeds attempt count");
	});

	it("rejects invalid output regexes and incomplete artifact verifiers", () => {
		const regexSuite = validSuite() as { scenarios: Array<{ verifiers: unknown[] }> };
		regexSuite.scenarios[0].verifiers = [{ type: "output", operator: "matches", expected: "[" }];
		expect(() => parseCapabilityEvalSuite(regexSuite)).toThrow("invalid output regex");

		const artifactSuite = validSuite() as { scenarios: Array<{ verifiers: unknown[] }> };
		artifactSuite.scenarios[0].verifiers = [{ type: "artifact_contains", path: "state.json" }];
		expect(() => parseCapabilityEvalSuite(artifactSuite)).toThrow("Invalid capability eval suite");
	});

	it("accepts objective JSON artifact verifiers and rejects invalid pointers", () => {
		const suite = validSuite() as { scenarios: Array<{ verifiers: unknown[] }> };
		suite.scenarios[0].verifiers = [
			{ type: "artifact_json", path: "fixture-state.json", pointer: "/todos/0", expected: { completed: true } },
		];
		expect(parseCapabilityEvalSuite(suite).scenarios[0].verifiers[0].type).toBe("artifact_json");
		suite.scenarios[0].verifiers = [
			{ type: "artifact_json", path: "fixture-state.json", pointer: "todos/0", expected: true },
		];
		expect(() => parseCapabilityEvalSuite(suite)).toThrow("Invalid capability eval suite");
	});

	it("selects requested scenarios and rejects unknown ids", () => {
		const input = validSuite() as { scenarios: Array<Record<string, unknown>> };
		input.scenarios.push({ ...structuredClone(input.scenarios[0]), id: "second-probe" });
		const suite = parseCapabilityEvalSuite(input);
		expect(selectCapabilityEvalScenarios(suite, ["second-probe"]).scenarios.map((scenario) => scenario.id)).toEqual([
			"second-probe",
		]);
		expect(() => selectCapabilityEvalScenarios(suite, ["missing-probe"])).toThrow("Unknown capability eval scenario");
	});
});
