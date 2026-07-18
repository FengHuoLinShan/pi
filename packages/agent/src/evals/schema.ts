import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const AGENT_HARNESS_EVAL_VERSION = 1 as const;

const textContentSchema = Type.Object(
	{
		type: Type.Literal("text"),
		text: Type.String(),
	},
	{ additionalProperties: false },
);

const toolCallContentSchema = Type.Object(
	{
		type: Type.Literal("toolCall"),
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		arguments: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: false },
);

const assistantResponseSchema = Type.Object(
	{
		content: Type.Array(Type.Union([textContentSchema, toolCallContentSchema]), { minItems: 1 }),
		stopReason: Type.Optional(
			Type.Union([
				Type.Literal("stop"),
				Type.Literal("length"),
				Type.Literal("toolUse"),
				Type.Literal("error"),
				Type.Literal("aborted"),
			]),
		),
		errorMessage: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const toolResultSchema = Type.Object(
	{
		content: Type.Array(textContentSchema, { minItems: 1 }),
		details: Type.Optional(Type.Unknown()),
		terminate: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const toolErrorSchema = Type.Object({ error: Type.String() }, { additionalProperties: false });

const toolFixtureSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		label: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		responses: Type.Array(Type.Union([toolResultSchema, toolErrorSchema]), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const expectedToolCallSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		arguments: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: false },
);

const finalOutputExpectationSchema = Type.Object(
	{
		equals: Type.Optional(Type.String()),
		contains: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const terminationExpectationSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("completed"),
			Type.Literal("budget_exhausted"),
			Type.Literal("deadline_exceeded"),
			Type.Literal("loop_detected"),
		]),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const usageExpectationSchema = Type.Object(
	{
		steps: Type.Optional(Type.Integer({ minimum: 0 })),
		modelCalls: Type.Optional(Type.Integer({ minimum: 0 })),
		toolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
		maxModelTokens: Type.Optional(Type.Number({ minimum: 0 })),
		maxCost: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

const assertionsSchema = Type.Object(
	{
		eventOrder: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		toolCalls: Type.Optional(Type.Array(expectedToolCallSchema)),
		finalOutput: Type.Optional(finalOutputExpectationSchema),
		termination: Type.Optional(terminationExpectationSchema),
		usage: Type.Optional(usageExpectationSchema),
		replayDeterministic: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const runBudgetSchema = Type.Object(
	{
		maxSteps: Type.Optional(Type.Integer({ minimum: 1 })),
		maxModelCalls: Type.Optional(Type.Integer({ minimum: 1 })),
		maxToolCalls: Type.Optional(Type.Integer({ minimum: 1 })),
		maxWallTimeMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		maxModelTokens: Type.Optional(Type.Number({ minimum: 0 })),
		maxCost: Type.Optional(Type.Number({ minimum: 0 })),
		deadline: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

const loopDetectionSchema = Type.Object(
	{
		maxConsecutiveToolCalls: Type.Integer({ minimum: 2 }),
		includeToolResult: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const AgentHarnessEvalScenarioSchema = Type.Object(
	{
		version: Type.Literal(AGENT_HARNESS_EVAL_VERSION),
		id: Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9._-]*$" }),
		description: Type.Optional(Type.String()),
		prompt: Type.String(),
		systemPrompt: Type.Optional(Type.String()),
		responses: Type.Array(assistantResponseSchema, { minItems: 1 }),
		tools: Type.Optional(Type.Array(toolFixtureSchema)),
		runBudget: Type.Optional(runBudgetSchema),
		loopDetection: Type.Optional(loopDetectionSchema),
		assertions: assertionsSchema,
	},
	{ additionalProperties: false },
);

export const AgentHarnessEvalSuiteSchema = Type.Object(
	{
		version: Type.Literal(AGENT_HARNESS_EVAL_VERSION),
		name: Type.String({ minLength: 1 }),
		scenarios: Type.Array(AgentHarnessEvalScenarioSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type AgentHarnessEvalScenario = Static<typeof AgentHarnessEvalScenarioSchema>;
export type AgentHarnessEvalSuite = Static<typeof AgentHarnessEvalSuiteSchema>;
export type AgentHarnessEvalAssistantResponse = Static<typeof assistantResponseSchema>;
export type AgentHarnessEvalToolFixture = Static<typeof toolFixtureSchema>;
export type AgentHarnessEvalExpectedToolCall = Static<typeof expectedToolCallSchema>;
export type AgentHarnessEvalTerminationExpectation = Static<typeof terminationExpectationSchema>;
export type AgentHarnessEvalUsageExpectation = Static<typeof usageExpectationSchema>;

function validateScenarioSemantics(suite: AgentHarnessEvalSuite): void {
	const scenarioIds = new Set<string>();
	for (const scenario of suite.scenarios) {
		if (scenarioIds.has(scenario.id)) throw new Error(`Duplicate eval scenario id: ${scenario.id}`);
		scenarioIds.add(scenario.id);

		const toolNames = new Set<string>();
		for (const tool of scenario.tools ?? []) {
			if (toolNames.has(tool.name)) throw new Error(`Scenario ${scenario.id} has duplicate tool ${tool.name}`);
			toolNames.add(tool.name);
		}

		for (const response of scenario.responses) {
			for (const content of response.content) {
				if (content.type === "toolCall" && !toolNames.has(content.name)) {
					throw new Error(`Scenario ${scenario.id} calls undeclared tool ${content.name}`);
				}
			}
		}
		if (
			scenario.assertions.finalOutput &&
			scenario.assertions.finalOutput.equals === undefined &&
			scenario.assertions.finalOutput.contains === undefined
		) {
			throw new Error(`Scenario ${scenario.id} finalOutput requires equals or contains`);
		}
	}
}

/** Validate untrusted JSON and return the typed deterministic eval suite. */
export function parseAgentHarnessEvalSuite(value: unknown): AgentHarnessEvalSuite {
	if (!Value.Check(AgentHarnessEvalSuiteSchema, value)) {
		const firstError = Value.Errors(AgentHarnessEvalSuiteSchema, value)[0];
		const detail = firstError
			? `${firstError.instancePath || "/"}: ${firstError.message}`
			: "unknown validation error";
		throw new Error(`Invalid AgentHarness eval suite: ${detail}`);
	}
	validateScenarioSemantics(value);
	return value;
}
