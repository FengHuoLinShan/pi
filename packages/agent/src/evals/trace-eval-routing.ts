import type { ReplayBranchAdapters } from "../harness/observability/forkable-replay.ts";
import {
	type ModelRouteCandidate,
	type ModelRoutePlan,
	type ModelRouteRequirements,
	ModelRoutingError,
	routeModels,
} from "../routing/model-routing.ts";
import {
	type MinedReplayEvalFixture,
	type MinedReplayEvalReport,
	runMinedReplayEval,
	verifyMinedReplayEvalFixture,
} from "./trace-mining.ts";

export const REPLAY_EVAL_CORPUS_VERSION = 1 as const;

const MAX_CORPUS_ENTRIES = 1_024;
const MAX_CONTROLLED_CANDIDATES = 256;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export interface ReplayEvalCorpusEntry {
	readonly fixture: MinedReplayEvalFixture;
	readonly addedAt: string;
	readonly tags: readonly string[];
}

export interface ReplayEvalCorpusSnapshot {
	readonly version: typeof REPLAY_EVAL_CORPUS_VERSION;
	readonly id: string;
	readonly revision: number;
	readonly entries: readonly ReplayEvalCorpusEntry[];
}

export interface ControlledRoutingCandidate {
	readonly candidate: ModelRouteCandidate;
	readonly adapters: ReplayBranchAdapters;
}

export interface ControlledRoutingPolicy {
	readonly fixtureIds?: readonly string[];
	readonly minPassRate?: number;
	readonly maxFailures?: number;
}

export interface CandidateReplayEvalResult {
	readonly fixtureId: string;
	readonly fixtureHash: string;
	readonly status: "passed" | "failed" | "error";
	readonly report?: MinedReplayEvalReport;
}

export interface CandidateEvalQualificationReport {
	readonly candidateId: string;
	readonly status: "qualified" | "failed";
	readonly corpusId: string;
	readonly corpusRevision: number;
	readonly evaluatedFixtureIds: readonly string[];
	readonly passed: number;
	readonly failed: number;
	readonly errors: number;
	readonly passRate: number;
	readonly reportId: string;
	readonly results: readonly CandidateReplayEvalResult[];
}

export interface ControlledModelRoutingOptions {
	readonly requestId: string;
	readonly corpus: ReplayEvalCorpusSnapshot;
	readonly candidates: readonly ControlledRoutingCandidate[];
	readonly requirements?: ModelRouteRequirements;
	readonly policy?: ControlledRoutingPolicy;
	readonly maxCandidates?: number;
	readonly signal?: AbortSignal;
}

export interface ControlledModelRoutingReport {
	readonly version: 1;
	readonly id: string;
	readonly corpusId: string;
	readonly corpusRevision: number;
	readonly fixtureIds: readonly string[];
	readonly qualifications: readonly CandidateEvalQualificationReport[];
	readonly routePlan: ModelRoutePlan;
}

export class TraceEvalRoutingError extends Error {
	readonly code: "invalid_corpus" | "revision_conflict" | "invalid_policy" | "invalid_candidate";

	constructor(code: "invalid_corpus" | "revision_conflict" | "invalid_policy" | "invalid_candidate", message: string) {
		super(message);
		this.name = "TraceEvalRoutingError";
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

function isReplayBranchAdapters(value: unknown): value is ReplayBranchAdapters {
	return (
		typeof value === "object" &&
		value !== null &&
		"invokeModel" in value &&
		typeof value.invokeModel === "function" &&
		"invokeTool" in value &&
		typeof value.invokeTool === "function"
	);
}

function isDense(value: readonly unknown[]): boolean {
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) return false;
	}
	return true;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length <= 4_096 && Number.isFinite(Date.parse(value));
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 64) {
		throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus tags must be a bounded array");
	}
	const tags: string[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus tags must be dense");
		const tag = value[index];
		if (typeof tag !== "string" || tag.trim() === "" || tag.length > 4_096 || /[\r\n]/.test(tag)) {
			throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus tags must be bounded strings");
		}
		tags.push(tag);
	}
	return [...new Set(tags)].sort(compareStrings);
}

async function sha256(value: unknown): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new TraceEvalRoutingError("invalid_corpus", "Controlled routing requires Web Crypto SHA-256");
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
	return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createReplayEvalCorpus(id: string): ReplayEvalCorpusSnapshot {
	if (typeof id !== "string" || id.length > 160 || !ID_PATTERN.test(id)) {
		throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus id must be lowercase and portable");
	}
	return { version: REPLAY_EVAL_CORPUS_VERSION, id, revision: 0, entries: [] };
}

