/** Version of the declarative completion-contract format. */
export const COMPLETION_CONTRACT_VERSION = 1 as const;

/** Version of the serializable completion report. */
export const COMPLETION_REPORT_VERSION = 1 as const;

export type CompletionStatus = "pass" | "fail" | "blocked" | "error";
export type CompletionConditionMode = "all" | "any";
export type CompletionVerifierErrorMode = "isolate" | "throw";

export type CompletionJsonPrimitive = string | number | boolean | null;
export type CompletionJsonValue =
	| CompletionJsonPrimitive
	| CompletionJsonValue[]
	| { [key: string]: CompletionJsonValue };

/** One independently verifiable condition in a completion contract. */
export interface CompletionCondition {
	id: string;
	description: string;
	/** Verifiers are evaluated in this declared order. */
	verifierIds: string[];
	/** `all` requires every verifier to pass; `any` requires at least one. Default: `all`. */
	mode?: CompletionConditionMode;
	/** Optional conditions are reported but do not affect the contract status. Default: true. */
	required?: boolean;
}

/** Declarative acceptance boundary. Calling a verifier runner is always explicit. */
export interface CompletionContract {
	version: typeof COMPLETION_CONTRACT_VERSION;
	id: string;
	objective: string;
	conditions: CompletionCondition[];
	metadata?: { [key: string]: CompletionJsonValue };
}

/** Serializable evidence produced by a verifier. */
export interface CompletionEvidence {
	id: string;
	/** Application-defined evidence kind, such as `test`, `command`, `diff`, or `artifact`. */
	kind: string;
	summary: string;
	reference?: string;
	data?: CompletionJsonValue;
}

export interface CompletionErrorDetails {
	name: string;
	message: string;
}

interface CompletionVerifierOutcomeBase {
	summary: string;
	evidence?: CompletionEvidence[];
}

export interface CompletionVerifierPass extends CompletionVerifierOutcomeBase {
	status: "pass";
}

export interface CompletionVerifierFail extends CompletionVerifierOutcomeBase {
	status: "fail";
}

export interface CompletionVerifierBlocked extends CompletionVerifierOutcomeBase {
	status: "blocked";
}

export interface CompletionVerifierError extends CompletionVerifierOutcomeBase {
	status: "error";
	error: CompletionErrorDetails;
}

/** Result returned by a verifier. Exceptions are converted to `error` by the default runner policy. */
export type CompletionVerifierOutcome =
	| CompletionVerifierPass
	| CompletionVerifierFail
	| CompletionVerifierBlocked
	| CompletionVerifierError;

export interface CompletionVerifierInput<TContext> {
	contract: CompletionContract;
	condition: CompletionCondition;
	context: TContext;
}

/** Small verifier protocol. Implementations must honor the supplied abort signal when practical. */
export interface CompletionVerifier<TContext = undefined> {
	id: string;
	verify(
		input: CompletionVerifierInput<TContext>,
		signal: AbortSignal,
	): CompletionVerifierOutcome | Promise<CompletionVerifierOutcome>;
}

export type CompletionVerifierReport = CompletionVerifierOutcome & { verifierId: string };

export interface CompletionConditionReport {
	conditionId: string;
	description: string;
	required: boolean;
	mode: CompletionConditionMode;
	status: CompletionStatus;
	verifiers: CompletionVerifierReport[];
}

export interface CompletionStatusCounts {
	total: number;
	pass: number;
	fail: number;
	blocked: number;
	error: number;
}

export interface CompletionReportSummary {
	required: CompletionStatusCounts;
	optional: CompletionStatusCounts;
}

/** Versioned, JSON-safe report. It intentionally contains no generated timestamp or duration. */
export interface CompletionReport {
	version: typeof COMPLETION_REPORT_VERSION;
	contract: CompletionContract;
	status: CompletionStatus;
	summary: CompletionReportSummary;
	conditions: CompletionConditionReport[];
}

export interface VerifyCompletionContractOptions<TContext> {
	context: TContext;
	signal?: AbortSignal;
	/** `isolate` records verifier exceptions and continues. `throw` fails fast. Default: `isolate`. */
	errorMode?: CompletionVerifierErrorMode;
}

export type CompletionContractErrorCode =
	| "invalid_contract"
	| "invalid_options"
	| "invalid_verifier"
	| "duplicate_verifier";

export class CompletionContractError extends Error {
	public code: CompletionContractErrorCode;

	constructor(code: CompletionContractErrorCode, message: string) {
		super(message);
		this.name = "CompletionContractError";
		this.code = code;
	}
}
