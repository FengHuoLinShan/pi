import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
} from "../src/core/extensions/index.ts";
import workspaceOverlayExtension, { openCliWorkspaceOverlay } from "../src/extensions/workspace-overlay/index.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type SessionBeforeSwitchHandler = (
	event: SessionBeforeSwitchEvent,
	ctx: ExtensionContext,
) => Promise<SessionBeforeSwitchResult | undefined>;

function setupExtension(sessionId: string, options: { auditError?: Error } = {}) {
	const commands = new Map<string, CommandHandler>();
	let sessionBeforeSwitch: SessionBeforeSwitchHandler | undefined;
	const appendEntry = vi.fn(() => {
		if (options.auditError) throw options.auditError;
	});
	const api = {
		registerFlag: vi.fn(),
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		on(event: string, handler: unknown) {
			if (event === "session_before_switch") {
				sessionBeforeSwitch = handler as SessionBeforeSwitchHandler;
			}
		},
		appendEntry,
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const setStatus = vi.fn();
	const select = vi.fn(async () => "Apply reviewed PatchSet and exit");
	const confirm = vi.fn(async () => true);
	const shutdown = vi.fn();
	const ctx = {
		mode: "rpc",
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: { confirm, notify, select, setStatus },
		shutdown,
	} as unknown as ExtensionCommandContext;
	workspaceOverlayExtension(api);
	return {
		appendEntry,
		command: commands.get("overlay")!,
		confirm,
		ctx,
		notify,
		select,
		sessionBeforeSwitch: (event: SessionBeforeSwitchEvent) => sessionBeforeSwitch!(event, ctx),
		shutdown,
	};
}

describe("workspace-overlay built-in extension", () => {
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		for (const path of temporaryDirectories) {
			rmSync(path, { recursive: true, force: true });
		}
		temporaryDirectories.length = 0;
	});

	function createFixture(sessionId: string) {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cli-overlay-workspace-"));
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cli-overlay-agent-"));
		temporaryDirectories.push(workspaceRoot, agentDir);
		writeFileSync(join(workspaceRoot, "tracked.txt"), "base\n");
		return { agentDir, sessionId, workspaceRoot };
	}

	it("persists an isolated worktree by session and provides independent Git metadata", async () => {
		const fixture = createFixture("session-persist");
		const first = await openCliWorkspaceOverlay(fixture);
		expect(first.gitWarning).toBeUndefined();
		expect(first.recovery).toEqual({ action: "none", paths: [] });
		expect((await first.overlay.createPatchSet()).entries).toHaveLength(0);

		writeFileSync(join(first.overlay.getWorkingDirectory(), "tracked.txt"), "overlay\n");
		expect(readFileSync(join(fixture.workspaceRoot, "tracked.txt"), "utf8")).toBe("base\n");
		expect(
			execFileSync("git", ["status", "--short"], {
				cwd: first.overlay.getWorkingDirectory(),
				encoding: "utf8",
			}).trim(),
		).toBe("M tracked.txt");

		const reopened = await openCliWorkspaceOverlay(fixture);
		expect(reopened.overlay.getId()).toBe(first.overlay.getId());
		expect(readFileSync(join(reopened.overlay.getWorkingDirectory(), "tracked.txt"), "utf8")).toBe("overlay\n");
	});

	it("reviews and atomically applies the captured PatchSet before shutdown", async () => {
		const fixture = createFixture("session-apply");
		const opened = await openCliWorkspaceOverlay(fixture);
		writeFileSync(join(opened.overlay.getWorkingDirectory(), "tracked.txt"), "applied\n");
		const extension = setupExtension(fixture.sessionId);

		await extension.command("apply", extension.ctx);

		expect(readFileSync(join(fixture.workspaceRoot, "tracked.txt"), "utf8")).toBe("applied\n");
		expect(extension.select).toHaveBeenCalledWith("Apply 1 reviewed path(s) to the original workspace?", [
			"Apply reviewed PatchSet and exit",
			"Cancel",
		]);
		expect(extension.appendEntry).toHaveBeenCalledWith(
			"workspace-overlay-applied-v1",
			expect.objectContaining({ version: 1, appliedPaths: ["tracked.txt"] }),
		);
		expect(extension.shutdown).toHaveBeenCalledTimes(1);
	});

	it("blocks session switches while the overlay has pending changes", async () => {
		const fixture = createFixture("session-switch");
		const opened = await openCliWorkspaceOverlay(fixture);
		writeFileSync(join(opened.overlay.getWorkingDirectory(), "tracked.txt"), "pending\n");
		const extension = setupExtension(fixture.sessionId);

		await expect(extension.sessionBeforeSwitch({ type: "session_before_switch", reason: "new" })).resolves.toEqual({
			cancel: true,
		});
		expect(extension.notify).toHaveBeenCalledWith(
			"Review, apply, or discard 1 overlay change(s) before changing sessions",
			"warning",
		);
	});

	it("discards a clean overlay before allowing a session switch", async () => {
		const fixture = createFixture("session-clean-switch");
		const opened = await openCliWorkspaceOverlay(fixture);
		const extension = setupExtension(fixture.sessionId);

		await expect(
			extension.sessionBeforeSwitch({ type: "session_before_switch", reason: "new" }),
		).resolves.toBeUndefined();
		expect(opened.overlay.getState()).toBe("discarded");
	});

	it("fails closed when the overlay cannot be verified before a session switch", async () => {
		const fixture = createFixture("session-invalid-switch");
		const outside = mkdtempSync(join(tmpdir(), "pi-cli-overlay-outside-"));
		temporaryDirectories.push(outside);
		const opened = await openCliWorkspaceOverlay(fixture);
		rmSync(opened.overlay.getWorkingDirectory(), { recursive: true });
		symlinkSync(outside, opened.overlay.getWorkingDirectory());
		const extension = setupExtension(fixture.sessionId);

		await expect(extension.sessionBeforeSwitch({ type: "session_before_switch", reason: "new" })).resolves.toEqual({
			cancel: true,
		});
		expect(extension.notify).toHaveBeenCalledWith(
			expect.stringContaining("Cannot verify workspace overlay before changing sessions:"),
			"error",
		);
	});

	it("does not misreport or strand a successful apply when audit persistence fails", async () => {
		const fixture = createFixture("session-audit-failure");
		const opened = await openCliWorkspaceOverlay(fixture);
		writeFileSync(join(opened.overlay.getWorkingDirectory(), "tracked.txt"), "applied\n");
		const extension = setupExtension(fixture.sessionId, {
			auditError: new Error("session is read-only"),
		});

		await extension.command("apply", extension.ctx);

		expect(readFileSync(join(fixture.workspaceRoot, "tracked.txt"), "utf8")).toBe("applied\n");
		expect(extension.notify).toHaveBeenCalledWith(
			"Workspace overlay was applied, but the session audit entry failed: session is read-only",
			"warning",
		);
		expect(extension.notify).toHaveBeenCalledWith("Applied 1 path(s) to the original workspace", "info");
		expect(extension.shutdown).toHaveBeenCalledTimes(1);
	});

	it("preserves both workspaces when apply detects an external conflict", async () => {
		const fixture = createFixture("session-conflict");
		const opened = await openCliWorkspaceOverlay(fixture);
		writeFileSync(join(opened.overlay.getWorkingDirectory(), "tracked.txt"), "overlay\n");
		writeFileSync(join(fixture.workspaceRoot, "tracked.txt"), "external\n");
		const extension = setupExtension(fixture.sessionId);

		await extension.command("apply", extension.ctx);

		expect(readFileSync(join(fixture.workspaceRoot, "tracked.txt"), "utf8")).toBe("external\n");
		expect(readFileSync(join(opened.overlay.getWorkingDirectory(), "tracked.txt"), "utf8")).toBe("overlay\n");
		expect(extension.notify).toHaveBeenCalledWith(
			expect.stringContaining("Workspace overlay apply failed:"),
			"error",
		);
		expect(extension.shutdown).not.toHaveBeenCalled();
	});

	it("discards pending overlay changes without touching the original workspace", async () => {
		const fixture = createFixture("session-discard");
		const opened = await openCliWorkspaceOverlay(fixture);
		writeFileSync(join(opened.overlay.getWorkingDirectory(), "tracked.txt"), "discarded\n");
		const extension = setupExtension(fixture.sessionId);

		await extension.command("discard", extension.ctx);

		expect(readFileSync(join(fixture.workspaceRoot, "tracked.txt"), "utf8")).toBe("base\n");
		expect(opened.overlay.getState()).toBe("discarded");
		expect(extension.confirm).toHaveBeenCalledTimes(1);
		expect(extension.shutdown).toHaveBeenCalledTimes(1);
	});
});
