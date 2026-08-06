import {
	compareReplayBranches,
	createReplayBranch,
	executeReplayBranch,
	type ReplayBranch,
	type ReplayBranchAdapters,
	type ReplayBranchComparison,
	ReplayBranchError,
	type ReplayBranchExecution,
	type ReplayBranchExecutionItem,
	type ReplayBranchOverride,
	verifyReplayBranch,
} from "../harness/observability/forkable-replay.ts";
import { type TraceBundle, verifyTraceBundle } from "../harness/observability/trace-bundle.ts";

export const MINED_REPLAY_EVAL_VERSION = 1 as const;

const MAX_ID_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 4 * 1_024;
const MAX_METRIC_THRESHOLDS = 256;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ReplayEvalAdapterKind = "model" | "tool";
export type ReplayEvalExpectation = "equivalent" | "different" | "complete";
export type ReplayEvalMiningReasonKind =
	| "tool-error"
	| "provider-failure"
	| "provider-interruption"
	| "turn-interruption"
	| "metric-threshold"
	| "forced";

export interface ReplayEvalMiningReason {
	readonly kind: ReplayEvalMiningReasonKind;
	readonly sequence: number;
	readonly id: string;
	readonly metric?: string;
	readonly value?: number;
	readonly threshold?: number;
}

export interface MineReplayEvalOptions {
	readonly id: string;
	readonly description?: string;
	readonly allowCapturedContent: boolean;
	readonly criticalSequence?: number;
	readonly metricThresholds?: Readonly<Record<string, number>>;
	readonly adapterKinds?: readonly ReplayEvalAdapterKind[];
	readonly expectation?: ReplayEvalExpectation;
	readonly force?: boolean;
}

export interface ReplayEvalExecutionSummary {
	readonly branchId: string;
	readonly definitionHash: string;
	readonly status: ReplayBranchExecution["status"];
	readonly items: readonly Omit<ReplayBranchExecutionItem, "result">[];
	readonly outcomeHash: string;
}

export interface MinedReplayEvalFixture {
	readonly version: typeof MINED_REPLAY_EVAL_VERSION;
	readonly id: string;
	readonly description?: string;
	readonly sourceBundleId: string;
	readonly sourceBundleChecksum: string;
	readonly criticalSequence: number;
	readonly reasons: readonly ReplayEvalMiningReason[];
	readonly expectation: ReplayEvalExpectation;
	readonly adapterKinds: readonly ReplayEvalAdapterKind[];
	readonly candidateBranch: ReplayBranch;
	readonly baseline: ReplayEvalExecutionSummary;
	readonly fixtureHash: string;
}

export interface MinedReplayEvalReport {
	readonly version: 1;
	readonly fixtureId: string;
	readonly fixtureHash: string;
	readonly passed: boolean;
	readonly expectation: ReplayEvalExpectation;
	readonly baseline: ReplayEvalExecutionSummary;
	readonly candidate: ReplayEvalExecutionSummary;
	readonly comparison: ReplayBranchComparison;
}

export class ReplayEvalMiningError extends Error {
	readonly code:
		| "invalid_bundle"
		| "invalid_options"
		| "not_candidate"
		| "content_not_allowed"
		| "content_unavailable"
		| "invalid_fixture";

	constructor(
		code:
			| "invalid_bundle"
			| "invalid_options"
			| "not_candidate"
			| "content_not_allowed"
			| "content_unavailable"
			| "invalid_fixture",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ReplayEvalMiningError";
		this.code = code;
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isExpectation(value: unknown): value is ReplayEvalExpectation {
	return value === "equivalent" || value === "different" || value === "complete";
}

function jsonSafe(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
	if (typeof value === "undefined") return { $type: "undefined" };
	if (typeof value === "function") return { $type: "function" };
	if (typeof value === "symbol") return { $type: "symbol", value: value.description ?? "" };
	if (value instanceof Uint8Array) return { $type: "bytes", values: [...value] };
	if (value instanceof Date) return { $type: "date", value: value.toISOString() };
	if (value instanceof Error) return { $type: "error", name: value.name, message: value.message };
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return { $type: "circular" };
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => compareStrings(left, right))
				.map(([key, item]) => [key, jsonSafe(item, seen)]),
		);
	} finally {
		seen.delete(value);
	}
}

