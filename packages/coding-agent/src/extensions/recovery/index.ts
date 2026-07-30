import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import type {
	CodingAgentRecoveryOperation,
	CodingAgentRecoveryProviderRequest,
	CodingAgentRecoveryReport,
	CodingAgentRecoveryToolCall,
} from "../../core/harness-recovery-report.ts";
import { getCodingAgentRecoveryReport } from "../../core/harness-recovery-report.ts";
import type { CustomEntry, ReadonlySessionManager } from "../../core/session-manager.ts";
import { stripAnsi } from "../../utils/ansi.ts";

const RECOVERY_ENTRY_TYPE = "coding-agent-recovery-v1";
const RECOVERY_ACK_ENTRY_TYPE = "coding-agent-recovery-ack-v1";
const STATUS_KEY = "recovery";
const DISPLAY_ITEM_LIMIT = 8;
const DISPLAY_REPORT_LIMIT = 5;

interface CodingAgentRecoveryAcknowledgement {
	version: 1;
	sessionId: string;
	recoveryIds: string[];
	acknowledgedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOperation(value: unknown): value is CodingAgentRecoveryOperation {
	return isRecord(value) && typeof value.operationId === "string" && typeof value.kind === "string";
}

function isProviderRequest(value: unknown): value is CodingAgentRecoveryProviderRequest {
	return (
		isRecord(value) &&
		typeof value.requestId === "string" &&
		typeof value.provider === "string" &&
		typeof value.modelId === "string"
	);
}

function isToolCall(value: unknown): value is CodingAgentRecoveryToolCall {
	return (
		isRecord(value) &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		typeof value.retrySafe === "boolean" &&
		typeof value.retryEligible === "boolean"
	);
}

function parseRecoveryReport(value: unknown): CodingAgentRecoveryReport | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.recoveryId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.recoveredAt !== "string" ||
		!isNonNegativeInteger(value.preservedQueueItemCount) ||
		!isNonNegativeInteger(value.recoveredPendingWriteCount) ||
		!Array.isArray(value.interruptedOperations) ||
		!value.interruptedOperations.every(isOperation) ||
		!isStringArray(value.interruptedTurnIds) ||
		!Array.isArray(value.interruptedProviderRequests) ||
		!value.interruptedProviderRequests.every(isProviderRequest) ||
		!Array.isArray(value.interruptedToolCalls) ||
		!value.interruptedToolCalls.every(isToolCall)
	) {
		return undefined;
	}
	return value as unknown as CodingAgentRecoveryReport;
}

function parseAcknowledgement(value: unknown): CodingAgentRecoveryAcknowledgement | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.sessionId !== "string" ||
		!isStringArray(value.recoveryIds) ||
		typeof value.acknowledgedAt !== "string"
	) {
		return undefined;
	}
	return value as unknown as CodingAgentRecoveryAcknowledgement;
}

function recoveryEntries(sessionManager: ReadonlySessionManager): CustomEntry[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is CustomEntry => entry.type === "custom")
		.filter((entry) => entry.customType === RECOVERY_ENTRY_TYPE || entry.customType === RECOVERY_ACK_ENTRY_TYPE);
}

function outstandingReports(
	sessionManager: ReadonlySessionManager,
	currentReport?: CodingAgentRecoveryReport,
): CodingAgentRecoveryReport[] {
	const sessionId = sessionManager.getSessionId();
	const reports = new Map<string, CodingAgentRecoveryReport>();
	const acknowledged = new Set<string>();
	for (const entry of recoveryEntries(sessionManager)) {
		if (entry.customType === RECOVERY_ENTRY_TYPE) {
			const report = parseRecoveryReport(entry.data);
			if (report?.sessionId === sessionId) reports.set(report.recoveryId, report);
		} else {
			const acknowledgement = parseAcknowledgement(entry.data);
			if (acknowledgement?.sessionId === sessionId) {
				for (const recoveryId of acknowledgement.recoveryIds) acknowledged.add(recoveryId);
			}
		}
	}
	if (currentReport?.sessionId === sessionId) reports.set(currentReport.recoveryId, currentReport);
	return [...reports.values()]
		.filter((report) => !acknowledged.has(report.recoveryId))
		.sort((left, right) => left.recoveredAt.localeCompare(right.recoveredAt));
}

