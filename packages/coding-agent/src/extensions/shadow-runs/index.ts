import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/index.ts";
import {
	applyShadowRunCandidate,
	discardShadowRunOverlays,
	runShadowCandidates,
	type ShadowRunCandidateResult,
	type ShadowRunReport,
} from "../../core/shadow-runs.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import {
	parseShadowRunsConfig,
	SHADOW_RUNS_CONFIG_PATH,
	type ShadowRunsCandidateConfig,
	type ShadowRunsConfig,
} from "./config.ts";
import {
	createDefaultShadowCandidateRunner,
	createShadowRunCompletion,
	type ShadowAgentOutput,
	type ShadowCandidateRunnerFactory,
} from "./runner.ts";

export const SHADOW_RUNS_FLAG = "shadow-runs";
const STATUS_KEY = "shadow-runs";
const MAX_OBJECTIVE_LENGTH = 32_000;
const MAX_REVIEW_CHARACTERS = 512 * 1024;
const INCOMPATIBLE_FLAGS = ["workspace-overlay", "task-contract", "verify-loop"] as const;

type AgentShadowRunReport = ShadowRunReport<ShadowRunsCandidateConfig, ShadowAgentOutput>;
type AgentShadowRunResult = ShadowRunCandidateResult<ShadowRunsCandidateConfig, ShadowAgentOutput>;

interface LoadedShadowRunsConfig {
	config: ShadowRunsConfig;
	revision: string;
}

interface ActiveShadowRun {
	objective: string;
	configRevision: string;
	report: AgentShadowRunReport;
	appliedCandidateId?: string;
}

export interface ShadowRunsExtensionDependencies {
	createCandidateRunner?: ShadowCandidateRunnerFactory;
}

const activeRunsBySessionId = new Map<string, ActiveShadowRun>();

