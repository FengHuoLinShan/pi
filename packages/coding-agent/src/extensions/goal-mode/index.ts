import { randomUUID } from "node:crypto";
import {
	type AgentMessage,
	type CompletionStatus,
	createWorkingSet,
	RevisionAwareWorkingSet,
	type WorkingSetEntryKind,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import {
	type GoalCompletionPlan,
	type GoalCompletionVerification,
	loadGoalCompletionPlan,
	verifyGoalCompletion,
} from "../../core/goal-completion.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import {
	cancelWorkGraph,
	consumeWorkNodeBudget,
	createWorkGraph,
	recordWorkNodeProgress,
	reopenWorkNode,
	transitionWorkNode,
	type WorkGraph,
	type WorkNode,
} from "../../core/work-graph.ts";
import { SessionWorkGraphStore } from "../../core/work-graph-session.ts";
import { prepareWorkspaceWorkingSet, SessionWorkingSetStore } from "../../core/working-set-session.ts";
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
const MAX_COMPLETION_CHECKS = 10;
const CHECK_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GOAL_WORK_NODE_ID = "work";
const GOAL_COMPLETE_NODE_ID = "complete";

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
export type GoalVerificationStatus = "pending" | CompletionStatus;

export interface GoalVerificationCheckState {
	id: string;
	status: GoalVerificationStatus;
	exitCode: number | null;
	killed: boolean;
}

export interface GoalVerificationState {
	configRevision: string;
	checkIds: string[];
	status: GoalVerificationStatus;
	checkedAt?: string;
	checks: GoalVerificationCheckState[];
}

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
	verification?: GoalVerificationState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "active" || value === "paused" || value === "blocked" || value === "completed" || value === "stopped"
	);
}

function isGoalVerificationStatus(value: unknown): value is GoalVerificationStatus {
	return value === "pending" || value === "pass" || value === "fail" || value === "blocked" || value === "error";
}

function parseGoalVerificationState(value: unknown): GoalVerificationState | undefined {
	if (
		!isRecord(value) ||
		typeof value.configRevision !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(value.configRevision) ||
		!Array.isArray(value.checkIds) ||
		value.checkIds.length === 0 ||
		value.checkIds.length > MAX_COMPLETION_CHECKS ||
		!value.checkIds.every((id) => typeof id === "string" && CHECK_ID_PATTERN.test(id)) ||
		new Set(value.checkIds).size !== value.checkIds.length ||
		!isGoalVerificationStatus(value.status) ||
		(value.checkedAt !== undefined &&
			(typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)))) ||
		!Array.isArray(value.checks) ||
		value.checks.length !== value.checkIds.length
	) {
		return undefined;
	}
	for (let index = 0; index < value.checks.length; index++) {
		if (!(index in value.checkIds) || !(index in value.checks)) return undefined;
		const check = value.checks[index];
		if (
			!isRecord(check) ||
			check.id !== value.checkIds[index] ||
			!isGoalVerificationStatus(check.status) ||
			(check.exitCode !== null && !Number.isSafeInteger(check.exitCode)) ||
			typeof check.killed !== "boolean"
		) {
			return undefined;
		}
	}
	return {
		configRevision: value.configRevision,
		checkIds: [...value.checkIds],
		status: value.status,
		...(value.checkedAt === undefined ? {} : { checkedAt: value.checkedAt as string }),
		checks: value.checks.map((check) => ({
			id: check.id as string,
			status: check.status as GoalVerificationStatus,
			exitCode: check.exitCode as number | null,
			killed: check.killed as boolean,
		})),
	};
}

