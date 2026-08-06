import { join } from "node:path";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execCommand } from "../../core/exec.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/index.ts";
import { ReviewablePatchStack } from "../../core/reviewable-patch-stack.ts";
import {
	WorkspaceOverlay,
	type WorkspaceOverlayApplyResult,
	type WorkspaceOverlayRecoveryReport,
	type WorkspacePatchSet,
} from "../../core/workspace-overlay.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";

export const WORKSPACE_OVERLAY_FLAG = "workspace-overlay";
const STATUS_KEY = "workspace-overlay";
const overlayBySessionId = new Map<string, WorkspaceOverlay>();
const patchStackBySessionId = new Map<string, ReviewablePatchStack>();

export interface CliWorkspaceOverlayOpenResult {
	overlay: WorkspaceOverlay;
	recovery: WorkspaceOverlayRecoveryReport;
	gitWarning?: string;
}

class PatchReview implements Component {
	private readonly lines: string[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private offset = 0;

	constructor(lines: string[], tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) {
		this.lines = lines;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
	}

	handleInput(data: string): void {
		const pageSize = Math.max(5, this.tui.terminal.rows - 5);
		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "tui.select.confirm")) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.offset = Math.min(Math.max(0, this.lines.length - pageSize), this.offset + 1);
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.offset = Math.max(0, this.offset - pageSize);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.offset = Math.min(Math.max(0, this.lines.length - pageSize), this.offset + pageSize);
		} else {
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const pageSize = Math.max(5, this.tui.terminal.rows - 5);
		const visible = this.lines.slice(this.offset, this.offset + pageSize);
		const end = Math.min(this.lines.length, this.offset + visible.length);
		return [
			this.theme.fg("accent", this.theme.bold("Workspace Overlay Review")),
			this.theme.fg("dim", `Lines ${this.lines.length === 0 ? 0 : this.offset + 1}-${end} of ${this.lines.length}`),
			...visible.map((line) => truncateToWidth(line, Math.max(1, width), "…", true)),
			this.theme.fg("dim", "Up/Down or PageUp/PageDown to scroll; Enter/Esc to close"),
		];
	}

	invalidate(): void {}
}

