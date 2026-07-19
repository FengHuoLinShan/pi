import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
	type CompletionContract,
	type CompletionReport,
	type CompletionVerifier,
	verifyCompletionContract,
} from "@earendil-works/pi-agent-core";
import { WorkspaceOverlay, type WorkspacePatchSet } from "./workspace-overlay.ts";

export type ShadowRunExecutionMode = "sequential" | "parallel";
export type ShadowRunErrorMode = "isolate" | "throw";

export interface ShadowRunCandidate<TConfig> {
	id: string;
	label?: string;
	config: TConfig;
}

export interface ShadowRunContext<TConfig> {
	candidate: Readonly<ShadowRunCandidate<TConfig>>;
	overlay: WorkspaceOverlay;
	signal: AbortSignal;
}

export interface ShadowRunVerificationContext<TConfig, TOutput> {
	candidate: Readonly<ShadowRunCandidate<TConfig>>;
	overlay: WorkspaceOverlay;
	output: TOutput;
	patchSet: WorkspacePatchSet;
}

export interface ShadowRunCompletionOptions<TConfig, TOutput> {
	contract: CompletionContract;
	/** Reusable verifier instances; every candidate evaluates the same ordered list. */
	verifiers: readonly CompletionVerifier<ShadowRunVerificationContext<TConfig, TOutput>>[];
}

export interface RunShadowCandidatesOptions<TConfig, TOutput> {
	workspaceRoot: string;
	candidates: readonly ShadowRunCandidate<TConfig>[];
	run(context: ShadowRunContext<TConfig>): Promise<TOutput>;
	/** Explicit opt-in to concurrent candidate execution. Default: sequential. */
	execution?: ShadowRunExecutionMode;
	/** Continue collecting other candidates after one fails. Default: isolate. */
	errorMode?: ShadowRunErrorMode;
	signal?: AbortSignal;
	overlay?: {
		exclude?: readonly string[];
		includeGitMetadata?: boolean;
		rootForCandidate?: (candidate: Readonly<ShadowRunCandidate<TConfig>>) => string | undefined;
	};
	completion?: ShadowRunCompletionOptions<TConfig, TOutput>;
}

export interface ShadowRunErrorDetails {
	name: string;
	message: string;
}

export interface ShadowRunCandidateResult<TConfig, TOutput> {
	candidate: ShadowRunCandidate<TConfig>;
	overlay: WorkspaceOverlay;
	status: "completed" | "failed" | "blocked";
	output?: TOutput;
	patchSet?: WorkspacePatchSet;
	completion?: CompletionReport;
	error?: ShadowRunErrorDetails;
}

export interface ShadowRunReport<TConfig, TOutput> {
	version: 1;
	workspaceRoot: string;
	baseSnapshotId: string;
	execution: ShadowRunExecutionMode;
	status: "completed" | "partial" | "blocked";
	runs: ShadowRunCandidateResult<TConfig, TOutput>[];
}

export interface ShadowRunScore {
	score: number;
	summary: string;
	metrics?: Readonly<Record<string, number>>;
}

export interface ShadowRunRankedCandidate {
	rank: number;
	candidateId: string;
	score: number;
	summary: string;
	metrics: Readonly<Record<string, number>>;
}

export interface ShadowRunRanking {
	selectedCandidateId?: string;
	ranked: ShadowRunRankedCandidate[];
	excluded: Array<{ candidateId: string; reason: "run_not_completed" | "completion_not_passed" }>;
}

export type ShadowRunErrorCode = "invalid_options" | "workspace_changed" | "run_failed" | "aborted";

export class ShadowRunError extends Error {
	public code: ShadowRunErrorCode;

	constructor(code: ShadowRunErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ShadowRunError";
		this.code = code;
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function rootsOverlap(left: string, right: string): boolean {
	const leftToRight = relative(left, right);
	const rightToLeft = relative(right, left);
	return [leftToRight, rightToLeft].some(
		(path) => path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)),
	);
}

async function assertUnusedCandidateRoot(root: string, candidateId: string): Promise<void> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(root);
	} catch (error) {
		if (isMissingPathError(error)) return;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new ShadowRunError(
			"invalid_options",
			`Shadow run candidate ${candidateId} overlay root must be a regular directory`,
		);
	}
	if ((await readdir(root)).length > 0) {
		throw new ShadowRunError(
			"invalid_options",
			`Shadow run candidate ${candidateId} overlay root must be empty and unused`,
		);
	}
}

function cloneCandidate<TConfig>(candidate: ShadowRunCandidate<TConfig>): ShadowRunCandidate<TConfig> {
	return { ...candidate };
}

