import { posix } from "node:path";

export const WORK_GRAPH_VERSION = 1 as const;

const MAX_NODES = 256;
const MAX_EVENTS = 4_096;
const MAX_EVIDENCE_PER_NODE = 64;
const MAX_TEXT_LENGTH = 8_000;
const MAX_ID_LENGTH = 128;
const MAX_BUDGET = 1_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

export type WorkNodeKind = "objective" | "task" | "join" | "verification" | "approval" | "apply";
export type WorkNodePolicy = "inline" | "parallel-read" | "isolated-mutation" | "verification" | "human";
export type WorkNodeStatus =
	| "pending"
	| "ready"
	| "running"
	| "paused"
	| "succeeded"
	| "failed"
	| "blocked"
	| "cancelled";
export type WorkBudgetUnit = "attempt" | "turn" | "token";
export type WorkLeaseMode = "read" | "write";

export interface WorkNodeBudget {
	readonly unit: WorkBudgetUnit;
	readonly limit: number;
	readonly used: number;
}

export interface WorkEvidence {
	readonly id: string;
	readonly kind: string;
	readonly summary: string;
	readonly reference?: string;
}

export interface WorkNode {
	readonly id: string;
	readonly kind: WorkNodeKind;
	readonly policy: WorkNodePolicy;
	readonly description: string;
	readonly dependsOn: readonly string[];
	readonly status: WorkNodeStatus;
	readonly attempts: number;
	readonly budget?: WorkNodeBudget;
	readonly evidence: readonly WorkEvidence[];
	readonly lastSummary?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface WorkLease {
	readonly id: string;
	readonly resource: string;
	readonly mode: WorkLeaseMode;
	readonly holderNodeId: string;
	readonly acquiredAt: string;
	readonly expiresAt?: string;
}

export interface WorkGraphEvent {
	readonly sequence: number;
	readonly nodeId: string;
	readonly from: WorkNodeStatus | null;
	readonly to: WorkNodeStatus;
	readonly at: string;
	readonly summary?: string;
	readonly evidenceIds: readonly string[];
}

export interface WorkGraph {
	readonly version: typeof WORK_GRAPH_VERSION;
	readonly id: string;
	readonly objective: string;
	readonly revision: number;
	readonly nodes: readonly WorkNode[];
	readonly leases: readonly WorkLease[];
	readonly events: readonly WorkGraphEvent[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface WorkNodeSpec {
	readonly id: string;
	readonly kind: WorkNodeKind;
	readonly policy: WorkNodePolicy;
	readonly description: string;
	readonly dependsOn?: readonly string[];
	readonly initialStatus?: "ready" | "running";
	readonly budget?: {
		readonly unit: WorkBudgetUnit;
		readonly limit: number;
	};
}

export interface CreateWorkGraphOptions {
	readonly id: string;
	readonly objective: string;
	readonly nodes: readonly WorkNodeSpec[];
	readonly now?: string;
}

export interface WorkNodeUpdate {
	readonly summary?: string;
	readonly evidence?: readonly WorkEvidence[];
	readonly now?: string;
}

export interface WorkLeaseRequest {
	readonly id: string;
	readonly resource: string;
	readonly mode: WorkLeaseMode;
	readonly ttlMs?: number;
	readonly now?: string;
}

export class WorkGraphConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkGraphConflictError";
	}
}

export class WorkGraphBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkGraphBudgetError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isWorkNodeKind(value: unknown): value is WorkNodeKind {
	return (
		value === "objective" ||
		value === "task" ||
		value === "join" ||
		value === "verification" ||
		value === "approval" ||
		value === "apply"
	);
}

function isWorkNodePolicy(value: unknown): value is WorkNodePolicy {
	return (
		value === "inline" ||
		value === "parallel-read" ||
		value === "isolated-mutation" ||
		value === "verification" ||
		value === "human"
	);
}

function isWorkNodeStatus(value: unknown): value is WorkNodeStatus {
	return (
		value === "pending" ||
		value === "ready" ||
		value === "running" ||
		value === "paused" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "blocked" ||
		value === "cancelled"
	);
}

function isWorkBudgetUnit(value: unknown): value is WorkBudgetUnit {
	return value === "attempt" || value === "turn" || value === "token";
}

function isWorkLeaseMode(value: unknown): value is WorkLeaseMode {
	return value === "read" || value === "write";
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new Error(`unknown ${label} field: ${unknownKey}`);
}

function isDenseArray(value: readonly unknown[]): boolean {
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) return false;
	}
	return true;
}