export async function verifyReplayEvalCorpus(snapshot: ReplayEvalCorpusSnapshot): Promise<boolean> {
	if (
		!isRecord(snapshot) ||
		Object.keys(snapshot).some((key) => !["version", "id", "revision", "entries"].includes(key)) ||
		snapshot.version !== REPLAY_EVAL_CORPUS_VERSION ||
		typeof snapshot.id !== "string" ||
		snapshot.id.length > 160 ||
		!ID_PATTERN.test(snapshot.id) ||
		!Number.isSafeInteger(snapshot.revision) ||
		snapshot.revision < 0 ||
		!Array.isArray(snapshot.entries) ||
		snapshot.entries.length > MAX_CORPUS_ENTRIES ||
		snapshot.revision !== snapshot.entries.length
	) {
		return false;
	}
	const fixtureIds = new Set<string>();
	for (let index = 0; index < snapshot.entries.length; index++) {
		if (!(index in snapshot.entries)) return false;
		const entry = snapshot.entries[index];
		if (
			!isRecord(entry) ||
			Object.keys(entry).some((key) => !["fixture", "addedAt", "tags"].includes(key)) ||
			!isTimestamp(entry.addedAt)
		) {
			return false;
		}
		let tags: string[];
		try {
			tags = normalizeTags(entry.tags);
		} catch {
			return false;
		}
		if (JSON.stringify(tags) !== JSON.stringify(entry.tags)) return false;
		const fixture = entry.fixture as MinedReplayEvalFixture;
		if (!(await verifyMinedReplayEvalFixture(fixture)) || fixtureIds.has(fixture.id)) return false;
		fixtureIds.add(fixture.id);
	}
	return true;
}

export async function appendReplayEvalCorpus(
	snapshot: ReplayEvalCorpusSnapshot,
	fixture: MinedReplayEvalFixture,
	options: { expectedRevision: number; addedAt: string; tags?: readonly string[] },
): Promise<ReplayEvalCorpusSnapshot> {
	if (
		!isRecord(options) ||
		Object.keys(options).some((key) => !["expectedRevision", "addedAt", "tags"].includes(key)) ||
		!Number.isSafeInteger(options.expectedRevision) ||
		options.expectedRevision < 0
	) {
		throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus append options are invalid");
	}
	let current: ReplayEvalCorpusSnapshot;
	let fixtureSnapshot: MinedReplayEvalFixture;
	try {
		current = structuredClone(snapshot);
		fixtureSnapshot = structuredClone(fixture);
	} catch {
		throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus inputs must be structured-cloneable");
	}
	const expectedRevision = options.expectedRevision;
	const addedAt = options.addedAt;
	const tags = normalizeTags(options.tags ?? []);
	if (!isTimestamp(addedAt)) {
		throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus addition time is invalid");
	}
	if (!(await verifyReplayEvalCorpus(current))) {
		throw new TraceEvalRoutingError("invalid_corpus", "Replay eval corpus failed integrity validation");
	}
	if (current.revision !== expectedRevision) {
		throw new TraceEvalRoutingError(
			"revision_conflict",
			`Replay eval corpus revision conflict: expected ${expectedRevision}, found ${current.revision}`,
		);
	}
	if (!(await verifyMinedReplayEvalFixture(fixtureSnapshot))) {
		throw new TraceEvalRoutingError("invalid_corpus", "Replay eval fixture failed integrity validation");
	}
	const existing = current.entries.find((entry) => entry.fixture.id === fixtureSnapshot.id);
	if (existing) {
		if (existing.fixture.fixtureHash === fixtureSnapshot.fixtureHash) return current;
		throw new TraceEvalRoutingError("invalid_corpus", `Replay eval fixture id already exists: ${fixtureSnapshot.id}`);
	}
	if (current.entries.length >= MAX_CORPUS_ENTRIES) {
		throw new TraceEvalRoutingError("invalid_corpus", `Replay eval corpus exceeds ${MAX_CORPUS_ENTRIES} entries`);
	}
	const entry: ReplayEvalCorpusEntry = {
		fixture: fixtureSnapshot,
		addedAt,
		tags,
	};
	return {
		...current,
		revision: current.revision + 1,
		entries: [...current.entries, entry],
	};
}

