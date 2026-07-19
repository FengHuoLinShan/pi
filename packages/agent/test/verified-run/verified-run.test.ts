import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { COMPLETION_CONTRACT_VERSION, type CompletionVerifier } from "../../src/completion/index.ts";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentRunBudget, AgentTool } from "../../src/types.ts";
import {
	executeVerifiedRun,
	serializeVerifiedRunReport,
	VERIFIED_RUN_SPEC_VERSION,
	type VerifiedRunSpec,
	type VerifiedRunVerificationContext,
} from "../../src/verified-run/index.ts";
import { calculateTool } from "../utils/calculate.ts";

let providerId = 0;

function createHarness(options: {
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];
	runBudget?: AgentRunBudget;
	tools?: AgentTool[];
}): AgentHarness {
	const models = createModels();
	const provider = fauxProvider({ provider: `verified-run-${++providerId}` });
	provider.setResponses(options.responses);
	models.setProvider(provider.provider);
	return new AgentHarness({
		models,
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: new Session(new InMemorySessionStorage()),
		model: provider.getModel(),
		runBudget: options.runBudget,
		tools: options.tools,
	});
}

function spec(): VerifiedRunSpec {
	return {
		version: VERIFIED_RUN_SPEC_VERSION,
		id: "verified-change",
		prompt: "Implement and verify the change",
		completionContract: {
			version: COMPLETION_CONTRACT_VERSION,
			id: "done",
			objective: "The change is complete",
			conditions: [{ id: "tests", description: "Tests pass", verifierIds: ["tests"] }],
		},
		artifactRefs: [
			{ id: "patch-z", kind: "patch", reference: "artifact://z" },
			{ id: "patch-a", kind: "patch", reference: "artifact://a" },
		],
		evidenceRefs: [{ id: "source", kind: "file", revision: "sha256:source" }],
	};
}