function validateCandidates<TConfig>(candidates: readonly ShadowRunCandidate<TConfig>[]): void {
	if (!Array.isArray(candidates) || candidates.length === 0) {
		throw new ShadowRunError("invalid_options", "Shadow runs require at least one candidate");
	}
	const ids = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate || typeof candidate.id !== "string" || candidate.id.trim() === "") {
			throw new ShadowRunError("invalid_options", "Shadow run candidate id must be a non-empty string");
		}
		if (ids.has(candidate.id)) {
			throw new ShadowRunError("invalid_options", `Duplicate shadow run candidate id: ${candidate.id}`);
		}
		ids.add(candidate.id);
		if (candidate.label !== undefined && candidate.label.trim() === "") {
			throw new ShadowRunError("invalid_options", `Shadow run candidate ${candidate.id} label must not be empty`);
		}
	}
}

async function discardOverlays(overlays: readonly WorkspaceOverlay[]): Promise<void> {
	const failures: Error[] = [];
	for (const overlay of overlays) {
		try {
			await overlay.discard();
		} catch (error) {
			failures.push(errorFromUnknown(error));
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Failed to discard shadow run overlays");
}

async function capturePatchSet(overlay: WorkspaceOverlay): Promise<WorkspacePatchSet | undefined> {
	try {
		return await overlay.createPatchSet();
	} catch {
		return undefined;
	}
}

async function executeCandidate<TConfig, TOutput>(
	candidate: ShadowRunCandidate<TConfig>,
	overlay: WorkspaceOverlay,
	options: RunShadowCandidatesOptions<TConfig, TOutput>,
	signal: AbortSignal,
): Promise<ShadowRunCandidateResult<TConfig, TOutput>> {
	if (signal.aborted) {
		return {
			candidate: cloneCandidate(candidate),
			overlay,
			status: "blocked",
			patchSet: await capturePatchSet(overlay),
		};
	}
	try {
		const output = await options.run({ candidate, overlay, signal });
		if (signal.aborted) {
			return {
				candidate: cloneCandidate(candidate),
				overlay,
				status: "blocked",
				output,
				patchSet: await capturePatchSet(overlay),
			};
		}
		const patchSet = await overlay.createPatchSet();
		const completion = options.completion
			? await verifyCompletionContract(options.completion.contract, options.completion.verifiers, {
					context: { candidate, overlay, output, patchSet },
					signal,
				})
			: undefined;
		return {
			candidate: cloneCandidate(candidate),
			overlay,
			status: signal.aborted ? "blocked" : "completed",
			output,
			patchSet,
			completion,
		};
	} catch (error) {
		if (options.errorMode === "throw" && !signal.aborted) throw error;
		const details = errorFromUnknown(error);
		return {
			candidate: cloneCandidate(candidate),
			overlay,
			status: signal.aborted ? "blocked" : "failed",
			patchSet: await capturePatchSet(overlay),
			error: signal.aborted ? undefined : { name: details.name, message: details.message },
		};
	}
}

/**
 * Run caller-supplied candidates against isolated workspace snapshots.
 * No candidate is selected or applied automatically; the returned overlays
 * remain owned by the caller until explicitly applied or discarded.
 */
export async function runShadowCandidates<TConfig, TOutput>(
	options: RunShadowCandidatesOptions<TConfig, TOutput>,
): Promise<ShadowRunReport<TConfig, TOutput>> {
	validateCandidates(options.candidates);
	if (typeof options.workspaceRoot !== "string" || options.workspaceRoot.trim() === "") {
		throw new ShadowRunError("invalid_options", "Shadow runs require a workspace root");
	}
	if (typeof options.run !== "function") {
		throw new ShadowRunError("invalid_options", "Shadow runs require an explicit runner");
	}
	const execution = options.execution ?? "sequential";
	if (execution !== "sequential" && execution !== "parallel") {
		throw new ShadowRunError("invalid_options", `Invalid shadow run execution mode: ${String(execution)}`);
	}
	const errorMode = options.errorMode ?? "isolate";
	if (errorMode !== "isolate" && errorMode !== "throw") {
		throw new ShadowRunError("invalid_options", `Invalid shadow run error mode: ${String(errorMode)}`);
	}
	const normalizedOptions = { ...options, execution, errorMode };
	const runController = new AbortController();
	const forwardAbort = () => runController.abort(options.signal?.reason);
	if (options.signal?.aborted) {
		throw new ShadowRunError("aborted", "Shadow runs were aborted before initialization");
	}
	options.signal?.addEventListener("abort", forwardAbort, { once: true });
	const signal = runController.signal;

	const overlays: WorkspaceOverlay[] = [];
	try {
		for (const candidate of options.candidates) {
			if (signal.aborted) throw new ShadowRunError("aborted", "Shadow runs were aborted during initialization");
			const candidateRoot = options.overlay?.rootForCandidate?.(candidate);
			if (candidateRoot) await assertUnusedCandidateRoot(candidateRoot, candidate.id);
			const opened = await WorkspaceOverlay.open({
				workspaceRoot: options.workspaceRoot,
				overlayRoot: candidateRoot,
				exclude: options.overlay?.exclude,
				includeGitMetadata: options.overlay?.includeGitMetadata,
			});
			overlays.push(opened.overlay);
			if (opened.overlay.getState() !== "active") {
				throw new ShadowRunError("invalid_options", `Shadow run candidate ${candidate.id} overlay is not active`);
			}
			if (overlays.slice(0, -1).some((overlay) => rootsOverlap(overlay.getRoot(), opened.overlay.getRoot()))) {
				throw new ShadowRunError("invalid_options", "Shadow run candidate overlay roots must not overlap");
			}
		}
		const baseSnapshotId = overlays[0]!.getBaseSnapshotId();
		if (overlays.some((overlay) => overlay.getBaseSnapshotId() !== baseSnapshotId)) {
			throw new ShadowRunError("workspace_changed", "Workspace changed while shadow run snapshots were initialized");
		}

		let runs: ShadowRunCandidateResult<TConfig, TOutput>[];
		if (execution === "parallel") {
			const settled = await Promise.allSettled(
				options.candidates.map(async (candidate, index) => {
					try {
						return await executeCandidate(candidate, overlays[index]!, normalizedOptions, signal);
					} catch (error) {
						if (errorMode === "throw") runController.abort(error);
						throw error;
					}
				}),
			);
			const rejected = settled.find((result) => result.status === "rejected");
			if (rejected?.status === "rejected") throw rejected.reason;
			runs = settled.map((result) => {
				if (result.status === "rejected") throw result.reason;
				return result.value;
			});
		} else {
			runs = [];
			for (let index = 0; index < options.candidates.length; index++) {
				runs.push(await executeCandidate(options.candidates[index]!, overlays[index]!, normalizedOptions, signal));
			}
		}
		const status = runs.every((run) => run.status === "completed")
			? "completed"
			: runs.every((run) => run.status === "blocked")
				? "blocked"
				: "partial";
		return {
			version: 1,
			workspaceRoot: overlays[0]!.getWorkspaceRoot(),
			baseSnapshotId,
			execution,
			status,
			runs,
		};
	} catch (error) {
		runController.abort(error);
		try {
			await discardOverlays(overlays);
		} catch (cleanupError) {
			throw new ShadowRunError(
				"run_failed",
				"Shadow runs failed and overlay cleanup was incomplete",
				new AggregateError([error, cleanupError]),
			);
		}
		if (error instanceof ShadowRunError) throw error;
		throw new ShadowRunError("run_failed", "Shadow runs failed", errorFromUnknown(error));
	} finally {
		options.signal?.removeEventListener("abort", forwardAbort);
	}
}

/** Rank completed candidates using an explicit caller-supplied evaluator. */
export async function rankShadowRuns<TConfig, TOutput>(
	report: ShadowRunReport<TConfig, TOutput>,
	evaluate: (run: Readonly<ShadowRunCandidateResult<TConfig, TOutput>>) => ShadowRunScore | Promise<ShadowRunScore>,
): Promise<ShadowRunRanking> {
	const eligible: ShadowRunCandidateResult<TConfig, TOutput>[] = [];
	const excluded: ShadowRunRanking["excluded"] = [];
	for (const run of report.runs) {
		if (run.status !== "completed") {
			excluded.push({ candidateId: run.candidate.id, reason: "run_not_completed" });
		} else if (run.completion && run.completion.status !== "pass") {
			excluded.push({ candidateId: run.candidate.id, reason: "completion_not_passed" });
		} else {
			eligible.push(run);
		}
	}
	const scored = await Promise.all(
		eligible.map(async (run) => {
			const score = await evaluate(run);
			if (!Number.isFinite(score.score) || typeof score.summary !== "string" || score.summary.trim() === "") {
				throw new ShadowRunError("invalid_options", `Invalid score for shadow run candidate ${run.candidate.id}`);
			}
			const metrics = { ...(score.metrics ?? {}) };
			for (const [name, value] of Object.entries(metrics)) {
				if (!Number.isFinite(value)) {
					throw new ShadowRunError("invalid_options", `Invalid metric ${name} for candidate ${run.candidate.id}`);
				}
			}
			return { candidateId: run.candidate.id, score: score.score, summary: score.summary, metrics };
		}),
	);
	scored.sort((left, right) => right.score - left.score || compareStrings(left.candidateId, right.candidateId));
	return {
		selectedCandidateId: scored[0]?.candidateId,
		ranked: scored.map((candidate, index) => ({ rank: index + 1, ...candidate })),
		excluded,
	};
}

/** Explicitly remove every retained overlay in a shadow-run report. */
export async function discardShadowRunOverlays<TConfig, TOutput>(
	report: ShadowRunReport<TConfig, TOutput>,
): Promise<void> {
	await discardOverlays(report.runs.map((run) => run.overlay));
}
