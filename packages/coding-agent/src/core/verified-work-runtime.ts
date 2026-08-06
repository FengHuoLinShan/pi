import {
	acquireWorkLease,
	consumeWorkNodeBudget,
	getReadyWorkNodes,
	recordWorkNodeProgress,
	recoverWorkGraph,
	releaseWorkLeases,
	transitionWorkNode,
	type WorkEvidence,
	type WorkGraph,
	WorkGraphBudgetError,
	type WorkLeaseRequest,
	type WorkNode,
	type WorkNodeStatus,
	type WorkNodeUpdate,
} from "./work-graph.ts";

export const VERIFIED_WORK_RUNTIME_REPORT_VERSION = 1 as const;

const DEFAULT_MAX_PARALLEL_READS = 4;
const MAX_PARALLEL_READS = 32;

export type VerifiedWorkRuntimeStatus = "passed" | "failed" | "blocked" | "paused" | "interrupted" | "stalled";
export type WorkNodeExecutionStatus = "succeeded" | "failed" | "blocked" | "paused" | "cancelled";

export interface WorkNodeExecutionResult {
	readonly status: WorkNodeExecutionStatus;
	readonly summary: string;
	readonly evidence?: readonly WorkEvidence[];
}

export interface WorkNodeExecutionContext {
	readonly graphId: string;
	readonly node: WorkNode;
	readonly signal?: AbortSignal;
	recordProgress(update: Omit<WorkNodeUpdate, "now">): Promise<void>;
	consumeBudget(unit: "turn" | "token", amount: number): Promise<void>;
	acquireLease(request: Omit<WorkLeaseRequest, "now">): Promise<void>;
	releaseLeases(): Promise<void>;
}

export type WorkNodeExecutor = (node: WorkNode, context: WorkNodeExecutionContext) => Promise<WorkNodeExecutionResult>;

export interface VerifiedWorkGraphStore {
	get(graphId: string): WorkGraph | undefined | Promise<WorkGraph | undefined>;
	save(graph: WorkGraph, expectedRevision: number): void | Promise<void>;
}

export interface VerifiedWorkRuntimeOptions {
	readonly execute: WorkNodeExecutor;
	readonly maxParallelReads?: number;
	readonly recoverOnStart?: boolean;
	readonly stopOnFailure?: boolean;
	readonly now?: () => string;
}

export interface WorkNodeAttemptReport {
	readonly nodeId: string;
	readonly policy: WorkNode["policy"];
	readonly attempt: number;
	readonly status: WorkNodeExecutionStatus;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly summary: string;
}

export interface VerifiedWorkRuntimeReport {
	readonly version: typeof VERIFIED_WORK_RUNTIME_REPORT_VERSION;
	readonly graphId: string;
	readonly status: VerifiedWorkRuntimeStatus;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly recoveredNodeIds: readonly string[];
	readonly attempts: readonly WorkNodeAttemptReport[];
	readonly finalRevision: number;
	readonly nodeStatuses: Readonly<Record<WorkNodeStatus, number>>;
}

function requireTimestamp(value: string): string {
	if (!Number.isFinite(Date.parse(value)))
		throw new Error("Verified work runtime clock returned an invalid timestamp");
	return value;
}

function requireParallelism(value: number | undefined): number {
	const resolved = value ?? DEFAULT_MAX_PARALLEL_READS;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_PARALLEL_READS) {
		throw new Error(`maxParallelReads must be between 1 and ${MAX_PARALLEL_READS}`);
	}
	return resolved;
}

function requireResult(result: WorkNodeExecutionResult): WorkNodeExecutionResult {
	if (
		!result ||
		(result.status !== "succeeded" &&
			result.status !== "failed" &&
			result.status !== "blocked" &&
			result.status !== "paused" &&
			result.status !== "cancelled")
	) {
		throw new Error("Work node executor returned an invalid status");
	}
	if (typeof result.summary !== "string" || result.summary.trim() === "") {
		throw new Error("Work node executor must return a non-empty summary");
	}
	return result;
}

