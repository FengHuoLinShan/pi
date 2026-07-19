import { createHash } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { AgentHarness } from "../harness/agent-harness.ts";
import { NodeExecutionEnv } from "../harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../harness/session/memory-storage.ts";
import { Session } from "../harness/session/session.ts";
import type { AgentHarnessEvent } from "../harness/types.ts";
import type { AgentMessage, AgentRunTermination, AgentRunUsage, AgentTool } from "../types.ts";
import type {
	AgentHarnessEvalAssistantResponse,
	AgentHarnessEvalExpectedToolCall,
	AgentHarnessEvalScenario,
	AgentHarnessEvalSuite,
	AgentHarnessEvalTerminationExpectation,
	AgentHarnessEvalToolFixture,
	AgentHarnessEvalUsageExpectation,
} from "./schema.ts";

export interface AgentHarnessEvalThresholds {
	minimumPassRate: number;
	maximumFailedScenarios: number;
	maximumRegressions: number;
	maximumUnbaselinedScenarios: number;
	requireReplayDeterminism: boolean;
}

export const DEFAULT_AGENT_HARNESS_EVAL_THRESHOLDS: AgentHarnessEvalThresholds = {
	minimumPassRate: 1,
	maximumFailedScenarios: 0,
	maximumRegressions: 0,
	maximumUnbaselinedScenarios: 0,
	requireReplayDeterminism: true,
};

export interface AgentHarnessEvalAssertionResult {
	name: string;
	passed: boolean;
	expected?: unknown;
	actual?: unknown;
	message?: string;
}

export interface AgentHarnessEvalToolCallResult {
	id: string;
	name: string;
	arguments: unknown;
	result?: unknown;
	isError?: boolean;
}

export interface AgentHarnessEvalTerminationResult {
	status: "completed" | AgentRunTermination["status"];
	reason?: string;
	details?: AgentRunTermination;
}

export interface AgentHarnessEvalUsageResult extends Omit<AgentRunUsage, "elapsedMs"> {
	elapsedMs: number;
}

export interface AgentHarnessEvalReplayResult {
	enabled: boolean;
	deterministic: boolean;
	firstDigest: string;
	secondDigest?: string;
}

export interface AgentHarnessEvalScenarioResult {
	id: string;
	description?: string;
	passed: boolean;
	assertions: AgentHarnessEvalAssertionResult[];
	eventSequence: string[];
	toolCalls: AgentHarnessEvalToolCallResult[];
	finalOutput: string;
	termination: AgentHarnessEvalTerminationResult;
	usage: AgentHarnessEvalUsageResult;
	replay: AgentHarnessEvalReplayResult;
	signature: string;
	error?: string;
}

export interface AgentHarnessEvalBaselineScenario {
	passed: boolean;
	signature: string;
}

export interface AgentHarnessEvalBaseline {
	version: 1;
	suiteName: string;
	createdAt: string;
	thresholds: AgentHarnessEvalThresholds;
	scenarios: Record<string, AgentHarnessEvalBaselineScenario>;
}

export interface AgentHarnessEvalBaselineComparison {
	passed: boolean;
	passRate: number;
	failedScenarios: string[];
	regressions: string[];
	unbaselinedScenarios: string[];
	removedScenarios: string[];
	replayFailures: string[];
	violations: string[];
}

export interface AgentHarnessEvalReport {
	version: 1;
	suiteName: string;
	generatedAt: string;
	passed: boolean;
	passRate: number;
	scenarios: AgentHarnessEvalScenarioResult[];
	baselineComparison?: AgentHarnessEvalBaselineComparison;
}

export interface RunAgentHarnessEvalSuiteOptions {
	cwd?: string;
	baseline?: AgentHarnessEvalBaseline;
	thresholds?: Partial<AgentHarnessEvalThresholds>;
}

interface ScenarioRunSnapshot {
	eventSequence: string[];
	toolCalls: AgentHarnessEvalToolCallResult[];
	finalOutput: string;
	termination: AgentHarnessEvalTerminationResult;
	usage: AgentHarnessEvalUsageResult;
	error?: string;
}