function displayText(value: string): string {
	return stripAnsi(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�");
}

function getOverlay(sessionId: string): WorkspaceOverlay | undefined {
	return overlayBySessionId.get(sessionId);
}

function unregisterOverlay(sessionId: string): void {
	overlayBySessionId.delete(sessionId);
	patchStackBySessionId.delete(sessionId);
}

async function initializeOverlayGit(overlay: WorkspaceOverlay): Promise<string | undefined> {
	const cwd = overlay.getWorkingDirectory();
	const existing = await execCommand("git", ["rev-parse", "--git-dir"], cwd, {
		timeout: 5_000,
	});
	if (existing.code === 0 && !existing.killed) return undefined;

	const commands = [
		["init", "--quiet"],
		["add", "--all", "--force"],
		[
			"-c",
			"user.name=Pi Workspace Overlay",
			"-c",
			"user.email=pi-overlay@localhost",
			"commit",
			"--quiet",
			"--allow-empty",
			"--no-gpg-sign",
			"-m",
			"Workspace overlay baseline",
		],
	];
	for (const args of commands) {
		const result = await execCommand("git", args, cwd, { timeout: 120_000 });
		if (result.code !== 0 || result.killed) {
			return result.stderr.trim() || `git ${args[0]} failed`;
		}
	}
	return undefined;
}

export async function openCliWorkspaceOverlay(options: {
	workspaceRoot: string;
	agentDir: string;
	sessionId: string;
}): Promise<CliWorkspaceOverlayOpenResult> {
	const overlayRoot = join(options.agentDir, "workspace-overlays", options.sessionId);
	let opened = await WorkspaceOverlay.open({
		workspaceRoot: options.workspaceRoot,
		overlayRoot,
	});
	if (opened.overlay.getState() === "applied") {
		await opened.overlay.discard();
		opened = await WorkspaceOverlay.open({
			workspaceRoot: options.workspaceRoot,
			overlayRoot,
		});
	}

	const gitWarning = await initializeOverlayGit(opened.overlay);
	overlayBySessionId.set(options.sessionId, opened.overlay);
	const currentStack = patchStackBySessionId.get(options.sessionId);
	const currentStackSnapshot = currentStack?.snapshot();
	if (
		!currentStackSnapshot ||
		currentStackSnapshot.overlayId !== opened.overlay.getId() ||
		currentStackSnapshot.baseSnapshotId !== opened.overlay.getBaseSnapshotId() ||
		currentStackSnapshot.state !== "active"
	) {
		patchStackBySessionId.set(
			options.sessionId,
			new ReviewablePatchStack({
				overlayId: opened.overlay.getId(),
				baseSnapshotId: opened.overlay.getBaseSnapshotId(),
			}),
		);
	}
	return { ...opened, gitWarning };
}

function formatReview(patchSet: WorkspacePatchSet, overlay: WorkspaceOverlay): string[] {
	const lines = [
		`Overlay: ${displayText(overlay.getWorkingDirectory())}`,
		`Target: ${displayText(overlay.getWorkspaceRoot())}`,
		`Changes: ${patchSet.entries.length}`,
		"",
	];
	for (const entry of patchSet.entries) {
		lines.push(`${entry.kind.toUpperCase()} ${displayText(entry.path)}`);
		if (entry.patch) {
			lines.push(...entry.patch.split("\n").map(displayText));
		} else {
			const before = entry.beforeByteLength ?? 0;
			const after = entry.afterByteLength ?? 0;
			lines.push(`Binary or mode-only change (${before} -> ${after} bytes)`);
		}
		lines.push("");
	}
	return lines;
}

async function showReview(
	patchSet: WorkspacePatchSet,
	overlay: WorkspaceOverlay,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			`Workspace overlay contains ${patchSet.entries.length} changed path(s): ${patchSet.entries
				.map((entry) => displayText(entry.path))
				.join(", ")}`,
			"info",
		);
		return;
	}

	const lines = formatReview(patchSet, overlay);
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => new PatchReview(lines, tui, theme, keybindings, done));
}

async function currentPatchSet(
	ctx: ExtensionCommandContext,
): Promise<{ overlay: WorkspaceOverlay; patchSet: WorkspacePatchSet; patchStack: ReviewablePatchStack } | undefined> {
	const overlay = getOverlay(ctx.sessionManager.getSessionId());
	if (!overlay) {
		ctx.ui.notify(`Workspace overlay is not active. Start pi with --${WORKSPACE_OVERLAY_FLAG}.`, "warning");
		return undefined;
	}
	if (overlay.getState() !== "active") {
		ctx.ui.notify(`Workspace overlay is ${overlay.getState()}`, "warning");
		return undefined;
	}
	const patchStack = patchStackBySessionId.get(ctx.sessionManager.getSessionId());
	if (!patchStack) {
		ctx.ui.notify("Workspace patch stack is unavailable for this overlay", "error");
		return undefined;
	}
	const patchSet = await overlay.createPatchSet();
	if (patchSet.entries.length > 0) {
		const stack = patchStack.snapshot();
		patchStack.capture(patchSet, {
			title: `Overlay checkpoint ${stack.layers.length + 1}`,
			summary: `${patchSet.entries.length} cumulative changed path(s)`,
		});
	}
	return { overlay, patchSet, patchStack };
}