async function sha256(value: unknown): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new ReplayEvalMiningError("invalid_fixture", "Replay eval mining requires Web Crypto SHA-256");
	}
	const bytes = new TextEncoder().encode(JSON.stringify(jsonSafe(value)));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function summarizeExecution(execution: ReplayBranchExecution): ReplayEvalExecutionSummary {
	return {
		branchId: execution.branchId,
		definitionHash: execution.definitionHash,
		status: execution.status,
		items: execution.items.map(({ result: _result, ...item }) => item),
		outcomeHash: execution.outcomeHash,
	};
}

function asExecution(summary: ReplayEvalExecutionSummary): ReplayBranchExecution {
	return {
		branchId: summary.branchId,
		definitionHash: summary.definitionHash,
		status: summary.status,
		items: summary.items.map((item) => ({ ...item })),
		outcomeHash: summary.outcomeHash,
	};
}

function startedSequenceForEvent(bundle: TraceBundle, sequence: number): number {
	const envelope = bundle.canonicalEvents[sequence - 1];
	if (!envelope) return sequence;
	const event = envelope.event;
	if (event.type === "provider_request_failed" || event.type === "provider_request_interrupted") {
		return (
			bundle.canonicalEvents.find(
				(candidate) =>
					candidate.event.type === "provider_request_started" && candidate.event.requestId === event.requestId,
			)?.sequence ?? sequence
		);
	}
	if (event.type === "turn_interrupted") {
		return (
			bundle.canonicalEvents.find(
				(candidate) => candidate.event.type === "turn_started" && candidate.event.turnId === event.turnId,
			)?.sequence ?? sequence
		);
	}
	return sequence;
}

function miningReasons(bundle: TraceBundle, options: MineReplayEvalOptions): ReplayEvalMiningReason[] {
	const reasons: ReplayEvalMiningReason[] = [];
	for (const exchange of bundle.toolExchanges) {
		if (exchange.isError) {
			reasons.push({
				kind: "tool-error",
				sequence: exchange.sequence,
				id: exchange.toolCallId,
			});
		}
	}
	for (const envelope of bundle.canonicalEvents) {
		const event = envelope.event;
		if (event.type === "provider_request_failed") {
			reasons.push({
				kind: "provider-failure",
				sequence: startedSequenceForEvent(bundle, envelope.sequence),
				id: event.requestId,
			});
		} else if (event.type === "provider_request_interrupted") {
			reasons.push({
				kind: "provider-interruption",
				sequence: startedSequenceForEvent(bundle, envelope.sequence),
				id: event.requestId,
			});
		} else if (event.type === "turn_interrupted") {
			reasons.push({
				kind: "turn-interruption",
				sequence: startedSequenceForEvent(bundle, envelope.sequence),
				id: event.turnId,
			});
		}
	}
	for (const [metric, threshold] of Object.entries(options.metricThresholds ?? {}).sort(([left], [right]) =>
		compareStrings(left, right),
	)) {
		if (!Number.isFinite(threshold)) {
			throw new ReplayEvalMiningError("invalid_options", `Metric threshold ${metric} must be finite`);
		}
		const value = bundle.metrics[metric];
		if (value !== undefined && value > threshold) {
			const lastExchangeSequence = Math.max(
				0,
				...bundle.modelExchanges.map((exchange) => exchange.sequence),
				...bundle.toolExchanges.map((exchange) => exchange.sequence),
			);
			reasons.push({
				kind: "metric-threshold",
				sequence: lastExchangeSequence || 1,
				id: metric,
				metric,
				value,
				threshold,
			});
		}
	}
	if (reasons.length === 0 && options.force) {
		reasons.push({ kind: "forced", sequence: 1, id: "forced" });
	}
	return reasons.sort(
		(left, right) =>
			left.sequence - right.sequence || compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id),
	);
}