export function parseGoalState(value: unknown): GoalState | undefined {
	const verification = isRecord(value) ? parseGoalVerificationState(value.verification) : undefined;
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
		(value.note !== undefined && (typeof value.note !== "string" || value.note.length > MAX_NOTE_LENGTH)) ||
		(value.verification !== undefined && verification === undefined)
	) {
		return undefined;
	}
	return {
		version: 1,
		id: value.id as string,
		objective: value.objective as string,
		status: value.status as GoalStatus,
		turns: value.turns as number,
		turnLimit: value.turnLimit as number,
		createdAt: value.createdAt as string,
		updatedAt: value.updatedAt as string,
		...(value.note === undefined ? {} : { note: value.note as string }),
		...(verification === undefined ? {} : { verification }),
	};
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
	if (state.verification) {
		lines.push(
			`Completion gate: ${state.verification.status} · ${state.verification.checkIds.join(", ")} · ${state.verification.configRevision.slice(0, 15)}…`,
		);
	}
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
	const completionGate = state.verification
		? `\n- The trusted completion gate is locked to checks: ${state.verification.checkIds.join(", ")}. Calling "complete" runs that frozen gate in the current logical workspace. The goal completes only when every check passes; repair failures and retry.`
		: "";
	return `## Goal mode

Objective:
${state.objective}

This goal is active. Continue working autonomously until the objective is genuinely achieved or progress requires user input or an external state change.

Required protocol:
- Make concrete progress in every turn. Inspect and verify real state instead of assuming.
- Use the goal tool with action "update" when a concise progress checkpoint will help preserve state.
- Before claiming success, verify the requested result in proportion to risk.
- Call the goal tool with action "complete" and a concise evidence-based summary only when the full objective is achieved.${completionGate}
- Call the goal tool with action "blocked" and a concrete reason only when you cannot make meaningful progress without user input or an external state change.
- Do not treat a normal assistant response as goal completion. If work remains, leave the goal active; Pi will schedule another continuation.

Current progress: ${state.note ?? "(none recorded)"}
Turns used in this activation budget: ${state.turns}/${state.turnLimit}`;
}

function toolText(state: GoalState): string {
	return formatStatus(state);
}

function pendingVerification(plan: GoalCompletionPlan): GoalVerificationState {
	const checkIds = plan.checks.map((check) => check.id);
	return {
		configRevision: plan.configRevision,
		checkIds,
		status: "pending",
		checks: checkIds.map((id) => ({ id, status: "pending", exitCode: null, killed: false })),
	};
}

function persistedVerification(
	plan: GoalCompletionPlan,
	verification: GoalCompletionVerification,
): GoalVerificationState {
	return {
		configRevision: plan.configRevision,
		checkIds: verification.checks.map((check) => check.id),
		status: verification.report.status,
		checkedAt: new Date().toISOString(),
		checks: verification.checks.map((check) => ({
			id: check.id,
			status: check.status,
			exitCode: check.exitCode,
			killed: check.killed,
		})),
	};
}

function sameCheckIds(expected: readonly string[], plan: GoalCompletionPlan): boolean {
	return expected.length === plan.checks.length && expected.every((id, index) => id === plan.checks[index]?.id);
}

function formatVerificationFailure(verification: GoalCompletionVerification): string {
	const failures = verification.checks
		.filter((check) => check.status !== "pass")
		.map((check) => {
			const outcome =
				check.status === "blocked"
					? "interrupted"
					: check.status === "error"
						? "errored"
						: `exited with code ${check.exitCode}`;
			return check.diagnostic ? `${check.id} ${outcome}\n${check.diagnostic}` : `${check.id} ${outcome}`;
		});
	return `Goal completion gate ${verification.report.status}:\n\n${failures.join("\n\n")}`;
}

function verificationNodeId(checkId: string): string {
	return `verify:${checkId}`;
}

