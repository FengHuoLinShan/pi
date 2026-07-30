import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { stripAnsi } from "../../utils/ansi.ts";

const GOAL_ENTRY_TYPE = "goal-mode-state-v1";
const GOAL_CONTEXT_TYPE = "goal-mode-context";
const STATUS_KEY = "goal-mode";
const WIDGET_KEY = "goal-mode";
const DEFAULT_TURN_BATCH = 25;
const MAX_TOTAL_TURNS = 1_000;
const MAX_OBJECTIVE_LENGTH = 8_000;
const MAX_NOTE_LENGTH = 2_000;
const DISPLAY_OBJECTIVE_LENGTH = 180;
const DISPLAY_NOTE_LENGTH = 240;

const GoalToolParams = Type.Object(
	{
		action: Type.Union([
			Type.Literal("status"),
			Type.Literal("update"),
			Type.Literal("complete"),
			Type.Literal("blocked"),
		]),
		note: Type.Optional(Type.String({ maxLength: MAX_NOTE_LENGTH })),
	},
	{ additionalProperties: false },
);

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "stopped";

export interface GoalState {
	version: 1;
	id: string;
	objective: string;
	status: GoalStatus;
	turns: number;
	turnLimit: number;
	createdAt: string;
	updatedAt: string;
	note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "active" || value === "paused" || value === "blocked" || value === "completed" || value === "stopped"
	);
}

export function parseGoalState(value: unknown): GoalState | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		typeof value.objective !== "string" ||
		value.objective.length === 0 ||
		value.objective.length > MAX_OBJECTIVE_LENGTH ||
		!isGoalStatus(value.status) ||
		!Number.isSafeInteger(value.turns) ||
		(value.turns as number) < 0 ||
		(value.turns as number) > MAX_TOTAL_TURNS ||
		!Number.isSafeInteger(value.turnLimit) ||
		(value.turnLimit as number) < 1 ||
		(value.turnLimit as number) > MAX_TOTAL_TURNS ||
		(value.turns as number) > (value.turnLimit as number) ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		typeof value.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.updatedAt)) ||
		(value.note !== undefined && (typeof value.note !== "string" || value.note.length > MAX_NOTE_LENGTH))
	) {
		return undefined;
	}
	return value as unknown as GoalState;
}

export function findGoalState(entries: readonly SessionEntry[]): GoalState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
		const state = parseGoalState(entry.data);
		if (state) return state;
	}
	return undefined;
}

function displayText(value: string, maximumLength: number): string {
	const sanitized = stripAnsi(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (sanitized.length <= maximumLength) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function formatElapsed(createdAt: string): string {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1_000));
	if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	return `${elapsedHours}h`;
}

function formatStatus(state: GoalState): string {
	const lines = [
		`Goal ${state.status} · turns ${state.turns}/${state.turnLimit} · elapsed ${formatElapsed(state.createdAt)}`,
		`Objective: ${displayText(state.objective, DISPLAY_OBJECTIVE_LENGTH)}`,
	];
	if (state.note) lines.push(`Latest: ${displayText(state.note, DISPLAY_NOTE_LENGTH)}`);
	return lines.join("\n");
}

function updateUi(ctx: ExtensionContext, state: GoalState | undefined): void {
	if (!state || state.status === "completed" || state.status === "stopped") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	const status =
		state.status === "active"
			? `goal ${state.turns}/${state.turnLimit}`
			: state.status === "blocked"
				? "goal blocked"
				: "goal paused";
	ctx.ui.setStatus(STATUS_KEY, status);
	ctx.ui.setWidget(WIDGET_KEY, formatStatus(state).split("\n"));
}

function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function normalizeNote(value: string | undefined): string | undefined {
	const note = value?.trim();
	return note ? note : undefined;
}

function buildAgentInstruction(state: GoalState): string {
	return `## Goal mode

Objective:
${state.objective}

This goal is active. Continue working autonomously until the objective is genuinely achieved or progress requires user input or an external state change.

Required protocol:
- Make concrete progress in every turn. Inspect and verify real state instead of assuming.
- Use the goal tool with action "update" when a concise progress checkpoint will help preserve state.
- Before claiming success, verify the requested result in proportion to risk.
- Call the goal tool with action "complete" and a concise evidence-based summary only when the full objective is achieved.
- Call the goal tool with action "blocked" and a concrete reason only when you cannot make meaningful progress without user input or an external state change.
- Do not treat a normal assistant response as goal completion. If work remains, leave the goal active; Pi will schedule another continuation.

Current progress: ${state.note ?? "(none recorded)"}
Turns used in this activation budget: ${state.turns}/${state.turnLimit}`;
}

function toolText(state: GoalState): string {
	return formatStatus(state);
}

