import { createHash } from "node:crypto";
import type {
	CompletionEvidence,
	CompletionJsonValue,
	CompletionVerifier,
	CompletionVerifierOutcome,
} from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";
import { computeFileRevision } from "./tools/file-transaction.ts";
import type { WorkspaceOverlayChangeKind, WorkspacePatchSet, WorkspacePatchSetEntry } from "./workspace-overlay.ts";

export type WorkspaceChangeOperation = "create" | "update" | "delete" | "mode";
export type WorkspaceChangeEvidencePathMode = "digest" | "omit" | "plain";
export type WorkspaceChangeEvidenceIdentityMode = "include" | "omit";

export interface WorkspaceChangeDisciplinePolicy {
	/** Portable workspace-relative glob patterns. Omit to allow every path. */
	allowedPaths?: readonly string[];
	/** Portable workspace-relative glob patterns. Deny rules take precedence over allow rules. */
	deniedPaths?: readonly string[];
	/** Operations permitted by the policy. Omit to allow every operation. */
	allowedOperations?: readonly WorkspaceChangeOperation[];
	/** Minimum number of PatchSet entries. Zero does not establish a policy gate. */
	minFiles?: number;
	maxFiles?: number;
	/** Conservative content bytes touched by create, delete, and content-update operations. */
	maxChangedBytes?: number;
	/** Maximum conservative content bytes touched by one PatchSet entry. */
	maxFileBytes?: number;
}

export type WorkspaceChangeDisciplineViolationCode =
	| "path_not_allowed"
	| "path_denied"
	| "operation_denied"
	| "min_files_not_met"
	| "max_files_exceeded"
	| "max_changed_bytes_exceeded"
	| "max_file_bytes_exceeded";

export interface WorkspaceChangeDisciplineViolation {
	code: WorkspaceChangeDisciplineViolationCode;
	path?: string;
	operation?: WorkspaceChangeOperation;
	actual?: number;
	limit?: number;
}

export interface WorkspaceChangeDisciplineResult {
	version: 1;
	status: "pass" | "fail";
	patchSetId: string;
	baseSnapshotId: string;
	fileCount: number;
	changedBytes: number;
	kindCounts: Record<WorkspaceOverlayChangeKind, number>;
	operationCounts: Record<WorkspaceChangeOperation, number>;
	violations: WorkspaceChangeDisciplineViolation[];
}

export interface WorkspaceChangeDisciplineVerifierOptions<TContext> {
	/** Stable verifier id referenced by a CompletionContract condition. */
	id: string;
	policy: WorkspaceChangeDisciplinePolicy;
	getPatchSet(context: TContext, signal: AbortSignal): WorkspacePatchSet | Promise<WorkspacePatchSet>;
	/** Paths are omitted by default. Digests and plain paths require explicit opt-in. */
	evidencePathMode?: WorkspaceChangeEvidencePathMode;
	/** PatchSet and base-snapshot identities are omitted by default. */
	evidenceIdentityMode?: WorkspaceChangeEvidenceIdentityMode;
}

interface NormalizedPolicy {
	allowedPaths?: string[];
	deniedPaths: string[];
	allowedOperations?: ReadonlySet<WorkspaceChangeOperation>;
	minFiles?: number;
	maxFiles?: number;
	maxChangedBytes?: number;
	maxFileBytes?: number;
}

const operations: readonly WorkspaceChangeOperation[] = ["create", "update", "delete", "mode"];
const pathMatchOptions = { dot: true, nocase: false, nonegate: true, nocomment: true } as const;
const patchSetResolutionAborted = Symbol("patch-set-resolution-aborted");

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertDenseArray(values: readonly unknown[], label: string): void {
	for (let index = 0; index < values.length; index++) {
		if (!(index in values)) throw new Error(`${label} must not contain sparse entries`);
	}
}

function validatePattern(pattern: string, label: string): string {
	if (typeof pattern !== "string" || pattern.length === 0) throw new Error(`${label} must not be empty`);
	if (pattern.includes("\\") || pattern.startsWith("/") || pattern.endsWith("/")) {
		throw new Error(`${label} must be a portable workspace-relative glob`);
	}
	const segments = pattern.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`${label} must be a portable workspace-relative glob`);
	}
	return pattern;
}

