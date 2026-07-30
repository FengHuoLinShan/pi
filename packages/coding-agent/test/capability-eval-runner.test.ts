import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCapabilityEvalSecretValues } from "../src/evals/capability/cli.ts";
import type { CapabilityEvalDriver } from "../src/evals/capability/runner.ts";
import { runCapabilityEvalSuite } from "../src/evals/capability/runner.ts";
import { parseCapabilityEvalSuite } from "../src/evals/capability/schema.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-capability-runner-test-"));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("runCapabilityEvalSuite", () => {
	it("automatically includes credential-shaped environment values in report redaction", () => {
		vi.stubEnv("CAPABILITY_EVAL_TEST_API_KEY", "unusual-provider-credential-value");
		expect(collectCapabilityEvalSecretValues([])).toContain("unusual-provider-credential-value");
	});

	it("runs repeated attempts, applies verifiers, and redacts reports and journals", async () => {
		const secret = "sk-secret-value-123456";
		const driver: CapabilityEvalDriver = {
			async runAttempt(context) {
				context.journal.write({
					scenario: context.scenario.id,
					attempt: context.attempt,
					event: "driver.observed",
					data: { authorization: `Bearer ${secret}`, safe: "visible" },
				});
				return {
					status: "completed",
					output: context.attempt === 1 ? "not yet" : `ok ${secret}`,
					metrics: { modelRequests: 1, toolCalls: 2, totalTokens: 50, orphanProcesses: 0 },
					trace: ["start", "finish"],
					lifecycle: ["server.started", "server.stopped"],
					details: { api_key: secret },
				};
			},
		};
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "attempt-suite",
			defaults: { attempts: { count: 3, minimumPassing: 2 } },
			scenarios: [
				{
					version: 1,
					id: "repeated",
					layer: "offline",
					task: "run",
					driver: { id: "fake" },
					verifiers: [
						{ type: "output", operator: "contains", expected: "ok" },
						{ type: "trace_order", expected: ["start", "finish"] },
						{ type: "lifecycle_order", expected: ["server.started", "server.stopped"] },
						{ type: "metric", metric: "orphanProcesses", operator: "equals", expected: 0 },
					],
				},
			],
		});
		const tempDir = createTempDir();
		const journalPath = join(tempDir, "journal.jsonl");
		const report = await runCapabilityEvalSuite(suite, {
			cwd: tempDir,
			drivers: { fake: driver },
			layers: ["offline"],
			journalPath,
			secretValues: [secret],
		});

		expect(report.passed).toBe(true);
		expect(report.scenarios[0].passingAttempts).toBe(2);
		expect(report.scenarios[0].attempts[1].output).toBe("ok [REDACTED]");
		expect(report.scenarios[0].attempts[1].details).toEqual({ api_key: "[REDACTED]" });
		const journal = readFileSync(journalPath, "utf8");
		expect(journal).not.toContain(secret);
		expect(journal).toContain("[REDACTED]");
	});

	it("fails attempts that exceed metric budgets", async () => {
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "budget-suite",
			scenarios: [
				{
					version: 1,
					id: "over-budget",
					layer: "offline",
					task: "run",
					driver: { id: "fake" },
					budgets: { maxToolCalls: 1 },
					verifiers: [{ type: "output", operator: "equals", expected: "done" }],
				},
			],
		});
		const report = await runCapabilityEvalSuite(suite, {
			drivers: {
				fake: {
					async runAttempt() {
						return { status: "completed", output: "done", metrics: { toolCalls: 2 } };
					},
				},
			},
			layers: ["offline"],
		});

		expect(report.passed).toBe(false);
		expect(report.scenarios[0].attempts[0].assertions).toContainEqual(
			expect.objectContaining({ name: "budget.maxToolCalls", passed: false }),
		);
	});

	it("evaluates JSON artifact state instead of trusting driver output", async () => {
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "artifact-suite",
			scenarios: [
				{
					version: 1,
					id: "artifact",
					layer: "offline",
					task: "run",
					driver: { id: "fake" },
					verifiers: [
						{ type: "output", operator: "equals", expected: "EVAL_OK" },
						{
							type: "artifact_json",
							path: "fixture-state.json",
							pointer: "/todos/0",
							expected: { text: "objective", completed: true },
						},
					],
				},
			],
		});
		const report = await runCapabilityEvalSuite(suite, {
			drivers: {
				fake: {
					async runAttempt() {
						return {
							status: "completed",
							output: "EVAL_OK",
							artifacts: {
								"fixture-state.json": JSON.stringify({ todos: [{ text: "objective", completed: false }] }),
							},
						};
					},
				},
			},
			layers: ["offline"],
		});

		expect(report.passed).toBe(false);
		expect(report.scenarios[0].attempts[0].assertions).toContainEqual(
			expect.objectContaining({ name: "artifact_json:fixture-state.json:/todos/0", passed: false }),
		);
	});

	it("aborts deadline overruns and always invokes cleanup", async () => {
		const cleanup = vi.fn(async () => {});
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "deadline-suite",
			scenarios: [
				{
					version: 1,
					id: "deadline",
					layer: "offline",
					task: "wait",
					driver: { id: "slow" },
					budgets: { maxWallTimeMs: 20 },
					verifiers: [{ type: "output", operator: "equals", expected: "never" }],
				},
			],
		});
		const report = await runCapabilityEvalSuite(suite, {
			drivers: {
				slow: {
					async runAttempt(context) {
						await new Promise<void>((resolveWait) =>
							context.signal.addEventListener("abort", () => resolveWait(), { once: true }),
						);
						return {
							status: "aborted",
							output: "partial output",
							metrics: { modelRequests: 2, toolCalls: 1, totalTokens: 42 },
						};
					},
					cleanupAttempt: cleanup,
				},
			},
			layers: ["offline"],
		});

		expect(report.passed).toBe(false);
		expect(report.scenarios[0].attempts[0].status).toBe("aborted");
		expect(report.scenarios[0].attempts[0].output).toBe("partial output");
		expect(report.scenarios[0].attempts[0].metrics).toMatchObject({
			modelRequests: 2,
			toolCalls: 1,
			totalTokens: 42,
		});
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("skips disabled layers and rejects live execution without explicit authorization", async () => {
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "layer-suite",
			scenarios: [
				{
					version: 1,
					id: "live",
					layer: "live",
					task: "live",
					driver: { id: "live" },
					verifiers: [{ type: "output", operator: "equals", expected: "ok" }],
				},
			],
		});
		const skipped = await runCapabilityEvalSuite(suite, { drivers: {}, layers: ["offline"] });
		expect(skipped.scenarios[0].status).toBe("skipped");
		await expect(runCapabilityEvalSuite(suite, { drivers: {}, layers: ["live"] })).rejects.toThrow(
			"require allowLive",
		);
	});
});