function validateOptions(bundle: TraceBundle, options: MineReplayEvalOptions): void {
	if (!isRecord(options)) {
		throw new ReplayEvalMiningError("invalid_options", "Replay eval mining options must be an object");
	}
	if (typeof options.id !== "string" || options.id.length > MAX_ID_LENGTH || !ID_PATTERN.test(options.id)) {
		throw new ReplayEvalMiningError("invalid_options", "Replay eval id must be lowercase and portable");
	}
	if (
		options.description !== undefined &&
		(typeof options.description !== "string" ||
			options.description.trim() === "" ||
			options.description.length > MAX_DESCRIPTION_LENGTH)
	) {
		throw new ReplayEvalMiningError("invalid_options", "Replay eval description must be non-empty and bounded");
	}
	if (typeof options.allowCapturedContent !== "boolean") {
		throw new ReplayEvalMiningError("invalid_options", "allowCapturedContent must be boolean");
	}
	if (!options.allowCapturedContent) {
		throw new ReplayEvalMiningError(
			"content_not_allowed",
			"Replay eval mining requires explicit allowCapturedContent because fixtures retain exact replay inputs",
		);
	}
	if (options.force !== undefined && typeof options.force !== "boolean") {
		throw new ReplayEvalMiningError("invalid_options", "force must be boolean");
	}
	if (options.expectation !== undefined && !isExpectation(options.expectation)) {
		throw new ReplayEvalMiningError("invalid_options", "expectation must be equivalent, different, or complete");
	}
	if (
		options.criticalSequence !== undefined &&
		(!Number.isSafeInteger(options.criticalSequence) ||
			options.criticalSequence < 1 ||
			options.criticalSequence > bundle.canonicalEvents.length + 1)
	) {
		throw new ReplayEvalMiningError("invalid_options", "criticalSequence is outside the canonical event log");
	}
	if (
		options.metricThresholds !== undefined &&
		(!isRecord(options.metricThresholds) ||
			Object.keys(options.metricThresholds).length > MAX_METRIC_THRESHOLDS ||
			Object.keys(options.metricThresholds).some(
				(metric) => metric.trim() === "" || metric.length > MAX_DESCRIPTION_LENGTH || /[\r\n]/.test(metric),
			))
	) {
		throw new ReplayEvalMiningError(
			"invalid_options",
			"metricThresholds must be a bounded record with non-empty single-line names",
		);
	}
	const kinds = options.adapterKinds ?? ["model", "tool"];
	if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => kind !== "model" && kind !== "tool")) {
		throw new ReplayEvalMiningError("invalid_options", "adapterKinds must contain model or tool");
	}
}

function adapterOverrides(
	bundle: TraceBundle,
	criticalSequence: number,
	kinds: ReadonlySet<ReplayEvalAdapterKind>,
): ReplayBranchOverride[] {
	const overrides: ReplayBranchOverride[] = [];
	if (kinds.has("model")) {
		for (const exchange of bundle.modelExchanges) {
			if (exchange.sequence >= criticalSequence) {
				overrides.push({
					kind: "model",
					requestId: exchange.requestId,
					response: { source: "adapter" },
				});
			}
		}
	}
	if (kinds.has("tool")) {
		for (const exchange of bundle.toolExchanges) {
			if (exchange.sequence >= criticalSequence) {
				overrides.push({
					kind: "tool",
					toolCallId: exchange.toolCallId,
					response: { source: "adapter" },
				});
			}
		}
	}
	return overrides;
}

function fixtureBody(fixture: Omit<MinedReplayEvalFixture, "fixtureHash">): unknown {
	return fixture;
}

function throwReplayBranchMiningError(error: unknown, contentMessage: string): never {
	if (error instanceof ReplayBranchError) {
		if (error.code === "invalid_bundle") {
			throw new ReplayEvalMiningError("invalid_bundle", "Trace bundle is invalid for replay", { cause: error });
		}
		if (error.code === "invalid_branch" || error.code === "override_not_found") {
			throw new ReplayEvalMiningError("invalid_options", "Critical sequence is not a valid replay boundary", {
				cause: error,
			});
		}
	}
	throw new ReplayEvalMiningError("content_unavailable", contentMessage, { cause: error });
}

