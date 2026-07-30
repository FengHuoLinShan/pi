import type {
	RuntimeEvent,
	RuntimeRecoveryResult,
	RuntimeRecoveryState,
	RuntimeToolCallState,
} from "@earendil-works/pi-agent-core";
import type { ReadonlySessionManager } from "./session-manager.ts";

export const CODING_AGENT_RECOVERY_REPORT_VERSION = 1 as const;

export interface CodingAgentRecoveryOperation {
	operationId: string;
	kind: string;
}

export interface CodingAgentRecoveryProviderRequest {
	requestId: string;
	provider: string;
	modelId: string;
}

export interface CodingAgentRecoveryToolCall {
	toolCallId: string;
	toolName: string;
	retrySafe: boolean;
	retryEligible: boolean;
}

/**
 * Low-sensitivity summary of work conservatively interrupted during restore.
 * It deliberately excludes messages, pending-write payloads, tool arguments,
 * tool results, provider payloads, and credentials.
 */
export interface CodingAgentRecoveryReport {
	version: typeof CODING_AGENT_RECOVERY_REPORT_VERSION;
	recoveryId: string;
	sessionId: string;
	recoveredAt: string;
	preservedQueueItemCount: number;
	recoveredPendingWriteCount: number;
	interruptedOperations: CodingAgentRecoveryOperation[];
	interruptedTurnIds: string[];
	interruptedProviderRequests: CodingAgentRecoveryProviderRequest[];
	interruptedToolCalls: CodingAgentRecoveryToolCall[];
}

const reportsBySessionManager = new WeakMap<ReadonlySessionManager, CodingAgentRecoveryReport>();

function interruptedIds<TType extends RuntimeEvent["type"], TId extends string>(
	events: readonly RuntimeEvent[],
	type: TType,
	getId: (event: Extract<RuntimeEvent, { type: TType }>) => TId,
): TId[] {
	return events.filter((event): event is Extract<RuntimeEvent, { type: TType }> => event.type === type).map(getId);
}

function toolCallReport(
	call: RuntimeToolCallState,
	retryableToolCallIds: ReadonlySet<string>,
): CodingAgentRecoveryToolCall {
	return {
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		retrySafe: call.retrySafe,
		retryEligible: retryableToolCallIds.has(call.toolCallId),
	};
}

function cloneReport(report: CodingAgentRecoveryReport): CodingAgentRecoveryReport {
	return {
		...report,
		interruptedOperations: report.interruptedOperations.map((operation) => ({ ...operation })),
		interruptedTurnIds: [...report.interruptedTurnIds],
		interruptedProviderRequests: report.interruptedProviderRequests.map((request) => ({ ...request })),
		interruptedToolCalls: report.interruptedToolCalls.map((call) => ({ ...call })),
	};
}

export function createCodingAgentRecoveryReport(
	recovery: RuntimeRecoveryResult,
	state: RuntimeRecoveryState,
): CodingAgentRecoveryReport | undefined {
	const events = recovery.plan.events;
	const interruptedOperationIds = interruptedIds(events, "operation_interrupted", (event) => event.operationId);
	const interruptedTurnIds = interruptedIds(events, "turn_interrupted", (event) => event.turnId);
	const interruptedRequestIds = interruptedIds(events, "provider_request_interrupted", (event) => event.requestId);
	const interruptedToolCallIds = interruptedIds(events, "tool_call_interrupted", (event) => event.toolCallId);
	const hasMaterialRecovery =
		recovery.plan.preservedQueueItemIds.length > 0 ||
		recovery.plan.pendingWriteIds.length > 0 ||
		interruptedOperationIds.length > 0 ||
		interruptedTurnIds.length > 0 ||
		interruptedRequestIds.length > 0 ||
		interruptedToolCallIds.length > 0;
	if (!hasMaterialRecovery) return undefined;

	const recoveryEnvelope = recovery.appended.find((envelope) => envelope.event.type === "recovery_started");
	const recoveryEvent = recoveryEnvelope?.event;
	if (!recoveryEnvelope || recoveryEvent?.type !== "recovery_started") {
		throw new Error("Material AgentHarness recovery is missing its recovery_started event");
	}
	const retryableToolCallIds = new Set(recovery.plan.retryableToolCallIds);
	return {
		version: CODING_AGENT_RECOVERY_REPORT_VERSION,
		recoveryId: recoveryEvent.recoveryId,
		sessionId: state.sessionId,
		recoveredAt: recoveryEnvelope.timestamp,
		preservedQueueItemCount: recovery.plan.preservedQueueItemIds.length,
		recoveredPendingWriteCount: recovery.plan.pendingWriteIds.length,
		interruptedOperations: interruptedOperationIds.map((operationId) => {
			const operation = state.operations[operationId];
			return { operationId, kind: operation?.kind ?? "unknown" };
		}),
		interruptedTurnIds,
		interruptedProviderRequests: interruptedRequestIds.map((requestId) => {
			const request = state.providerRequests[requestId];
			return {
				requestId,
				provider: request?.provider ?? "unknown",
				modelId: request?.modelId ?? "unknown",
			};
		}),
		interruptedToolCalls: interruptedToolCallIds.map((toolCallId) => {
			const call = state.toolCalls[toolCallId];
			return call
				? toolCallReport(call, retryableToolCallIds)
				: { toolCallId, toolName: "unknown", retrySafe: false, retryEligible: false };
		}),
	};
}

export function setCodingAgentRecoveryReport(
	sessionManager: ReadonlySessionManager,
	report: CodingAgentRecoveryReport | undefined,
): void {
	if (report) reportsBySessionManager.set(sessionManager, cloneReport(report));
	else reportsBySessionManager.delete(sessionManager);
}

export function getCodingAgentRecoveryReport(
	sessionManager: ReadonlySessionManager,
): CodingAgentRecoveryReport | undefined {
	const report = reportsBySessionManager.get(sessionManager);
	return report ? cloneReport(report) : undefined;
}