describe("verified run", () => {
	it("combines a real Harness run with completion evidence and opaque references", async () => {
		const harness = createHarness({ responses: [() => fauxAssistantMessage("implemented")] });
		type Context = { workspace: string };
		const verifier: CompletionVerifier<VerifiedRunVerificationContext<Context>> = {
			id: "tests",
			verify: ({ context }) => {
				expect(context.context.workspace).toBe("repo");
				expect(context.finalMessage.content[0]).toMatchObject({ type: "text", text: "implemented" });
				expect(context.artifactRefs.map((reference) => reference.id)).toEqual(["patch-a", "patch-z"]);
				return {
					status: "pass",
					summary: "Focused tests passed",
					evidence: [{ id: "vitest", kind: "test", summary: "1 test passed" }],
				};
			},
		};

		const report = await executeVerifiedRun(harness, spec(), {
			context: { workspace: "repo" },
			verifiers: [verifier],
		});

		expect(report.status).toBe("passed");
		expect(report.usage).toMatchObject({ steps: 1, modelCalls: 1, toolCalls: 0 });
		expect(report.artifactRefs.map((reference) => reference.id)).toEqual(["patch-a", "patch-z"]);
		expect(report.completion?.conditions[0]?.verifiers[0]?.evidence).toEqual([
			{ id: "vitest", kind: "test", summary: "1 test passed" },
		]);
		expect(JSON.parse(serializeVerifiedRunReport(report))).toEqual(report);
	});

	it.each([
		["fail" as const, "failed" as const],
		["blocked" as const, "blocked" as const],
	])("maps completion %s to run status %s", async (completionStatus, expectedStatus) => {
		const harness = createHarness({ responses: [() => fauxAssistantMessage("implemented")] });
		const verifier: CompletionVerifier<VerifiedRunVerificationContext<undefined>> = {
			id: "tests",
			verify: () => ({ status: completionStatus, summary: `Completion ${completionStatus}` }),
		};

		const report = await executeVerifiedRun(harness, spec(), { context: undefined, verifiers: [verifier] });

		expect(report.status).toBe(expectedStatus);
		expect(report.completion?.status).toBe(completionStatus);
	});

	it("maps Harness budget termination to blocked without running completion verifiers", async () => {
		const harness = createHarness({
			responses: [
				() =>
					fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
						stopReason: "toolUse",
					}),
			],
			runBudget: { maxModelCalls: 1 },
			tools: [calculateTool],
		});
		const verify = vi.fn(() => ({ status: "pass" as const, summary: "should not run" }));

		const report = await executeVerifiedRun(harness, spec(), {
			context: undefined,
			verifiers: [{ id: "tests", verify }],
		});

		expect(report.status).toBe("blocked");
		expect(report.termination).toMatchObject({ status: "budget_exhausted", reason: "max_model_calls" });
		expect(report.usage).toMatchObject({ modelCalls: 1, toolCalls: 1 });
		expect(verify).not.toHaveBeenCalled();
	});

	it("maps provider failures to failed without treating an assistant message as completion", async () => {
		const harness = createHarness({
			responses: [() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })],
		});
		const verify = vi.fn(() => ({ status: "pass" as const, summary: "should not run" }));

		const report = await executeVerifiedRun(harness, spec(), {
			context: undefined,
			verifiers: [{ id: "tests", verify }],
		});

		expect(report.status).toBe("failed");
		expect(report.failure).toEqual({ stage: "harness", name: "ProviderError", message: "provider failed" });
		expect(verify).not.toHaveBeenCalled();
	});

	it("returns interrupted without starting Harness work for a pre-aborted signal", async () => {
		const harness = createHarness({ responses: [() => fauxAssistantMessage("unused")] });
		const controller = new AbortController();
		controller.abort();

		const report = await executeVerifiedRun(harness, spec(), {
			context: undefined,
			verifiers: [],
			signal: controller.signal,
		});

		expect(report.status).toBe("interrupted");
		expect(report.usage).toEqual({ steps: 0, modelCalls: 0, toolCalls: 0, modelTokens: 0, cost: 0, elapsedMs: 0 });
		expect(report.finalMessage).toBeUndefined();
	});

	it("isolates verifier mutations from later verifiers and the returned report", async () => {
		const harness = createHarness({ responses: [() => fauxAssistantMessage("implemented")] });
		const runSpec = spec();
		runSpec.completionContract.conditions[0]!.verifierIds = ["mutator", "observer"];
		runSpec.artifactRefs![0]!.metadata = { source: "original" };
		const mutator: CompletionVerifier<VerifiedRunVerificationContext<undefined>> = {
			id: "mutator",
			verify: ({ contract, condition, context }) => {
				contract.id = "mutated-contract";
				condition.id = "mutated-condition";
				context.spec.id = "mutated-run";
				context.usage.steps = 999;
				context.artifactRefs[0]!.id = "mutated-artifact";
				const block = context.finalMessage.content[0];
				if (block?.type === "text") block.text = "mutated-message";
				return { status: "pass", summary: "mutated local snapshot" };
			},
		};
		const observer: CompletionVerifier<VerifiedRunVerificationContext<undefined>> = {
			id: "observer",
			verify: ({ contract, condition, context }) => {
				expect(contract.id).toBe("done");
				expect(condition.id).toBe("tests");
				expect(context.spec.id).toBe("verified-change");
				expect(context.usage.steps).toBe(1);
				expect(context.artifactRefs[0]?.id).toBe("patch-a");
				expect(context.finalMessage.content[0]).toMatchObject({ type: "text", text: "implemented" });
				return { status: "pass", summary: "observed isolated snapshot" };
			},
		};

		const report = await executeVerifiedRun(harness, runSpec, {
			context: undefined,
			verifiers: [mutator, observer],
		});

		expect(report.status).toBe("passed");
		expect(report.runId).toBe("verified-change");
		expect(report.usage.steps).toBe(1);
		expect(report.artifactRefs.map((reference) => reference.id)).toEqual(["patch-a", "patch-z"]);
		expect(report.finalMessage?.content[0]).toMatchObject({ type: "text", text: "implemented" });
		expect(report.completion?.contract.id).toBe("done");
	});

	it("rejects non-JSON reference metadata before starting Harness work", async () => {
		const harness = createHarness({ responses: [() => fauxAssistantMessage("unused")] });
		const runSpec = spec();
		Reflect.set(runSpec.artifactRefs![0]!, "metadata", { createdAt: new Date() });

		await expect(executeVerifiedRun(harness, runSpec, { context: undefined, verifiers: [] })).rejects.toThrow(
			"must be JSON serializable",
		);
	});

	it("maps an abort during completion verification to interrupted", async () => {
		const harness = createHarness({ responses: [() => fauxAssistantMessage("implemented")] });
		const controller = new AbortController();
		let notifyStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const verifier: CompletionVerifier<VerifiedRunVerificationContext<undefined>> = {
			id: "tests",
			verify: (_input, signal) =>
				new Promise((resolve) => {
					notifyStarted?.();
					const finish = () => resolve({ status: "blocked", summary: "aborted" });
					if (signal.aborted) finish();
					else signal.addEventListener("abort", finish, { once: true });
				}),
		};

		const pending = executeVerifiedRun(harness, spec(), {
			context: undefined,
			verifiers: [verifier],
			signal: controller.signal,
		});
		await started;
		controller.abort();
		const report = await pending;

		expect(report.status).toBe("interrupted");
		expect(report.completion?.status).toBe("blocked");
		expect(report.usage).toMatchObject({ steps: 1, modelCalls: 1 });
	});

	it("rejects non-JSON report values instead of silently erasing them", async () => {
		const harness = createHarness({ responses: [() => fauxAssistantMessage("implemented")] });
		const report = await executeVerifiedRun(harness, spec(), {
			context: undefined,
			verifiers: [{ id: "tests", verify: () => ({ status: "pass", summary: "passed" }) }],
		});
		Reflect.set(report.artifactRefs[0]!, "metadata", { createdAt: new Date() });

		expect(() => serializeVerifiedRunReport(report)).toThrow("not JSON serializable");
	});
});