export async function mineReplayEval(
	bundle: TraceBundle,
	options: MineReplayEvalOptions,
): Promise<MinedReplayEvalFixture> {
	let bundleValid = false;
	try {
		bundleValid = await verifyTraceBundle(bundle);
	} catch (error) {
		throw new ReplayEvalMiningError("invalid_bundle", "Trace bundle could not be verified", { cause: error });
	}
	if (!bundleValid) throw new ReplayEvalMiningError("invalid_bundle", "Trace bundle checksum is invalid");
	validateOptions(bundle, options);
	const reasons = miningReasons(bundle, options);
	if (reasons.length === 0) {
		throw new ReplayEvalMiningError("not_candidate", "Trace contains no failed operation or metric threshold breach");
	}
	const criticalSequence = options.criticalSequence ?? reasons[0]!.sequence;
	const adapterKinds: ReplayEvalAdapterKind[] = [
		...new Set<ReplayEvalAdapterKind>(options.adapterKinds ?? ["model", "tool"]),
	].sort(compareStrings);
	let baselineBranch: ReplayBranch;
	try {
		baselineBranch = await createReplayBranch(bundle, {
			branchId: `${options.id}-baseline`,
			forkBeforeSequence: criticalSequence,
			label: "Mined baseline",
		});
	} catch (error) {
		throwReplayBranchMiningError(
			error,
			"Critical replay suffix was not captured exactly; recapture only the required model/tool items with explicit consent",
		);
	}
	const baselineExecution = await executeReplayBranch(baselineBranch);
	if (baselineExecution.status !== "complete") {
		throw new ReplayEvalMiningError(
			"content_unavailable",
			"Critical replay suffix does not contain complete recorded responses",
		);
	}
	const overrides = adapterOverrides(bundle, criticalSequence, new Set(adapterKinds));
	if (overrides.length === 0) {
		throw new ReplayEvalMiningError(
			"invalid_options",
			"The critical replay suffix contains no steps matching adapterKinds",
		);
	}
	let candidateBranch: ReplayBranch;
	try {
		candidateBranch = await createReplayBranch(bundle, {
			branchId: `${options.id}-candidate`,
			forkBeforeSequence: criticalSequence,
			label: "Regression candidate",
			overrides,
		});
	} catch (error) {
		throwReplayBranchMiningError(
			error,
			"Critical replay suffix was not captured exactly; recapture only the required model/tool items with explicit consent",
		);
	}
	const body: Omit<MinedReplayEvalFixture, "fixtureHash"> = {
		version: MINED_REPLAY_EVAL_VERSION,
		id: options.id,
		...(options.description === undefined ? {} : { description: options.description }),
		sourceBundleId: bundle.manifest.bundleId,
		sourceBundleChecksum: bundle.manifest.checksum,
		criticalSequence,
		reasons,
		expectation: options.expectation ?? "equivalent",
		adapterKinds,
		candidateBranch,
		baseline: summarizeExecution(baselineExecution),
	};
	return { ...body, fixtureHash: await sha256(fixtureBody(body)) };
}

function isExecutionSummary(value: unknown): value is ReplayEvalExecutionSummary {
	if (
		!isRecord(value) ||
		typeof value.branchId !== "string" ||
		value.branchId.trim() === "" ||
		typeof value.definitionHash !== "string" ||
		!SHA256_PATTERN.test(value.definitionHash) ||
		(value.status !== "complete" && value.status !== "blocked" && value.status !== "error") ||
		!Array.isArray(value.items) ||
		typeof value.outcomeHash !== "string" ||
		!SHA256_PATTERN.test(value.outcomeHash)
	) {
		return false;
	}
	return value.items.every((item) => {
		if (!isRecord(item) || Object.hasOwn(item, "result")) return false;
		const unknownKey = Object.keys(item).find(
			(key) =>
				!["kind", "id", "sequence", "status", "responseSource", "resultHash", "isError", "errorName"].includes(key),
		);
		return (
			unknownKey === undefined &&
			(item.kind === "model" || item.kind === "tool") &&
			typeof item.id === "string" &&
			item.id.trim() !== "" &&
			Number.isSafeInteger(item.sequence) &&
			(item.sequence as number) >= 1 &&
			(item.status === "resolved" || item.status === "blocked" || item.status === "error") &&
			(item.responseSource === undefined ||
				item.responseSource === "recorded" ||
				item.responseSource === "override" ||
				item.responseSource === "adapter") &&
			(item.resultHash === undefined ||
				(typeof item.resultHash === "string" && SHA256_PATTERN.test(item.resultHash))) &&
			(item.isError === undefined || typeof item.isError === "boolean") &&
			(item.errorName === undefined || typeof item.errorName === "string")
		);
	});
}