function parseEvidence(value: unknown, label: string): WorkEvidence {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	assertAllowedKeys(value, ["id", "kind", "summary", "reference"], label);
	if (!isId(value.id)) throw new Error(`${label}.id must be a portable identifier`);
	if (!isText(value.kind)) throw new Error(`${label}.kind must be a non-empty bounded string`);
	if (!isText(value.summary)) throw new Error(`${label}.summary must be a non-empty bounded string`);
	if (value.reference !== undefined && !isText(value.reference)) {
		throw new Error(`${label}.reference must be a non-empty bounded string`);
	}
	return {
		id: value.id,
		kind: value.kind,
		summary: value.summary,
		...(value.reference === undefined ? {} : { reference: value.reference as string }),
	};
}

function parseBudget(value: unknown, label: string): WorkNodeBudget {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	assertAllowedKeys(value, ["unit", "limit", "used"], label);
	if (!isWorkBudgetUnit(value.unit)) throw new Error(`${label}.unit is invalid`);
	if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_BUDGET) {
		throw new Error(`${label}.limit must be a positive bounded safe integer`);
	}
	if (
		!Number.isSafeInteger(value.used) ||
		(value.used as number) < 0 ||
		(value.used as number) > (value.limit as number)
	) {
		throw new Error(`${label}.used must be between zero and the limit`);
	}
	return { unit: value.unit, limit: value.limit as number, used: value.used as number };
}

function parseNode(value: unknown, index: number): WorkNode {
	const label = `nodes[${index}]`;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	assertAllowedKeys(
		value,
		[
			"id",
			"kind",
			"policy",
			"description",
			"dependsOn",
			"status",
			"attempts",
			"budget",
			"evidence",
			"lastSummary",
			"createdAt",
			"updatedAt",
		],
		label,
	);
	if (!isId(value.id)) throw new Error(`${label}.id must be a portable identifier`);
	if (!isWorkNodeKind(value.kind)) throw new Error(`${label}.kind is invalid`);
	if (!isWorkNodePolicy(value.policy)) throw new Error(`${label}.policy is invalid`);
	if (!isText(value.description)) throw new Error(`${label}.description must be a non-empty bounded string`);
	if (
		!Array.isArray(value.dependsOn) ||
		value.dependsOn.length > MAX_NODES ||
		!value.dependsOn.every(isId) ||
		new Set(value.dependsOn).size !== value.dependsOn.length
	) {
		throw new Error(`${label}.dependsOn must contain unique portable identifiers`);
	}
	if (!isWorkNodeStatus(value.status)) throw new Error(`${label}.status is invalid`);
	if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0) {
		throw new Error(`${label}.attempts must be a non-negative safe integer`);
	}
	if (
		!Array.isArray(value.evidence) ||
		value.evidence.length > MAX_EVIDENCE_PER_NODE ||
		!isDenseArray(value.evidence)
	) {
		throw new Error(`${label}.evidence must be a bounded dense array`);
	}
	const evidence = value.evidence.map((item, evidenceIndex) =>
		parseEvidence(item, `${label}.evidence[${evidenceIndex}]`),
	);
	if (new Set(evidence.map((item) => item.id)).size !== evidence.length) {
		throw new Error(`${label}.evidence ids must be unique`);
	}
	if (value.lastSummary !== undefined && !isText(value.lastSummary)) {
		throw new Error(`${label}.lastSummary must be a non-empty bounded string`);
	}
	if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
		throw new Error(`${label} timestamps are invalid`);
	}
	return {
		id: value.id,
		kind: value.kind,
		policy: value.policy,
		description: value.description,
		dependsOn: [...value.dependsOn],
		status: value.status,
		attempts: value.attempts as number,
		...(value.budget === undefined ? {} : { budget: parseBudget(value.budget, `${label}.budget`) }),
		evidence,
		...(value.lastSummary === undefined ? {} : { lastSummary: value.lastSummary as string }),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

function parseLease(value: unknown, index: number): WorkLease {
	const label = `leases[${index}]`;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	assertAllowedKeys(value, ["id", "resource", "mode", "holderNodeId", "acquiredAt", "expiresAt"], label);
	if (!isId(value.id)) throw new Error(`${label}.id must be a portable identifier`);
	if (!isText(value.resource) || normalizeResource(value.resource) !== value.resource) {
		throw new Error(`${label}.resource must be a canonical workspace-relative path`);
	}
	if (!isWorkLeaseMode(value.mode)) throw new Error(`${label}.mode is invalid`);
	if (!isId(value.holderNodeId)) throw new Error(`${label}.holderNodeId must be a portable identifier`);
	if (!isTimestamp(value.acquiredAt)) throw new Error(`${label}.acquiredAt is invalid`);
	if (value.expiresAt !== undefined && !isTimestamp(value.expiresAt)) {
		throw new Error(`${label}.expiresAt is invalid`);
	}
	if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)) {
		throw new Error(`${label}.expiresAt must be later than acquiredAt`);
	}
	return {
		id: value.id,
		resource: value.resource,
		mode: value.mode,
		holderNodeId: value.holderNodeId,
		acquiredAt: value.acquiredAt,
		...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as string }),
	};
}