const fixtureToolParameters = Type.Object({}, { additionalProperties: true });

function normalizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (value === undefined) return "[undefined]";
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function") return "[function]";
	if (typeof value === "symbol") return String(value);
	if (Array.isArray(value)) return value.map((item) => normalizeValue(item, seen));
	if (typeof value === "object") {
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const propertyValue = (value as Record<string, unknown>)[key];
			if (propertyValue !== undefined) normalized[key] = normalizeValue(propertyValue, seen);
		}
		seen.delete(value);
		return normalized;
	}
	return String(value);
}

function stableStringify(value: unknown): string {
	return JSON.stringify(normalizeValue(value));
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((content) =>
			content && typeof content === "object" && "type" in content && content.type === "text" && "text" in content
				? [String(content.text)]
				: [],
		)
		.join("");
}

function messageRole(message: AgentMessage): string {
	return "role" in message && typeof message.role === "string" ? message.role : "unknown";
}

function eventKey(event: AgentHarnessEvent): string | undefined {
	switch (event.type) {
		case "message_update":
		case "tool_execution_update":
			return undefined;
		case "message_start":
		case "message_end":
			return `${event.type}:${messageRole(event.message)}`;
		case "tool_execution_start":
		case "tool_execution_end":
			return `${event.type}:${event.toolName}`;
		case "turn_end":
			return event.message.role === "assistant"
				? `${event.type}:${event.message.stopReason}`
				: `${event.type}:${messageRole(event.message)}`;
		case "agent_termination":
			return `${event.type}:${event.termination.status}:${event.termination.reason}`;
		default:
			return event.type;
	}
}

function createResponse(response: AgentHarnessEvalAssistantResponse) {
	const content = response.content.map((block) =>
		block.type === "text" ? fauxText(block.text) : fauxToolCall(block.name, block.arguments, { id: block.id }),
	);
	const inferredStopReason = response.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
	return fauxAssistantMessage(content, {
		stopReason: response.stopReason ?? inferredStopReason,
		errorMessage: response.errorMessage,
	});
}

function createFixtureTool(fixture: AgentHarnessEvalToolFixture): AgentTool<typeof fixtureToolParameters, unknown> {
	let responseIndex = 0;
	return {
		name: fixture.name,
		label: fixture.label ?? fixture.name,
		description: fixture.description ?? `Deterministic eval fixture for ${fixture.name}`,
		parameters: fixtureToolParameters,
		async execute() {
			const response = fixture.responses[responseIndex++];
			if (!response) throw new Error(`No fixture response left for tool ${fixture.name}`);
			if ("error" in response) throw new Error(response.error);
			return {
				content: response.content.map((content) => ({ type: "text" as const, text: content.text })),
				details: response.details,
				terminate: response.terminate,
			};
		},
	};
}

function getToolResultContent(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const record = result as Record<string, unknown>;
	return {
		content: record.content,
		details: record.details,
		terminate: record.terminate,
	};
}

function snapshotForReplay(snapshot: ScenarioRunSnapshot): unknown {
	return {
		eventSequence: snapshot.eventSequence,
		toolCalls: snapshot.toolCalls,
		finalOutput: snapshot.finalOutput,
		termination: snapshot.termination,
		usage: {
			steps: snapshot.usage.steps,
			modelCalls: snapshot.usage.modelCalls,
			toolCalls: snapshot.usage.toolCalls,
			modelTokens: snapshot.usage.modelTokens,
			cost: snapshot.usage.cost,
		},
		error: snapshot.error,
	};
}

