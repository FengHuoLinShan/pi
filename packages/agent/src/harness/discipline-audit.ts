import type {
	CompletionEvidence,
	CompletionJsonValue,
	CompletionVerifier,
	CompletionVerifierOutcome,
} from "../completion/types.ts";
import {
	TOOL_POLICY_AUTHORIZATION_OBSERVATION_VERSION,
	type ToolPolicyApprovalObservation,
	type ToolPolicyAuthorizationObservation,
} from "../tool-policy.ts";
import type { ToolAttemptOutcome } from "../types.ts";
import type { AgentHarnessEvent } from "./types.ts";

export const HARNESS_DISCIPLINE_AUDIT_SNAPSHOT_VERSION = 2 as const;

const TOOL_ATTEMPT_OUTCOMES = [
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

const TOOL_ATTEMPT_OUTCOME_SET: ReadonlySet<string> = new Set(TOOL_ATTEMPT_OUTCOMES);

export type HarnessDisciplineDeniedAttempts = "allow" | "fail";

export interface HarnessDisciplineAuditSnapshot {
	readonly version: typeof HARNESS_DISCIPLINE_AUDIT_SNAPSHOT_VERSION;
	readonly authorizationDecisions: {
		readonly total: number;
		readonly allowed: number;
		readonly denied: number;
		readonly approvalNotRequired: number;
		readonly approvalGranted: number;
		readonly approvalNotGranted: number;
		readonly policyRevisionCount: number;
	};
	/** `tool_execution_start` attempts; this is not proof that a tool body executed. */
	readonly executionAttempts: {
		readonly total: number;
		readonly withDecision: number;
		readonly allowed: number;
		readonly denied: number;
		readonly unresolved: number;
	};
	readonly attemptOutcomes: {
		/** Valid, timely terminal outcomes matched to an earlier start by tool-call id and tool name. */
		readonly observed: number;
		/** Execution starts without a matching valid terminal outcome. */
		readonly missing: number;
		readonly counts: Readonly<Record<ToolAttemptOutcome, number>>;
	};
	readonly settlement: {
		readonly observed: boolean;
		readonly count: number;
		readonly nextTurnCount?: number;
	};
	readonly anomalies: {
		readonly invalidAuthorizationObservations: number;
		readonly invalidHarnessEvents: number;
		readonly duplicateAuthorizationObservations: number;
		readonly duplicateExecutionStarts: number;
		readonly invalidAttemptOutcomes: number;
		readonly outcomeWithoutAttempt: number;
		readonly duplicateAttemptOutcomes: number;
		readonly lateAttemptOutcomes: number;
		readonly authorizationWithoutAttempt: number;
		readonly lateAuthorizationObservations: number;
		readonly lateExecutionStarts: number;
		readonly duplicateSettlements: number;
		readonly toolNameMismatches: number;
	};
}

/**
 * Per-run, content-minimized audit sink. Create a new instance for every Harness run.
 * Observer properties are bound closures and may be passed directly as callbacks.
 */
export interface HarnessDisciplineAudit {
	readonly observeAuthorization: (observation: ToolPolicyAuthorizationObservation) => void;
	readonly observeHarnessEvent: (event: AgentHarnessEvent) => void;
	readonly snapshot: () => HarnessDisciplineAuditSnapshot;
}

export type HarnessDisciplineViolationCode =
	| "invalid_authorization_observation"
	| "invalid_harness_event"
	| "duplicate_authorization_observation"
	| "duplicate_execution_start"
	| "invalid_attempt_outcome"
	| "outcome_without_attempt"
	| "duplicate_attempt_outcome"
	| "late_attempt_outcome"
	| "authorization_without_attempt"
	| "late_authorization_observation"
	| "late_execution_start"
	| "duplicate_settlement"
	| "tool_name_mismatch"
	| "policy_revision_mismatch"
	| "attempt_without_decision"
	| "attempt_not_allowed"
	| "attempt_without_outcome"
	| "attempt_outcome_not_allowed"
	| "denied_attempt"
	| "minimum_authorizations_not_met"
	| "settlement_not_observed"
	| "next_turn_count_exceeded";

export interface HarnessDisciplineViolation {
	readonly code: HarnessDisciplineViolationCode;
	readonly count: number;
	readonly limit?: number;
}

/** All behavior-affecting fields are explicit; this verifier has no policy defaults. */
export interface HarnessDisciplineCompletionVerifierOptions<TContext> {
	readonly id: string;
	readonly getAudit: (context: TContext) => HarnessDisciplineAudit;
	readonly expectedPolicyRevision?: string;
	readonly requireEveryExecutionAuthorized: boolean;
	readonly deniedAttempts: HarnessDisciplineDeniedAttempts;
	readonly minAuthorizationDecisions: number;
	readonly requireEveryAttemptOutcome: boolean;
	readonly allowedAttemptOutcomes: readonly ToolAttemptOutcome[];
	readonly requireSettled: boolean;
	readonly maxNextTurnCount?: number;
}

interface InternalAuthorization {
	readonly toolName: string;
	readonly policyRevision: string;
	readonly allowed: boolean;
	readonly approval: ToolPolicyApprovalObservation;
}

interface InternalAttempt {
	readonly toolName: string;
}

interface InternalAttemptOutcome {
	readonly toolName: string;
	/** Whether this end matched an earlier start before settlement when it was observed. */
	readonly matchedAttempt: boolean;
	readonly outcome?: ToolAttemptOutcome;
}

interface MutableAnomalies {
	invalidAuthorizationObservations: number;
	invalidHarnessEvents: number;
	duplicateAuthorizationObservations: number;
	duplicateExecutionStarts: number;
	invalidAttemptOutcomes: number;
	outcomeWithoutAttempt: number;
	duplicateAttemptOutcomes: number;
	lateAttemptOutcomes: number;
	authorizationWithoutAttempt: number;
	lateAuthorizationObservations: number;
	lateExecutionStarts: number;
	duplicateSettlements: number;
	toolNameMismatches: number;
}

interface InternalAuditState {
	readonly authorizations: Map<string, InternalAuthorization>;
	readonly attempts: Map<string, InternalAttempt>;
	readonly outcomes: Map<string, InternalAttemptOutcome>;
	readonly anomalies: MutableAnomalies;
	settled: boolean;
	settlementCount: number;
	nextTurnCount?: number;
}

const internalStates = new WeakMap<HarnessDisciplineAudit, InternalAuditState>();

/**
 * Collect policy outcomes and Harness execution-start/end/settled events without retaining
 * arguments, hashes, resources, paths, reasons, or caller-owned observation objects.
 */
export function createHarnessDisciplineAudit(): HarnessDisciplineAudit {
	const state: InternalAuditState = {
		authorizations: new Map(),
		attempts: new Map(),
		outcomes: new Map(),
		anomalies: {
			invalidAuthorizationObservations: 0,
			invalidHarnessEvents: 0,
			duplicateAuthorizationObservations: 0,
			duplicateExecutionStarts: 0,
			invalidAttemptOutcomes: 0,
			outcomeWithoutAttempt: 0,
			duplicateAttemptOutcomes: 0,
			lateAttemptOutcomes: 0,
			authorizationWithoutAttempt: 0,
			lateAuthorizationObservations: 0,
			lateExecutionStarts: 0,
			duplicateSettlements: 0,
			toolNameMismatches: 0,
		},
		settled: false,
		settlementCount: 0,
	};

	const recordAuthorization = (observation: ToolPolicyAuthorizationObservation): void => {
		const copied = copyAuthorizationObservation(observation);
		if (!copied) {
			state.anomalies.invalidAuthorizationObservations++;
			return;
		}
		if (state.settled) state.anomalies.lateAuthorizationObservations++;
		if (state.authorizations.has(copied.toolCallId)) {
			state.anomalies.duplicateAuthorizationObservations++;
			return;
		}
		const attempt = state.attempts.get(copied.toolCallId);
		if (!attempt) state.anomalies.authorizationWithoutAttempt++;
		else if (attempt.toolName !== copied.toolName) state.anomalies.toolNameMismatches++;
		state.authorizations.set(copied.toolCallId, {
			toolName: copied.toolName,
			policyRevision: copied.policyRevision,
			allowed: copied.allowed,
			approval: copied.approval,
		});
	};
	const observeAuthorization = (observation: ToolPolicyAuthorizationObservation): void => {
		try {
			recordAuthorization(observation);
		} catch {
			state.anomalies.invalidAuthorizationObservations++;
		}
	};

	const recordHarnessEvent = (event: AgentHarnessEvent): void => {
		const value: unknown = event;
		if (!isRecord(value)) return;
		const type = value.type;
		if (type === "tool_execution_start") {
			const toolCallId = value.toolCallId;
			const toolName = value.toolName;
			if (!isNonEmptyString(toolCallId) || !isNonEmptyString(toolName)) {
				state.anomalies.invalidHarnessEvents++;
				return;
			}
			if (state.settled) state.anomalies.lateExecutionStarts++;
			if (state.attempts.has(toolCallId)) {
				state.anomalies.duplicateExecutionStarts++;
				return;
			}
			const authorization = state.authorizations.get(toolCallId);
			if (authorization && authorization.toolName !== toolName) state.anomalies.toolNameMismatches++;
			const outcome = state.outcomes.get(toolCallId);
			if (outcome && outcome.toolName !== toolName) state.anomalies.toolNameMismatches++;
			state.attempts.set(toolCallId, { toolName });
			return;
		}
		if (type === "tool_execution_end") {
			const toolCallId = value.toolCallId;
			const toolName = value.toolName;
			if (!isNonEmptyString(toolCallId) || !isNonEmptyString(toolName)) {
				state.anomalies.invalidHarnessEvents++;
				return;
			}
			const isLate = state.settled;
			if (isLate) state.anomalies.lateAttemptOutcomes++;
			if (state.outcomes.has(toolCallId)) {
				state.anomalies.duplicateAttemptOutcomes++;
				return;
			}
			const attempt = state.attempts.get(toolCallId);
			if (!attempt) state.anomalies.outcomeWithoutAttempt++;
			else if (attempt.toolName !== toolName) state.anomalies.toolNameMismatches++;
			const matchedAttempt = !isLate && attempt?.toolName === toolName;
			const rawOutcome = value.attemptOutcome;
			if (rawOutcome === undefined) {
				state.outcomes.set(toolCallId, { toolName, matchedAttempt });
				return;
			}
			if (!isToolAttemptOutcome(rawOutcome)) {
				state.anomalies.invalidAttemptOutcomes++;
				state.outcomes.set(toolCallId, { toolName, matchedAttempt });
				return;
			}
			state.outcomes.set(toolCallId, { toolName, matchedAttempt, outcome: rawOutcome });
			return;
		}
		if (type !== "settled") return;
		const nextTurnCount = value.nextTurnCount;
		if (typeof nextTurnCount !== "number" || !Number.isSafeInteger(nextTurnCount) || nextTurnCount < 0) {
			state.anomalies.invalidHarnessEvents++;
			return;
		}
		state.settlementCount++;
		if (state.settled) {
			state.anomalies.duplicateSettlements++;
			return;
		}
		state.settled = true;
		state.nextTurnCount = nextTurnCount;
	};
	const observeHarnessEvent = (event: AgentHarnessEvent): void => {
		try {
			recordHarnessEvent(event);
		} catch {
			state.anomalies.invalidHarnessEvents++;
		}
	};

	const snapshot = (): HarnessDisciplineAuditSnapshot => createSnapshot(state);
	const audit = { observeAuthorization, observeHarnessEvent, snapshot } satisfies HarnessDisciplineAudit;
	internalStates.set(audit, state);
	return audit;
}

/** Build an explicit completion verifier over a single run's discipline audit. */
export function createHarnessDisciplineCompletionVerifier<TContext>(
	options: HarnessDisciplineCompletionVerifierOptions<TContext>,
): CompletionVerifier<TContext> {
	const normalized = normalizeVerifierOptions(options);
	return {
		id: normalized.id,
		verify: ({ context }, signal): CompletionVerifierOutcome => {
			if (signal.aborted) return { status: "blocked", summary: "Harness discipline verification aborted" };
			const audit = normalized.getAudit(context);
			const state = internalStates.get(audit);
			if (!state)
				throw new Error("Harness discipline verifier requires an audit from createHarnessDisciplineAudit()");
			const snapshot = createSnapshot(state);
			const violations = evaluateViolations(state, snapshot, normalized);
			const evidence = createEvidence(normalized.id, snapshot, violations);
			if (violations.length === 0) {
				return { status: "pass", summary: "Harness discipline checks passed", evidence: [evidence] };
			}
			return {
				status: "fail",
				summary: `Harness discipline checks failed with ${violations.length} violation type(s)`,
				evidence: [evidence],
			};
		},
	};
}

function copyAuthorizationObservation(
	value: ToolPolicyAuthorizationObservation,
): (InternalAuthorization & { toolCallId: string }) | undefined {
	const candidate: unknown = value;
	if (!isRecord(candidate)) return undefined;
	const version = candidate.version;
	const toolCallId = candidate.toolCallId;
	const toolName = candidate.toolName;
	const resolvedCallHash = candidate.resolvedCallHash;
	const policyRevision = candidate.policyRevision;
	const toolSpecRevision = candidate.toolSpecRevision;
	const ruleId = candidate.ruleId;
	const decision = candidate.decision;
	const allowed = candidate.allowed;
	const approval = candidate.approval;
	if (version !== TOOL_POLICY_AUTHORIZATION_OBSERVATION_VERSION) return undefined;
	if (!isNonEmptyString(toolCallId) || !isNonEmptyString(toolName)) return undefined;
	if (!isResolvedCallHash(resolvedCallHash) || !isNonEmptyString(policyRevision)) return undefined;
	if (toolSpecRevision !== undefined && !isNonEmptyString(toolSpecRevision)) return undefined;
	if (ruleId !== undefined && !isNonEmptyString(ruleId)) return undefined;
	if (decision !== "allow" && decision !== "deny" && decision !== "require_approval") {
		return undefined;
	}
	if (typeof allowed !== "boolean") return undefined;
	if (approval !== "not_required" && approval !== "granted" && approval !== "not_granted") {
		return undefined;
	}
	if (decision === "allow" && (!allowed || approval !== "not_required")) return undefined;
	if (decision === "deny" && (allowed || approval !== "not_required")) return undefined;
	if (decision === "require_approval") {
		if (approval === "not_required") return undefined;
		if (allowed !== (approval === "granted")) return undefined;
	}
	return {
		toolCallId,
		toolName,
		policyRevision,
		allowed,
		approval,
	};
}

function createSnapshot(state: InternalAuditState): HarnessDisciplineAuditSnapshot {
	let allowed = 0;
	let approvalNotRequired = 0;
	let approvalGranted = 0;
	let approvalNotGranted = 0;
	const policyRevisions = new Set<string>();
	for (const authorization of state.authorizations.values()) {
		if (authorization.allowed) allowed++;
		if (authorization.approval === "not_required") approvalNotRequired++;
		else if (authorization.approval === "granted") approvalGranted++;
		else approvalNotGranted++;
		policyRevisions.add(authorization.policyRevision);
	}

	let withDecision = 0;
	let allowedAttempts = 0;
	let deniedAttempts = 0;
	const attemptOutcomeCounts = createAttemptOutcomeCounts();
	let observedAttemptOutcomes = 0;
	for (const [toolCallId, attempt] of state.attempts) {
		const authorization = state.authorizations.get(toolCallId);
		if (authorization && authorization.toolName === attempt.toolName) {
			withDecision++;
			if (authorization.allowed) allowedAttempts++;
			else deniedAttempts++;
		}
		const outcome = state.outcomes.get(toolCallId);
		if (outcome?.matchedAttempt && outcome.outcome !== undefined && outcome.toolName === attempt.toolName) {
			observedAttemptOutcomes++;
			attemptOutcomeCounts[outcome.outcome]++;
		}
	}

	const authorizationTotal = state.authorizations.size;
	return {
		version: HARNESS_DISCIPLINE_AUDIT_SNAPSHOT_VERSION,
		authorizationDecisions: {
			total: authorizationTotal,
			allowed,
			denied: authorizationTotal - allowed,
			approvalNotRequired,
			approvalGranted,
			approvalNotGranted,
			policyRevisionCount: policyRevisions.size,
		},
		executionAttempts: {
			total: state.attempts.size,
			withDecision,
			allowed: allowedAttempts,
			denied: deniedAttempts,
			unresolved: state.attempts.size - withDecision,
		},
		attemptOutcomes: {
			observed: observedAttemptOutcomes,
			missing: state.attempts.size - observedAttemptOutcomes,
			counts: attemptOutcomeCounts,
		},
		settlement: {
			observed: state.settled,
			count: state.settlementCount,
			...(state.nextTurnCount === undefined ? {} : { nextTurnCount: state.nextTurnCount }),
		},
		anomalies: { ...state.anomalies },
	};
}

function createAttemptOutcomeCounts(): Record<ToolAttemptOutcome, number> {
	return {
		not_executed_missing_tool: 0,
		not_executed_preparation_error: 0,
		not_executed_before_hook_error: 0,
		not_executed_blocked: 0,
		not_executed_aborted_before_body: 0,
		not_executed_truncated: 0,
		not_executed_budget: 0,
		not_executed_deadline: 0,
		not_executed_loop: 0,
		body_success: 0,
		body_error: 0,
		after_hook_error: 0,
	};
}

function evaluateViolations<TContext>(
	state: InternalAuditState,
	snapshot: HarnessDisciplineAuditSnapshot,
	options: HarnessDisciplineCompletionVerifierOptions<TContext>,
): HarnessDisciplineViolation[] {
	const violations: HarnessDisciplineViolation[] = [];
	addViolation(violations, "invalid_authorization_observation", snapshot.anomalies.invalidAuthorizationObservations);
	addViolation(violations, "invalid_harness_event", snapshot.anomalies.invalidHarnessEvents);
	addViolation(
		violations,
		"duplicate_authorization_observation",
		snapshot.anomalies.duplicateAuthorizationObservations,
	);
	addViolation(violations, "duplicate_execution_start", snapshot.anomalies.duplicateExecutionStarts);
	addViolation(violations, "invalid_attempt_outcome", snapshot.anomalies.invalidAttemptOutcomes);
	addViolation(violations, "outcome_without_attempt", snapshot.anomalies.outcomeWithoutAttempt);
	addViolation(violations, "duplicate_attempt_outcome", snapshot.anomalies.duplicateAttemptOutcomes);
	addViolation(violations, "late_attempt_outcome", snapshot.anomalies.lateAttemptOutcomes);
	addViolation(violations, "authorization_without_attempt", snapshot.anomalies.authorizationWithoutAttempt);
	addViolation(violations, "late_authorization_observation", snapshot.anomalies.lateAuthorizationObservations);
	addViolation(violations, "late_execution_start", snapshot.anomalies.lateExecutionStarts);
	addViolation(violations, "duplicate_settlement", snapshot.anomalies.duplicateSettlements);
	addViolation(violations, "tool_name_mismatch", snapshot.anomalies.toolNameMismatches);

	if (options.expectedPolicyRevision !== undefined) {
		let mismatches = 0;
		for (const authorization of state.authorizations.values()) {
			if (authorization.policyRevision !== options.expectedPolicyRevision) mismatches++;
		}
		addViolation(violations, "policy_revision_mismatch", mismatches);
	}
	if (options.requireEveryExecutionAuthorized) {
		addViolation(violations, "attempt_without_decision", snapshot.executionAttempts.unresolved);
		addViolation(violations, "attempt_not_allowed", snapshot.executionAttempts.denied);
	}
	if (options.requireEveryAttemptOutcome) {
		addViolation(violations, "attempt_without_outcome", snapshot.attemptOutcomes.missing);
	}
	const allowedAttemptOutcomes = new Set(options.allowedAttemptOutcomes);
	let disallowedAttemptOutcomes = 0;
	for (const outcome of TOOL_ATTEMPT_OUTCOMES) {
		if (!allowedAttemptOutcomes.has(outcome)) disallowedAttemptOutcomes += snapshot.attemptOutcomes.counts[outcome];
	}
	addViolation(violations, "attempt_outcome_not_allowed", disallowedAttemptOutcomes);
	if (options.deniedAttempts === "fail") {
		addViolation(violations, "denied_attempt", snapshot.authorizationDecisions.denied);
	}
	if (snapshot.authorizationDecisions.total < options.minAuthorizationDecisions) {
		violations.push({
			code: "minimum_authorizations_not_met",
			count: options.minAuthorizationDecisions - snapshot.authorizationDecisions.total,
			limit: options.minAuthorizationDecisions,
		});
	}
	if (options.requireSettled && !snapshot.settlement.observed) {
		violations.push({ code: "settlement_not_observed", count: 1 });
	}
	if (
		options.maxNextTurnCount !== undefined &&
		snapshot.settlement.nextTurnCount !== undefined &&
		snapshot.settlement.nextTurnCount > options.maxNextTurnCount
	) {
		violations.push({
			code: "next_turn_count_exceeded",
			count: snapshot.settlement.nextTurnCount - options.maxNextTurnCount,
			limit: options.maxNextTurnCount,
		});
	}
	return violations;
}

function createEvidence(
	verifierId: string,
	snapshot: HarnessDisciplineAuditSnapshot,
	violations: readonly HarnessDisciplineViolation[],
): CompletionEvidence {
	return {
		id: `${verifierId}:audit`,
		kind: "harness-discipline",
		summary:
			violations.length === 0
				? "Aggregated Harness discipline audit passed"
				: `Aggregated Harness discipline audit contains ${violations.length} violation type(s)`,
		data: {
			snapshot: snapshotToJson(snapshot),
			violations: violations.map((violation) => ({
				code: violation.code,
				count: violation.count,
				...(violation.limit === undefined ? {} : { limit: violation.limit }),
			})),
		},
	};
}

function snapshotToJson(snapshot: HarnessDisciplineAuditSnapshot): CompletionJsonValue {
	return {
		version: snapshot.version,
		authorizationDecisions: { ...snapshot.authorizationDecisions },
		executionAttempts: { ...snapshot.executionAttempts },
		attemptOutcomes: {
			observed: snapshot.attemptOutcomes.observed,
			missing: snapshot.attemptOutcomes.missing,
			counts: { ...snapshot.attemptOutcomes.counts },
		},
		settlement: {
			observed: snapshot.settlement.observed,
			count: snapshot.settlement.count,
			...(snapshot.settlement.nextTurnCount === undefined
				? {}
				: { nextTurnCount: snapshot.settlement.nextTurnCount }),
		},
		anomalies: { ...snapshot.anomalies },
	};
}

function addViolation(
	violations: HarnessDisciplineViolation[],
	code: HarnessDisciplineViolationCode,
	count: number,
): void {
	if (count > 0) violations.push({ code, count });
}

function normalizeVerifierOptions<TContext>(
	options: HarnessDisciplineCompletionVerifierOptions<TContext>,
): HarnessDisciplineCompletionVerifierOptions<TContext> {
	if (!isRecord(options)) throw new Error("Harness discipline verifier options must be an object");
	const id = options.id;
	const getAudit = options.getAudit;
	const expectedPolicyRevision = options.expectedPolicyRevision;
	const requireEveryExecutionAuthorized = options.requireEveryExecutionAuthorized;
	const deniedAttempts = options.deniedAttempts;
	const minAuthorizationDecisions = options.minAuthorizationDecisions;
	const requireEveryAttemptOutcome = options.requireEveryAttemptOutcome;
	const allowedAttemptOutcomes = options.allowedAttemptOutcomes;
	const requireSettled = options.requireSettled;
	const maxNextTurnCount = options.maxNextTurnCount;
	if (!isNonEmptyString(id)) throw new Error("Harness discipline verifier id must not be empty");
	if (typeof getAudit !== "function") throw new Error("Harness discipline verifier requires getAudit");
	if (expectedPolicyRevision !== undefined && !isNonEmptyString(expectedPolicyRevision)) {
		throw new Error("Expected Harness policy revision must not be empty");
	}
	if (typeof requireEveryExecutionAuthorized !== "boolean") {
		throw new Error("Harness discipline requireEveryExecutionAuthorized must be boolean");
	}
	if (deniedAttempts !== "allow" && deniedAttempts !== "fail") {
		throw new Error("Harness discipline deniedAttempts must be allow or fail");
	}
	if (!Number.isSafeInteger(minAuthorizationDecisions) || minAuthorizationDecisions < 0) {
		throw new Error("Harness discipline minAuthorizationDecisions must be a non-negative safe integer");
	}
	if (typeof requireEveryAttemptOutcome !== "boolean") {
		throw new Error("Harness discipline requireEveryAttemptOutcome must be boolean");
	}
	const copiedAllowedAttemptOutcomes = copyAllowedAttemptOutcomes(allowedAttemptOutcomes);
	if (typeof requireSettled !== "boolean") {
		throw new Error("Harness discipline requireSettled must be boolean");
	}
	if (maxNextTurnCount !== undefined && (!Number.isSafeInteger(maxNextTurnCount) || maxNextTurnCount < 0)) {
		throw new Error("Harness discipline maxNextTurnCount must be a non-negative safe integer");
	}
	if (maxNextTurnCount !== undefined && !requireSettled) {
		throw new Error("Harness discipline maxNextTurnCount requires requireSettled");
	}
	return {
		id,
		getAudit,
		...(expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision }),
		requireEveryExecutionAuthorized,
		deniedAttempts,
		minAuthorizationDecisions,
		requireEveryAttemptOutcome,
		allowedAttemptOutcomes: copiedAllowedAttemptOutcomes,
		requireSettled,
		...(maxNextTurnCount === undefined ? {} : { maxNextTurnCount }),
	};
}

function copyAllowedAttemptOutcomes(value: unknown): ToolAttemptOutcome[] {
	if (!Array.isArray(value)) {
		throw new Error("Harness discipline allowedAttemptOutcomes must be an array");
	}
	const copied: ToolAttemptOutcome[] = [];
	const seen = new Set<ToolAttemptOutcome>();
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new Error("Harness discipline allowedAttemptOutcomes must be dense");
		const outcome: unknown = value[index];
		if (!isToolAttemptOutcome(outcome)) {
			throw new Error("Harness discipline allowedAttemptOutcomes contains an unsupported outcome");
		}
		if (seen.has(outcome)) {
			throw new Error("Harness discipline allowedAttemptOutcomes must not contain duplicates");
		}
		seen.add(outcome);
		copied.push(outcome);
	}
	return copied;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isToolAttemptOutcome(value: unknown): value is ToolAttemptOutcome {
	return typeof value === "string" && TOOL_ATTEMPT_OUTCOME_SET.has(value);
}

function isResolvedCallHash(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