function parseEvent(value: unknown, index: number): WorkGraphEvent {
	const label = `events[${index}]`;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	assertAllowedKeys(value, ["sequence", "nodeId", "from", "to", "at", "summary", "evidenceIds"], label);
	if (value.sequence !== index + 1) throw new Error(`${label}.sequence must be contiguous`);
	if (!isId(value.nodeId)) throw new Error(`${label}.nodeId must be a portable identifier`);
	if (value.from !== null && !isWorkNodeStatus(value.from)) throw new Error(`${label}.from is invalid`);
	if (!isWorkNodeStatus(value.to)) throw new Error(`${label}.to is invalid`);
	if (!isTimestamp(value.at)) throw new Error(`${label}.at is invalid`);
	if (value.summary !== undefined && !isText(value.summary)) {
		throw new Error(`${label}.summary must be a non-empty bounded string`);
	}
	if (
		!Array.isArray(value.evidenceIds) ||
		value.evidenceIds.length > MAX_EVIDENCE_PER_NODE ||
		!value.evidenceIds.every(isId)
	) {
		throw new Error(`${label}.evidenceIds must contain portable identifiers`);
	}
	return {
		sequence: value.sequence,
		nodeId: value.nodeId,
		from: value.from,
		to: value.to,
		at: value.at,
		...(value.summary === undefined ? {} : { summary: value.summary as string }),
		evidenceIds: [...value.evidenceIds],
	};
}