export default function workspaceOverlayExtension(pi: ExtensionAPI): void {
	pi.registerFlag(WORKSPACE_OVERLAY_FLAG, {
		description: "Run built-in coding tools in a persistent transactional workspace overlay",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		const overlay = getOverlay(ctx.sessionManager.getSessionId());
		ctx.ui.setStatus(STATUS_KEY, overlay?.getState() === "active" ? "overlay active" : undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!getOverlay(ctx.sessionManager.getSessionId())) return;
		return {
			systemPrompt: `${event.systemPrompt}

## Transactional workspace overlay

Built-in file, search, and bash tools run in a persistent workspace overlay. The original workspace is unchanged until the user runs /overlay apply. Use /overlay review to inspect the pending PatchSet and /overlay discard to abandon it. Git metadata inside the overlay is independent and excluded from the PatchSet. This is a review boundary, not an OS sandbox: do not access the original workspace through absolute paths or host-side extensions.`,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const overlay = getOverlay(ctx.sessionManager.getSessionId());
		if (!overlay || overlay.getState() !== "active") return;
		try {
			const patchSet = await overlay.createPatchSet();
			const patchStack = patchStackBySessionId.get(ctx.sessionManager.getSessionId());
			if (patchStack && patchSet.entries.length > 0) {
				const stack = patchStack.snapshot();
				patchStack.capture(patchSet, {
					title: `Agent checkpoint ${stack.layers.length + 1}`,
					summary: `${patchSet.entries.length} cumulative changed path(s)`,
				});
			}
			const stack = patchStack?.snapshot();
			ctx.ui.setStatus(
				STATUS_KEY,
				patchSet.entries.length === 0
					? "overlay clean"
					: `overlay ${patchSet.entries.length} changed · stack ${
							stack?.layers.filter((layer) => layer.status === "approved").length ?? 0
						}/${stack?.layers.length ?? 0} reviewed`,
			);
		} catch {
			ctx.ui.setStatus(STATUS_KEY, "overlay error");
		}
	});

	const blockChangedSessionExit = async (ctx: ExtensionContext): Promise<{ cancel: boolean } | undefined> => {
		const overlay = getOverlay(ctx.sessionManager.getSessionId());
		if (!overlay || overlay.getState() !== "active") return undefined;
		let patchSet: WorkspacePatchSet;
		try {
			patchSet = await overlay.createPatchSet();
		} catch (error) {
			ctx.ui.notify(
				`Cannot verify workspace overlay before changing sessions: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { cancel: true };
		}
		if (patchSet.entries.length === 0) {
			try {
				await overlay.discard();
				unregisterOverlay(ctx.sessionManager.getSessionId());
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return undefined;
			} catch (error) {
				ctx.ui.notify(
					`Cannot discard the clean workspace overlay before changing sessions: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return { cancel: true };
			}
		}
		ctx.ui.notify(
			`Review, apply, or discard ${patchSet.entries.length} overlay change(s) before changing sessions`,
			"warning",
		);
		return { cancel: true };
	};

	pi.on("session_before_switch", async (_event, ctx) => blockChangedSessionExit(ctx));
	pi.on("session_before_fork", async (_event, ctx) => blockChangedSessionExit(ctx));

	pi.registerCommand("overlay", {
		description: "Review, apply, discard, or inspect the transactional workspace overlay",
		handler: async (args, ctx) => {
			const [action = "review", layerArgument] = args.trim().split(/\s+/, 2);
			const current = await currentPatchSet(ctx);
			if (!current) return;
			const { overlay, patchSet, patchStack } = current;
			const stack = patchStack.snapshot();

			if (action === "status") {
				ctx.ui.notify(
					`Workspace overlay ${overlay.getState()}: ${patchSet.entries.length} changed path(s); patch stack ${stack.layers.filter((layer) => layer.status === "approved").length}/${stack.layers.length} reviewed; ${displayText(overlay.getWorkingDirectory())}`,
					"info",
				);
				return;
			}
			if (action === "stack") {
				ctx.ui.notify(
					stack.layers.length === 0
						? "Workspace patch stack has no checkpoints"
						: stack.layers
								.map(
									(layer, index) =>
										`${index + 1}. ${layer.status} ${layer.id} · ${displayText(layer.title)} · ${layer.patchSet.entries.length} path(s)`,
								)
								.join("\n"),
					"info",
				);
				return;
			}
			if (action === "review") {
				const layer = layerArgument ? stack.layers.find((candidate) => candidate.id === layerArgument) : undefined;
				if (layerArgument && !layer) {
					ctx.ui.notify(`Unknown patch layer: ${displayText(layerArgument)}`, "warning");
					return;
				}
				await showReview(layer?.patchSet ?? patchSet, overlay, ctx);
				return;
			}
			if (action === "approve") {
				const layer = layerArgument
					? stack.layers.find((candidate) => candidate.id === layerArgument)
					: [...stack.layers].reverse().find((candidate) => candidate.status === "pending");
				if (layerArgument && !layer) {
					ctx.ui.notify(`Unknown patch layer: ${displayText(layerArgument)}`, "warning");
					return;
				}
				if (!layer) {
					ctx.ui.notify("Workspace patch stack has no pending layer to approve", "warning");
					return;
				}
				if (layer.status !== "pending") {
					ctx.ui.notify(`Patch layer ${layer.id} is already ${layer.status}`, "warning");
					return;
				}
				await showReview(layer.patchSet, overlay, ctx);
				if (
					!ctx.hasUI ||
					!(await ctx.ui.confirm(
						"Approve patch layer?",
						`Approve ${displayText(layer.title)} with ${layer.patchSet.entries.length} cumulative path(s)?`,
					))
				) {
					return;
				}
				patchStack.review(layer.id, "approved", patchStack.snapshot().revision);
				ctx.ui.notify(`Approved patch layer ${layer.id}`, "info");
				return;
			}
			if (action === "reject") {
				const layer = layerArgument
					? stack.layers.find((candidate) => candidate.id === layerArgument)
					: [...stack.layers].reverse().find((candidate) => candidate.status === "pending");
				if (layerArgument && !layer) {
					ctx.ui.notify(`Unknown patch layer: ${displayText(layerArgument)}`, "warning");
					return;
				}
				if (!layer) {
					ctx.ui.notify("Workspace patch stack has no pending layer to reject", "warning");
					return;
				}
				if (
					!ctx.hasUI ||
					!(await ctx.ui.confirm(
						"Reject patch layer?",
						`Reject ${displayText(layer.title)} and block stack application?`,
					))
				) {
					return;
				}
				patchStack.review(layer.id, "rejected", patchStack.snapshot().revision);
				ctx.ui.notify(`Rejected patch layer ${layer.id}; discard the overlay or revise the workflow`, "warning");
				return;
			}
			if (action === "apply") {
				if (patchSet.entries.length === 0) {
					ctx.ui.notify("Workspace overlay has no changes to apply", "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("Applying a workspace overlay requires approval UI", "error");
					return;
				}
				await showReview(patchSet, overlay, ctx);
				const choice = await ctx.ui.select(
					`Apply ${patchSet.entries.length} reviewed path(s) to the original workspace?`,
					["Apply reviewed PatchSet and exit", "Cancel"],
				);
				if (choice !== "Apply reviewed PatchSet and exit") return;

				let result: WorkspaceOverlayApplyResult;
				try {
					patchStack.approveAll(
						patchStack.snapshot().revision,
						"Approved through final cumulative PatchSet review",
					);
					result = await patchStack.apply(overlay, patchStack.snapshot().revision);
				} catch (error) {
					ctx.ui.notify(
						`Workspace overlay apply failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				try {
					pi.appendEntry("workspace-overlay-applied-v1", {
						version: 1,
						overlayId: overlay.getId(),
						patchStackId: patchStack.snapshot().id,
						patchStackRevision: patchStack.snapshot().revision,
						patchSetId: result.patchSetId,
						applyId: result.applyId,
						appliedPaths: result.appliedPaths,
						appliedAt: new Date().toISOString(),
					});
				} catch (error) {
					ctx.ui.notify(
						`Workspace overlay was applied, but the session audit entry failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				unregisterOverlay(ctx.sessionManager.getSessionId());
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(`Applied ${result.appliedPaths.length} path(s) to the original workspace`, "info");
				ctx.shutdown();
				return;
			}
			if (action === "discard") {
				if (
					patchSet.entries.length > 0 &&
					(!ctx.hasUI ||
						!(await ctx.ui.confirm(
							"Discard workspace overlay?",
							`Permanently discard ${patchSet.entries.length} pending path(s)?`,
						)))
				) {
					return;
				}
				await overlay.discard();
				unregisterOverlay(ctx.sessionManager.getSessionId());
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Workspace overlay discarded", "info");
				ctx.shutdown();
				return;
			}

			ctx.ui.notify(
				"Usage: /overlay [review [layer-id]|stack|approve [layer-id]|reject [layer-id]|status|apply|discard]",
				"warning",
			);
		},
	});
}