export default function goalModeExtension(pi: ExtensionAPI): void {
	let state: GoalState | undefined;
	let runtimeArmed = false;
	let lastStopReason: StopReason | undefined;

	function persist(ctx: ExtensionContext, nextState: GoalState): string | undefined {
		try {
			pi.appendEntry(GOAL_ENTRY_TYPE, nextState);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		state = nextState;
		updateUi(ctx, state);
		return undefined;
	}

	function transition(
		ctx: ExtensionContext,
		status: GoalStatus,
		note: string | undefined,
		options: { extendTurnLimit?: boolean } = {},
	): string | undefined {
		if (!state) return "No goal exists in the current session branch";
		const turnLimit = options.extendTurnLimit
			? Math.min(MAX_TOTAL_TURNS, Math.max(state.turnLimit, state.turns + DEFAULT_TURN_BATCH))
			: state.turnLimit;
		return persist(ctx, {
			...state,
			status,
			turnLimit,
			updatedAt: new Date().toISOString(),
			note,
		});
	}

	function queueGoalTurn(current: GoalState): void {
		pi.sendMessage(
			{
				customType: GOAL_CONTEXT_TYPE,
				content: buildAgentInstruction(current),
				display: false,
				details: { goalId: current.id, turn: current.turns + 1 },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function requireGoalTool(ctx: ExtensionContext): boolean {
		if (pi.getActiveTools().includes("goal")) return true;
		ctx.ui.notify("Goal mode requires the goal tool. Remove it from --exclude-tools or --no-tools.", "error");
		return false;
	}

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Report goal-mode status or progress. Only the user can start a goal. Use complete only after verifying the full objective; use blocked only when progress requires user input or an external state change.",
		promptSnippet: "Report progress, completion, or a genuine blocker for an active /goal workflow",
		promptGuidelines: [
			"While goal mode is active, call goal complete only after verification, or goal blocked only when external input or state is required.",
		],
		parameters: GoalToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				return {
					content: [{ type: "text", text: "No goal exists in the current session branch." }],
					details: { state: undefined },
				};
			}
			if (params.action === "status") {
				return {
					content: [{ type: "text", text: toolText(state) }],
					details: { state },
				};
			}
			if (state.status !== "active") {
				return {
					content: [{ type: "text", text: `Goal is ${state.status}; only an active goal can be updated.` }],
					details: { state },
				};
			}
			const note = normalizeNote(params.note);
			if (!note) {
				return {
					content: [{ type: "text", text: `A non-empty note is required for goal ${params.action}.` }],
					details: { state },
				};
			}
			const nextStatus =
				params.action === "complete" ? "completed" : params.action === "blocked" ? "blocked" : "active";
			const error = transition(ctx, nextStatus, note);
			if (error) {
				return {
					content: [{ type: "text", text: `Goal state could not be persisted: ${error}` }],
					details: { state },
				};
			}
			if (nextStatus !== "active") runtimeArmed = false;
			const verb = nextStatus === "completed" ? "completed" : nextStatus === "blocked" ? "blocked" : "updated";
			return {
				content: [{ type: "text", text: `Goal ${verb}: ${note}` }],
				details: { state },
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Start or control a persistent autonomous goal",
		handler: async (args, ctx) => {
			const input = args.trim();
			const action = input || "status";

			if (action === "status") {
				ctx.ui.notify(state ? formatStatus(state) : "No goal exists in the current session branch.", "info");
				return;
			}

			if (action === "pause") {
				if (!state || state.status !== "active") {
					ctx.ui.notify("Only an active goal can be paused.", "warning");
					return;
				}
				const error = transition(ctx, "paused", "Paused by user.");
				if (error) {
					ctx.ui.notify(`Goal pause could not be persisted: ${error}`, "error");
					return;
				}
				runtimeArmed = false;
				if (!ctx.isIdle()) ctx.abort();
				ctx.ui.notify("Goal paused. Run /goal resume to continue.", "info");
				return;
			}

			if (action === "resume") {
				if (!state || (state.status !== "paused" && state.status !== "blocked" && state.status !== "active")) {
					ctx.ui.notify("No paused, blocked, or active goal can be resumed.", "warning");
					return;
				}
				if (state.status === "active" && runtimeArmed && !ctx.isIdle()) {
					ctx.ui.notify("Goal is already running.", "info");
					return;
				}
				if (state.turns >= MAX_TOTAL_TURNS) {
					ctx.ui.notify(`Goal reached its lifetime limit of ${MAX_TOTAL_TURNS} agent runs.`, "error");
					return;
				}
				if (!requireGoalTool(ctx)) return;
				const extendTurnLimit = state.turns >= state.turnLimit;
				const error = transition(ctx, "active", state.note, { extendTurnLimit });
				if (error) {
					ctx.ui.notify(`Goal resume could not be persisted: ${error}`, "error");
					return;
				}
				runtimeArmed = true;
				lastStopReason = undefined;
				queueGoalTurn(state!);
				ctx.ui.notify("Goal resumed.", "info");
				return;
			}

			if (action === "stop") {
				if (!state || state.status === "completed" || state.status === "stopped") {
					ctx.ui.notify("No unfinished goal can be stopped.", "warning");
					return;
				}
				const error = transition(ctx, "stopped", "Stopped by user.");
				if (error) {
					ctx.ui.notify(`Goal stop could not be persisted: ${error}`, "error");
					return;
				}
				runtimeArmed = false;
				if (!ctx.isIdle()) ctx.abort();
				ctx.ui.notify("Goal stopped.", "info");
				return;
			}

			const objective = action.startsWith("start ") ? action.slice("start ".length).trim() : action;
			if (!objective) {
				ctx.ui.notify("Usage: /goal <objective> | /goal [status|pause|resume|stop]", "warning");
				return;
			}
			if (objective.length > MAX_OBJECTIVE_LENGTH) {
				ctx.ui.notify(`Goal objective must be at most ${MAX_OBJECTIVE_LENGTH} characters.`, "error");
				return;
			}
			if (state && state.status !== "completed" && state.status !== "stopped") {
				ctx.ui.notify(
					`A ${state.status} goal already exists. Stop or complete it before starting another.`,
					"warning",
				);
				return;
			}
			if (!requireGoalTool(ctx)) return;

			const now = new Date().toISOString();
			const nextState: GoalState = {
				version: 1,
				id: randomUUID(),
				objective,
				status: "active",
				turns: 0,
				turnLimit: DEFAULT_TURN_BATCH,
				createdAt: now,
				updatedAt: now,
			};
			const error = persist(ctx, nextState);
			if (error) {
				ctx.ui.notify(`Goal could not be started because its state was not persisted: ${error}`, "error");
				return;
			}
			runtimeArmed = true;
			lastStopReason = undefined;
			queueGoalTurn(nextState);
			ctx.ui.notify("Goal started. Use /goal pause or /goal stop to interrupt it.", "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		state = findGoalState(ctx.sessionManager.getBranch());
		runtimeArmed = false;
		lastStopReason = undefined;
		updateUi(ctx, state);
		if (state?.status === "active" && event.reason !== "activation") {
			ctx.ui.notify("An active goal was restored. Run /goal resume or send a message to continue it.", "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = findGoalState(ctx.sessionManager.getBranch());
		runtimeArmed = false;
		lastStopReason = undefined;
		updateUi(ctx, state);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (state?.status !== "active") return;
		if (!pi.getActiveTools().includes("goal")) {
			const error = transition(ctx, "paused", "The goal tool is disabled.");
			if (error) {
				ctx.ui.notify(`Disabled goal state could not be persisted: ${error}`, "error");
			} else {
				ctx.ui.notify("Goal paused because the goal tool is disabled.", "error");
			}
			return;
		}
		runtimeArmed = true;
		lastStopReason = undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildAgentInstruction(state)}`,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!runtimeArmed || state?.status !== "active") return;
		if (state.turns >= state.turnLimit) {
			const error = transition(
				ctx,
				"paused",
				`Automatic turn limit ${state.turnLimit} reached before the next model request.`,
			);
			runtimeArmed = false;
			ctx.abort();
			if (error) ctx.ui.notify(`Goal turn limit could not be persisted: ${error}`, "error");
			return;
		}
		const error = persist(ctx, {
			...state,
			turns: state.turns + 1,
			updatedAt: new Date().toISOString(),
		});
		if (!error) return;
		runtimeArmed = false;
		ctx.abort();
		ctx.ui.notify(`Goal turn could not be persisted: ${error}`, "error");
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!runtimeArmed || state?.status !== "active") return;
		const assistant = findLastAssistant(event.messages);
		lastStopReason = assistant?.stopReason;
		if (assistant?.stopReason === "error") return;
		if (assistant?.stopReason === "aborted") {
			const error = transition(ctx, "paused", "The agent run was interrupted.");
			runtimeArmed = false;
			if (error) ctx.ui.notify(`Interrupted goal state could not be persisted: ${error}`, "error");
			return;
		}
		if (state.turns >= state.turnLimit) {
			const error = transition(
				ctx,
				"paused",
				`Automatic turn limit ${state.turnLimit} reached. Review progress before resuming.`,
			);
			runtimeArmed = false;
			if (error) {
				ctx.ui.notify(`Goal turn limit could not be persisted: ${error}`, "error");
			} else {
				ctx.ui.notify(
					"Goal paused at its automatic turn limit. Run /goal resume to grant another batch.",
					"warning",
				);
			}
			return;
		}
		if (ctx.hasPendingMessages()) return;
		queueGoalTurn(state);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!runtimeArmed || state?.status !== "active") {
			runtimeArmed = false;
			return;
		}
		const note =
			lastStopReason === "error"
				? "The provider or agent runtime ended with an error."
				: "The agent run settled before the goal reached a terminal state.";
		const nextStatus: GoalStatus = lastStopReason === "error" ? "blocked" : "paused";
		const error = transition(ctx, nextStatus, note);
		runtimeArmed = false;
		if (error) {
			ctx.ui.notify(`Settled goal state could not be persisted: ${error}`, "error");
		} else {
			ctx.ui.notify(
				nextStatus === "blocked"
					? "Goal blocked by an agent/runtime error. Resolve it and run /goal resume."
					: "Goal paused because the run settled unexpectedly. Run /goal resume to continue.",
				nextStatus === "blocked" ? "error" : "warning",
			);
		}
	});
}