async function runScenarioOnce(scenario: AgentHarnessEvalScenario, cwd: string): Promise<ScenarioRunSnapshot> {
	const faux = fauxProvider({ provider: `faux-eval-${scenario.id}`, tokenSize: { min: 4, max: 4 } });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(scenario.responses.map(createResponse));
	const harness = new AgentHarness({
		models,
		env: new NodeExecutionEnv({ cwd }),
		session: new Session(new InMemorySessionStorage()),
		model: faux.getModel(),
		systemPrompt: scenario.systemPrompt ?? "You are a deterministic eval assistant.",
		tools: (scenario.tools ?? []).map(createFixtureTool),
		runBudget: scenario.runBudget,
		loopDetection: scenario.loopDetection,
	});
	const events: AgentHarnessEvent[] = [];
	harness.subscribe((event) => {
		events.push(event);
	});
	const startedAt = performance.now();
	let finalOutput = "";
	let runError: string | undefined;
	try {
		finalOutput = messageText(await harness.prompt(scenario.prompt));
	} catch (error) {
		runError = error instanceof Error ? error.message : String(error);
	}

	const eventSequence = events.flatMap((event) => {
		const key = eventKey(event);
		return key ? [key] : [];
	});
	const toolCalls: AgentHarnessEvalToolCallResult[] = [];
	for (const event of events) {
		if (event.type === "tool_execution_start") {
			toolCalls.push({ id: event.toolCallId, name: event.toolName, arguments: normalizeValue(event.args) });
		} else if (event.type === "tool_execution_end") {
			const call = toolCalls.find((candidate) => candidate.id === event.toolCallId);
			if (call) {
				call.result = normalizeValue(getToolResultContent(event.result));
				call.isError = event.isError;
			}
		}
	}

	const terminationEvent = events.find(
		(event): event is Extract<AgentHarnessEvent, { type: "agent_termination" }> => event.type === "agent_termination",
	);
	const termination: AgentHarnessEvalTerminationResult = terminationEvent
		? {
				status: terminationEvent.termination.status,
				reason: terminationEvent.termination.reason,
				details: normalizeValue(terminationEvent.termination) as AgentRunTermination,
			}
		: { status: "completed" };
	const assistantMessages = events.filter(
		(event): event is Extract<AgentHarnessEvent, { type: "message_end" }> =>
			event.type === "message_end" && event.message.role === "assistant",
	);
	const computedUsage: AgentHarnessEvalUsageResult = {
		steps: events.filter((event) => event.type === "turn_start").length,
		modelCalls: assistantMessages.length,
		toolCalls: events.filter((event) => event.type === "tool_execution_start").length,
		modelTokens: assistantMessages.reduce(
			(sum, event) => sum + (event.message.role === "assistant" ? event.message.usage.totalTokens : 0),
			0,
		),
		cost: assistantMessages.reduce(
			(sum, event) => sum + (event.message.role === "assistant" ? event.message.usage.cost.total : 0),
			0,
		),
		elapsedMs: Math.max(0, performance.now() - startedAt),
	};
	const usage = terminationEvent
		? { ...terminationEvent.usage, elapsedMs: Math.max(0, performance.now() - startedAt) }
		: computedUsage;

	return { eventSequence, toolCalls, finalOutput, termination, usage, error: runError };
}

function includesOrdered(
	actual: readonly string[],
	expected: readonly string[],
): { passed: boolean; missing?: string } {
	let actualIndex = 0;
	for (const expectedEvent of expected) {
		while (actualIndex < actual.length && actual[actualIndex] !== expectedEvent) actualIndex++;
		if (actualIndex >= actual.length) return { passed: false, missing: expectedEvent };
		actualIndex++;
	}
	return { passed: true };
}

function compareToolCalls(
	actual: AgentHarnessEvalToolCallResult[],
	expected: AgentHarnessEvalExpectedToolCall[],
): boolean {
	return (
		stableStringify(actual.map(({ name, arguments: args }) => ({ name, arguments: args }))) ===
		stableStringify(expected)
	);
}

function assertTermination(
	actual: AgentHarnessEvalTerminationResult,
	expected: AgentHarnessEvalTerminationExpectation,
): boolean {
	return actual.status === expected.status && (expected.reason === undefined || actual.reason === expected.reason);
}

