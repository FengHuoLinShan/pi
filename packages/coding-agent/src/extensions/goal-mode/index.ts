import { randomUUID } from "node:crypto";
import {
	type AgentMessage,
	type CompletionStatus,
	createEngineeringMemory,
	type EngineeringMemoryKind,
	type EngineeringMemoryRecord,
	type EngineeringMemoryRecordInput,
	RevisionedEngineeringMemory,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	prepareWorkspaceEngineeringMemory,
	resolveWorkspaceMemorySources,
	SessionEngineeringMemoryStore,
} from "../../core/engineering-memory-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import {
	type GoalCompletionPlan,
	type GoalCompletionVerification,
	loadGoalCompletionPlan,
	verifyGoalCompletion,
} from "../../core/goal-completion.ts";
import {
	collectGitChangedPaths,
	getImpactGraphProvider,
	type ImpactVerificationCatalogPlan,
	type ImpactVerificationCoverage,
	type ImpactVerificationResult,
	loadImpactVerificationCatalog,
	verifyImpactPlan,
} from "../../core/impact-verification.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import {
	cancelWorkGraph,
	consumeWorkNodeBudget,
	createWorkGraph,
	recordWorkNodeProgress,
	recoverWorkGraph,
	reopenWorkNode,
	transitionWorkNode,
	type WorkGraph,
	type WorkNode,
} from "../../core/work-graph.ts";
import { SessionWorkGraphStore } from "../../core/work-graph-session.ts";
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
const MAX_DISPLAY_MEMORY_RECORDS = 20;
const MAX_COMPLETION_CHECKS = 10;
const MAX_IMPACT_CHECKS = 100;
const CHECK_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GOAL_WORK_NODE_ID = "work";
const GOAL_IMPACT_NODE_ID = "verify:impact";
const GOAL_COMPLETE_NODE_ID = "complete";

const GoalToolParams = Type.Object(
	{
		action: Type.Union([
			Type.Literal("status"),
			Type.Literal("update"),
			Type.Literal("remember"),
			Type.Literal("complete"),
			Type.Literal("blocked"),
		]),
		note: Type.Optional(Type.String({ maxLength: MAX_NOTE_LENGTH })),
		memoryKind: Type.Optional(
			Type.Union([
				Type.Literal("fact"),
				Type.Literal("decision"),
				Type.Literal("attempt"),
				Type.Literal("evidence"),
			]),
		),
		sources: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.String({ minLength: 1, maxLength: 4_096 }),
						symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 64 },
			),
		),
		replaces: Type.Optional(Type.Array(Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }), { maxItems: 64 })),
		evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 64 })),
		rationale: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_NOTE_LENGTH })),
		alternatives: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: MAX_NOTE_LENGTH }), { maxItems: 64 }),
		),
		outcome: Type.Optional(
			Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("inconclusive")]),
		),
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

export interface GoalImpactVerificationState {
	catalogRevision: string;
	status: GoalVerificationStatus;
	checkedAt?: string;
	coverage?: ImpactVerificationCoverage;
	changedFileCount: number;
	affectedFileCount: number;
	selectedCheckIds: string[];
	evidenceId?: string;
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
	impactVerification?: GoalImpactVerificationState;
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

function parseGoalImpactVerificationState(value: unknown): GoalImpactVerificationState | undefined {
	if (
		!isRecord(value) ||
		typeof value.catalogRevision !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(value.catalogRevision) ||
		!isGoalVerificationStatus(value.status) ||
		(value.checkedAt !== undefined &&
			(typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)))) ||
		(value.coverage !== undefined &&
			value.coverage !== "complete" &&
			value.coverage !== "fallback" &&
			value.coverage !== "uncovered") ||
		!Number.isSafeInteger(value.changedFileCount) ||
		(value.changedFileCount as number) < 0 ||
		!Number.isSafeInteger(value.affectedFileCount) ||
		(value.affectedFileCount as number) < 0 ||
		!Array.isArray(value.selectedCheckIds) ||
		value.selectedCheckIds.length > MAX_IMPACT_CHECKS ||
		!value.selectedCheckIds.every((id) => typeof id === "string" && CHECK_ID_PATTERN.test(id)) ||
		new Set(value.selectedCheckIds).size !== value.selectedCheckIds.length ||
		(value.evidenceId !== undefined &&
			(typeof value.evidenceId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.evidenceId)))
	) {
		return undefined;
	}
	for (let index = 0; index < value.selectedCheckIds.length; index++) {
		if (!(index in value.selectedCheckIds)) return undefined;
	}
	return {
		catalogRevision: value.catalogRevision,
		status: value.status,
		...(value.checkedAt === undefined ? {} : { checkedAt: value.checkedAt as string }),
		...(value.coverage === undefined ? {} : { coverage: value.coverage as ImpactVerificationCoverage }),
		changedFileCount: value.changedFileCount as number,
		affectedFileCount: value.affectedFileCount as number,
		selectedCheckIds: [...value.selectedCheckIds],
		...(value.evidenceId === undefined ? {} : { evidenceId: value.evidenceId as string }),
	};
}