function selectReadyBatch(graph: WorkGraph, maxParallelReads: number): readonly WorkNode[] {
	const ready = getReadyWorkNodes(graph);
	const first = ready[0];
	if (!first) return [];
	if (first.policy !== "parallel-read") return [first];
	return ready.filter((node) => node.policy === "parallel-read").slice(0, maxParallelReads);
}

function countStatuses(graph: WorkGraph): Readonly<Record<WorkNodeStatus, number>> {
	const result: Record<WorkNodeStatus, number> = {
		pending: 0,
		ready: 0,
		running: 0,
		paused: 0,
		succeeded: 0,
		failed: 0,
		blocked: 0,
		cancelled: 0,
	};
	for (const node of graph.nodes) result[node.status]++;
	return result;
}

function finalStatus(graph: WorkGraph, signal: AbortSignal | undefined): VerifiedWorkRuntimeStatus {
	if (signal?.aborted) return "interrupted";
	if (graph.nodes.every((node) => node.status === "succeeded")) return "passed";
	if (graph.nodes.some((node) => node.status === "failed")) return "failed";
	if (graph.nodes.some((node) => node.status === "blocked" || node.status === "cancelled")) return "blocked";
	if (graph.nodes.some((node) => node.status === "paused")) return "paused";
	return "stalled";
}

function failureSummary(error: unknown): string {
	if (error instanceof WorkGraphBudgetError) return error.message;
	if (error instanceof Error && error.message.trim()) return error.message;
	return "Work node executor failed";
}

/**
 * Executes a persisted WorkGraph locally while keeping every state mutation
 * optimistic, serialized, and recoverable.
 */
export class LocalVerifiedWorkRuntime {
	private readonly store: VerifiedWorkGraphStore;
	private readonly execute: WorkNodeExecutor;
	private readonly maxParallelReads: number;
	private readonly recoverOnStart: boolean;
	private readonly stopOnFailure: boolean;
	private readonly clock: () => string;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(store: VerifiedWorkGraphStore, options: VerifiedWorkRuntimeOptions) {
		this.store = store;
		this.execute = options.execute;
		this.maxParallelReads = requireParallelism(options.maxParallelReads);
		this.recoverOnStart = options.recoverOnStart ?? true;
		this.stopOnFailure = options.stopOnFailure ?? true;
		this.clock = options.now ?? (() => new Date().toISOString());
	}

	private now(): string {
		return requireTimestamp(this.clock());
	}

	private async requireGraph(graphId: string): Promise<WorkGraph> {
		const graph = await this.store.get(graphId);
		if (!graph) throw new Error(`Work graph does not exist: ${graphId}`);
		return graph;
	}

	private async mutate(graphId: string, update: (graph: WorkGraph) => WorkGraph): Promise<WorkGraph> {
		let resolveResult: ((graph: WorkGraph) => void) | undefined;
		let rejectResult: ((error: unknown) => void) | undefined;
		const result = new Promise<WorkGraph>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const run = async (): Promise<void> => {
			try {
				const current = await this.requireGraph(graphId);
				const next = update(current);
				if (next.revision !== current.revision) await this.store.save(next, current.revision);
				resolveResult?.(next);
			} catch (error) {
				rejectResult?.(error);
			}
		};
		this.mutationTail = this.mutationTail.then(run, run);
		await this.mutationTail;
		return await result;
	}