function usageAssertions(
	actual: AgentHarnessEvalUsageResult,
	expected: AgentHarnessEvalUsageExpectation,
): AgentHarnessEvalAssertionResult[] {
	const results: AgentHarnessEvalAssertionResult[] = [];
	for (const field of ["steps", "modelCalls", "toolCalls"] as const) {
		if (expected[field] !== undefined) {
			results.push({
				name: `usage.${field}`,
				passed: actual[field] === expected[field],
				expected: expected[field],
				actual: actual[field],
			});
		}
	}
	if (expected.maxModelTokens !== undefined) {
		results.push({
			name: "usage.maxModelTokens",
			passed: actual.modelTokens <= expected.maxModelTokens,
			expected: `<= ${expected.maxModelTokens}`,
			actual: actual.modelTokens,
		});
	}
	if (expected.maxCost !== undefined) {
		results.push({
			name: "usage.maxCost",
			passed: actual.cost <= expected.maxCost,
			expected: `<= ${expected.maxCost}`,
			actual: actual.cost,
		});
	}
	return results;
}

function evaluateAssertions(
	scenario: AgentHarnessEvalScenario,
	snapshot: ScenarioRunSnapshot,
): AgentHarnessEvalAssertionResult[] {
	const assertions: AgentHarnessEvalAssertionResult[] = [];
	if (snapshot.error) assertions.push({ name: "runner", passed: false, actual: snapshot.error });
	if (scenario.assertions.eventOrder) {
		const result = includesOrdered(snapshot.eventSequence, scenario.assertions.eventOrder);
		assertions.push({
			name: "eventOrder",
			passed: result.passed,
			expected: scenario.assertions.eventOrder,
			actual: snapshot.eventSequence,
			message: result.missing ? `Missing ordered event ${result.missing}` : undefined,
		});
	}
	if (scenario.assertions.toolCalls) {
		assertions.push({
			name: "toolCalls",
			passed: compareToolCalls(snapshot.toolCalls, scenario.assertions.toolCalls),
			expected: scenario.assertions.toolCalls,
			actual: snapshot.toolCalls.map(({ name, arguments: args }) => ({ name, arguments: args })),
		});
	}
	if (scenario.assertions.finalOutput) {
		const expectation = scenario.assertions.finalOutput;
		if (expectation.equals !== undefined) {
			assertions.push({
				name: "finalOutput.equals",
				passed: snapshot.finalOutput === expectation.equals,
				expected: expectation.equals,
				actual: snapshot.finalOutput,
			});
		}
		if (expectation.contains !== undefined) {
			assertions.push({
				name: "finalOutput.contains",
				passed: snapshot.finalOutput.includes(expectation.contains),
				expected: expectation.contains,
				actual: snapshot.finalOutput,
			});
		}
	}
	if (scenario.assertions.termination) {
		assertions.push({
			name: "termination",
			passed: assertTermination(snapshot.termination, scenario.assertions.termination),
			expected: scenario.assertions.termination,
			actual: snapshot.termination,
		});
	}
	if (scenario.assertions.usage) assertions.push(...usageAssertions(snapshot.usage, scenario.assertions.usage));
	return assertions;
}

async function runScenario(scenario: AgentHarnessEvalScenario, cwd: string): Promise<AgentHarnessEvalScenarioResult> {
	const first = await runScenarioOnce(scenario, cwd);
	const firstDigest = digest(snapshotForReplay(first));
	const replayEnabled = scenario.assertions.replayDeterministic === true;
	const second = replayEnabled ? await runScenarioOnce(scenario, cwd) : undefined;
	const secondDigest = second ? digest(snapshotForReplay(second)) : undefined;
	const replay = {
		enabled: replayEnabled,
		deterministic: !replayEnabled || firstDigest === secondDigest,
		firstDigest,
		secondDigest,
	};
	const assertions = evaluateAssertions(scenario, first);
	if (replayEnabled) {
		assertions.push({
			name: "replayDeterministic",
			passed: replay.deterministic,
			expected: firstDigest,
			actual: secondDigest,
		});
	}
	const signature = digest(snapshotForReplay(first));
	return {
		id: scenario.id,
		description: scenario.description,
		passed: assertions.every((assertion) => assertion.passed),
		assertions,
		eventSequence: first.eventSequence,
		toolCalls: first.toolCalls,
		finalOutput: first.finalOutput,
		termination: first.termination,
		usage: first.usage,
		replay,
		signature,
		error: first.error,
	};
}