function hasCandidateReplayCoverage(fixture: MinedReplayEvalFixture): boolean {
	const branch = fixture.candidateBranch;
	if (
		fixture.baseline.status !== "complete" ||
		fixture.baseline.branchId !== `${fixture.id}-baseline` ||
		branch.manifest.branchId !== `${fixture.id}-candidate` ||
		branch.manifest.prefixEventCount !== fixture.criticalSequence - 1 ||
		branch.stateAtFork?.lastSequence !== branch.manifest.prefixEventCount ||
		branch.steps.length === 0 ||
		fixture.baseline.items.length !== branch.steps.length
	) {
		return false;
	}
	let invokesSelectedAdapter = false;
	for (let index = 0; index < branch.steps.length; index++) {
		if (!(index in branch.steps) || !(index in fixture.baseline.items)) return false;
		const step = branch.steps[index]!;
		const baseline = fixture.baseline.items[index]!;
		const stepId = step.kind === "model" ? step.requestId : step.toolCallId;
		if (
			baseline.kind !== step.kind ||
			baseline.id !== stepId ||
			baseline.sequence !== step.sequence ||
			baseline.status !== "resolved" ||
			baseline.responseSource !== "recorded" ||
			baseline.resultHash === undefined
		) {
			return false;
		}
		if (step.responseSource === undefined && fixture.adapterKinds.includes(step.kind)) {
			invokesSelectedAdapter = true;
		}
	}
	return invokesSelectedAdapter;
}

export async function verifyMinedReplayEvalFixture(fixture: MinedReplayEvalFixture): Promise<boolean> {
	if (
		!isRecord(fixture) ||
		fixture.version !== MINED_REPLAY_EVAL_VERSION ||
		typeof fixture.fixtureHash !== "string" ||
		!SHA256_PATTERN.test(fixture.fixtureHash) ||
		typeof fixture.id !== "string" ||
		fixture.id.length > MAX_ID_LENGTH ||
		!ID_PATTERN.test(fixture.id) ||
		typeof fixture.sourceBundleId !== "string" ||
		fixture.sourceBundleId.trim() === "" ||
		typeof fixture.sourceBundleChecksum !== "string" ||
		!SHA256_PATTERN.test(fixture.sourceBundleChecksum) ||
		!Number.isSafeInteger(fixture.criticalSequence) ||
		fixture.criticalSequence < 1 ||
		!Array.isArray(fixture.reasons) ||
		!isExpectation(fixture.expectation) ||
		!Array.isArray(fixture.adapterKinds) ||
		fixture.adapterKinds.length === 0 ||
		fixture.adapterKinds.some((kind) => kind !== "model" && kind !== "tool") ||
		!isExecutionSummary(fixture.baseline) ||
		!isRecord(fixture.candidateBranch) ||
		!isRecord(fixture.candidateBranch.manifest) ||
		fixture.candidateBranch.manifest.sourceBundleId !== fixture.sourceBundleId ||
		fixture.candidateBranch.manifest.sourceBundleChecksum !== fixture.sourceBundleChecksum ||
		fixture.candidateBranch.manifest.forkBeforeSequence !== fixture.criticalSequence ||
		!(await verifyReplayBranch(fixture.candidateBranch as ReplayBranch)) ||
		!hasCandidateReplayCoverage(fixture)
	) {
		return false;
	}
	const { fixtureHash, ...body } = fixture;
	return (await sha256(fixtureBody(body))) === fixtureHash;
}

export async function runMinedReplayEval(
	fixture: MinedReplayEvalFixture,
	adapters: ReplayBranchAdapters,
	options: { signal?: AbortSignal } = {},
): Promise<MinedReplayEvalReport> {
	if (!(await verifyMinedReplayEvalFixture(fixture))) {
		throw new ReplayEvalMiningError("invalid_fixture", "Mined replay eval fixture failed integrity validation");
	}
	const candidateExecution = await executeReplayBranch(fixture.candidateBranch, adapters, options);
	const candidate = summarizeExecution(candidateExecution);
	const comparison = compareReplayBranches(asExecution(fixture.baseline), asExecution(candidate));
	const passed =
		fixture.expectation === "equivalent"
			? comparison.equivalent
			: fixture.expectation === "different"
				? !comparison.equivalent && candidate.status === "complete"
				: candidate.status === "complete";
	return {
		version: 1,
		fixtureId: fixture.id,
		fixtureHash: fixture.fixtureHash,
		passed,
		expectation: fixture.expectation,
		baseline: fixture.baseline,
		candidate,
		comparison,
	};
}