function assertAcyclic(nodes: readonly Pick<WorkNode, "id" | "dependsOn">[]): void {
	const nodeIds = new Set(nodes.map((node) => node.id));
	for (const node of nodes) {
		if (node.dependsOn.includes(node.id)) throw new Error(`work node ${node.id} cannot depend on itself`);
		const missing = node.dependsOn.find((dependency) => !nodeIds.has(dependency));
		if (missing) throw new Error(`work node ${node.id} depends on missing node ${missing}`);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const visit = (nodeId: string): void => {
		if (visiting.has(nodeId)) throw new Error(`work graph contains a cycle at ${nodeId}`);
		if (visited.has(nodeId)) return;
		visiting.add(nodeId);
		for (const dependency of byId.get(nodeId)?.dependsOn ?? []) visit(dependency);
		visiting.delete(nodeId);
		visited.add(nodeId);
	};
	for (const node of nodes) visit(node.id);
}

function validateGraph(graph: WorkGraph): void {
	if (new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length) {
		throw new Error("work graph node ids must be unique");
	}
	assertAcyclic(graph.nodes);
	const nodeIds = new Set(graph.nodes.map((node) => node.id));
	const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
	if (graph.leases.some((lease) => !nodeIds.has(lease.holderNodeId))) {
		throw new Error("work graph lease holder must reference an existing node");
	}
	if (graph.leases.some((lease) => nodesById.get(lease.holderNodeId)?.status !== "running")) {
		throw new Error("work graph lease holder must be running");
	}
	if (new Set(graph.leases.map((lease) => lease.id)).size !== graph.leases.length) {
		throw new Error("work graph lease ids must be unique");
	}
	for (let leftIndex = 0; leftIndex < graph.leases.length; leftIndex++) {
		const left = graph.leases[leftIndex]!;
		const conflict = graph.leases
			.slice(leftIndex + 1)
			.find(
				(right) =>
					left.holderNodeId !== right.holderNodeId &&
					resourcesOverlap(left.resource, right.resource) &&
					(left.mode === "write" || right.mode === "write"),
			);
		if (conflict) {
			throw new Error(`work graph leases ${left.id} and ${conflict.id} conflict`);
		}
	}
	if (graph.events.some((event) => !nodeIds.has(event.nodeId))) {
		throw new Error("work graph event must reference an existing node");
	}
}

export function parseWorkGraph(value: unknown): WorkGraph | undefined {
	try {
		if (!isRecord(value)) return undefined;
		assertAllowedKeys(
			value,
			["version", "id", "objective", "revision", "nodes", "leases", "events", "createdAt", "updatedAt"],
			"work graph",
		);
		if (
			value.version !== WORK_GRAPH_VERSION ||
			!isId(value.id) ||
			!isText(value.objective) ||
			!Number.isSafeInteger(value.revision) ||
			(value.revision as number) < 0 ||
			!Array.isArray(value.nodes) ||
			value.nodes.length === 0 ||
			value.nodes.length > MAX_NODES ||
			!isDenseArray(value.nodes) ||
			!Array.isArray(value.leases) ||
			value.leases.length > MAX_NODES ||
			!isDenseArray(value.leases) ||
			!Array.isArray(value.events) ||
			value.events.length > MAX_EVENTS ||
			!isDenseArray(value.events) ||
			!isTimestamp(value.createdAt) ||
			!isTimestamp(value.updatedAt)
		) {
			return undefined;
		}
		const graph: WorkGraph = {
			version: WORK_GRAPH_VERSION,
			id: value.id,
			objective: value.objective,
			revision: value.revision as number,
			nodes: value.nodes.map(parseNode),
			leases: value.leases.map(parseLease),
			events: value.events.map(parseEvent),
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
		validateGraph(graph);
		return graph;
	} catch {
		return undefined;
	}
}

function requireTimestamp(value: string | undefined): string {
	const timestamp = value ?? new Date().toISOString();
	if (!isTimestamp(timestamp)) throw new Error("now must be an ISO-compatible timestamp");
	return timestamp;
}

function validateNodeSpec(spec: WorkNodeSpec, index: number): void {
	if (!isId(spec.id)) throw new Error(`nodes[${index}].id must be a portable identifier`);
	if (!isWorkNodeKind(spec.kind)) throw new Error(`nodes[${index}].kind is invalid`);
	if (!isWorkNodePolicy(spec.policy)) throw new Error(`nodes[${index}].policy is invalid`);
	if (!isText(spec.description)) throw new Error(`nodes[${index}].description must be a non-empty bounded string`);
	if (
		spec.dependsOn !== undefined &&
		(spec.dependsOn.length > MAX_NODES ||
			!spec.dependsOn.every(isId) ||
			new Set(spec.dependsOn).size !== spec.dependsOn.length)
	) {
		throw new Error(`nodes[${index}].dependsOn must contain unique portable identifiers`);
	}
	if (spec.initialStatus !== undefined && spec.initialStatus !== "ready" && spec.initialStatus !== "running") {
		throw new Error(`nodes[${index}].initialStatus is invalid`);
	}
	if (
		spec.budget &&
		(!isWorkBudgetUnit(spec.budget.unit) ||
			!Number.isSafeInteger(spec.budget.limit) ||
			spec.budget.limit < 1 ||
			spec.budget.limit > MAX_BUDGET)
	) {
		throw new Error(`nodes[${index}].budget is invalid`);
	}
}

export function createWorkGraph(options: CreateWorkGraphOptions): WorkGraph {
	if (!isId(options.id)) throw new Error("work graph id must be a portable identifier");
	if (!isText(options.objective)) throw new Error("work graph objective must be a non-empty bounded string");
	if (options.nodes.length === 0 || options.nodes.length > MAX_NODES) {
		throw new Error(`work graph must contain between 1 and ${MAX_NODES} nodes`);
	}
	options.nodes.forEach(validateNodeSpec);
	const now = requireTimestamp(options.now);
	const dependencies = options.nodes.map((spec) => ({ id: spec.id, dependsOn: [...(spec.dependsOn ?? [])] }));
	if (new Set(dependencies.map((node) => node.id)).size !== dependencies.length) {
		throw new Error("work graph node ids must be unique");
	}
	assertAcyclic(dependencies);
	const nodes = options.nodes.map((spec): WorkNode => {
		const dependsOn = [...(spec.dependsOn ?? [])];
		if (spec.initialStatus && dependsOn.length > 0) {
			throw new Error(`work node ${spec.id} cannot start ${spec.initialStatus} while it has dependencies`);
		}
		const status = spec.initialStatus ?? (dependsOn.length === 0 ? "ready" : "pending");
		return {
			id: spec.id,
			kind: spec.kind,
			policy: spec.policy,
			description: spec.description,
			dependsOn,
			status,
			attempts: status === "running" ? 1 : 0,
			...(spec.budget
				? { budget: { ...spec.budget, used: status === "running" && spec.budget.unit === "attempt" ? 1 : 0 } }
				: {}),
			evidence: [],
			createdAt: now,
			updatedAt: now,
		};
	});
	return {
		version: WORK_GRAPH_VERSION,
		id: options.id,
		objective: options.objective,
		revision: 0,
		nodes,
		leases: [],
		events: nodes.map((node, index) => ({
			sequence: index + 1,
			nodeId: node.id,
			from: null,
			to: node.status,
			at: now,
			evidenceIds: [],
		})),
		createdAt: now,
		updatedAt: now,
	};
}

function findNode(graph: WorkGraph, nodeId: string): WorkNode {
	const node = graph.nodes.find((candidate) => candidate.id === nodeId);
	if (!node) throw new Error(`unknown work node: ${nodeId}`);
	return node;
}

function appendEvidence(node: WorkNode, evidence: readonly WorkEvidence[] | undefined): readonly WorkEvidence[] {
	if (!evidence || evidence.length === 0) return node.evidence;
	const parsed = evidence.map((item, index) => parseEvidence(item, `evidence[${index}]`));
	const ids = new Set(node.evidence.map((item) => item.id));
	for (const item of parsed) {
		if (ids.has(item.id)) throw new Error(`duplicate work evidence id: ${item.id}`);
		ids.add(item.id);
	}
	if (node.evidence.length + parsed.length > MAX_EVIDENCE_PER_NODE) {
		throw new Error(`work node evidence exceeds ${MAX_EVIDENCE_PER_NODE} entries`);
	}
	return [...node.evidence, ...parsed];
}

function appendEvent(
	events: readonly WorkGraphEvent[],
	nodeId: string,
	from: WorkNodeStatus,
	to: WorkNodeStatus,
	now: string,
	update: WorkNodeUpdate,
): readonly WorkGraphEvent[] {
	if (events.length >= MAX_EVENTS) throw new Error(`work graph event history exceeds ${MAX_EVENTS} entries`);
	return [
		...events,
		{
			sequence: events.length + 1,
			nodeId,
			from,
			to,
			at: now,
			...(update.summary ? { summary: update.summary } : {}),
			evidenceIds: update.evidence?.map((item) => item.id) ?? [],
		},
	];
}

function finalizeGraph(
	graph: WorkGraph,
	nodes: readonly WorkNode[],
	leases: readonly WorkLease[],
	events: readonly WorkGraphEvent[],
	now: string,
): WorkGraph {
	return {
		...graph,
		revision: graph.revision + 1,
		nodes,
		leases,
		events,
		updatedAt: now,
	};
}

function dependencyStatus(nodes: readonly WorkNode[], node: WorkNode): "ready" | "pending" | "cancelled" {
	const dependencies = node.dependsOn.map((id) => nodes.find((candidate) => candidate.id === id)!);
	if (dependencies.some((dependency) => dependency.status === "cancelled")) return "cancelled";
	if (dependencies.every((dependency) => dependency.status === "succeeded")) return "ready";
	return "pending";
}

function promotePendingNodes(
	nodes: readonly WorkNode[],
	events: readonly WorkGraphEvent[],
	now: string,
): { nodes: readonly WorkNode[]; events: readonly WorkGraphEvent[] } {
	let nextNodes = [...nodes];
	let nextEvents = [...events];
	let changed = true;
	while (changed) {
		changed = false;
		nextNodes = nextNodes.map((node) => {
			if (node.status !== "pending") return node;
			const nextStatus = dependencyStatus(nextNodes, node);
			if (nextStatus === "pending") return node;
			changed = true;
			nextEvents = [
				...nextEvents,
				{
					sequence: nextEvents.length + 1,
					nodeId: node.id,
					from: node.status,
					to: nextStatus,
					at: now,
					summary:
						nextStatus === "ready" ? "Dependencies satisfied" : "Cancelled because a dependency was cancelled",
					evidenceIds: [],
				},
			];
			return { ...node, status: nextStatus, updatedAt: now };
		});
	}
	if (nextEvents.length > MAX_EVENTS) throw new Error(`work graph event history exceeds ${MAX_EVENTS} entries`);
	return { nodes: nextNodes, events: nextEvents };
}

function canTransition(from: WorkNodeStatus, to: WorkNodeStatus): boolean {
	switch (from) {
		case "pending":
			return to === "cancelled";
		case "ready":
			return to === "running" || to === "blocked" || to === "cancelled";
		case "running":
			return to === "paused" || to === "succeeded" || to === "failed" || to === "blocked" || to === "cancelled";
		case "paused":
		case "failed":
		case "blocked":
			return to === "ready" || to === "cancelled";
		case "succeeded":
		case "cancelled":
			return false;
	}
}

export function transitionWorkNode(
	graph: WorkGraph,
	nodeId: string,
	status: WorkNodeStatus,
	update: WorkNodeUpdate = {},
): WorkGraph {
	const node = findNode(graph, nodeId);
	if (!canTransition(node.status, status)) {
		throw new Error(`invalid work node transition: ${node.id} ${node.status} -> ${status}`);
	}
	const now = requireTimestamp(update.now);
	let budget = node.budget;
	let attempts = node.attempts;
	if (status === "running") {
		attempts++;
		if (budget?.unit === "attempt") {
			if (budget.used >= budget.limit)
				throw new WorkGraphBudgetError(`work node ${node.id} exhausted its attempt budget`);
			budget = { ...budget, used: budget.used + 1 };
		}
	}
	const evidence = appendEvidence(node, update.evidence);
	const replacement: WorkNode = {
		...node,
		status,
		attempts,
		...(budget ? { budget } : {}),
		evidence,
		...(update.summary ? { lastSummary: update.summary } : {}),
		updatedAt: now,
	};
	let nodes: readonly WorkNode[] = graph.nodes.map((candidate) => (candidate.id === nodeId ? replacement : candidate));
	let events = appendEvent(graph.events, nodeId, node.status, status, now, update);
	if (
		status === "succeeded" ||
		status === "failed" ||
		status === "blocked" ||
		status === "cancelled" ||
		status === "paused"
	) {
		const promoted = promotePendingNodes(nodes, events, now);
		nodes = promoted.nodes;
		events = promoted.events;
	}
	const leases =
		status === "running" || status === "ready"
			? graph.leases
			: graph.leases.filter((lease) => lease.holderNodeId !== nodeId);
	return finalizeGraph(graph, nodes, leases, events, now);
}

export function recordWorkNodeProgress(graph: WorkGraph, nodeId: string, update: WorkNodeUpdate): WorkGraph {
	const node = findNode(graph, nodeId);
	if (node.status !== "ready" && node.status !== "running") {
		throw new Error(`work node ${node.id} cannot record progress while ${node.status}`);
	}
	if (!update.summary && (!update.evidence || update.evidence.length === 0)) {
		throw new Error("work node progress requires a summary or evidence");
	}
	const now = requireTimestamp(update.now);
	const evidence = appendEvidence(node, update.evidence);
	const replacement: WorkNode = {
		...node,
		evidence,
		...(update.summary ? { lastSummary: update.summary } : {}),
		updatedAt: now,
	};
	const events = appendEvent(graph.events, nodeId, node.status, node.status, now, update);
	return finalizeGraph(
		graph,
		graph.nodes.map((candidate) => (candidate.id === nodeId ? replacement : candidate)),
		graph.leases,
		events,
		now,
	);
}

export function consumeWorkNodeBudget(
	graph: WorkGraph,
	nodeId: string,
	unit: WorkBudgetUnit,
	amount: number,
	now?: string,
): WorkGraph {
	const node = findNode(graph, nodeId);
	if (node.status !== "running") throw new Error(`work node ${node.id} is not running`);
	if (!node.budget || node.budget.unit !== unit) throw new Error(`work node ${node.id} has no ${unit} budget`);
	if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("budget amount must be a positive safe integer");
	const timestamp = requireTimestamp(now);
	if (node.budget.used + amount > node.budget.limit) {
		return transitionWorkNode(graph, nodeId, "blocked", {
			summary: `${unit} budget exhausted at ${node.budget.used}/${node.budget.limit}`,
			now: timestamp,
		});
	}
	const replacement: WorkNode = {
		...node,
		budget: { ...node.budget, used: node.budget.used + amount },
		updatedAt: timestamp,
	};
	return finalizeGraph(
		graph,
		graph.nodes.map((candidate) => (candidate.id === nodeId ? replacement : candidate)),
		graph.leases,
		graph.events,
		timestamp,
	);
}

function descendants(graph: WorkGraph, nodeId: string): Set<string> {
	const result = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of graph.nodes) {
			if (result.has(node.id) || node.id === nodeId) continue;
			if (node.dependsOn.includes(nodeId) || node.dependsOn.some((dependency) => result.has(dependency))) {
				result.add(node.id);
				changed = true;
			}
		}
	}
	return result;
}