function displayText(value: string): string {
	return stripAnsi(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�");
}

function appendBoundedItems<T>(lines: string[], label: string, items: readonly T[], format: (item: T) => string): void {
	if (items.length === 0) return;
	lines.push(`${label}:`);
	for (const item of items.slice(0, DISPLAY_ITEM_LIMIT)) lines.push(`  - ${format(item)}`);
	if (items.length > DISPLAY_ITEM_LIMIT) lines.push(`  - … ${items.length - DISPLAY_ITEM_LIMIT} more`);
}

function formatReport(report: CodingAgentRecoveryReport): string[] {
	const lines = [
		`Recovery ${displayText(report.recoveryId)} at ${displayText(report.recoveredAt)}`,
		`Preserved: ${report.preservedQueueItemCount} queued item(s), ${report.recoveredPendingWriteCount} pending write(s)`,
	];
	appendBoundedItems(lines, "Interrupted operations", report.interruptedOperations, (operation) => {
		return `${displayText(operation.operationId)} (${displayText(operation.kind)})`;
	});
	appendBoundedItems(lines, "Interrupted turns", report.interruptedTurnIds, displayText);
	appendBoundedItems(lines, "Interrupted provider requests", report.interruptedProviderRequests, (request) => {
		return `${displayText(request.requestId)} (${displayText(request.provider)}/${displayText(request.modelId)})`;
	});
	appendBoundedItems(lines, "Interrupted tool calls", report.interruptedToolCalls, (call) => {
		const eligibility = call.retryEligible
			? "retry eligible"
			: call.retrySafe
				? "retry-safe, not eligible"
				: "not retry-safe";
		return `${displayText(call.toolCallId)} (${displayText(call.toolName)}; ${eligibility}; not replayed)`;
	});
	return lines;
}

function formatOutstandingReports(reports: readonly CodingAgentRecoveryReport[]): string {
	const visible = reports.slice(-DISPLAY_REPORT_LIMIT);
	const lines = [`Outstanding recovery reports: ${reports.length}`];
	if (reports.length > DISPLAY_REPORT_LIMIT) {
		lines.push(`${reports.length - DISPLAY_REPORT_LIMIT} older report(s) omitted from this view.`);
	}
	for (const report of visible) {
		lines.push("", ...formatReport(report));
	}
	lines.push(
		"",
		"No interrupted provider request or tool call was automatically replayed.",
		"Inspect external side effects before continuing. Tool retry eligibility is advisory only.",
		"Run /recovery acknowledge after review.",
	);
	return lines.join("\n");
}

function setRecoveryStatus(ctx: ExtensionContext, reports: readonly CodingAgentRecoveryReport[]): void {
	ctx.ui.setStatus(STATUS_KEY, reports.length > 0 ? `recovery attention (${reports.length})` : undefined);
}

function persistCurrentReport(pi: ExtensionAPI, ctx: ExtensionContext): CodingAgentRecoveryReport | undefined {
	const report = getCodingAgentRecoveryReport(ctx.sessionManager);
	if (!report) return undefined;
	const alreadyPersisted = recoveryEntries(ctx.sessionManager).some((entry) => {
		const existing = entry.customType === RECOVERY_ENTRY_TYPE ? parseRecoveryReport(entry.data) : undefined;
		return existing?.recoveryId === report.recoveryId;
	});
	if (!alreadyPersisted) pi.appendEntry(RECOVERY_ENTRY_TYPE, report);
	return report;
}

export default function recoveryExtension(pi: ExtensionAPI): void {
	const notifiedRecoveryIds = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		let currentReport: CodingAgentRecoveryReport | undefined;
		try {
			currentReport = persistCurrentReport(pi, ctx);
		} catch (error) {
			currentReport = getCodingAgentRecoveryReport(ctx.sessionManager);
			ctx.ui.notify(
				`Recovery evidence could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		const reports = outstandingReports(ctx.sessionManager, currentReport);
		setRecoveryStatus(ctx, reports);
		const unnotified = reports.filter((report) => !notifiedRecoveryIds.has(report.recoveryId));
		if (unnotified.length === 0) return;
		for (const report of unnotified) notifiedRecoveryIds.add(report.recoveryId);
		const latest = unnotified[unnotified.length - 1]!;
		ctx.ui.notify(
			`Interrupted work requires review: ${latest.interruptedOperations.length} operation(s), ${latest.interruptedToolCalls.length} tool call(s), ${latest.preservedQueueItemCount} queued item(s). No tool call was replayed. Run /recovery.`,
			"warning",
		);
	});

	pi.registerCommand("recovery", {
		description: "Review and acknowledge conservatively recovered interrupted work",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			const currentReport = getCodingAgentRecoveryReport(ctx.sessionManager);
			const reports = outstandingReports(ctx.sessionManager, currentReport);
			setRecoveryStatus(ctx, reports);

			if (action === "status") {
				if (reports.length === 0) {
					ctx.ui.notify("No unacknowledged recovery reports", "info");
					return;
				}
				ctx.ui.notify(formatOutstandingReports(reports), "warning");
				return;
			}
			if (action === "acknowledge") {
				if (reports.length === 0) {
					ctx.ui.notify("No unacknowledged recovery reports", "info");
					return;
				}
				const acknowledgement: CodingAgentRecoveryAcknowledgement = {
					version: 1,
					sessionId: ctx.sessionManager.getSessionId(),
					recoveryIds: reports.map((report) => report.recoveryId),
					acknowledgedAt: new Date().toISOString(),
				};
				try {
					pi.appendEntry(RECOVERY_ACK_ENTRY_TYPE, acknowledgement);
				} catch (error) {
					ctx.ui.notify(
						`Recovery acknowledgement could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				setRecoveryStatus(ctx, []);
				ctx.ui.notify(
					`Acknowledged ${reports.length} recovery report(s). Audit entries were preserved; no tool call was replayed.`,
					"info",
				);
				return;
			}

			ctx.ui.notify("Usage: /recovery [status|acknowledge]", "warning");
		},
	});
}
