import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { COMPLETION_CONTRACT_VERSION, type CompletionContract } from "../../src/completion/types.ts";
import { verifyCompletionContract } from "../../src/completion/verify.ts";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessEvent } from "../../src/harness/types.ts";
import {
	createHarnessDisciplineAudit,
	createHarnessDisciplineCompletionVerifier,
	type HarnessDisciplineAudit,
	type HarnessDisciplineViolationCode,
	type ToolAttemptOutcome,
} from "../../src/index.ts";
import {
	createToolPolicyAdapter,
	type ToolPolicyAuthorizationObservation,
	type ToolSpec,
} from "../../src/tool-policy.ts";
import { calculateTool } from "../utils/calculate.ts";

interface TestContext {
	audit: HarnessDisciplineAudit;
}

const completionContract: CompletionContract = {
	version: COMPLETION_CONTRACT_VERSION,
	id: "discipline-contract",
	objective: "Verify Harness discipline",
	conditions: [{ id: "discipline", description: "Harness run is disciplined", verifierIds: ["discipline"] }],
};

const calculateSpec: ToolSpec = {
	name: "calculate",
	revision: "calculate@1",
	retrySafe: true,
	risk: { level: "low" },
	sideEffects: ["none"],
	resources: [],
	permissions: [],
};

const allAttemptOutcomes = [
	"not_executed_missing_tool",
	"not_executed_preparation_error",
	"not_executed_before_hook_error",
	"not_executed_blocked",
	"not_executed_aborted_before_body",
	"not_executed_truncated",
	"not_executed_budget",
	"not_executed_deadline",
	"not_executed_loop",
	"body_success",
	"body_error",
	"after_hook_error",
] as const satisfies readonly ToolAttemptOutcome[];

function observation(overrides: Partial<ToolPolicyAuthorizationObservation> = {}): ToolPolicyAuthorizationObservation {
	return {
		version: 1,
		toolCallId: "call-1",
		toolName: "calculate",
		resolvedCallHash: `sha256:${"a".repeat(64)}`,
		policyRevision: "policy@1",
		decision: "allow",
		allowed: true,
		approval: "not_required",
		...overrides,
	};
}

function executionStart(
	audit: HarnessDisciplineAudit,
	toolCallId = "call-1",
	toolName = "calculate",
	args: unknown = { expression: "2 + 2" },
): void {
	audit.observeHarnessEvent({ type: "tool_execution_start", toolCallId, toolName, args });
}

function executionEnd(
	audit: HarnessDisciplineAudit,
	toolCallId = "call-1",
	toolName = "calculate",
	attemptOutcome: ToolAttemptOutcome | undefined = "body_success",
): void {
	audit.observeHarnessEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: {},
		isError: attemptOutcome !== "body_success",
		...(attemptOutcome === undefined ? {} : { attemptOutcome }),
	});
}

function settle(audit: HarnessDisciplineAudit, nextTurnCount = 0): void {
	audit.observeHarnessEvent({ type: "settled", nextTurnCount });
}

async function verifyAudit(
	audit: HarnessDisciplineAudit,
	overrides: Partial<Parameters<typeof createHarnessDisciplineCompletionVerifier<TestContext>>[0]> = {},
) {
	const verifier = createHarnessDisciplineCompletionVerifier<TestContext>({
		id: "discipline",
		getAudit: (context) => context.audit,
		requireEveryExecutionAuthorized: true,
		deniedAttempts: "fail",
		minAuthorizationDecisions: 1,
		requireEveryAttemptOutcome: false,
		allowedAttemptOutcomes: allAttemptOutcomes,
		requireSettled: true,
		maxNextTurnCount: 0,
		...overrides,
	});
	return verifyCompletionContract(completionContract, [verifier], { context: { audit } });
}

function violationCodes(report: Awaited<ReturnType<typeof verifyAudit>>): HarnessDisciplineViolationCode[] {
	const evidence = report.conditions[0]?.verifiers[0]?.evidence?.[0];
	const data = evidence?.data as { violations?: Array<{ code?: HarnessDisciplineViolationCode }> } | undefined;
	return data?.violations?.flatMap((violation) => (violation.code ? [violation.code] : [])) ?? [];
}