function validatePolicy(policy: ControlledRoutingPolicy | undefined): Required<ControlledRoutingPolicy> {
	if (
		policy !== undefined &&
		(!isRecord(policy) ||
			Object.keys(policy).some((key) => !["fixtureIds", "minPassRate", "maxFailures"].includes(key)))
	) {
		throw new TraceEvalRoutingError("invalid_policy", "Controlled routing policy is invalid");
	}
	const fixtureIds = policy?.fixtureIds ?? [];
	if (
		!Array.isArray(fixtureIds) ||
		fixtureIds.length > MAX_CORPUS_ENTRIES ||
		!isDense(fixtureIds) ||
		fixtureIds.some((id) => typeof id !== "string" || id.length > 160 || !ID_PATTERN.test(id)) ||
		new Set(fixtureIds).size !== fixtureIds.length
	) {
		throw new TraceEvalRoutingError(
			"invalid_policy",
			"Controlled routing fixture ids must be a bounded set of portable ids",
		);
	}
	const rawMinPassRate = policy?.minPassRate;
	const minPassRate = rawMinPassRate === undefined ? 1 : rawMinPassRate;
	if (typeof minPassRate !== "number" || !Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
		throw new TraceEvalRoutingError(
			"invalid_policy",
			"Controlled routing minimum pass rate must be between zero and one",
		);
	}
	const rawMaxFailures = policy?.maxFailures;
	const maxFailures = rawMaxFailures === undefined ? 0 : rawMaxFailures;
	if (typeof maxFailures !== "number" || !Number.isSafeInteger(maxFailures) || maxFailures < 0) {
		throw new TraceEvalRoutingError("invalid_policy", "Controlled routing maximum failures must be non-negative");
	}
	return { fixtureIds: [...fixtureIds], minPassRate, maxFailures };
}

async function qualifyCandidate(
	corpus: ReplayEvalCorpusSnapshot,
	entries: readonly ReplayEvalCorpusEntry[],
	input: ControlledRoutingCandidate,
	policy: Required<ControlledRoutingPolicy>,
	signal?: AbortSignal,
): Promise<CandidateEvalQualificationReport> {
	const results: CandidateReplayEvalResult[] = [];
	for (const entry of entries) {
		signal?.throwIfAborted();
		try {
			const report = await runMinedReplayEval(structuredClone(entry.fixture), input.adapters, { signal });
			signal?.throwIfAborted();
			results.push({
				fixtureId: entry.fixture.id,
				fixtureHash: entry.fixture.fixtureHash,
				status: report.candidate.status === "complete" ? (report.passed ? "passed" : "failed") : "error",
				report,
			});
		} catch {
			signal?.throwIfAborted();
			results.push({
				fixtureId: entry.fixture.id,
				fixtureHash: entry.fixture.fixtureHash,
				status: "error",
			});
		}
	}
	const passed = results.filter((result) => result.status === "passed").length;
	const errors = results.filter((result) => result.status === "error").length;
	const failed = results.length - passed;
	const passRate = results.length === 0 ? 0 : passed / results.length;
	const status: CandidateEvalQualificationReport["status"] =
		errors === 0 && passRate >= policy.minPassRate && failed <= policy.maxFailures ? "qualified" : "failed";
	const body = {
		candidateId: input.candidate.id,
		status,
		corpusId: corpus.id,
		corpusRevision: corpus.revision,
		evaluatedFixtureIds: results.map((result) => result.fixtureId),
		passed,
		failed,
		errors,
		passRate,
		results: results.map((result) => ({
			fixtureId: result.fixtureId,
			fixtureHash: result.fixtureHash,
			status: result.status,
			outcomeHash: result.report?.candidate.outcomeHash,
		})),
	};
	return { ...body, reportId: await sha256(body), results };
}