export function reopenWorkNode(graph: WorkGraph, nodeId: string, update: WorkNodeUpdate = {}): WorkGraph {
	const node = findNode(graph, nodeId);
	if (
		node.status !== "succeeded" &&
		node.status !== "failed" &&
		node.status !== "blocked" &&
		node.status !== "paused"
	) {
		throw new Error(`work node ${node.id} cannot be reopened while ${node.status}`);
	}
	const now = requireTimestamp(update.now);
	const affected = descendants(graph, nodeId);
	affected.add(nodeId);
	let events = [...graph.events];
	const provisionalNodes = graph.nodes.map((candidate): WorkNode => {
		if (!affected.has(candidate.id) || candidate.status === "cancelled") return candidate;
		const nextStatus = candidate.id === nodeId ? dependencyStatus(graph.nodes, candidate) : "pending";
		if (candidate.status !== nextStatus) {
			events = [
				...events,
				{
					sequence: events.length + 1,
					nodeId: candidate.id,
					from: candidate.status,
					to: nextStatus,
					at: now,
					...(candidate.id === nodeId && update.summary ? { summary: update.summary } : {}),
					evidenceIds: [],
				},
			];
		}
		return {
			...candidate,
			status: nextStatus,
			...(candidate.id === nodeId && update.summary ? { lastSummary: update.summary } : {}),
			updatedAt: now,
		};
	});
	if (events.length > MAX_EVENTS) throw new Error(`work graph event history exceeds ${MAX_EVENTS} entries`);
	const leases = graph.leases.filter((lease) => !affected.has(lease.holderNodeId));
	return finalizeGraph(graph, provisionalNodes, leases, events, now);
}

