import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	CompletionContract,
	CompletionJsonValue,
	CompletionReport,
	CompletionVerifier,
} from "../completion/index.ts";
import type { AgentRunTermination, AgentRunUsage } from "../types.ts";

export const VERIFIED_RUN_SPEC_VERSION = 1 as const;
export const VERIFIED_RUN_REPORT_VERSION = 1 as const;

export type VerifiedRunStatus = "passed" | "failed" | "blocked" | "interrupted";

/** Opaque application-owned reference. The core snapshots the descriptor but never resolves its target. */
export interface VerifiedRunReference {
	id: string;
	kind: string;
	reference?: string;
	revision?: string;
	metadata?: { [key: string]: CompletionJsonValue };
}

/** Declarative input for one explicit Harness turn plus completion verification. */
export interface VerifiedRunSpec {
	version: typeof VERIFIED_RUN_SPEC_VERSION;
	id: string;
	prompt: string;
	completionContract: CompletionContract;
	artifactRefs?: VerifiedRunReference[];
	evidenceRefs?: VerifiedRunReference[];
	metadata?: { [key: string]: CompletionJsonValue };
}

export interface VerifiedRunVerificationContext<TContext> {
	context: TContext;
	spec: VerifiedRunSpec;
	finalMessage: AssistantMessage;
	usage: AgentRunUsage;
	artifactRefs: VerifiedRunReference[];
	evidenceRefs: VerifiedRunReference[];
}

export interface VerifiedRunFailure {
	stage: "harness" | "completion";
	name: string;
	message: string;
	code?: string;
}

/** Versioned result of exactly one explicit verified-run invocation. */
export interface VerifiedRunReport {
	version: typeof VERIFIED_RUN_REPORT_VERSION;
	runId: string;
	status: VerifiedRunStatus;
	usage: AgentRunUsage;
	finalMessage?: AssistantMessage;
	termination?: AgentRunTermination;
	completion?: CompletionReport;
	artifactRefs: VerifiedRunReference[];
	evidenceRefs: VerifiedRunReference[];
	failure?: VerifiedRunFailure;
}

export interface ExecuteVerifiedRunOptions<TContext> {
	context: TContext;
	verifiers: Iterable<CompletionVerifier<VerifiedRunVerificationContext<TContext>>>;
	signal?: AbortSignal;
}
