import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBrowserJsonlCapabilityDriver } from "../src/evals/capability/browser-driver.ts";
import { createJsonlCommandCapabilityDriver } from "../src/evals/capability/jsonl-command-driver.ts";
import { runCapabilityEvalSuite } from "../src/evals/capability/runner.ts";
import { parseCapabilityEvalSuite } from "../src/evals/capability/schema.ts";

const jsonFixture = fileURLToPath(new URL("../evals/fixtures/jsonl-agent-fixture.mjs", import.meta.url));
const browserFixture = fileURLToPath(new URL("../evals/fixtures/browser-agent-fixture.mjs", import.meta.url));

describe("capability eval JSONL command drivers", () => {
	it("extracts Pi JSON events and redacts child output", async () => {
		const secret = "fixture-secret-987654321";
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "jsonl",
			scenarios: [
				{
					version: 1,
					id: "jsonl",
					layer: "offline",
					task: "json task",
					driver: { id: "jsonl" },
					verifiers: [
						{ type: "output", operator: "contains", expected: "completed json task" },
						{ type: "metric", metric: "modelRequests", operator: "equals", expected: 1 },
						{ type: "metric", metric: "toolCalls", operator: "equals", expected: 1 },
						{ type: "metric", metric: "totalTokens", operator: "equals", expected: 42 },
					],
				},
			],
		});
		const report = await runCapabilityEvalSuite(suite, {
			drivers: {
				jsonl: createJsonlCommandCapabilityDriver({
					command: process.execPath,
					args: [jsonFixture, "{{task}}"],
					environment: { CAPABILITY_EVAL_FIXTURE_SECRET: secret },
				}),
			},
			layers: ["offline"],
			secretValues: [secret],
		});

		expect(report.passed).toBe(true);
		expect(report.scenarios[0].attempts[0].output).toBe("completed json task; token=[REDACTED]");
	});

	it("provides a local web fixture and captures its state as an artifact", async () => {
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "browser-jsonl",
			scenarios: [
				{
					version: 1,
					id: "browser",
					layer: "browser",
					task: "complete a todo",
					driver: { id: "browser" },
					verifiers: [
						{ type: "output", operator: "equals", expected: "EVAL_OK" },
						{ type: "artifact_contains", path: "fixture-state.json", expected: '"completed": true' },
						{
							type: "lifecycle_order",
							expected: ["fixture.started", "process.spawned", "process.exited", "fixture.stopped"],
						},
					],
				},
			],
		});
		const report = await runCapabilityEvalSuite(suite, {
			drivers: {
				browser: createBrowserJsonlCapabilityDriver({
					command: process.execPath,
					args: [browserFixture, "{{fixtureUrl}}"],
				}),
			},
			layers: ["browser"],
		});

		expect(report.passed).toBe(true);
		expect(report.scenarios[0].attempts[0].artifacts["fixture-state.json"]).toContain("browser fixture");
	});

	it("detects and cleans up descendant processes left by a command", async () => {
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "orphan-jsonl",
			scenarios: [
				{
					version: 1,
					id: "orphan",
					layer: "offline",
					task: "detect process leaks",
					driver: { id: "orphan" },
					verifiers: [
						{ type: "output", operator: "equals", expected: "done" },
						{ type: "metric", metric: "orphanProcesses", operator: "equals", expected: 0 },
					],
				},
			],
		});
		const childScript = [
			'const { spawn } = require("node:child_process")',
			'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref()',
			'process.stdout.write(JSON.stringify({ type: "capability_eval_output", output: "done" }) + "\\n")',
		].join(";");
		const report = await runCapabilityEvalSuite(suite, {
			drivers: {
				orphan: createJsonlCommandCapabilityDriver({ command: process.execPath, args: ["-e", childScript] }),
			},
			layers: ["offline"],
		});

		expect(report.passed).toBe(false);
		expect(report.scenarios[0].attempts[0].metrics.orphanProcesses).toBe(1);
	});
});