function resolveThresholds(
	baseline: AgentHarnessEvalBaseline | undefined,
	overrides: Partial<AgentHarnessEvalThresholds> | undefined,
): AgentHarnessEvalThresholds {
	const thresholds = { ...DEFAULT_AGENT_HARNESS_EVAL_THRESHOLDS, ...baseline?.thresholds, ...overrides };
	validateAgentHarnessEvalThresholds(thresholds);
	return thresholds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject quality gates whose ranges would make comparisons ambiguous or ineffective. */
export function validateAgentHarnessEvalThresholds(thresholds: AgentHarnessEvalThresholds): AgentHarnessEvalThresholds {
	if (
		!Number.isFinite(thresholds.minimumPassRate) ||
		thresholds.minimumPassRate < 0 ||
		thresholds.minimumPassRate > 1
	) {
		throw new Error("minimumPassRate must be between 0 and 1");
	}
	for (const field of ["maximumFailedScenarios", "maximumRegressions", "maximumUnbaselinedScenarios"] as const) {
		if (!Number.isInteger(thresholds[field]) || thresholds[field] < 0) {
			throw new Error(`${field} must be a non-negative integer`);
		}
	}
	if (typeof thresholds.requireReplayDeterminism !== "boolean") {
		throw new Error("requireReplayDeterminism must be boolean");
	}
	return thresholds;
}

/** Parse and validate a versioned baseline loaded from JSON. */
export function parseAgentHarnessEvalBaseline(value: unknown): AgentHarnessEvalBaseline {
	if (!isRecord(value) || value.version !== 1) throw new Error("Invalid AgentHarness eval baseline version");
	if (typeof value.suiteName !== "string" || value.suiteName.length === 0) {
		throw new Error("Invalid AgentHarness eval baseline suiteName");
	}
	if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
		throw new Error("Invalid AgentHarness eval baseline createdAt");
	}
	if (!isRecord(value.thresholds)) throw new Error("Invalid AgentHarness eval baseline thresholds");
	const thresholds = validateAgentHarnessEvalThresholds({
		minimumPassRate: value.thresholds.minimumPassRate as number,
		maximumFailedScenarios: value.thresholds.maximumFailedScenarios as number,
		maximumRegressions: value.thresholds.maximumRegressions as number,
		maximumUnbaselinedScenarios: value.thresholds.maximumUnbaselinedScenarios as number,
		requireReplayDeterminism: value.thresholds.requireReplayDeterminism as boolean,
	});
	if (!isRecord(value.scenarios)) throw new Error("Invalid AgentHarness eval baseline scenarios");
	const scenarios: Record<string, AgentHarnessEvalBaselineScenario> = {};
	for (const [id, scenario] of Object.entries(value.scenarios)) {
		if (
			!isRecord(scenario) ||
			typeof scenario.passed !== "boolean" ||
			typeof scenario.signature !== "string" ||
			scenario.signature.length === 0
		) {
			throw new Error(`Invalid AgentHarness eval baseline scenario ${id}`);
		}
		scenarios[id] = { passed: scenario.passed, signature: scenario.signature };
	}
	return {
		version: 1,
		suiteName: value.suiteName,
		createdAt: value.createdAt,
		thresholds,
		scenarios,
	};
}

