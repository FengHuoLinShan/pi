import { describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "../src/core/extensions/index.ts";
import { type CodingAgentRecoveryReport, setCodingAgentRecoveryReport } from "../src/core/harness-recovery-report.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import recoveryExtension from "../src/extensions/recovery/index.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;

function createReport(sessionId: string, recoveryId = "recovery-1"): CodingAgentRecoveryReport {
	return {
		version: 1,
		recoveryId,
		sessionId,
		recoveredAt: "2026-07-30T01:02:03.000Z",
		preservedQueueItemCount: 1,
		recoveredPendingWriteCount: 2,
		interruptedOperations: [{ operationId: "operation-1", kind: "turn" }],
		interruptedTurnIds: ["turn-1"],
		interruptedProviderRequests: [{ requestId: "request-1", provider: "provider\u001b[31m", modelId: "model-1" }],
		interruptedToolCalls: [{ toolCallId: "tool-1", toolName: "write", retrySafe: false, retryEligible: false }],
	};
}

function setupExtension(options: { failCustomTypes?: string[] } = {}) {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const commands = new Map<string, CommandHandler>();
	let sessionStart: SessionStartHandler | undefined;
	const appendEntry = vi.fn((customType: string, data?: unknown) => {
		if (options.failCustomTypes?.includes(customType)) throw new Error("session is read-only");
		sessionManager.appendCustomEntry(customType, data);
	});
	const api = {
		appendEntry,
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
		},
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		sessionManager,
		ui: { notify, setStatus },
	} as unknown as ExtensionCommandContext;
	recoveryExtension(api);
	return {
		appendEntry,
		command: commands.get("recovery")!,
		ctx,
		notify,
		sessionManager,
		sessionStart: (reason: SessionStartEvent["reason"] = "startup") =>
			sessionStart!({ type: "session_start", reason }, ctx),
		setStatus,
	};
}

describe("recovery built-in extension", () => {
	it("is registered as a hidden built-in extension", () => {
		expect(builtInExtensions).toContainEqual(
			expect.objectContaining({ name: "recovery", factory: recoveryExtension, hidden: true }),
		);
	});

	it("persists and warns about a current low-sensitivity recovery report once", async () => {
		const extension = setupExtension();
		setCodingAgentRecoveryReport(extension.sessionManager, createReport(extension.sessionManager.getSessionId()));

		await extension.sessionStart();
		await extension.sessionStart("reload");

		expect(extension.appendEntry).toHaveBeenCalledTimes(1);
		expect(extension.appendEntry).toHaveBeenCalledWith(
			"coding-agent-recovery-v1",
			expect.objectContaining({ recoveryId: "recovery-1" }),
		);
		expect(extension.notify).toHaveBeenCalledTimes(1);
		expect(extension.notify).toHaveBeenCalledWith(expect.stringContaining("No tool call was replayed"), "warning");
		expect(extension.setStatus).toHaveBeenLastCalledWith("recovery", "recovery attention (1)");
		expect(JSON.stringify(extension.sessionManager.getEntries())).not.toContain("tool arguments");
	});

	it("shows sanitized detail and durably acknowledges every outstanding report", async () => {
		const extension = setupExtension();
		const first = createReport(extension.sessionManager.getSessionId());
		const second = {
			...createReport(extension.sessionManager.getSessionId(), "recovery-2"),
			recoveredAt: "2026-07-30T02:03:04.000Z",
		};
		extension.sessionManager.appendCustomEntry("coding-agent-recovery-v1", first);
		extension.sessionManager.appendCustomEntry("coding-agent-recovery-v1", second);

		await extension.command("status", extension.ctx);
		expect(extension.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("Outstanding recovery reports: 2"),
			"warning",
		);
		const statusMessage = extension.notify.mock.calls.at(-1)?.[0] as string;
		expect(statusMessage).toContain("provider/model-1");
		expect(statusMessage).not.toContain("\u001b");
		expect(statusMessage).toContain("not replayed");

		await extension.command("acknowledge", extension.ctx);
		expect(extension.appendEntry).toHaveBeenCalledWith(
			"coding-agent-recovery-ack-v1",
			expect.objectContaining({ recoveryIds: ["recovery-1", "recovery-2"] }),
		);
		expect(extension.setStatus).toHaveBeenLastCalledWith("recovery", undefined);

		await extension.command("", extension.ctx);
		expect(extension.notify).toHaveBeenLastCalledWith("No unacknowledged recovery reports", "info");
	});

	it("ignores malformed and inherited recovery entries", async () => {
		const extension = setupExtension();
		extension.sessionManager.appendCustomEntry("coding-agent-recovery-v1", { version: 1, recoveryId: "broken" });
		extension.sessionManager.appendCustomEntry(
			"coding-agent-recovery-v1",
			createReport("different-session", "inherited"),
		);

		await extension.sessionStart();
		await extension.command("status", extension.ctx);

		expect(extension.appendEntry).not.toHaveBeenCalled();
		expect(extension.notify).toHaveBeenLastCalledWith("No unacknowledged recovery reports", "info");
		expect(extension.setStatus).toHaveBeenCalledWith("recovery", undefined);
	});

	it("keeps recovery attention active when evidence or acknowledgement persistence fails", async () => {
		const extension = setupExtension({
			failCustomTypes: ["coding-agent-recovery-v1", "coding-agent-recovery-ack-v1"],
		});
		setCodingAgentRecoveryReport(extension.sessionManager, createReport(extension.sessionManager.getSessionId()));

		await extension.sessionStart();
		expect(extension.notify).toHaveBeenCalledWith(
			"Recovery evidence could not be persisted: session is read-only",
			"warning",
		);
		expect(extension.setStatus).toHaveBeenLastCalledWith("recovery", "recovery attention (1)");

		await extension.command("acknowledge", extension.ctx);
		expect(extension.notify).toHaveBeenLastCalledWith(
			"Recovery acknowledgement could not be persisted: session is read-only",
			"error",
		);
		expect(extension.setStatus).not.toHaveBeenCalledWith("recovery", undefined);
	});
});