function createGoalWorkGraph(
	id: string,
	objective: string,
	completionPlan: GoalCompletionPlan | undefined,
	now: string,
): WorkGraph {
	const verificationNodes =
		completionPlan?.checks.map((check) => ({
			id: verificationNodeId(check.id),
			kind: "verification" as const,
			policy: "verification" as const,
			description: `Run completion check ${check.id}`,
			dependsOn: [GOAL_WORK_NODE_ID],
			budget: { unit: "attempt" as const, limit: MAX_TOTAL_TURNS },
		})) ?? [];
	return createWorkGraph({
		id,
		objective,
		now,
		nodes: [
			{
				id: GOAL_WORK_NODE_ID,
				kind: "task",
				policy: "inline",
				description: objective,
				initialStatus: "running",
				budget: { unit: "turn", limit: MAX_TOTAL_TURNS },
			},
			...verificationNodes,
			{
				id: GOAL_COMPLETE_NODE_ID,
				kind: "objective",
				policy: "inline",
				description: `Complete: ${objective}`,
				dependsOn: verificationNodes.length > 0 ? verificationNodes.map((node) => node.id) : [GOAL_WORK_NODE_ID],
			},
		],
	});
}

function requireGoalWorkNode(graph: WorkGraph): WorkNode {
	const node = graph.nodes.find((candidate) => candidate.id === GOAL_WORK_NODE_ID);
	if (!node) throw new Error(`Goal work graph is missing node ${GOAL_WORK_NODE_ID}`);
	return node;
}

function ensureGoalWorkRunning(graph: WorkGraph, now: string): WorkGraph {
	const node = requireGoalWorkNode(graph);
	if (node.status === "running") return graph;
	if (node.status === "ready") return transitionWorkNode(graph, node.id, "running", { now });
	if (
		node.status === "paused" ||
		node.status === "blocked" ||
		node.status === "failed" ||
		node.status === "succeeded"
	) {
		const reopened = reopenWorkNode(graph, node.id, { now });
		return transitionWorkNode(reopened, node.id, "running", { now });
	}
	throw new Error(`Goal work node cannot resume while ${node.status}`);
}

function syncGoalWorkGraph(graph: WorkGraph, status: GoalStatus, note: string | undefined, now: string): WorkGraph {
	if (status === "stopped") return cancelWorkGraph(graph, note ?? "Goal stopped", now);
	if (status === "active") {
		const running = ensureGoalWorkRunning(graph, now);
		return note ? recordWorkNodeProgress(running, GOAL_WORK_NODE_ID, { summary: note, now }) : running;
	}
	if (status === "paused" || status === "blocked") {
		const running = ensureGoalWorkRunning(graph, now);
		return transitionWorkNode(running, GOAL_WORK_NODE_ID, status, { summary: note, now });
	}

	let completed = graph;
	const work = requireGoalWorkNode(completed);
	if (work.status !== "succeeded") {
		completed = ensureGoalWorkRunning(completed, now);
		completed = transitionWorkNode(completed, GOAL_WORK_NODE_ID, "succeeded", { summary: note, now });
	}
	const incompleteVerification = completed.nodes.find(
		(node) => node.kind === "verification" && node.status !== "succeeded",
	);
	if (incompleteVerification) {
		throw new Error(`Completion node ${incompleteVerification.id} has not succeeded`);
	}
	const objective = completed.nodes.find((node) => node.id === GOAL_COMPLETE_NODE_ID);
	if (!objective) throw new Error(`Goal work graph is missing node ${GOAL_COMPLETE_NODE_ID}`);
	if (objective.status === "succeeded") return completed;
	if (objective.status !== "ready" && objective.status !== "running") {
		throw new Error(`Goal completion node cannot finish while ${objective.status}`);
	}
	if (objective.status === "ready") {
		completed = transitionWorkNode(completed, objective.id, "running", { now });
	}
	return transitionWorkNode(completed, objective.id, "succeeded", { summary: note, now });
}