export function parseGoalState(value: unknown): GoalState | undefined {
	const verification = isRecord(value) ? parseGoalVerificationState(value.verification) : undefined;
	const impactVerification = isRecord(value) ? parseGoalImpactVerificationState(value.impactVerification) : undefined;
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
		(value.verification !== undefined && verification === undefined) ||
		(value.impactVerification !== undefined && impactVerification === undefined)
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
		...(impactVerification === undefined ? {} : { impactVerification }),
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

export function formatGoalWorkGraph(graph: WorkGraph): string[] {
	const count = (status: WorkNode["status"]) => graph.nodes.filter((node) => node.status === status).length;
	const lines = [
		`Work graph r${graph.revision} · ${count("succeeded")}/${graph.nodes.length} succeeded · ${count("running")} running · ${count("ready")} ready`,
	];
	const visibleNodes = graph.nodes.filter(
		(node) =>
			node.status === "running" ||
			node.status === "ready" ||
			node.status === "failed" ||
			node.status === "blocked" ||
			node.status === "paused",
	);
	for (const node of visibleNodes.slice(0, 5)) {
		const budget = node.budget ? ` · ${node.budget.unit} ${node.budget.used}/${node.budget.limit}` : "";
		const summary = node.lastSummary ? ` · ${displayText(node.lastSummary, 100)}` : "";
		lines.push(`${node.status} ${node.id} [${node.policy}]${budget}${summary}`);
	}
	if (visibleNodes.length > 5) lines.push(`… ${visibleNodes.length - 5} more active nodes`);
	if (graph.leases.length > 0) {
		lines.push(
			`Leases: ${graph.leases
				.slice(0, 4)
				.map((lease) => `${lease.mode}:${lease.resource}`)
				.join(", ")}${graph.leases.length > 4 ? `, +${graph.leases.length - 4}` : ""}`,
		);
	}
	return lines;
}

function formatStatus(state: GoalState, graph?: WorkGraph): string {
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
	if (state.impactVerification) {
		lines.push(
			`Impact gate: ${state.impactVerification.status} · ${state.impactVerification.coverage ?? "pending"} · ${state.impactVerification.selectedCheckIds.length} check(s)`,
		);
	}
	if (graph) lines.push(...formatGoalWorkGraph(graph));
	return lines.join("\n");
}

function updateUi(ctx: ExtensionContext, state: GoalState | undefined, graph?: WorkGraph): void {
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
	ctx.ui.setWidget(WIDGET_KEY, formatStatus(state, graph).split("\n"));
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

function formatEngineeringMemory(snapshot: ReturnType<SessionEngineeringMemoryStore["get"]>): string {
	if (!snapshot) return "No engineering memory exists in the current session branch.";
	const memory = new RevisionedEngineeringMemory(snapshot);
	const history = memory.history();
	const lines = [
		`Engineering memory r${history.memoryRevision}: ${history.activeRecordIds.length} active, ${history.supersededRecordIds.length} superseded`,
	];
	const activeRecords = memory.activeRecords();
	for (const record of activeRecords.slice(0, MAX_DISPLAY_MEMORY_RECORDS)) {
		const content = record.content.replace(/\s+/g, " ").trim();
		const summary = content.length > DISPLAY_NOTE_LENGTH ? `${content.slice(0, DISPLAY_NOTE_LENGTH - 1)}…` : content;
		lines.push(`- ${record.kind} ${record.id.slice(0, 15)}… ${summary}`);
	}
	if (activeRecords.length > MAX_DISPLAY_MEMORY_RECORDS) {
		lines.push(`… ${activeRecords.length - MAX_DISPLAY_MEMORY_RECORDS} more active records`);
	}
	return lines.join("\n");
}

function buildAgentInstruction(state: GoalState, graph?: WorkGraph): string {
	const completionGate = state.verification
		? `\n- The trusted completion gate is locked to checks: ${state.verification.checkIds.join(", ")}. Calling "complete" runs that frozen gate in the current logical workspace. The goal completes only when every check passes; repair failures and retry.`
		: "";
	const impactGate = state.impactVerification
		? '\n- The revision-locked impact gate is mandatory. Calling "complete" discovers the full Git change set, synchronizes the active CodeGraph provider, selects coverage from .pi/checks.json, and fails closed on missing graph coverage or failed checks.'
		: "";
	const workGraph = graph
		? `\n\nCurrent durable work graph:\n${formatGoalWorkGraph(graph)
				.map((line) => `- ${line}`)
				.join("\n")}`
		: "";
	return `## Goal mode

Objective:
${state.objective}

This goal is active. Continue working autonomously until the objective is genuinely achieved or progress requires user input or an external state change.

Required protocol:
- Make concrete progress in every turn. Inspect and verify real state instead of assuming.
- Use the goal tool with action "update" when a concise progress checkpoint will help preserve state.
- Use the goal tool with action "remember" to preserve source-revisioned facts, explicit decisions, failed attempts, and evidence. Replace obsolete records instead of silently contradicting them.
- Before claiming success, verify the requested result in proportion to risk.
- Call the goal tool with action "complete" and a concise evidence-based summary only when the full objective is achieved.${completionGate}${impactGate}
- Call the goal tool with action "blocked" and a concrete reason only when you cannot make meaningful progress without user input or an external state change.
- Do not treat a normal assistant response as goal completion. If work remains, leave the goal active; Pi will schedule another continuation.

Current progress: ${state.note ?? "(none recorded)"}
Turns used in this activation budget: ${state.turns}/${state.turnLimit}${workGraph}`;
}

function toolText(state: GoalState, graph?: WorkGraph): string {
	return formatStatus(state, graph);
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

function pendingImpactVerification(plan: ImpactVerificationCatalogPlan): GoalImpactVerificationState {
	return {
		catalogRevision: plan.configRevision,
		status: "pending",
		changedFileCount: 0,
		affectedFileCount: 0,
		selectedCheckIds: [],
	};
}

function persistedImpactVerification(
	plan: ImpactVerificationCatalogPlan,
	result: ImpactVerificationResult,
): GoalImpactVerificationState {
	return {
		catalogRevision: plan.configRevision,
		status: result.status,
		checkedAt: new Date().toISOString(),
		coverage: result.plan.coverage,
		changedFileCount: result.plan.impact.changedFiles.length,
		affectedFileCount: result.plan.impact.affectedFiles.length,
		selectedCheckIds: result.plan.selected.map(({ check }) => check.id),
		evidenceId: result.evidence.id,
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
	impactPlan: ImpactVerificationCatalogPlan | undefined,
	now: string,
): WorkGraph {
	const configuredVerificationNodes =
		completionPlan?.checks.map((check) => ({
			id: verificationNodeId(check.id),
			kind: "verification" as const,
			policy: "verification" as const,
			description: `Run completion check ${check.id}`,
			dependsOn: [GOAL_WORK_NODE_ID],
			budget: { unit: "attempt" as const, limit: MAX_TOTAL_TURNS },
		})) ?? [];
	const verificationNodes = impactPlan
		? [
				...configuredVerificationNodes,
				{
					id: GOAL_IMPACT_NODE_ID,
					kind: "verification" as const,
					policy: "verification" as const,
					description: "Run CodeGraph-driven impact verification",
					dependsOn: [GOAL_WORK_NODE_ID],
					budget: { unit: "attempt" as const, limit: MAX_TOTAL_TURNS },
				},
			]
		: configuredVerificationNodes;
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
	let goalMutationInFlight = false;
	let goalMutationEpoch = 0;

	function graphStore(ctx: ExtensionContext): SessionWorkGraphStore {
		return new SessionWorkGraphStore(
			() => ctx.sessionManager.getBranch(),
			(customType, data) => pi.appendEntry(customType, data),
		);
	}

	function engineeringMemoryStore(ctx: ExtensionContext): SessionEngineeringMemoryStore {
		return new SessionEngineeringMemoryStore(
			() => ctx.sessionManager.getBranch(),
			(customType, data) => pi.appendEntry(customType, data),
		);
	}

	function currentGoalGraph(ctx: ExtensionContext): WorkGraph | undefined {
		if (!state) return undefined;
		try {
			return graphStore(ctx).get(state.id);
		} catch {
			return undefined;
		}
	}

	function recoverGoalGraph(ctx: ExtensionContext): string | undefined {
		if (!state) return undefined;
		try {
			const store = graphStore(ctx);
			const current = store.get(state.id);
			if (!current) return `Work graph ${state.id} does not exist`;
			const recovered = recoverWorkGraph(current, new Date().toISOString());
			if (recovered.revision !== current.revision) store.save(recovered, current.revision);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	function appendGoalMemory(
		ctx: ExtensionContext,
		input: Omit<EngineeringMemoryRecordInput, "createdAt">,
	): { record?: EngineeringMemoryRecord; error?: string } {
		if (!state) return { error: "No goal exists in the current session branch" };
		try {
			const store = engineeringMemoryStore(ctx);
			const snapshot = store.get(state.id);
			if (!snapshot) return { error: `Engineering memory ${state.id} does not exist` };
			const memory = new RevisionedEngineeringMemory(snapshot);
			const record = memory.append({
				...input,
				createdAt: new Date().toISOString(),
			});
			if (memory.snapshot().revision !== snapshot.revision) store.save(memory.snapshot(), snapshot.revision);
			return { record };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
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
			if (!current) return { error: `Work graph ${state.id} does not exist` };
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
		updateUi(ctx, state, currentGoalGraph(ctx));
		return undefined;
	}

	function transition(
		ctx: ExtensionContext,
		status: GoalStatus,
		note: string | undefined,
		options: {
			extendTurnLimit?: boolean;
			verification?: GoalVerificationState;
			impactVerification?: GoalImpactVerificationState;
			syncGraph?: boolean;
			syncMemory?: boolean;
			memoryKind?: EngineeringMemoryKind;
		} = {},
	): string | undefined {
		if (!state) return "No goal exists in the current session branch";
		const now = new Date().toISOString();
		if (options.syncGraph !== false) {
			const graphResult = mutateGoalGraph(ctx, (graph) => syncGoalWorkGraph(graph, status, note, now));
			if (graphResult.error) return `Work graph could not be persisted: ${graphResult.error}`;
		}
		if (note && options.syncMemory !== false) {
			const memoryResult = appendGoalMemory(ctx, {
				kind:
					options.memoryKind ??
					(status === "completed" ? "evidence" : status === "paused" ? "decision" : "attempt"),
				content: note,
				priority: status === "completed" ? 100 : status === "paused" ? 50 : 0,
				required: false,
				tags: ["goal"],
				sources: [],
				evidenceIds: [],
				replaces: [],
				alternatives: [],
			});
			if (memoryResult.error) return `Engineering memory could not be persisted: ${memoryResult.error}`;
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
			impactVerification: options.impactVerification ?? state.impactVerification,
		});
	}

	function queueGoalTurn(current: GoalState, ctx: ExtensionContext): void {
		pi.sendMessage(
			{
				customType: GOAL_CONTEXT_TYPE,
				content: buildAgentInstruction(current, currentGoalGraph(ctx)),
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

	function recordImpactCheck(
		ctx: ExtensionContext,
		status: CompletionStatus,
		summary: string,
		evidenceId?: string,
	): string | undefined {
		const now = new Date().toISOString();
		const graphResult = mutateGoalGraph(ctx, (graph) => {
			let next = graph;
			const work = requireGoalWorkNode(next);
			if (work.status !== "succeeded") {
				next = ensureGoalWorkRunning(next, now);
				next = transitionWorkNode(next, GOAL_WORK_NODE_ID, "succeeded", {
					summary: "Implementation submitted to impact verification",
					now,
				});
			}
			const node = next.nodes.find((candidate) => candidate.id === GOAL_IMPACT_NODE_ID);
			if (!node) throw new Error(`Goal work graph is missing completion node ${GOAL_IMPACT_NODE_ID}`);
			if (node.status !== "ready") {
				throw new Error(`Completion node ${GOAL_IMPACT_NODE_ID} is ${node.status}, expected ready`);
			}
			next = transitionWorkNode(next, node.id, "running", { now });
			return transitionWorkNode(
				next,
				node.id,
				status === "pass" ? "succeeded" : status === "blocked" ? "blocked" : "failed",
				{
					summary,
					evidence: evidenceId ? [{ id: evidenceId, kind: "impact", summary }] : undefined,
					now,
				},
			);
		});
		return graphResult.error;
	}

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Report goal-mode status or progress and record revisioned engineering facts, decisions, attempts, or evidence. Only the user can start a goal. Use complete only after verifying the full objective; use blocked only when progress requires user input or an external state change.",
		promptSnippet: "Report progress, preserve engineering memory, complete, or identify a genuine blocker",
		promptGuidelines: [
			"While goal mode is active, call goal complete only after verification, or goal blocked only when external input or state is required.",
			"Use goal remember for durable facts, decisions, failed attempts, and evidence; facts require current source paths and changed conclusions should replace prior record ids.",
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
					content: [{ type: "text", text: toolText(state, currentGoalGraph(ctx)) }],
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
			if (goalMutationInFlight) {
				return {
					content: [{ type: "text", text: "Another goal mutation is already in progress." }],
					details: { state },
				};
			}
			goalMutationInFlight = true;
			const mutationGoalId = state.id;
			const mutationEpoch = goalMutationEpoch;
			const mutationIsCurrent = (): boolean =>
				state?.id === mutationGoalId && state.status === "active" && goalMutationEpoch === mutationEpoch;
			const supersededMutationResult = () => ({
				content: [{ type: "text" as const, text: "Goal mutation stopped because the goal state changed." }],
				details: { state },
			});
			try {
				if (params.action === "remember") {
					if (!params.memoryKind) {
						return {
							content: [{ type: "text", text: "memoryKind is required for goal remember." }],
							details: { state },
						};
					}
					const sourceRequests = params.sources ?? [];
					if (params.memoryKind === "fact" && sourceRequests.length === 0) {
						return {
							content: [{ type: "text", text: "Fact memory requires at least one source path." }],
							details: { state },
						};
					}
					try {
						const paths = [...new Set(sourceRequests.map((source) => source.path))];
						const currentSources = await resolveWorkspaceMemorySources(ctx.workspace, paths, { signal });
						if (!mutationIsCurrent()) return supersededMutationResult();
						const revisions = new Map(currentSources.map((source) => [source.path, source.revision]));
						const missing = paths.filter((path) => !revisions.has(path));
						if (missing.length > 0) {
							throw new Error(`Memory source is missing from the logical workspace: ${missing.join(", ")}`);
						}
						const result = appendGoalMemory(ctx, {
							kind: params.memoryKind,
							content: note,
							priority: params.memoryKind === "decision" ? 50 : params.memoryKind === "evidence" ? 100 : 0,
							required: false,
							tags: ["goal", "engineering-memory"],
							sources: sourceRequests.map((source) => ({
								path: source.path,
								revision: revisions.get(source.path)!,
								...(source.symbol ? { symbol: source.symbol } : {}),
							})),
							evidenceIds: params.evidenceIds ?? [],
							replaces: params.replaces ?? [],
							...(params.rationale ? { rationale: params.rationale } : {}),
							alternatives: params.alternatives ?? [],
							...(params.outcome ? { outcome: params.outcome } : {}),
						});
						if (result.error || !result.record)
							throw new Error(result.error ?? "Memory record was not persisted");
						return {
							content: [
								{
									type: "text",
									text: `Remembered ${params.memoryKind} ${result.record.id}: ${note}`,
								},
							],
							details: { state, memoryRecord: result.record },
						};
					} catch (error) {
						return {
							content: [
								{
									type: "text",
									text: `Engineering memory could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
								},
							],
							details: { state },
						};
					}
				}
				if (params.action === "complete" && (state.verification || state.impactVerification)) {
					const expectedVerification = state.verification;
					const expectedImpact = state.impactVerification;
					const blockForConfig = (reason: string) => {
						if (!mutationIsCurrent()) return supersededMutationResult();
						const checkedAt = new Date().toISOString();
						const verification = expectedVerification
							? { ...expectedVerification, status: "blocked" as const, checkedAt }
							: undefined;
						const impactVerification = expectedImpact
							? { ...expectedImpact, status: "blocked" as const, checkedAt }
							: undefined;
						const error = transition(ctx, "blocked", reason, { verification, impactVerification });
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
					let completedVerification = expectedVerification;
					let completionReport: GoalCompletionVerification["report"] | undefined;
					if (expectedVerification) {
						let plan: GoalCompletionPlan | undefined;
						try {
							plan = await loadGoalCompletionPlan(ctx.workspace.sourceRoot);
						} catch (error) {
							return blockForConfig(
								`Completion gate configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						if (!mutationIsCurrent()) return supersededMutationResult();
						if (!plan) return blockForConfig("Completion gate configuration was removed after the goal started.");
						if (
							plan.configRevision !== expectedVerification.configRevision ||
							!sameCheckIds(expectedVerification.checkIds, plan)
						) {
							return blockForConfig("Completion gate configuration changed after the goal started.");
						}
						const verification = await verifyGoalCompletion(
							state.objective,
							plan,
							ctx.workspace.logicalRoot,
							(command, args, options) => pi.exec(command, args, options),
							signal,
						);
						if (!mutationIsCurrent()) return supersededMutationResult();
						const graphError = recordCompletionChecks(ctx, verification);
						if (graphError) {
							return blockForConfig(`Completion results could not be persisted: ${graphError}`);
						}
						completedVerification = persistedVerification(plan, verification);
						completionReport = verification.report;
						if (verification.report.status !== "pass") {
							const error = transition(
								ctx,
								"active",
								`Completion gate ${verification.report.status}: ${verification.checks
									.filter((check) => check.status !== "pass")
									.map((check) => check.id)
									.join(", ")}`,
								{ verification: completedVerification },
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
					}

					let completedImpact = expectedImpact;
					let impactResult: ImpactVerificationResult | undefined;
					if (expectedImpact) {
						let impactPlan: ImpactVerificationCatalogPlan | undefined;
						try {
							impactPlan = await loadImpactVerificationCatalog(ctx.workspace.sourceRoot);
						} catch (error) {
							return blockForConfig(
								`Impact gate configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						if (!mutationIsCurrent()) return supersededMutationResult();
						if (!impactPlan)
							return blockForConfig("Impact gate configuration was removed after the goal started.");
						if (impactPlan.configRevision !== expectedImpact.catalogRevision) {
							return blockForConfig("Impact gate configuration changed after the goal started.");
						}
						let changedPaths: string[];
						try {
							changedPaths = await collectGitChangedPaths(
								ctx.workspace.logicalRoot,
								(command, args, options) => pi.exec(command, args, options),
								signal,
							);
							if (!mutationIsCurrent()) return supersededMutationResult();
						} catch (error) {
							return blockForConfig(
								`Impact gate could not discover the complete Git change set: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						if (changedPaths.length === 0) {
							const graphError = recordImpactCheck(ctx, "pass", "No workspace changes require impact checks");
							if (graphError) return blockForConfig(`Impact result could not be persisted: ${graphError}`);
							completedImpact = {
								...expectedImpact,
								status: "pass",
								checkedAt: new Date().toISOString(),
								coverage: "complete",
								changedFileCount: 0,
								affectedFileCount: 0,
								selectedCheckIds: [],
							};
						} else {
							const provider = getImpactGraphProvider(ctx.workspace.logicalRoot);
							if (!provider) {
								return blockForConfig(
									"Impact gate requires an active CodeGraph provider for the logical workspace.",
								);
							}
							try {
								await provider.sync({ signal });
								if (!mutationIsCurrent()) return supersededMutationResult();
								impactResult = await verifyImpactPlan(
									state.objective,
									impactPlan,
									provider.impactMap(changedPaths, { maxDepth: 4, maxPaths: 1_000 }),
									ctx.workspace.logicalRoot,
									(command, args, options) => pi.exec(command, args, options),
									signal,
								);
								if (!mutationIsCurrent()) return supersededMutationResult();
							} catch (error) {
								return blockForConfig(
									`Impact gate execution failed: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
							const summary =
								impactResult.status === "pass"
									? `Impact gate passed with ${impactResult.plan.selected.length} check(s)`
									: (impactResult.reason ?? `Impact gate ${impactResult.status}`);
							const graphError = recordImpactCheck(ctx, impactResult.status, summary, impactResult.evidence.id);
							if (graphError) return blockForConfig(`Impact result could not be persisted: ${graphError}`);
							completedImpact = persistedImpactVerification(impactPlan, impactResult);
							if (impactResult.status !== "pass") {
								const error = transition(ctx, "active", summary, {
									verification: completedVerification,
									impactVerification: completedImpact,
								});
								const failure =
									impactResult.verification && impactResult.verification.report.status !== "pass"
										? formatVerificationFailure(impactResult.verification)
										: summary;
								return {
									content: [
										{
											type: "text",
											text: error ? `Goal state could not be persisted: ${error}` : failure,
										},
									],
									details: { state, impact: impactResult.evidence },
								};
							}
						}
					}

					if (!mutationIsCurrent()) return supersededMutationResult();
					const error = transition(ctx, "completed", note, {
						verification: completedVerification,
						impactVerification: completedImpact,
					});
					if (error) {
						return {
							content: [{ type: "text", text: `Goal state could not be persisted: ${error}` }],
							details: { state, verification: completionReport, impact: impactResult?.evidence },
						};
					}
					runtimeArmed = false;
					const gateLabel =
						expectedVerification && expectedImpact
							? "completion and impact gates"
							: expectedImpact
								? "impact gate"
								: "completion gate";
					return {
						content: [{ type: "text", text: `Goal completed after the ${gateLabel} passed: ${note}` }],
						details: { state, verification: completionReport, impact: impactResult?.evidence },
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
			} finally {
				goalMutationInFlight = false;
			}
		},
	});

	pi.registerCommand("goal", {
		description: "Start or control a persistent autonomous goal",
		handler: async (args, ctx) => {
			const input = args.trim();
			const action = input || "status";

			if (action === "status") {
				ctx.ui.notify(
					state ? formatStatus(state, currentGoalGraph(ctx)) : "No goal exists in the current session branch.",
					"info",
				);
				return;
			}

			if (action === "graph") {
				const graph = currentGoalGraph(ctx);
				ctx.ui.notify(
					state && graph
						? formatGoalWorkGraph(graph).join("\n")
						: "No goal work graph exists in the current session branch.",
					"info",
				);
				return;
			}

			if (action === "memory") {
				ctx.ui.notify(
					state
						? formatEngineeringMemory(engineeringMemoryStore(ctx).get(state.id))
						: "No engineering memory exists in the current session branch.",
					"info",
				);
				return;
			}

			if (action === "pause") {
				if (!state || state.status !== "active") {
					ctx.ui.notify("Only an active goal can be paused.", "warning");
					return;
				}
				goalMutationEpoch++;
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
				goalMutationEpoch++;
				const extendTurnLimit = state.turns >= state.turnLimit;
				const error = transition(ctx, "active", state.note, { extendTurnLimit });
				if (error) {
					ctx.ui.notify(`Goal resume could not be persisted: ${error}`, "error");
					return;
				}
				runtimeArmed = true;
				lastStopReason = undefined;
				queueGoalTurn(state!, ctx);
				ctx.ui.notify("Goal resumed.", "info");
				return;
			}

			if (action === "stop") {
				if (!state || state.status === "completed" || state.status === "stopped") {
					ctx.ui.notify("No unfinished goal can be stopped.", "warning");
					return;
				}
				goalMutationEpoch++;
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
				ctx.ui.notify("Usage: /goal <objective> | /goal [status|graph|memory|pause|resume|stop]", "warning");
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
			let impactPlan: ImpactVerificationCatalogPlan | undefined;
			if (ctx.isProjectTrusted()) {
				try {
					completionPlan = await loadGoalCompletionPlan(ctx.workspace.sourceRoot);
					impactPlan = await loadImpactVerificationCatalog(ctx.workspace.sourceRoot);
				} catch (error) {
					ctx.ui.notify(
						`Goal could not be started because a completion gate is invalid: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
			}
			if ((completionPlan || impactPlan) && ctx.workspace.execution.target !== "host") {
				ctx.ui.notify(
					"Goal could not be started because its completion gates cannot run through an execution boundary.",
					"error",
				);
				return;
			}
			const now = new Date().toISOString();
			const goalId = randomUUID();
			goalMutationEpoch++;
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
				...(impactPlan ? { impactVerification: pendingImpactVerification(impactPlan) } : {}),
			};
			try {
				graphStore(ctx).create(createGoalWorkGraph(goalId, objective, completionPlan, impactPlan, now));
				const store = engineeringMemoryStore(ctx);
				const initialMemory = createEngineeringMemory(goalId);
				store.create(initialMemory);
				const memory = new RevisionedEngineeringMemory(initialMemory);
				memory.append({
					kind: "objective",
					content: objective,
					priority: 1_000,
					required: true,
					tags: ["goal", "objective"],
					sources: [],
					evidenceIds: [],
					createdAt: now,
					replaces: [],
					alternatives: [],
				});
				store.save(memory.snapshot(), initialMemory.revision);
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
			queueGoalTurn(nextState, ctx);
			const gates = [
				...(completionPlan ? [`${completionPlan.checks.length} revision-locked completion check(s)`] : []),
				...(impactPlan ? ["a revision-locked impact gate"] : []),
			];
			ctx.ui.notify(
				gates.length > 0
					? `Goal started with ${gates.join(" and ")}.`
					: "Goal started. Use /goal pause or /goal stop to interrupt it.",
				"info",
			);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		goalMutationEpoch++;
		state = findGoalState(ctx.sessionManager.getBranch());
		runtimeArmed = false;
		lastStopReason = undefined;
		const recoveryError = state?.status === "active" ? recoverGoalGraph(ctx) : undefined;
		updateUi(ctx, state, currentGoalGraph(ctx));
		if (recoveryError) ctx.ui.notify(`Goal work graph could not be recovered: ${recoveryError}`, "error");
		if (state?.status === "active" && event.reason !== "activation") {
			ctx.ui.notify("An active goal was restored. Run /goal resume or send a message to continue it.", "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		goalMutationEpoch++;
		state = findGoalState(ctx.sessionManager.getBranch());
		runtimeArmed = false;
		lastStopReason = undefined;
		const recoveryError = state?.status === "active" ? recoverGoalGraph(ctx) : undefined;
		updateUi(ctx, state, currentGoalGraph(ctx));
		if (recoveryError) ctx.ui.notify(`Goal work graph could not be recovered: ${recoveryError}`, "error");
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
		const graphResult = mutateGoalGraph(ctx, (graph) => ensureGoalWorkRunning(graph, new Date().toISOString()));
		if (graphResult.error) {
			const reason = `Work graph could not claim the active goal node: ${graphResult.error}`;
			const persistError = transition(ctx, "blocked", reason, { syncGraph: false });
			runtimeArmed = false;
			ctx.ui.notify(
				persistError ? `Goal and work graph failure could not be persisted: ${persistError}` : reason,
				"error",
			);
			return;
		}
		let memoryContext = "";
		try {
			const snapshot = engineeringMemoryStore(ctx).get(state.id);
			if (snapshot) {
				const prepared = await prepareWorkspaceEngineeringMemory(
					snapshot,
					ctx.workspace,
					{ task: state.objective, tokenBudget: 1_600, maxEntries: 64 },
					{ signal: ctx.signal },
				);
				if (prepared.workingSet.status === "blocked") {
					const stale = prepared.workingSet.freshness
						.filter((entry) => entry.status !== "fresh")
						.map((entry) => entry.entryId)
						.join(", ");
					const error = transition(ctx, "blocked", `Required engineering memory is stale or missing: ${stale}`);
					runtimeArmed = false;
					if (error) {
						ctx.ui.notify(`Stale engineering memory state could not be persisted: ${error}`, "error");
					} else {
						ctx.ui.notify("Goal blocked because required engineering memory is stale or missing.", "error");
					}
					return;
				}
				memoryContext = `\n\n## Revisioned engineering memory\n\n${prepared.workingSet.compiledContext.text}`;
			}
		} catch (error) {
			const reason = `Engineering memory could not be prepared: ${error instanceof Error ? error.message : String(error)}`;
			const persistError = transition(ctx, "blocked", reason, { syncMemory: false });
			runtimeArmed = false;
			ctx.ui.notify(
				persistError
					? `Engineering-memory failure and blocked state could not be persisted: ${persistError}`
					: reason,
				"error",
			);
			return;
		}
		runtimeArmed = true;
		lastStopReason = undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildAgentInstruction(state, graphResult.graph)}${memoryContext}`,
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
		queueGoalTurn(state, ctx);
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