	private async settleAfterFailure(
		graphId: string,
		nodeId: string,
		error: unknown,
		signal: AbortSignal | undefined,
	): Promise<{ status: WorkNodeExecutionStatus; summary: string }> {
		const summary = signal?.aborted ? "Interrupted by runtime cancellation" : failureSummary(error);
		let status: WorkNodeExecutionStatus = signal?.aborted
			? "paused"
			: error instanceof WorkGraphBudgetError
				? "blocked"
				: "failed";
		await this.mutate(graphId, (graph) => {
			const node = graph.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) throw new Error(`Unknown work node: ${nodeId}`);
			if (node.status !== "running") {
				if (
					node.status === "succeeded" ||
					node.status === "failed" ||
					node.status === "blocked" ||
					node.status === "paused" ||
					node.status === "cancelled"
				) {
					status = node.status;
				}
				return graph;
			}
			return transitionWorkNode(graph, nodeId, status, { summary, now: this.now() });
		});
		return { status, summary };
	}

	private async executeNode(
		graphId: string,
		nodeId: string,
		signal: AbortSignal | undefined,
	): Promise<WorkNodeAttemptReport> {
		const startedAt = this.now();
		const claimed = await this.mutate(graphId, (graph) =>
			transitionWorkNode(graph, nodeId, "running", { now: startedAt }),
		);
		const node = claimed.nodes.find((candidate) => candidate.id === nodeId);
		if (!node) throw new Error(`Unknown work node: ${nodeId}`);
		const executionNode = structuredClone(node);
		const context: WorkNodeExecutionContext = {
			graphId,
			node: executionNode,
			signal,
			recordProgress: async (update) => {
				await this.mutate(graphId, (graph) =>
					recordWorkNodeProgress(graph, nodeId, { ...update, now: this.now() }),
				);
			},
			consumeBudget: async (unit, amount) => {
				const next = await this.mutate(graphId, (graph) =>
					consumeWorkNodeBudget(graph, nodeId, unit, amount, this.now()),
				);
				if (next.nodes.find((candidate) => candidate.id === nodeId)?.status === "blocked") {
					throw new WorkGraphBudgetError(`work node ${nodeId} exhausted its ${unit} budget`);
				}
			},
			acquireLease: async (request) => {
				await this.mutate(graphId, (graph) => acquireWorkLease(graph, nodeId, { ...request, now: this.now() }));
			},
			releaseLeases: async () => {
				await this.mutate(graphId, (graph) => releaseWorkLeases(graph, nodeId, this.now()));
			},
		};

		let status: WorkNodeExecutionStatus;
		let summary: string;
		try {
			const result = requireResult(await this.execute(executionNode, context));
			status = signal?.aborted ? "paused" : result.status;
			summary = signal?.aborted ? "Interrupted by runtime cancellation" : result.summary;
			await this.mutate(graphId, (graph) => {
				const current = graph.nodes.find((candidate) => candidate.id === nodeId);
				if (!current) throw new Error(`Unknown work node: ${nodeId}`);
				if (current.status !== "running") {
					if (
						current.status === "succeeded" ||
						current.status === "failed" ||
						current.status === "blocked" ||
						current.status === "paused" ||
						current.status === "cancelled"
					) {
						status = current.status;
					}
					return graph;
				}
				return transitionWorkNode(graph, nodeId, status, {
					summary,
					evidence: result.evidence,
					now: this.now(),
				});
			});
		} catch (error) {
			({ status, summary } = await this.settleAfterFailure(graphId, nodeId, error, signal));
		}
		return {
			nodeId,
			policy: executionNode.policy,
			attempt: executionNode.attempts,
			status,
			startedAt,
			finishedAt: this.now(),
			summary,
		};
	}

	async run(graphId: string, options: { signal?: AbortSignal } = {}): Promise<VerifiedWorkRuntimeReport> {
		const startedAt = this.now();
		const initial = await this.requireGraph(graphId);
		const recoveredNodeIds = this.recoverOnStart
			? initial.nodes.filter((node) => node.status === "running").map((node) => node.id)
			: [];
		if (this.recoverOnStart) {
			await this.mutate(graphId, (graph) => recoverWorkGraph(graph, this.now()));
		}
		const attempts: WorkNodeAttemptReport[] = [];
		while (!options.signal?.aborted) {
			const graph = await this.requireGraph(graphId);
			const batch = selectReadyBatch(graph, this.maxParallelReads);
			if (batch.length === 0) break;
			const reports = await Promise.all(batch.map((node) => this.executeNode(graphId, node.id, options.signal)));
			attempts.push(...reports);
			if (
				this.stopOnFailure &&
				reports.some((report) => report.status !== "succeeded" && report.status !== "cancelled")
			) {
				break;
			}
		}
		const finalGraph = await this.requireGraph(graphId);
		return {
			version: VERIFIED_WORK_RUNTIME_REPORT_VERSION,
			graphId,
			status: finalStatus(finalGraph, options.signal),
			startedAt,
			finishedAt: this.now(),
			recoveredNodeIds,
			attempts,
			finalRevision: finalGraph.revision,
			nodeStatuses: countStatuses(finalGraph),
		};
	}
}