export function cancelWorkGraph(graph: WorkGraph, summary: string, now?: string): WorkGraph {
	if (!isText(summary)) throw new Error("cancellation summary must be a non-empty bounded string");
	const timestamp = requireTimestamp(now);
	let events = [...graph.events];
	const nodes = graph.nodes.map((node): WorkNode => {
		if (node.status === "succeeded" || node.status === "cancelled") return node;
		events = [
			...events,
			{
				sequence: events.length + 1,
				nodeId: node.id,
				from: node.status,
				to: "cancelled",
				at: timestamp,
				summary,
				evidenceIds: [],
			},
		];
		return { ...node, status: "cancelled", lastSummary: summary, updatedAt: timestamp };
	});
	if (events.length > MAX_EVENTS) throw new Error(`work graph event history exceeds ${MAX_EVENTS} entries`);
	return finalizeGraph(graph, nodes, [], events, timestamp);
}

function normalizeResource(resource: string): string {
	const portable = resource.replaceAll("\\", "/");
	const normalized = posix.normalize(portable).replace(/^\.\//, "").replace(/\/$/, "");
	if (
		!normalized ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("/") ||
		normalized.startsWith("../") ||
		/^[A-Za-z]:\//.test(normalized) ||
		normalized.length > MAX_TEXT_LENGTH ||
		normalized.includes("\0")
	) {
		throw new Error("lease resource must be a non-empty bounded path-like string");
	}
	return normalized;
}

function resourcesOverlap(left: string, right: string): boolean {
	return (
		left === "*" || right === "*" || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
	);
}

function isExpired(lease: WorkLease, now: string): boolean {
	return lease.expiresAt !== undefined && Date.parse(lease.expiresAt) <= Date.parse(now);
}

export function acquireWorkLease(graph: WorkGraph, nodeId: string, request: WorkLeaseRequest): WorkGraph {
	const node = findNode(graph, nodeId);
	if (node.status !== "running") throw new Error(`work node ${node.id} must be running before acquiring a lease`);
	if (!isId(request.id)) throw new Error("lease id must be a portable identifier");
	if (!isWorkLeaseMode(request.mode)) throw new Error("lease mode is invalid");
	if (
		request.ttlMs !== undefined &&
		(!Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1_000 || request.ttlMs > 24 * 60 * 60_000)
	) {
		throw new Error("lease ttlMs must be between 1000 and 86400000");
	}
	const now = requireTimestamp(request.now);
	const resource = normalizeResource(request.resource);
	const activeLeases = graph.leases.filter((lease) => !isExpired(lease, now));
	if (activeLeases.some((lease) => lease.id === request.id)) {
		throw new WorkGraphConflictError(`work lease id already exists: ${request.id}`);
	}
	const conflict = activeLeases.find(
		(lease) =>
			lease.holderNodeId !== nodeId &&
			resourcesOverlap(lease.resource, resource) &&
			(lease.mode === "write" || request.mode === "write"),
	);
	if (conflict) {
		throw new WorkGraphConflictError(
			`work lease ${request.id} conflicts with ${conflict.id} held by ${conflict.holderNodeId}`,
		);
	}
	const lease: WorkLease = {
		id: request.id,
		resource,
		mode: request.mode,
		holderNodeId: nodeId,
		acquiredAt: now,
		...(request.ttlMs === undefined ? {} : { expiresAt: new Date(Date.parse(now) + request.ttlMs).toISOString() }),
	};
	return finalizeGraph(graph, graph.nodes, [...activeLeases, lease], graph.events, now);
}

export function releaseWorkLeases(graph: WorkGraph, nodeId: string, now?: string): WorkGraph {
	findNode(graph, nodeId);
	const leases = graph.leases.filter((lease) => lease.holderNodeId !== nodeId);
	if (leases.length === graph.leases.length) return graph;
	return finalizeGraph(graph, graph.nodes, leases, graph.events, requireTimestamp(now));
}

export function recoverWorkGraph(graph: WorkGraph, now?: string): WorkGraph {
	const timestamp = requireTimestamp(now);
	let events = [...graph.events];
	const recovered = new Set<string>();
	const nodes = graph.nodes.map((node): WorkNode => {
		if (node.status !== "running") return node;
		recovered.add(node.id);
		events = [
			...events,
			{
				sequence: events.length + 1,
				nodeId: node.id,
				from: "running",
				to: "ready",
				at: timestamp,
				summary: "Recovered after an interrupted runtime",
				evidenceIds: [],
			},
		];
		return {
			...node,
			status: "ready",
			lastSummary: "Recovered after an interrupted runtime",
			updatedAt: timestamp,
		};
	});
	const leases = graph.leases.filter((lease) => !recovered.has(lease.holderNodeId) && !isExpired(lease, timestamp));
	if (recovered.size === 0 && leases.length === graph.leases.length) return graph;
	if (events.length > MAX_EVENTS) throw new Error(`work graph event history exceeds ${MAX_EVENTS} entries`);
	return finalizeGraph(graph, nodes, leases, events, timestamp);
}

export function getReadyWorkNodes(graph: WorkGraph): readonly WorkNode[] {
	return graph.nodes.filter((node) => node.status === "ready");
}