export default function goalModeExtension(pi: ExtensionAPI): void {
	let state: GoalState | undefined;
	let runtimeArmed = false;
	let lastStopReason: StopReason | undefined;

	function graphStore(ctx: ExtensionContext): SessionWorkGraphStore {
		return new SessionWorkGraphStore(
			() => ctx.sessionManager.getBranch(),
			(customType, data) => pi.appendEntry(customType, data),
		);
	}

	function workingSetStore(ctx: ExtensionContext): SessionWorkingSetStore {
		return new SessionWorkingSetStore(
			() => ctx.sessionManager.getBranch(),
			(customType, data) => pi.appendEntry(customType, data),
		);
	}

	function appendGoalWorkingSet(
		ctx: ExtensionContext,
		kind: WorkingSetEntryKind,
		content: string,
	): string | undefined {
		if (!state) return undefined;
		try {
			const store = workingSetStore(ctx);
			const snapshot = store.get(state.id);
			if (!snapshot) return undefined;
			const workingSet = new RevisionAwareWorkingSet(snapshot);
			workingSet.append({
				id: `goal:${kind}:${snapshot.revision + 1}`,
				kind,
				content,
				priority: kind === "evidence" ? 100 : kind === "decision" ? 50 : 0,
				required: false,
				tags: ["goal"],
				sources: [],
				evidenceIds: [],
				createdAt: new Date().toISOString(),
			});
			store.save(workingSet.snapshot(), snapshot.revision);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	function mutateGoalGraph(
		ctx: ExtensionContext,
		mutate: (graph: WorkGraph) => WorkGraph,
	): { graph?: WorkGraph; error?: string } {
		if (!state) return {};
		try {
			const store = graphStore(ctx);
			const current = store.get(state.id);
			if (!current) return {};
			const next = mutate(current);
			if (next.revision !== current.revision) store.save(next, current.revision);
			return { graph: next };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

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
		options: {
			extendTurnLimit?: boolean;
			verification?: GoalVerificationState;
			syncGraph?: boolean;
			syncWorkingSet?: boolean;
			workingSetKind?: WorkingSetEntryKind;
		} = {},
	): string | undefined {
		if (!state) return "No goal exists in the current session branch";
		const now = new Date().toISOString();
		if (options.syncGraph !== false) {
			const graphResult = mutateGoalGraph(ctx, (graph) => syncGoalWorkGraph(graph, status, note, now));
			if (graphResult.error) return `Work graph could not be persisted: ${graphResult.error}`;
		}
		if (note && options.syncWorkingSet !== false) {
			const workingSetError = appendGoalWorkingSet(
				ctx,
				options.workingSetKind ??
					(status === "completed" ? "evidence" : status === "paused" ? "decision" : "attempt"),
				note,
			);
			if (workingSetError) return `Working set could not be persisted: ${workingSetError}`;
		}
		const turnLimit = options.extendTurnLimit
			? Math.min(MAX_TOTAL_TURNS, Math.max(state.turnLimit, state.turns + DEFAULT_TURN_BATCH))
			: state.turnLimit;
		return persist(ctx, {
			...state,
			status,
			turnLimit,
			updatedAt: now,
			note,
			verification: options.verification ?? state.verification,
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

	function recordCompletionChecks(
		ctx: ExtensionContext,
		verification: GoalCompletionVerification,
	): string | undefined {
		const now = new Date().toISOString();
		const graphResult = mutateGoalGraph(ctx, (graph) => {
			let next = graph;
			const work = requireGoalWorkNode(next);
			if (work.status !== "succeeded") {
				next = ensureGoalWorkRunning(next, now);
				next = transitionWorkNode(next, GOAL_WORK_NODE_ID, "succeeded", {
					summary: "Implementation submitted to the completion gate",
					now,
				});
			}
			for (const check of verification.checks) {
				const nodeId = verificationNodeId(check.id);
				const node = next.nodes.find((candidate) => candidate.id === nodeId);
				if (!node) throw new Error(`Goal work graph is missing completion node ${nodeId}`);
				if (node.status !== "ready") throw new Error(`Completion node ${nodeId} is ${node.status}, expected ready`);
				next = transitionWorkNode(next, nodeId, "running", { now });
				const status = check.status === "pass" ? "succeeded" : check.status === "blocked" ? "blocked" : "failed";
				next = transitionWorkNode(next, nodeId, status, {
					summary:
						check.status === "pass"
							? `Completion check ${check.id} passed`
							: `Completion check ${check.id} ${check.status}`,
					evidence: [
						{
							id: `goal-check:${check.id}:${next.revision + 1}`,
							kind: "process",
							summary: `Exit ${check.exitCode ?? "unknown"}; killed ${check.killed}`,
						},
					],
					now,
				});
			}
			return next;
		});
		return graphResult.error;
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
			if (params.action === "complete" && state.verification) {
				const expected = state.verification;
				const blockForConfig = (reason: string) => {
					const verification: GoalVerificationState = {
						...expected,
						status: "blocked",
						checkedAt: new Date().toISOString(),
					};
					const error = transition(ctx, "blocked", reason, { verification });
					runtimeArmed = false;
					return {
						content: [
							{
								type: "text" as const,
								text: error ? `Goal state could not be persisted: ${error}` : `Goal blocked: ${reason}`,
							},
						],
						details: { state },
					};
				};
				if (!ctx.isProjectTrusted()) {
					return blockForConfig("Project trust was revoked before the completion gate ran.");
				}
				if (ctx.workspace.execution.target !== "host") {
					return blockForConfig(
						"Completion gates cannot run through an execution boundary because extension commands execute on the host.",
					);
				}
				let plan: GoalCompletionPlan | undefined;
				try {
					plan = await loadGoalCompletionPlan(ctx.workspace.sourceRoot);
				} catch (error) {
					return blockForConfig(
						`Completion gate configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (!plan) return blockForConfig("Completion gate configuration was removed after the goal started.");
				if (plan.configRevision !== expected.configRevision || !sameCheckIds(expected.checkIds, plan)) {
					return blockForConfig("Completion gate configuration changed after the goal started.");
				}
				const verification = await verifyGoalCompletion(
					state.objective,
					plan,
					ctx.workspace.logicalRoot,
					(command, args, options) => pi.exec(command, args, options),
					signal,
				);
				const graphError = recordCompletionChecks(ctx, verification);
				if (graphError) {
					return blockForConfig(`Completion results could not be persisted: ${graphError}`);
				}
				const persisted = persistedVerification(plan, verification);
				if (verification.report.status !== "pass") {
					const error = transition(
						ctx,
						"active",
						`Completion gate ${verification.report.status}: ${verification.checks
							.filter((check) => check.status !== "pass")
							.map((check) => check.id)
							.join(", ")}`,
						{ verification: persisted },
					);
					return {
						content: [
							{
								type: "text",
								text: error
									? `Goal state could not be persisted: ${error}`
									: formatVerificationFailure(verification),
							},
						],
						details: { state, verification: verification.report },
					};
				}
				const error = transition(ctx, "completed", note, { verification: persisted });
				if (error) {
					return {
						content: [{ type: "text", text: `Goal state could not be persisted: ${error}` }],
						details: { state, verification: verification.report },
					};
				}
				runtimeArmed = false;
				return {
					content: [{ type: "text", text: `Goal completed after the completion gate passed: ${note}` }],
					details: { state, verification: verification.report },
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

			let completionPlan: GoalCompletionPlan | undefined;
			if (ctx.isProjectTrusted()) {
				try {
					completionPlan = await loadGoalCompletionPlan(ctx.workspace.sourceRoot);
				} catch (error) {
					ctx.ui.notify(
						`Goal could not be started because the completion gate is invalid: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
			}
			if (completionPlan && ctx.workspace.execution.target !== "host") {
				ctx.ui.notify(
					"Goal could not be started because its completion gate cannot run through an execution boundary.",
					"error",
				);
				return;
			}
			const now = new Date().toISOString();
			const goalId = randomUUID();
			const nextState: GoalState = {
				version: 1,
				id: goalId,
				objective,
				status: "active",
				turns: 0,
				turnLimit: DEFAULT_TURN_BATCH,
				createdAt: now,
				updatedAt: now,
				...(completionPlan ? { verification: pendingVerification(completionPlan) } : {}),
			};
			try {
				graphStore(ctx).create(createGoalWorkGraph(goalId, objective, completionPlan, now));
				const store = workingSetStore(ctx);
				const initialWorkingSet = createWorkingSet(goalId);
				store.create(initialWorkingSet);
				const workingSet = new RevisionAwareWorkingSet(initialWorkingSet);
				workingSet.append({
					id: "goal:objective",
					kind: "objective",
					content: objective,
					priority: 1_000,
					required: true,
					tags: ["goal", "objective"],
					sources: [],
					evidenceIds: [],
					createdAt: now,
				});
				store.save(workingSet.snapshot(), initialWorkingSet.revision);
			} catch (error) {
				ctx.ui.notify(
					`Goal could not be started because its durable state was not persisted: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			const error = persist(ctx, nextState);
			if (error) {
				ctx.ui.notify(`Goal could not be started because its state was not persisted: ${error}`, "error");
				return;
			}
			runtimeArmed = true;
			lastStopReason = undefined;
			queueGoalTurn(nextState);
			ctx.ui.notify(
				completionPlan
					? `Goal started with ${completionPlan.checks.length} revision-locked completion check${completionPlan.checks.length === 1 ? "" : "s"}.`
					: "Goal started. Use /goal pause or /goal stop to interrupt it.",
				"info",
			);
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
		let workingSetContext = "";
		try {
			const snapshot = workingSetStore(ctx).get(state.id);
			if (snapshot) {
				const prepared = await prepareWorkspaceWorkingSet(
					snapshot,
					ctx.workspace,
					{ task: state.objective, tokenBudget: 1_600, maxEntries: 64 },
					{ signal: ctx.signal },
				);
				if (prepared.status === "blocked") {
					const stale = prepared.freshness
						.filter((entry) => entry.status !== "fresh")
						.map((entry) => entry.entryId)
						.join(", ");
					const error = transition(ctx, "blocked", `Required working-set context is stale or missing: ${stale}`);
					runtimeArmed = false;
					if (error) {
						ctx.ui.notify(`Stale working-set state could not be persisted: ${error}`, "error");
					} else {
						ctx.ui.notify("Goal blocked because required working-set context is stale or missing.", "error");
					}
					return;
				}
				workingSetContext = `\n\n## Durable working set\n\n${prepared.compiledContext.text}`;
			}
		} catch (error) {
			const reason = `Working set could not be prepared: ${error instanceof Error ? error.message : String(error)}`;
			const persistError = transition(ctx, "blocked", reason, { syncWorkingSet: false });
			runtimeArmed = false;
			ctx.ui.notify(
				persistError ? `Working-set failure and blocked state could not be persisted: ${persistError}` : reason,
				"error",
			);
			return;
		}
		runtimeArmed = true;
		lastStopReason = undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildAgentInstruction(state)}${workingSetContext}`,
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
		const graphResult = mutateGoalGraph(ctx, (graph) =>
			consumeWorkNodeBudget(graph, GOAL_WORK_NODE_ID, "turn", 1, new Date().toISOString()),
		);
		if (graphResult.error) {
			const error = transition(ctx, "blocked", `Work graph budget could not be updated: ${graphResult.error}`, {
				syncGraph: false,
			});
			runtimeArmed = false;
			ctx.abort();
			ctx.ui.notify(
				error
					? `Goal work graph and blocked state could not be persisted: ${error}`
					: `Goal blocked because its work graph could not be updated: ${graphResult.error}`,
				"error",
			);
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