function snapshotCandidates(inputs: readonly ControlledRoutingCandidate[]): ControlledRoutingCandidate[] {
	if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_CONTROLLED_CANDIDATES) {
		throw new TraceEvalRoutingError(
			"invalid_candidate",
			`Controlled routing requires between 1 and ${MAX_CONTROLLED_CANDIDATES} candidates`,
		);
	}
	for (let index = 0; index < inputs.length; index++) {
		if (!(index in inputs)) {
			throw new TraceEvalRoutingError("invalid_candidate", "Controlled routing candidates must be dense");
		}
		const input = inputs[index];
		if (!isRecord(input) || !isReplayBranchAdapters(input.adapters)) {
			throw new TraceEvalRoutingError("invalid_candidate", `Controlled routing candidate ${index} is invalid`);
		}
	}
	let normalized: readonly ModelRouteCandidate[];
	try {
		normalized = routeModels({
			requestId: "controlled-routing-candidate-validation",
			candidates: inputs.map((input) => input.candidate),
		}).evaluations.map((evaluation) => evaluation.candidate);
	} catch (error) {
		if (error instanceof ModelRoutingError) {
			throw new TraceEvalRoutingError("invalid_candidate", error.message);
		}
		throw error;
	}
	return normalized.map((candidate, index) => {
		const adapters = inputs[index]!.adapters;
		const invokeModel = adapters.invokeModel;
		const invokeTool = adapters.invokeTool;
		return {
			candidate,
			adapters: {
				invokeModel: (step, signal) =>
					invokeModel.call(
						adapters,
						{
							...structuredClone(step),
							provider: candidate.profile.provider,
							modelId: candidate.profile.model,
						},
						signal,
					),
				invokeTool: (step, signal) => invokeTool.call(adapters, structuredClone(step), signal),
			},
		};
	});
}

export async function runControlledModelRouting(
	options: ControlledModelRoutingOptions,
): Promise<ControlledModelRoutingReport> {
	if (!isRecord(options)) {
		throw new TraceEvalRoutingError("invalid_corpus", "Controlled routing requires a valid replay eval corpus");
	}
	if (
		Object.keys(options).some(
			(key) =>
				!["requestId", "corpus", "candidates", "requirements", "policy", "maxCandidates", "signal"].includes(key),
		)
	) {
		throw new TraceEvalRoutingError("invalid_policy", "Controlled routing options contain an unknown field");
	}
	let corpus: ReplayEvalCorpusSnapshot;
	try {
		corpus = structuredClone(options.corpus);
	} catch {
		throw new TraceEvalRoutingError("invalid_corpus", "Controlled routing requires a cloneable replay eval corpus");
	}
	const candidates = snapshotCandidates(options.candidates);
	const requestId = options.requestId;
	const requirements = options.requirements === undefined ? undefined : structuredClone(options.requirements);
	const maxCandidates = options.maxCandidates;
	const signal = options.signal;
	const policy = validatePolicy(options.policy);
	if (!(await verifyReplayEvalCorpus(corpus))) {
		throw new TraceEvalRoutingError("invalid_corpus", "Controlled routing requires a valid replay eval corpus");
	}
	const selectedIds = new Set(policy.fixtureIds);
	const entries =
		selectedIds.size === 0
			? [...corpus.entries]
			: corpus.entries.filter((entry) => selectedIds.has(entry.fixture.id));
	if (entries.length === 0) {
		throw new TraceEvalRoutingError("invalid_policy", "Controlled routing selected no replay eval fixtures");
	}
	const missing = [...selectedIds].filter((id) => !entries.some((entry) => entry.fixture.id === id));
	if (missing.length > 0) {
		throw new TraceEvalRoutingError(
			"invalid_policy",
			`Controlled routing fixtures do not exist: ${missing.join(", ")}`,
		);
	}
	const qualifications: CandidateEvalQualificationReport[] = [];
	for (const input of candidates) {
		qualifications.push(await qualifyCandidate(corpus, entries, input, policy, signal));
	}
	const byCandidate = new Map(qualifications.map((report) => [report.candidateId, report]));
	const routeCandidates = candidates.map(({ candidate }) => {
		const report = byCandidate.get(candidate.id)!;
		return {
			...candidate,
			qualification: {
				status: report.status,
				corpusId: report.corpusId,
				corpusRevision: report.corpusRevision,
				passRate: report.passRate,
				reportId: report.reportId,
			},
		};
	});
	const routePlan = routeModels({
		requestId,
		candidates: routeCandidates,
		requirements: {
			...requirements,
			qualityGate: {
				required: true,
				corpusId: corpus.id,
				minCorpusRevision: corpus.revision,
				minPassRate: policy.minPassRate,
			},
		},
		maxCandidates,
	});
	const body = {
		version: 1 as const,
		corpusId: corpus.id,
		corpusRevision: corpus.revision,
		fixtureIds: entries.map((entry) => entry.fixture.id),
		qualifications,
		routePlan,
	};
	return { ...body, id: await sha256(body) };
}