class ShadowRunReview implements Component {
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
			this.theme.fg("accent", this.theme.bold("Shadow Run Review")),
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

function normalizeObjective(value: string): string {
	const objective = value.trim();
	if (!objective) throw new Error("shadow run objective must not be empty");
	if (objective.includes("\0")) throw new Error("shadow run objective must not contain NUL bytes");
	if (objective.length > MAX_OBJECTIVE_LENGTH) {
		throw new Error(`shadow run objective exceeds ${MAX_OBJECTIVE_LENGTH} characters`);
	}
	return objective;
}

async function loadShadowRunsConfig(cwd: string): Promise<LoadedShadowRunsConfig> {
	const path = join(cwd, SHADOW_RUNS_CONFIG_PATH);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(`${SHADOW_RUNS_CONFIG_PATH} must be a regular file`);
	}
	const source = await readFile(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(source) as unknown;
	} catch (error) {
		throw new Error(
			`cannot parse ${SHADOW_RUNS_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		config: parseShadowRunsConfig(value),
		revision: createHash("sha256").update(source).digest("hex"),
	};
}

function completionStatus(run: AgentShadowRunResult): string {
	if (run.status !== "completed") return run.status;
	return run.completion?.status ?? "unverified";
}

function candidateDisplay(run: AgentShadowRunResult): string {
	const changed = run.patchSet?.entries.length ?? 0;
	const label = run.candidate.label ? `${run.candidate.id} (${run.candidate.label})` : run.candidate.id;
	return `${displayText(label)} — ${completionStatus(run)} — ${changed} path(s)`;
}

function eligibleRuns(active: ActiveShadowRun): AgentShadowRunResult[] {
	if (active.appliedCandidateId) return [];
	return active.report.runs.filter(
		(run) =>
			run.status === "completed" &&
			run.completion?.status === "pass" &&
			(run.patchSet?.entries.length ?? 0) > 0 &&
			run.overlay.getState() === "active",
	);
}

function buildReviewLines(active: ActiveShadowRun, run: AgentShadowRunResult): string[] {
	const lines = [
		`Objective: ${displayText(active.objective)}`,
		`Candidate: ${displayText(run.candidate.id)}${run.candidate.label ? ` (${displayText(run.candidate.label)})` : ""}`,
		`Run status: ${run.status}`,
		`Completion: ${run.completion?.status ?? "not available"}`,
		`Overlay state: ${run.overlay.getState()}`,
		`Changed paths: ${run.patchSet?.entries.length ?? 0}`,
		"",
		"Strategy:",
		...run.candidate.config.instructions.split("\n").map(displayText),
		"",
	];
	if (run.output) {
		lines.push(
			`Model: ${displayText(run.output.model.provider)}/${displayText(run.output.model.id)} (${run.output.thinkingLevel})`,
			`Usage: ${run.output.usage.assistantTurns} assistant turn(s), ${run.output.usage.toolCalls} tool call(s), ${run.output.usage.tokens} token(s), $${run.output.usage.cost.toFixed(6)}`,
			"",
		);
		if (run.output.warnings.length > 0) {
			lines.push("Warnings:", ...run.output.warnings.map((warning) => displayText(warning)), "");
		}
		lines.push("Final response:", ...run.output.response.split("\n").map(displayText), "");
	}
	if (run.error) {
		lines.push(`Error: ${displayText(run.error.name)}: ${displayText(run.error.message)}`, "");
	}
	if (run.completion) {
		lines.push("Completion evidence:");
		for (const condition of run.completion.conditions) {
			lines.push(
				`${condition.status.toUpperCase()} ${displayText(condition.conditionId)}: ${displayText(condition.description)}`,
			);
			for (const verifier of condition.verifiers) {
				lines.push(
					`  ${verifier.status.toUpperCase()} ${displayText(verifier.verifierId)}: ${displayText(verifier.summary)}`,
				);
				for (const evidence of verifier.evidence ?? []) {
					lines.push(`    ${displayText(evidence.kind)}: ${displayText(evidence.summary)}`);
					if (evidence.data !== undefined) lines.push(`    ${displayText(JSON.stringify(evidence.data))}`);
				}
			}
		}
		lines.push("");
	}
	if (run.patchSet) {
		lines.push("PatchSet:");
		for (const entry of run.patchSet.entries) {
			lines.push(`${entry.kind.toUpperCase()} ${displayText(entry.path)}`);
			if (entry.patch) {
				lines.push(...entry.patch.split("\n").map(displayText));
			} else {
				lines.push(
					`Binary or mode-only change (${entry.beforeByteLength ?? 0} -> ${entry.afterByteLength ?? 0} bytes)`,
				);
			}
			lines.push("");
		}
	}
	const joined = lines.join("\n");
	if (joined.length <= MAX_REVIEW_CHARACTERS) return lines;
	return [
		...joined.slice(0, MAX_REVIEW_CHARACTERS).split("\n"),
		"",
		`[review truncated at ${MAX_REVIEW_CHARACTERS} characters]`,
	];
}

async function showReview(
	active: ActiveShadowRun,
	run: AgentShadowRunResult,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(candidateDisplay(run), "info");
		return;
	}
	const lines = buildReviewLines(active, run);
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => new ShadowRunReview(lines, tui, theme, keybindings, done),
	);
}

async function selectCandidate(
	runs: readonly AgentShadowRunResult[],
	title: string,
	ctx: ExtensionCommandContext,
): Promise<AgentShadowRunResult | undefined> {
	if (runs.length === 0) return undefined;
	if (runs.length === 1) return runs[0];
	const options = runs.map(candidateDisplay);
	const selected = await ctx.ui.select(title, options);
	const index = selected === undefined ? -1 : options.indexOf(selected);
	return index < 0 ? undefined : runs[index];
}

function getActiveRun(ctx: ExtensionContext): ActiveShadowRun | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	const active = activeRunsBySessionId.get(sessionId);
	if (!active) return undefined;
	if (active.report.runs.every((run) => run.overlay.getState() === "discarded")) {
		activeRunsBySessionId.delete(sessionId);
		return undefined;
	}
	return active;
}

function statusText(active: ActiveShadowRun): string {
	if (active.appliedCandidateId) return "shadow cleanup pending";
	const passed = eligibleRuns(active).length;
	return `shadow ${passed}/${active.report.runs.length} eligible`;
}

function appendAuditEntry(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	customType: string,
	data: Record<string, unknown>,
): void {
	try {
		pi.appendEntry(customType, data);
	} catch (error) {
		ctx.ui.notify(
			`Shadow run audit entry failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

function appendCompletedAudit(pi: ExtensionAPI, ctx: ExtensionCommandContext, active: ActiveShadowRun): void {
	appendAuditEntry(pi, ctx, "shadow-runs-completed-v1", {
		version: 1,
		objective: active.objective,
		configRevision: active.configRevision,
		baseSnapshotId: active.report.baseSnapshotId,
		execution: active.report.execution,
		status: active.report.status,
		candidates: active.report.runs.map((run) => ({
			id: run.candidate.id,
			status: run.status,
			completionStatus: run.completion?.status,
			changedPathCount: run.patchSet?.entries.length ?? 0,
			usage: run.output?.usage,
			error: run.error,
		})),
		completedAt: new Date().toISOString(),
	});
}

function incompatibleFlags(pi: ExtensionAPI): string[] {
	return INCOMPATIBLE_FLAGS.filter((flag) => pi.getFlag(flag) === true);
}

async function objectiveFromCommand(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (args.trim()) return normalizeObjective(args);
	if (!ctx.hasUI) {
		ctx.ui.notify("Usage: /shadow run <objective>", "warning");
		return undefined;
	}
	const edited = await ctx.ui.editor("Shadow run objective");
	return edited === undefined ? undefined : normalizeObjective(edited);
}

function reportSummary(active: ActiveShadowRun): string {
	const statuses = active.report.runs
		.map((run) => `${run.candidate.id}:${completionStatus(run)}/${run.patchSet?.entries.length ?? 0}`)
		.join(", ");
	return `Shadow runs ${active.report.status}; ${statuses}. Use /shadow review and /shadow apply.`;
}

async function runCandidates(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	createCandidateRunner: ShadowCandidateRunnerFactory,
): Promise<void> {
	if (getActiveRun(ctx)) {
		ctx.ui.notify("Review, apply, or discard the active shadow run before starting another", "warning");
		return;
	}
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify(
			`Shadow runs require a trusted project because ${SHADOW_RUNS_CONFIG_PATH} controls prompts and commands`,
			"error",
		);
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify("Shadow runs require an active model", "error");
		return;
	}
	const incompatible = incompatibleFlags(pi);
	if (incompatible.length > 0) {
		ctx.ui.notify(
			`--${SHADOW_RUNS_FLAG} cannot be combined with ${incompatible.map((flag) => `--${flag}`).join(", ")}`,
			"error",
		);
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Shadow runs require approval-capable UI", "error");
		return;
	}

	let loaded: LoadedShadowRunsConfig;
	let objective: string | undefined;
	try {
		loaded = await loadShadowRunsConfig(ctx.cwd);
		objective = await objectiveFromCommand(args, ctx);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	if (!objective) return;
	const maximumModelCalls = loaded.config.candidates.length * loaded.config.budget.maxModelCalls;
	const maximumCost =
		loaded.config.budget.maxCost === undefined
			? "; no monetary cost cap is configured"
			: ` and up to $${(loaded.config.candidates.length * loaded.config.budget.maxCost).toFixed(2)}`;
	const approved = await ctx.ui.confirm(
		"Run isolated coding candidates?",
		`${loaded.config.candidates.length} ${loaded.config.execution} candidate(s), up to ${maximumModelCalls} model calls${maximumCost}. ${loaded.config.checks.length} trusted project command(s) run per candidate with the inherited host environment. The original workspace remains unchanged until explicit apply.`,
	);
	if (!approved) return;

	const model = ctx.model;
	const baseThinkingLevel = pi.getThinkingLevel();
	const runner = createCandidateRunner({
		model,
		modelRegistry: ctx.modelRegistry,
		baseThinkingLevel,
	});
	let candidateIndex = 0;
	try {
		const report = await runShadowCandidates({
			workspaceRoot: ctx.cwd,
			candidates: loaded.config.candidates.map((candidate) => ({
				id: candidate.id,
				label: candidate.label,
				config: candidate,
			})),
			execution: loaded.config.execution,
			run: async (context) => {
				const position = ++candidateIndex;
				ctx.ui.setStatus(
					STATUS_KEY,
					`shadow ${position}/${loaded.config.candidates.length} ${context.candidate.id}`,
				);
				return runner(context, {
					objective,
					model,
					baseThinkingLevel,
					budget: loaded.config.budget,
				});
			},
			completion: createShadowRunCompletion(loaded.config, objective),
		});
		const active: ActiveShadowRun = {
			objective,
			configRevision: loaded.revision,
			report,
		};
		activeRunsBySessionId.set(ctx.sessionManager.getSessionId(), active);
		ctx.ui.setStatus(STATUS_KEY, statusText(active));
		appendCompletedAudit(pi, ctx, active);
		ctx.ui.notify(reportSummary(active), eligibleRuns(active).length > 0 ? "info" : "warning");
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(`Shadow runs failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function reviewCandidate(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const active = getActiveRun(ctx);
	if (!active) {
		ctx.ui.notify("No active shadow run", "warning");
		return;
	}
	const requestedId = args.trim();
	const run = requestedId
		? active.report.runs.find((candidate) => candidate.candidate.id === requestedId)
		: await selectCandidate(active.report.runs, "Review which shadow candidate?", ctx);
	if (!run) {
		if (requestedId) ctx.ui.notify(`Unknown shadow run candidate: ${requestedId}`, "warning");
		return;
	}
	await showReview(active, run, ctx);
}

async function applyCandidate(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const active = getActiveRun(ctx);
	if (!active) {
		ctx.ui.notify("No active shadow run", "warning");
		return;
	}
	if (active.appliedCandidateId) {
		ctx.ui.notify(`Candidate ${active.appliedCandidateId} was applied; only cleanup remains`, "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Applying a shadow candidate requires approval-capable UI", "error");
		return;
	}
	const eligible = eligibleRuns(active);
	const requestedId = args.trim();
	const run = requestedId
		? eligible.find((candidate) => candidate.candidate.id === requestedId)
		: await selectCandidate(eligible, "Apply which verified shadow candidate?", ctx);
	if (!run) {
		ctx.ui.notify(
			requestedId
				? `Candidate ${requestedId} is not eligible for apply`
				: "No completed candidate passed every check with a non-empty PatchSet",
			"warning",
		);
		return;
	}
	await showReview(active, run, ctx);
	const changedPathCount = run.patchSet?.entries.length ?? 0;
	const approved = await ctx.ui.confirm(
		"Apply reviewed shadow candidate?",
		`Apply candidate ${run.candidate.id} with ${changedPathCount} changed path(s) and discard every other candidate?`,
	);
	if (!approved) return;

	try {
		const result = await applyShadowRunCandidate(active.report, run.candidate.id);
		appendAuditEntry(pi, ctx, "shadow-runs-applied-v1", {
			version: 1,
			objective: active.objective,
			configRevision: active.configRevision,
			baseSnapshotId: active.report.baseSnapshotId,
			candidateId: run.candidate.id,
			patchSetId: result.apply.patchSetId,
			applyId: result.apply.applyId,
			appliedPaths: result.apply.appliedPaths,
			completionStatus: run.completion?.status,
			usage: run.output?.usage,
			appliedAt: new Date().toISOString(),
		});
		if (result.cleanupFailures.length > 0) {
			active.appliedCandidateId = run.candidate.id;
			ctx.ui.setStatus(STATUS_KEY, statusText(active));
			ctx.ui.notify(
				`Applied ${result.apply.appliedPaths.length} path(s), but ${result.cleanupFailures.length} candidate overlay(s) still require /shadow discard`,
				"warning",
			);
			return;
		}
		activeRunsBySessionId.delete(ctx.sessionManager.getSessionId());
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(`Applied candidate ${run.candidate.id}: ${result.apply.appliedPaths.length} path(s)`, "info");
	} catch (error) {
		ctx.ui.notify(
			`Shadow candidate apply failed; all candidates were retained: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

async function discardCandidates(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const active = getActiveRun(ctx);
	if (!active) {
		ctx.ui.notify("No active shadow run", "warning");
		return;
	}
	if (
		!ctx.hasUI ||
		!(await ctx.ui.confirm(
			"Discard shadow runs?",
			active.appliedCandidateId
				? "Discard the remaining candidate overlay cleanup state?"
				: `Permanently discard ${active.report.runs.length} candidate overlay(s)?`,
		))
	) {
		return;
	}
	try {
		await discardShadowRunOverlays(active.report);
		appendAuditEntry(pi, ctx, "shadow-runs-discarded-v1", {
			version: 1,
			objective: active.objective,
			configRevision: active.configRevision,
			baseSnapshotId: active.report.baseSnapshotId,
			discardedAt: new Date().toISOString(),
		});
		activeRunsBySessionId.delete(ctx.sessionManager.getSessionId());
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Shadow run candidates discarded", "info");
	} catch (error) {
		ctx.ui.notify(`Shadow run cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function showStatus(ctx: ExtensionCommandContext): void {
	const active = getActiveRun(ctx);
	if (!active) {
		ctx.ui.notify("No active shadow run", "info");
		return;
	}
	ctx.ui.notify(
		`${active.appliedCandidateId ? `Applied ${active.appliedCandidateId}; cleanup pending` : active.report.status}: ${active.report.runs.map(candidateDisplay).join(", ")}`,
		"info",
	);
}

export function createShadowRunsExtension(
	dependencies: ShadowRunsExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
	const createCandidateRunner = dependencies.createCandidateRunner ?? createDefaultShadowCandidateRunner;
	return (pi) => {
		pi.registerFlag(SHADOW_RUNS_FLAG, {
			description: "Enable reviewed multi-candidate coding runs from .pi/shadow-runs.json",
			type: "boolean",
			default: false,
		});

		pi.on("session_start", async (_event, ctx) => {
			const active = getActiveRun(ctx);
			ctx.ui.setStatus(STATUS_KEY, active ? statusText(active) : undefined);
		});

		const blockSessionChange = (ctx: ExtensionContext): { cancel: boolean } | undefined => {
			if (!getActiveRun(ctx)) return undefined;
			ctx.ui.notify("Review, apply, or discard the active shadow run before changing sessions", "warning");
			return { cancel: true };
		};
		pi.on("session_before_switch", async (_event, ctx) => blockSessionChange(ctx));
		pi.on("session_before_fork", async (_event, ctx) => blockSessionChange(ctx));

		pi.on("session_shutdown", async (_event, ctx) => {
			const active = getActiveRun(ctx);
			if (!active) return;
			try {
				await discardShadowRunOverlays(active.report);
				activeRunsBySessionId.delete(ctx.sessionManager.getSessionId());
			} catch (error) {
				ctx.ui.notify(
					`Shadow run shutdown cleanup failed; overlays were retained: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		});

		pi.registerCommand("shadow", {
			description: "Run, review, apply, discard, or inspect isolated coding candidates",
			handler: async (args, ctx) => {
				if (pi.getFlag(SHADOW_RUNS_FLAG) !== true) {
					ctx.ui.notify(`Start pi with --${SHADOW_RUNS_FLAG} to enable multi-candidate coding runs`, "warning");
					return;
				}
				const trimmed = args.trim();
				const separator = trimmed.indexOf(" ");
				const action = (separator === -1 ? trimmed : trimmed.slice(0, separator)) || "status";
				const rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
				if (action === "run") {
					await runCandidates(rest, ctx, pi, createCandidateRunner);
				} else if (action === "review") {
					await reviewCandidate(rest, ctx);
				} else if (action === "apply") {
					await applyCandidate(rest, ctx, pi);
				} else if (action === "discard") {
					await discardCandidates(ctx, pi);
				} else if (action === "status") {
					showStatus(ctx);
				} else {
					ctx.ui.notify("Usage: /shadow [run <objective>|review [id]|apply [id]|discard|status]", "warning");
				}
			},
		});
	};
}

export default createShadowRunsExtension();