function normalizePatterns(patterns: readonly string[] | undefined, label: string): string[] | undefined {
	if (patterns === undefined) return undefined;
	if (!Array.isArray(patterns)) throw new Error(`${label} must be an array`);
	assertDenseArray(patterns, label);
	const normalized = patterns.map((pattern, index) => validatePattern(pattern, `${label}[${index}]`));
	if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`);
	return [...normalized].sort(compareStrings);
}

function validateLimit(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
	return value;
}

function normalizePolicy(policy: WorkspaceChangeDisciplinePolicy): NormalizedPolicy {
	if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
		throw new Error("Workspace change discipline policy must be an object");
	}
	let allowedOperations: ReadonlySet<WorkspaceChangeOperation> | undefined;
	if (policy.allowedOperations !== undefined) {
		if (!Array.isArray(policy.allowedOperations)) throw new Error("allowedOperations must be an array");
		assertDenseArray(policy.allowedOperations, "allowedOperations");
		if (!policy.allowedOperations.every((operation) => operations.includes(operation))) {
			throw new Error("allowedOperations contains an unknown operation");
		}
		if (new Set(policy.allowedOperations).size !== policy.allowedOperations.length) {
			throw new Error("allowedOperations must not contain duplicates");
		}
		allowedOperations = new Set(policy.allowedOperations);
	}
	const allowedPaths = normalizePatterns(policy.allowedPaths, "allowedPaths");
	const deniedPaths = normalizePatterns(policy.deniedPaths, "deniedPaths") ?? [];
	const minFiles = validateLimit(policy.minFiles, "minFiles");
	const maxFiles = validateLimit(policy.maxFiles, "maxFiles");
	const maxChangedBytes = validateLimit(policy.maxChangedBytes, "maxChangedBytes");
	const maxFileBytes = validateLimit(policy.maxFileBytes, "maxFileBytes");
	if (
		allowedPaths === undefined &&
		deniedPaths.length === 0 &&
		allowedOperations === undefined &&
		(minFiles === undefined || minFiles === 0) &&
		maxFiles === undefined &&
		maxChangedBytes === undefined &&
		maxFileBytes === undefined
	) {
		throw new Error("Workspace change discipline policy requires at least one effective gate");
	}
	if (minFiles !== undefined && maxFiles !== undefined && minFiles > maxFiles) {
		throw new Error("Workspace change discipline minFiles must not exceed maxFiles");
	}
	return {
		allowedPaths,
		deniedPaths,
		allowedOperations,
		minFiles,
		maxFiles,
		maxChangedBytes,
		maxFileBytes,
	};
}

function isRevision(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isByteLength(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isMode(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
}

function isNormalizedPath(path: unknown): path is string {
	if (typeof path !== "string" || !path || path.includes("\\") || path.startsWith("/") || path.endsWith("/")) {
		return false;
	}
	return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function assertValidEntry(entry: WorkspacePatchSetEntry, index: number): void {
	if (!isPlainObject(entry)) throw new Error(`Workspace PatchSet entry ${index} must be an object`);
	if (!isNormalizedPath(entry.path)) throw new Error(`Workspace PatchSet entry ${index} has an invalid path`);
	if (entry.patch !== undefined && typeof entry.patch !== "string") {
		throw new Error(`Workspace PatchSet entry ${index} patch must be a string`);
	}
	if (entry.kind !== "create" && entry.kind !== "update" && entry.kind !== "delete") {
		throw new Error(`Workspace PatchSet entry ${index} has an invalid kind`);
	}
	const beforeExists = isRevision(entry.beforeRevision);
	const afterExists = isRevision(entry.afterRevision);
	if (
		(entry.kind === "create" && (entry.beforeRevision !== "missing" || !afterExists)) ||
		(entry.kind === "update" && (!beforeExists || !afterExists)) ||
		(entry.kind === "delete" && (!beforeExists || entry.afterRevision !== "missing"))
	) {
		throw new Error(`Workspace PatchSet entry ${index} has inconsistent revisions`);
	}
	if (
		(entry.kind === "create" &&
			(entry.beforeByteLength !== undefined ||
				!isByteLength(entry.afterByteLength) ||
				entry.beforeMode !== undefined ||
				!isMode(entry.afterMode))) ||
		(entry.kind === "update" &&
			(!isByteLength(entry.beforeByteLength) ||
				!isByteLength(entry.afterByteLength) ||
				!isMode(entry.beforeMode) ||
				!isMode(entry.afterMode))) ||
		(entry.kind === "delete" &&
			(!isByteLength(entry.beforeByteLength) ||
				entry.afterByteLength !== undefined ||
				!isMode(entry.beforeMode) ||
				entry.afterMode !== undefined))
	) {
		throw new Error(`Workspace PatchSet entry ${index} has inconsistent size or mode metadata`);
	}
	if (entry.kind === "delete") {
		if (entry.afterContent !== undefined) {
			throw new Error(`Workspace PatchSet entry ${index} deletion must not contain afterContent`);
		}
	} else {
		if (!Buffer.isBuffer(entry.afterContent) || entry.afterContent.length !== entry.afterByteLength) {
			throw new Error(`Workspace PatchSet entry ${index} afterContent does not match its byte length`);
		}
		if (computeFileRevision(entry.afterContent) !== entry.afterRevision) {
			throw new Error(`Workspace PatchSet entry ${index} afterContent does not match its revision`);
		}
	}
	if (
		entry.kind === "update" &&
		entry.beforeRevision === entry.afterRevision &&
		entry.beforeByteLength !== entry.afterByteLength
	) {
		throw new Error(`Workspace PatchSet entry ${index} with the same revision must have the same byte length`);
	}
	if (
		entry.kind === "update" &&
		entry.beforeRevision === entry.afterRevision &&
		entry.beforeMode === entry.afterMode
	) {
		throw new Error(`Workspace PatchSet entry ${index} does not describe a change`);
	}
}

function normalizePatchSet(patchSet: WorkspacePatchSet): WorkspacePatchSetEntry[] {
	if (!isPlainObject(patchSet) || patchSet.version !== 1) throw new Error("Workspace PatchSet version must be 1");
	if (typeof patchSet.id !== "string" || patchSet.id.trim() === "") {
		throw new Error("Workspace PatchSet id must not be empty");
	}
	if (typeof patchSet.overlayId !== "string" || patchSet.overlayId.trim() === "") {
		throw new Error("Workspace PatchSet overlay id must not be empty");
	}
	if (typeof patchSet.createdAt !== "string" || patchSet.createdAt.trim() === "") {
		throw new Error("Workspace PatchSet creation timestamp must not be empty");
	}
	if (typeof patchSet.baseSnapshotId !== "string" || !isRevision(patchSet.baseSnapshotId)) {
		throw new Error("Workspace PatchSet base snapshot id is invalid");
	}
	if (!Array.isArray(patchSet.entries)) throw new Error("Workspace PatchSet entries must be an array");
	assertDenseArray(patchSet.entries, "Workspace PatchSet entries");
	const entries = [...patchSet.entries];
	entries.forEach(assertValidEntry);
	const paths = entries.map((entry) => entry.path);
	if (new Set(paths).size !== paths.length) throw new Error("Workspace PatchSet contains duplicate paths");
	return entries.sort((left, right) => compareStrings(left.path, right.path));
}

function entryOperations(entry: WorkspacePatchSetEntry): WorkspaceChangeOperation[] {
	if (entry.kind !== "update") return [entry.kind];
	const result: WorkspaceChangeOperation[] = [];
	if (entry.beforeRevision !== entry.afterRevision) result.push("update");
	if (entry.beforeMode !== entry.afterMode) result.push("mode");
	return result;
}

function entryChangedBytes(entry: WorkspacePatchSetEntry): number {
	if (entry.kind === "create") return entry.afterByteLength!;
	if (entry.kind === "delete") return entry.beforeByteLength!;
	if (entry.beforeRevision === entry.afterRevision) return 0;
	return Math.max(entry.beforeByteLength!, entry.afterByteLength!);
}

function compareViolations(
	left: WorkspaceChangeDisciplineViolation,
	right: WorkspaceChangeDisciplineViolation,
): number {
	return (
		compareStrings(left.code, right.code) ||
		compareStrings(left.path ?? "", right.path ?? "") ||
		compareStrings(left.operation ?? "", right.operation ?? "") ||
		(left.actual ?? -1) - (right.actual ?? -1) ||
		(left.limit ?? -1) - (right.limit ?? -1)
	);
}

function evaluateNormalized(patchSet: WorkspacePatchSet, policy: NormalizedPolicy): WorkspaceChangeDisciplineResult {
	const entries = normalizePatchSet(patchSet);
	const kindCounts: Record<WorkspaceOverlayChangeKind, number> = { create: 0, update: 0, delete: 0 };
	const operationCounts: Record<WorkspaceChangeOperation, number> = { create: 0, update: 0, delete: 0, mode: 0 };
	const violations: WorkspaceChangeDisciplineViolation[] = [];
	let changedBytes = 0;

	for (const entry of entries) {
		kindCounts[entry.kind]++;
		const entryBytes = entryChangedBytes(entry);
		changedBytes += entryBytes;
		if (!Number.isSafeInteger(changedBytes)) throw new Error("Workspace PatchSet changed byte total is unsafe");

		if (
			policy.allowedPaths &&
			!policy.allowedPaths.some((pattern) => minimatch(entry.path, pattern, pathMatchOptions))
		) {
			violations.push({ code: "path_not_allowed", path: entry.path });
		}
		if (policy.deniedPaths.some((pattern) => minimatch(entry.path, pattern, pathMatchOptions))) {
			violations.push({ code: "path_denied", path: entry.path });
		}
		for (const operation of entryOperations(entry)) {
			operationCounts[operation]++;
			if (policy.allowedOperations && !policy.allowedOperations.has(operation)) {
				violations.push({ code: "operation_denied", path: entry.path, operation });
			}
		}
		if (policy.maxFileBytes !== undefined && entryBytes > policy.maxFileBytes) {
			violations.push({
				code: "max_file_bytes_exceeded",
				path: entry.path,
				actual: entryBytes,
				limit: policy.maxFileBytes,
			});
		}
	}

	if (policy.minFiles !== undefined && entries.length < policy.minFiles) {
		violations.push({ code: "min_files_not_met", actual: entries.length, limit: policy.minFiles });
	}
	if (policy.maxFiles !== undefined && entries.length > policy.maxFiles) {
		violations.push({ code: "max_files_exceeded", actual: entries.length, limit: policy.maxFiles });
	}
	if (policy.maxChangedBytes !== undefined && changedBytes > policy.maxChangedBytes) {
		violations.push({
			code: "max_changed_bytes_exceeded",
			actual: changedBytes,
			limit: policy.maxChangedBytes,
		});
	}
	violations.sort(compareViolations);
	return {
		version: 1,
		status: violations.length === 0 ? "pass" : "fail",
		patchSetId: patchSet.id,
		baseSnapshotId: patchSet.baseSnapshotId,
		fileCount: entries.length,
		changedBytes,
		kindCounts,
		operationCounts,
		violations,
	};
}

/** Evaluate one already-captured PatchSet without reading or changing either workspace. */
export function evaluateWorkspaceChangeDiscipline(
	patchSet: WorkspacePatchSet,
	policy: WorkspaceChangeDisciplinePolicy,
): WorkspaceChangeDisciplineResult {
	return evaluateNormalized(patchSet, normalizePolicy(policy));
}

function pathDigest(path: string): string {
	return `sha256:${createHash("sha256").update(path).digest("hex")}`;
}

function evidenceViolations(
	violations: readonly WorkspaceChangeDisciplineViolation[],
	pathMode: WorkspaceChangeEvidencePathMode,
): CompletionJsonValue[] {
	return violations.map((violation) => {
		const result: { [key: string]: CompletionJsonValue } = { code: violation.code };
		if (violation.path !== undefined && pathMode === "plain") result.path = violation.path;
		if (violation.path !== undefined && pathMode === "digest") result.pathDigest = pathDigest(violation.path);
		if (violation.operation !== undefined) result.operation = violation.operation;
		if (violation.actual !== undefined) result.actual = violation.actual;
		if (violation.limit !== undefined) result.limit = violation.limit;
		return result;
	});
}

function createEvidence(
	id: string,
	result: WorkspaceChangeDisciplineResult,
	pathMode: WorkspaceChangeEvidencePathMode,
	identityMode: WorkspaceChangeEvidenceIdentityMode,
): CompletionEvidence[] {
	return [
		{
			id: `${id}:workspace-change-discipline`,
			kind: "workspace-change-discipline",
			summary:
				result.status === "pass"
					? `Workspace PatchSet satisfies the configured discipline (${result.fileCount} files)`
					: `Workspace PatchSet violates the configured discipline (${result.violations.length} violations)`,
			...(identityMode === "include" ? { reference: `workspace-patch-set:${result.patchSetId}` } : {}),
			data: {
				version: result.version,
				...(identityMode === "include"
					? { patchSetId: result.patchSetId, baseSnapshotId: result.baseSnapshotId }
					: {}),
				fileCount: result.fileCount,
				changedBytes: result.changedBytes,
				kindCounts: result.kindCounts,
				operationCounts: result.operationCounts,
				violationCount: result.violations.length,
				violations: evidenceViolations(result.violations, pathMode),
			},
		},
	];
}

/**
 * Build an opt-in, foreground verifier for an application-owned WorkspacePatchSet.
 *
 * Policy evaluation performs no I/O and never applies or discards an overlay. The
 * host-supplied resolver may capture a PatchSet. Completion evidence contains no content,
 * patches, identities, per-file revisions, or plain paths unless explicitly requested.
 */
export function createWorkspaceChangeDisciplineVerifier<TContext>(
	options: WorkspaceChangeDisciplineVerifierOptions<TContext>,
): CompletionVerifier<TContext> {
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new Error("Workspace change discipline verifier options must be an object");
	}
	if (typeof options.id !== "string" || options.id.trim() === "") {
		throw new Error("Workspace change discipline verifier id must not be empty");
	}
	if (typeof options.getPatchSet !== "function") {
		throw new Error("Workspace change discipline verifier requires getPatchSet");
	}
	const pathMode = options.evidencePathMode ?? "omit";
	if (pathMode !== "digest" && pathMode !== "omit" && pathMode !== "plain") {
		throw new Error(`Invalid workspace change evidence path mode: ${String(pathMode)}`);
	}
	const identityMode = options.evidenceIdentityMode ?? "omit";
	if (identityMode !== "include" && identityMode !== "omit") {
		throw new Error(`Invalid workspace change evidence identity mode: ${String(identityMode)}`);
	}
	const id = options.id;
	const policy = normalizePolicy(options.policy);
	const getPatchSet = options.getPatchSet;
	return {
		id,
		verify: async ({ context }, signal): Promise<CompletionVerifierOutcome> => {
			if (signal.aborted) {
				return { status: "blocked", summary: "Workspace change discipline verification was interrupted" };
			}
			let removeAbortListener: (() => void) | undefined;
			const abortResolution = new Promise<typeof patchSetResolutionAborted>((resolve) => {
				const onAbort = () => resolve(patchSetResolutionAborted);
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
			let patchSet: WorkspacePatchSet;
			try {
				const resolved = await Promise.race([Promise.resolve(getPatchSet(context, signal)), abortResolution]);
				if (resolved === patchSetResolutionAborted) {
					return { status: "blocked", summary: "Workspace change discipline verification was interrupted" };
				}
				patchSet = resolved;
			} catch (error) {
				if (signal.aborted) {
					return { status: "blocked", summary: "Workspace change discipline verification was interrupted" };
				}
				throw error;
			} finally {
				removeAbortListener?.();
			}
			if (signal.aborted) {
				return { status: "blocked", summary: "Workspace change discipline verification was interrupted" };
			}
			const result = evaluateNormalized(patchSet, policy);
			return {
				status: result.status,
				summary:
					result.status === "pass"
						? "Workspace change discipline passed"
						: `Workspace change discipline failed with ${result.violations.length} violations`,
				evidence: createEvidence(id, result, pathMode, identityMode),
			};
		},
	};
}