describe("Harness discipline audit", () => {
	it("binds callbacks, snapshots inputs defensively, and emits content-minimized evidence", async () => {
		const audit = createHarnessDisciplineAudit();
		const { observeAuthorization, observeHarnessEvent } = audit;
		const input = {
			...observation(),
			resolvedCallHash: `sha256:${"b".repeat(64)}`,
			policyRevision: "private-policy-revision",
		} satisfies ToolPolicyAuthorizationObservation;
		observeHarnessEvent({
			type: "tool_execution_start",
			toolCallId: "private-call-id",
			toolName: "private-tool-name",
			args: { path: "/private/path", secret: "private-argument" },
		});
		input.toolCallId = "private-call-id";
		input.toolName = "private-tool-name";
		observeAuthorization(input);
		input.policyRevision = "mutated-policy-revision";
		observeHarnessEvent({ type: "settled", nextTurnCount: 0 });

		const first = audit.snapshot();
		(first.anomalies as { invalidHarnessEvents: number }).invalidHarnessEvents = 99;
		const second = audit.snapshot();
		expect(second).toMatchObject({
			version: 2,
			authorizationDecisions: { total: 1, allowed: 1, policyRevisionCount: 1 },
			executionAttempts: { total: 1, withDecision: 1, allowed: 1, unresolved: 0 },
			settlement: { observed: true, count: 1, nextTurnCount: 0 },
			anomalies: { invalidHarnessEvents: 0 },
		});

		const report = await verifyAudit(audit, { expectedPolicyRevision: "private-policy-revision" });
		expect(report.status).toBe("pass");
		const serialized = JSON.stringify(report);
		for (const privateValue of [
			"private-call-id",
			"private-tool-name",
			"private-argument",
			"/private/path",
			input.resolvedCallHash,
			"private-policy-revision",
		]) {
			expect(serialized).not.toContain(privateValue);
		}
	});

	it("applies every explicit completion policy independently", async () => {
		const audit = createHarnessDisciplineAudit();
		executionStart(audit);
		audit.observeAuthorization(
			observation({ decision: "deny", allowed: false, approval: "not_required", policyRevision: "policy@2" }),
		);
		settle(audit, 2);

		const permissive = await verifyAudit(audit, {
			expectedPolicyRevision: "policy@2",
			requireEveryExecutionAuthorized: false,
			deniedAttempts: "allow",
			minAuthorizationDecisions: 1,
			requireSettled: true,
			maxNextTurnCount: 2,
		});
		expect(permissive.status).toBe("pass");

		const strict = await verifyAudit(audit, {
			expectedPolicyRevision: "policy@1",
			requireEveryExecutionAuthorized: true,
			deniedAttempts: "fail",
			minAuthorizationDecisions: 2,
			requireSettled: true,
			maxNextTurnCount: 1,
		});
		expect(strict.status).toBe("fail");
		expect(violationCodes(strict)).toEqual([
			"policy_revision_mismatch",
			"attempt_not_allowed",
			"denied_attempt",
			"minimum_authorizations_not_met",
			"next_turn_count_exceeded",
		]);
	});

	it("fails closed for malformed, duplicate, unknown, out-of-order, mismatched, and late events", async () => {
		const audit = createHarnessDisciplineAudit();
		audit.observeHarnessEvent({ type: "ignored-event" } as unknown as AgentHarnessEvent);
		audit.observeAuthorization(observation({ toolCallId: "early", toolName: "expected" }));
		executionStart(audit, "early", "different");
		executionStart(audit, "early", "different");
		audit.observeAuthorization(observation({ toolCallId: "early", toolName: "expected" }));
		audit.observeHarnessEvent({ type: "tool_execution_start", toolCallId: "", toolName: "bad", args: {} });
		audit.observeAuthorization({ ...observation(), resolvedCallHash: "not-a-hash" });
		expect(() =>
			audit.observeAuthorization(
				new Proxy(observation(), {
					get() {
						throw new Error("hostile authorization getter");
					},
				}),
			),
		).not.toThrow();
		expect(() =>
			audit.observeHarnessEvent(
				new Proxy({ type: "settled", nextTurnCount: 0 } satisfies AgentHarnessEvent, {
					get() {
						throw new Error("hostile event getter");
					},
				}),
			),
		).not.toThrow();
		settle(audit);
		settle(audit);
		executionStart(audit, "late", "calculate");
		audit.observeAuthorization(observation({ toolCallId: "late" }));

		const report = await verifyAudit(audit, {
			requireEveryExecutionAuthorized: false,
			deniedAttempts: "allow",
			minAuthorizationDecisions: 0,
		});
		expect(report.status).toBe("fail");
		expect(violationCodes(report)).toEqual([
			"invalid_authorization_observation",
			"invalid_harness_event",
			"duplicate_authorization_observation",
			"duplicate_execution_start",
			"authorization_without_attempt",
			"late_authorization_observation",
			"late_execution_start",
			"duplicate_settlement",
			"tool_name_mismatch",
		]);
	});

	it("requires settlement when configured and rejects contradictory or implicit options", async () => {
		const audit = createHarnessDisciplineAudit();
		const report = await verifyAudit(audit, {
			requireEveryExecutionAuthorized: false,
			deniedAttempts: "allow",
			minAuthorizationDecisions: 0,
			requireSettled: true,
			maxNextTurnCount: 0,
		});
		expect(violationCodes(report)).toEqual(["settlement_not_observed"]);

		const unresolvedAudit = createHarnessDisciplineAudit();
		executionStart(unresolvedAudit);
		settle(unresolvedAudit);
		const unresolved = await verifyAudit(unresolvedAudit, {
			requireEveryExecutionAuthorized: true,
			deniedAttempts: "allow",
			minAuthorizationDecisions: 0,
		});
		expect(violationCodes(unresolved)).toEqual(["attempt_without_decision"]);

		expect(() =>
			createHarnessDisciplineCompletionVerifier({
				id: "invalid",
				getAudit: () => audit,
				requireEveryExecutionAuthorized: false,
				deniedAttempts: "allow",
				minAuthorizationDecisions: 0,
				requireEveryAttemptOutcome: false,
				allowedAttemptOutcomes: allAttemptOutcomes,
				requireSettled: false,
				maxNextTurnCount: 0,
			}),
		).toThrow("maxNextTurnCount requires requireSettled");
		expect(() =>
			createHarnessDisciplineCompletionVerifier({
				id: "implicit",
				getAudit: () => audit,
			} as unknown as Parameters<typeof createHarnessDisciplineCompletionVerifier>[0]),
		).toThrow("requireEveryExecutionAuthorized must be boolean");

		const explicitOptions = {
			id: "outcomes",
			getAudit: () => audit,
			requireEveryExecutionAuthorized: false,
			deniedAttempts: "allow" as const,
			minAuthorizationDecisions: 0,
			requireEveryAttemptOutcome: false,
			allowedAttemptOutcomes: ["body_success"] as ToolAttemptOutcome[],
			requireSettled: false,
		};
		expect(() =>
			createHarnessDisciplineCompletionVerifier({
				...explicitOptions,
				requireEveryAttemptOutcome: undefined,
			} as unknown as Parameters<typeof createHarnessDisciplineCompletionVerifier>[0]),
		).toThrow("requireEveryAttemptOutcome must be boolean");
		expect(() =>
			createHarnessDisciplineCompletionVerifier({
				...explicitOptions,
				allowedAttemptOutcomes: ["body_success", "body_success"],
			}),
		).toThrow("must not contain duplicates");
		const sparseOutcomes = new Array<ToolAttemptOutcome>(1);
		expect(() =>
			createHarnessDisciplineCompletionVerifier({
				...explicitOptions,
				allowedAttemptOutcomes: sparseOutcomes,
			}),
		).toThrow("must be dense");
		expect(() =>
			createHarnessDisciplineCompletionVerifier({
				...explicitOptions,
				allowedAttemptOutcomes: ["unsupported"],
			} as unknown as Parameters<typeof createHarnessDisciplineCompletionVerifier>[0]),
		).toThrow("contains an unsupported outcome");
	});

	it("snapshots verifier options and getAudit at construction", async () => {
		const audited = createHarnessDisciplineAudit();
		executionStart(audited);
		executionEnd(audited, "call-1", "calculate", "body_error");
		audited.observeAuthorization(observation({ decision: "deny", allowed: false }));
		settle(audited);
		const replacement = createHarnessDisciplineAudit();
		settle(replacement);
		const options: {
			id: string;
			getAudit: (context: TestContext) => HarnessDisciplineAudit;
			expectedPolicyRevision: string;
			requireEveryExecutionAuthorized: boolean;
			deniedAttempts: "allow" | "fail";
			minAuthorizationDecisions: number;
			requireEveryAttemptOutcome: boolean;
			allowedAttemptOutcomes: ToolAttemptOutcome[];
			requireSettled: boolean;
			maxNextTurnCount: number;
		} = {
			id: "discipline",
			getAudit: (context: TestContext) => context.audit,
			expectedPolicyRevision: "policy@1",
			requireEveryExecutionAuthorized: false,
			deniedAttempts: "fail",
			minAuthorizationDecisions: 1,
			requireEveryAttemptOutcome: false,
			allowedAttemptOutcomes: ["body_error"],
			requireSettled: true,
			maxNextTurnCount: 0,
		};
		const verifier = createHarnessDisciplineCompletionVerifier(options);
		options.id = "mutated";
		options.getAudit = () => replacement;
		options.expectedPolicyRevision = "mutated";
		options.deniedAttempts = "allow";
		options.minAuthorizationDecisions = 0;
		options.requireEveryAttemptOutcome = true;
		options.allowedAttemptOutcomes.length = 0;
		options.requireSettled = false;
		options.maxNextTurnCount = 99;

		const report = await verifyCompletionContract(completionContract, [verifier], {
			context: { audit: audited },
		});

		expect(verifier.id).toBe("discipline");
		expect(report.status).toBe("fail");
		expect(violationCodes(report)).toEqual(["denied_attempt"]);
	});

	it("records terminal outcome structure fail-closed while keeping evidence aggregated", async () => {
		const audit = createHarnessDisciplineAudit();
		executionEnd(audit, "orphan", "calculate", "body_success");
		executionStart(audit, "orphan");
		executionEnd(audit, "orphan", "calculate", "body_error");
		executionStart(audit, "invalid");
		audit.observeHarnessEvent({
			type: "tool_execution_end",
			toolCallId: "invalid",
			toolName: "calculate",
			result: {},
			isError: true,
			attemptOutcome: "private-invalid-outcome",
		} as unknown as AgentHarnessEvent);
		executionStart(audit, "private-call-id-7");
		executionEnd(audit, "private-call-id-7", "different", "body_success");
		executionStart(audit, "late");
		settle(audit);
		executionEnd(audit, "late", "calculate", "body_success");

		const report = await verifyAudit(audit, {
			requireEveryExecutionAuthorized: false,
			deniedAttempts: "allow",
			minAuthorizationDecisions: 0,
			requireEveryAttemptOutcome: false,
		});
		expect(audit.snapshot().attemptOutcomes).toMatchObject({ observed: 0, missing: 4 });
		expect(violationCodes(report)).toEqual([
			"invalid_attempt_outcome",
			"outcome_without_attempt",
			"duplicate_attempt_outcome",
			"late_attempt_outcome",
			"tool_name_mismatch",
		]);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("private-invalid-outcome");
		expect(serialized).not.toContain("orphan");
		expect(serialized).not.toContain("private-call-id-7");
		expect(serialized).not.toContain("different");
	});

	it("applies explicit terminal outcome completeness and allowlist policies", async () => {
		const audit = createHarnessDisciplineAudit();
		executionStart(audit, "missing");
		executionStart(audit, "failed");
		executionEnd(audit, "failed", "calculate", "body_error");
		settle(audit);

		expect(audit.snapshot().attemptOutcomes).toMatchObject({
			observed: 1,
			missing: 1,
			counts: { body_error: 1 },
		});
		const report = await verifyAudit(audit, {
			requireEveryExecutionAuthorized: false,
			deniedAttempts: "allow",
			minAuthorizationDecisions: 0,
			requireEveryAttemptOutcome: true,
			allowedAttemptOutcomes: ["body_success"],
		});
		expect(violationCodes(report)).toEqual(["attempt_without_outcome", "attempt_outcome_not_allowed"]);
	});

	it("correlates the actual Harness start-before-authorization order and terminal settlement", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "harness-discipline-audit" });
		faux.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "5 + 7" }, { id: "real-call" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		models.setProvider(faux.provider);
		const audit = createHarnessDisciplineAudit();
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: faux.getModel(),
			tools: [calculateTool],
			toolPolicy: createToolPolicyAdapter({
				policy: { revision: "actual-policy@1", rules: [], default: { effect: "allow", reason: "test" } },
				specs: [calculateSpec],
				observeAuthorization: audit.observeAuthorization,
			}),
		});
		harness.subscribe(audit.observeHarnessEvent);

		await harness.prompt("calculate");

		expect(audit.snapshot()).toMatchObject({
			authorizationDecisions: { total: 1, allowed: 1 },
			executionAttempts: { total: 1, allowed: 1, unresolved: 0 },
			attemptOutcomes: { observed: 1, missing: 0, counts: { body_success: 1 } },
			settlement: { observed: true, nextTurnCount: 0 },
			anomalies: { authorizationWithoutAttempt: 0 },
		});
		expect((await verifyAudit(audit, { expectedPolicyRevision: "actual-policy@1" })).status).toBe("pass");
	});

	it("classifies real invalid arguments, hook blocks, and policy denials without false structural anomalies", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "harness-discipline-blocked-paths" });
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("calculate", { wrong: 42 }, { id: "invalid-args" }),
						fauxToolCall("calculate", { expression: "1 + 1" }, { id: "hook-blocked" }),
						fauxToolCall("calculate", { expression: "2 + 2" }, { id: "policy-denied" }),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("done"),
		]);
		models.setProvider(faux.provider);
		const audit = createHarnessDisciplineAudit();
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: faux.getModel(),
			tools: [calculateTool],
			toolPolicy: createToolPolicyAdapter({
				policy: { revision: "deny-policy@1", rules: [], default: { effect: "deny", reason: "test" } },
				specs: [calculateSpec],
				observeAuthorization: audit.observeAuthorization,
			}),
		});
		let validToolCallCount = 0;
		harness.on("tool_call", () => {
			validToolCallCount++;
			return validToolCallCount === 1 ? { block: true, reason: "test hook block" } : undefined;
		});
		harness.subscribe(audit.observeHarnessEvent);

		await harness.prompt("exercise blocked tool paths");

		expect(audit.snapshot()).toMatchObject({
			authorizationDecisions: { total: 1, denied: 1 },
			executionAttempts: { total: 3, withDecision: 1, denied: 1, unresolved: 2 },
			attemptOutcomes: {
				observed: 3,
				missing: 0,
				counts: { not_executed_preparation_error: 1, not_executed_blocked: 2 },
			},
			settlement: { observed: true, nextTurnCount: 0 },
			anomalies: {
				invalidAuthorizationObservations: 0,
				invalidHarnessEvents: 0,
				authorizationWithoutAttempt: 0,
				toolNameMismatches: 0,
			},
		});
		const report = await verifyAudit(audit, { expectedPolicyRevision: "deny-policy@1" });
		expect(violationCodes(report)).toEqual(["attempt_without_decision", "attempt_not_allowed", "denied_attempt"]);
	});
});