export function compareAgentHarnessEvalReport(
	report: AgentHarnessEvalReport,
	baseline: AgentHarnessEvalBaseline,
	thresholdOverrides?: Partial<AgentHarnessEvalThresholds>,
): AgentHarnessEvalBaselineComparison {
	if (baseline.version !== 1) throw new Error(`Unsupported AgentHarness eval baseline version ${baseline.version}`);
	if (baseline.suiteName !== report.suiteName) {
		throw new Error(`Eval baseline suite ${baseline.suiteName} does not match report suite ${report.suiteName}`);
	}
	const thresholds = resolveThresholds(baseline, thresholdOverrides);
	const currentById = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
	const failedScenarios = report.scenarios.filter((scenario) => !scenario.passed).map((scenario) => scenario.id);
	const unbaselinedScenarios = report.scenarios
		.filter((scenario) => !baseline.scenarios[scenario.id])
		.map((scenario) => scenario.id);
	const removedScenarios = Object.keys(baseline.scenarios).filter((id) => !currentById.has(id));
	const regressions = report.scenarios.flatMap((scenario) => {
		const previous = baseline.scenarios[scenario.id];
		if (!previous) return [];
		return previous.signature !== scenario.signature || (previous.passed && !scenario.passed) ? [scenario.id] : [];
	});
	regressions.push(...removedScenarios);
	const replayFailures = report.scenarios
		.filter((scenario) => !scenario.replay.enabled || !scenario.replay.deterministic)
		.map((scenario) => scenario.id);
	const violations: string[] = [];
	if (report.passRate < thresholds.minimumPassRate) {
		violations.push(`Pass rate ${report.passRate} is below ${thresholds.minimumPassRate}`);
	}
	if (failedScenarios.length > thresholds.maximumFailedScenarios) {
		violations.push(`Failed scenarios ${failedScenarios.length} exceed ${thresholds.maximumFailedScenarios}`);
	}
	if (regressions.length > thresholds.maximumRegressions) {
		violations.push(`Regressions ${regressions.length} exceed ${thresholds.maximumRegressions}`);
	}
	if (unbaselinedScenarios.length > thresholds.maximumUnbaselinedScenarios) {
		violations.push(
			`Unbaselined scenarios ${unbaselinedScenarios.length} exceed ${thresholds.maximumUnbaselinedScenarios}`,
		);
	}
	if (thresholds.requireReplayDeterminism && replayFailures.length > 0) {
		violations.push(`Replay determinism failed for: ${replayFailures.join(", ")}`);
	}
	return {
		passed: violations.length === 0,
		passRate: report.passRate,
		failedScenarios,
		regressions: [...new Set(regressions)],
		unbaselinedScenarios,
		removedScenarios,
		replayFailures,
		violations,
	};
}

export function createAgentHarnessEvalBaseline(
	report: AgentHarnessEvalReport,
	thresholds: AgentHarnessEvalThresholds = DEFAULT_AGENT_HARNESS_EVAL_THRESHOLDS,
): AgentHarnessEvalBaseline {
	if (!report.passed) throw new Error("Refusing to create an eval baseline from a failing report");
	validateAgentHarnessEvalThresholds(thresholds);
	if (thresholds.requireReplayDeterminism) {
		const replayFailures = report.scenarios
			.filter((scenario) => !scenario.replay.enabled || !scenario.replay.deterministic)
			.map((scenario) => scenario.id);
		if (replayFailures.length > 0) {
			throw new Error(
				`Refusing to create an eval baseline without deterministic replay for: ${replayFailures.join(", ")}`,
			);
		}
	}
	return {
		version: 1,
		suiteName: report.suiteName,
		createdAt: new Date().toISOString(),
		thresholds: { ...thresholds },
		scenarios: Object.fromEntries(
			report.scenarios.map((scenario) => [scenario.id, { passed: scenario.passed, signature: scenario.signature }]),
		),
	};
}

/** Run the suite entirely against fresh in-memory sessions and faux providers. */
export async function runAgentHarnessEvalSuite(
	suite: AgentHarnessEvalSuite,
	options: RunAgentHarnessEvalSuiteOptions = {},
): Promise<AgentHarnessEvalReport> {
	const scenarios: AgentHarnessEvalScenarioResult[] = [];
	for (const scenario of suite.scenarios) scenarios.push(await runScenario(scenario, options.cwd ?? process.cwd()));
	const passedCount = scenarios.filter((scenario) => scenario.passed).length;
	const passRate = scenarios.length === 0 ? 0 : passedCount / scenarios.length;
	const report: AgentHarnessEvalReport = {
		version: 1,
		suiteName: suite.name,
		generatedAt: new Date().toISOString(),
		passed: scenarios.every((scenario) => scenario.passed),
		passRate,
		scenarios,
	};
	if (options.baseline) {
		report.baselineComparison = compareAgentHarnessEvalReport(report, options.baseline, options.thresholds);
		report.passed = report.passed && report.baselineComparison.passed;
	}
	return report;
}
