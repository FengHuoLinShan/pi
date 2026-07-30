import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const CAPABILITY_EVAL_VERSION = 1 as const;

const layerSchema = Type.Union([Type.Literal("offline"), Type.Literal("browser"), Type.Literal("live")]);

const budgetSchema = Type.Object(
	{
		maxWallTimeMs: Type.Optional(Type.Integer({ minimum: 1 })),
		maxModelRequests: Type.Optional(Type.Integer({ minimum: 0 })),
		maxToolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
		maxTotalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

const attemptPolicySchema = Type.Object(
	{
		count: Type.Integer({ minimum: 1, maximum: 100 }),
		minimumPassing: Type.Integer({ minimum: 1, maximum: 100 }),
	},
	{ additionalProperties: false },
);

const driverSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

const outputVerifierSchema = Type.Object(
	{
		type: Type.Literal("output"),
		operator: Type.Union([Type.Literal("equals"), Type.Literal("contains"), Type.Literal("matches")]),
		expected: Type.String(),
	},
	{ additionalProperties: false },
);

const traceOrderVerifierSchema = Type.Object(
	{
		type: Type.Literal("trace_order"),
		expected: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const lifecycleOrderVerifierSchema = Type.Object(
	{
		type: Type.Literal("lifecycle_order"),
		expected: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const metricVerifierSchema = Type.Object(
	{
		type: Type.Literal("metric"),
		metric: Type.Union([
			Type.Literal("wallTimeMs"),
			Type.Literal("modelRequests"),
			Type.Literal("toolCalls"),
			Type.Literal("totalTokens"),
			Type.Literal("orphanProcesses"),
		]),
		operator: Type.Union([Type.Literal("equals"), Type.Literal("lte"), Type.Literal("gte")]),
		expected: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const artifactExistsVerifierSchema = Type.Object(
	{
		type: Type.Literal("artifact_exists"),
		path: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const artifactContainsVerifierSchema = Type.Object(
	{
		type: Type.Literal("artifact_contains"),
		path: Type.String({ minLength: 1 }),
		expected: Type.String(),
	},
	{ additionalProperties: false },
);

const artifactJsonVerifierSchema = Type.Object(
	{
		type: Type.Literal("artifact_json"),
		path: Type.String({ minLength: 1 }),
		pointer: Type.String({ pattern: "^(?:|/.*)$" }),
		expected: Type.Unknown(),
	},
	{ additionalProperties: false },
);

const customVerifierSchema = Type.Object(
	{
		type: Type.Literal("custom"),
		name: Type.String({ minLength: 1 }),
		config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const CapabilityEvalVerifierSchema = Type.Union([
	outputVerifierSchema,
	traceOrderVerifierSchema,
	lifecycleOrderVerifierSchema,
	metricVerifierSchema,
	artifactExistsVerifierSchema,
	artifactContainsVerifierSchema,
	artifactJsonVerifierSchema,
	customVerifierSchema,
]);

export const CapabilityEvalScenarioSchema = Type.Object(
	{
		version: Type.Literal(CAPABILITY_EVAL_VERSION),
		id: Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9._-]*$" }),
		description: Type.Optional(Type.String()),
		layer: layerSchema,
		task: Type.String({ minLength: 1 }),
		driver: driverSchema,
		budgets: Type.Optional(budgetSchema),
		attempts: Type.Optional(attemptPolicySchema),
		verifiers: Type.Array(CapabilityEvalVerifierSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const CapabilityEvalSuiteSchema = Type.Object(
	{
		version: Type.Literal(CAPABILITY_EVAL_VERSION),
		name: Type.String({ minLength: 1 }),
		defaults: Type.Optional(
			Type.Object(
				{
					budgets: Type.Optional(budgetSchema),
					attempts: Type.Optional(attemptPolicySchema),
				},
				{ additionalProperties: false },
			),
		),
		scenarios: Type.Array(CapabilityEvalScenarioSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type CapabilityEvalLayer = Static<typeof layerSchema>;
export type CapabilityEvalBudgets = Static<typeof budgetSchema>;
export type CapabilityEvalAttemptPolicy = Static<typeof attemptPolicySchema>;
export type CapabilityEvalVerifier = Static<typeof CapabilityEvalVerifierSchema>;
export type CapabilityEvalScenario = Static<typeof CapabilityEvalScenarioSchema>;
export type CapabilityEvalSuite = Static<typeof CapabilityEvalSuiteSchema>;

function validateAttempts(id: string, attempts: CapabilityEvalAttemptPolicy): void {
	if (attempts.minimumPassing > attempts.count) {
		throw new Error(`Capability eval scenario ${id} minimumPassing exceeds attempt count`);
	}
}

function validateSemantics(suite: CapabilityEvalSuite): void {
	const scenarioIds = new Set<string>();
	if (suite.defaults?.attempts) validateAttempts("defaults", suite.defaults.attempts);
	for (const scenario of suite.scenarios) {
		if (scenarioIds.has(scenario.id)) throw new Error(`Duplicate capability eval scenario id: ${scenario.id}`);
		scenarioIds.add(scenario.id);
		if (scenario.attempts) validateAttempts(scenario.id, scenario.attempts);
		for (const verifier of scenario.verifiers) {
			if (verifier.type === "output" && verifier.operator === "matches") {
				try {
					new RegExp(verifier.expected, "u");
				} catch (error) {
					throw new Error(
						`Capability eval scenario ${scenario.id} has invalid output regex: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	}
}

/** Validate an untrusted, versioned capability-eval suite. */
export function parseCapabilityEvalSuite(value: unknown): CapabilityEvalSuite {
	if (!Value.Check(CapabilityEvalSuiteSchema, value)) {
		const firstError = Value.Errors(CapabilityEvalSuiteSchema, value)[0];
		const detail = firstError
			? `${firstError.instancePath || "/"}: ${firstError.message}`
			: "unknown validation error";
		throw new Error(`Invalid capability eval suite: ${detail}`);
	}
	validateSemantics(value);
	return value;
}
