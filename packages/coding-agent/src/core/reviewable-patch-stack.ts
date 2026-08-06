import { createHash, randomUUID } from "node:crypto";
import { computeFileRevision } from "./tools/file-transaction.ts";
import type {
	WorkspaceOverlay,
	WorkspaceOverlayApplyResult,
	WorkspacePatchSet,
	WorkspacePatchSetEntry,
} from "./workspace-overlay.ts";

export const REVIEWABLE_PATCH_STACK_VERSION = 1 as const;

const MAX_LAYERS = 128;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ID_LENGTH = 512;

export type ReviewablePatchLayerStatus = "pending" | "approved" | "rejected";
export type ReviewablePatchStackState = "active" | "applied";

export interface ReviewablePatchLayer {
	readonly id: string;
	readonly title: string;
	readonly summary?: string;
	readonly status: ReviewablePatchLayerStatus;
	readonly fingerprint: string;
	readonly patchSet: WorkspacePatchSet;
	readonly createdAt: string;
	readonly reviewedAt?: string;
	readonly reviewNote?: string;
}

export interface ReviewablePatchStackSnapshot {
	readonly version: typeof REVIEWABLE_PATCH_STACK_VERSION;
	readonly id: string;
	readonly overlayId: string;
	readonly baseSnapshotId: string;
	readonly revision: number;
	readonly state: ReviewablePatchStackState;
	readonly layers: readonly ReviewablePatchLayer[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly apply?: WorkspaceOverlayApplyResult;
}

export interface ReviewablePatchStackOptions {
	readonly id?: string;
	readonly overlayId: string;
	readonly baseSnapshotId: string;
	readonly now?: () => string;
	readonly createId?: () => string;
}

function cloneEntry(entry: WorkspacePatchSetEntry): WorkspacePatchSetEntry {
	return {
		...entry,
		afterContent: entry.afterContent ? Buffer.from(entry.afterContent) : undefined,
	};
}

function clonePatchSet(patchSet: WorkspacePatchSet): WorkspacePatchSet {
	return { ...patchSet, entries: patchSet.entries.map(cloneEntry) };
}

function cloneLayer(layer: ReviewablePatchLayer): ReviewablePatchLayer {
	return { ...layer, patchSet: clonePatchSet(layer.patchSet) };
}

function requireText(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_TEXT_LENGTH) {
		throw new Error(`${label} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
	}
	return normalized;
}

function requireId(value: string, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.length > MAX_ID_LENGTH ||
		value.includes("\0") ||
		/[\r\n]/.test(value)
	) {
		throw new Error(`${label} must be a bounded single-line string`);
	}
	return value;
}

function requireTimestamp(value: string): string {
	if (!Number.isFinite(Date.parse(value))) throw new Error("Patch stack clock returned an invalid timestamp");
	return value;
}

function assertDense(entries: readonly WorkspacePatchSetEntry[]): void {
	for (let index = 0; index < entries.length; index++) {
		if (!(index in entries)) throw new Error("Workspace PatchSet entries must be dense");
	}
}

function assertPatchSet(patchSet: WorkspacePatchSet, overlayId: string, baseSnapshotId: string): void {
	if (
		!patchSet ||
		patchSet.version !== 1 ||
		typeof patchSet.id !== "string" ||
		patchSet.id.trim() === "" ||
		patchSet.overlayId !== overlayId ||
		patchSet.baseSnapshotId !== baseSnapshotId ||
		!Number.isFinite(Date.parse(patchSet.createdAt)) ||
		!Array.isArray(patchSet.entries)
	) {
		throw new Error("Workspace PatchSet does not belong to this patch stack");
	}
	if (patchSet.entries.length === 0) throw new Error("Reviewable patch layers cannot be empty");
	assertDense(patchSet.entries);
	const paths = new Set<string>();
	for (const entry of patchSet.entries) {
		if (
			!entry ||
			(entry.kind !== "create" && entry.kind !== "update" && entry.kind !== "delete") ||
			typeof entry.path !== "string" ||
			entry.path.trim() === "" ||
			paths.has(entry.path)
		) {
			throw new Error("Workspace PatchSet contains an invalid or duplicate path");
		}
		paths.add(entry.path);
		if (entry.kind === "delete" && entry.afterContent !== undefined) {
			throw new Error("Deleted Workspace PatchSet entries cannot contain after content");
		}
		if (entry.kind !== "delete" && !entry.afterContent) {
			throw new Error("Created and updated Workspace PatchSet entries require after content");
		}
		if (entry.afterContent && computeFileRevision(entry.afterContent) !== entry.afterRevision) {
			throw new Error("Workspace PatchSet after content does not match its revision");
		}
	}
}

export function fingerprintWorkspacePatchSet(patchSet: WorkspacePatchSet): string {
	const content = patchSet.entries
		.map((entry) => ({
			kind: entry.kind,
			path: entry.path,
			beforeRevision: entry.beforeRevision,
			afterRevision: entry.afterRevision,
			beforeMode: entry.beforeMode,
			afterMode: entry.afterMode,
			afterContentRevision: entry.afterContent ? computeFileRevision(entry.afterContent) : "missing",
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	return `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
}

/**
 * Keeps review decisions over immutable cumulative Overlay PatchSet snapshots.
 *
 * Each layer records the complete workspace state at one checkpoint. Applying
 * the stack always delegates the final approved PatchSet to WorkspaceOverlay,
 * preserving its conflict preflight, journal, verification, and rollback.
 */
export class ReviewablePatchStack {
	private readonly clock: () => string;
	private readonly createId: () => string;
	private snapshotValue: ReviewablePatchStackSnapshot;
	private applyInFlight = false;

	constructor(options: ReviewablePatchStackOptions) {
		if (!options.overlayId.trim() || !options.baseSnapshotId.trim()) {
			throw new Error("Patch stack requires overlay and base snapshot identifiers");
		}
		this.clock = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? randomUUID;
		const now = requireTimestamp(this.clock());
		const id = requireId(options.id ?? this.createId(), "Patch stack id");
		this.snapshotValue = {
			version: REVIEWABLE_PATCH_STACK_VERSION,
			id,
			overlayId: options.overlayId,
			baseSnapshotId: options.baseSnapshotId,
			revision: 0,
			state: "active",
			layers: [],
			createdAt: now,
			updatedAt: now,
		};
	}

	snapshot(): ReviewablePatchStackSnapshot {
		return {
			...this.snapshotValue,
			layers: this.snapshotValue.layers.map(cloneLayer),
			apply: this.snapshotValue.apply
				? { ...this.snapshotValue.apply, appliedPaths: [...this.snapshotValue.apply.appliedPaths] }
				: undefined,
		};
	}

	private assertActive(): void {
		if (this.applyInFlight) throw new Error("Reviewable patch stack is being applied");
		if (this.snapshotValue.state !== "active") throw new Error("Reviewable patch stack has already been applied");
	}

	private assertRevision(expectedRevision: number): void {
		if (this.snapshotValue.revision !== expectedRevision) {
			throw new Error(
				`Patch stack revision conflict: expected ${expectedRevision}, found ${this.snapshotValue.revision}`,
			);
		}
	}

	capture(
		patchSet: WorkspacePatchSet,
		options: { title: string; summary?: string },
	): ReviewablePatchLayer | undefined {
		this.assertActive();
		assertPatchSet(patchSet, this.snapshotValue.overlayId, this.snapshotValue.baseSnapshotId);
		const fingerprint = fingerprintWorkspacePatchSet(patchSet);
		if (this.snapshotValue.layers.at(-1)?.fingerprint === fingerprint) return undefined;
		if (this.snapshotValue.layers.length >= MAX_LAYERS) {
			throw new Error(`Reviewable patch stack cannot exceed ${MAX_LAYERS} layers`);
		}
		const now = requireTimestamp(this.clock());
		const layerId = requireId(this.createId(), "Patch layer id");
		if (this.snapshotValue.layers.some((layer) => layer.id === layerId)) {
			throw new Error(`Patch layer id already exists: ${layerId}`);
		}
		const layer: ReviewablePatchLayer = {
			id: layerId,
			title: requireText(options.title, "Patch layer title"),
			...(options.summary === undefined ? {} : { summary: requireText(options.summary, "Patch layer summary") }),
			status: "pending",
			fingerprint,
			patchSet: clonePatchSet(patchSet),
			createdAt: now,
		};
		this.snapshotValue = {
			...this.snapshotValue,
			revision: this.snapshotValue.revision + 1,
			layers: [...this.snapshotValue.layers, layer],
			updatedAt: now,
		};
		return cloneLayer(layer);
	}

	review(
		layerId: string,
		status: "approved" | "rejected",
		expectedRevision: number,
		note?: string,
	): ReviewablePatchLayer {
		this.assertActive();
		this.assertRevision(expectedRevision);
		const layer = this.snapshotValue.layers.find((candidate) => candidate.id === layerId);
		if (!layer) throw new Error(`Unknown patch layer: ${layerId}`);
		if (layer.status !== "pending") throw new Error(`Patch layer ${layerId} is already ${layer.status}`);
		const now = requireTimestamp(this.clock());
		const replacement: ReviewablePatchLayer = {
			...layer,
			status,
			reviewedAt: now,
			...(note === undefined ? {} : { reviewNote: requireText(note, "Patch review note") }),
		};
		this.snapshotValue = {
			...this.snapshotValue,
			revision: this.snapshotValue.revision + 1,
			layers: this.snapshotValue.layers.map((candidate) => (candidate.id === layerId ? replacement : candidate)),
			updatedAt: now,
		};
		return cloneLayer(replacement);
	}

	approveAll(expectedRevision: number, note?: string): void {
		this.assertActive();
		this.assertRevision(expectedRevision);
		const pending = this.snapshotValue.layers.filter((layer) => layer.status === "pending");
		if (pending.length === 0) return;
		const now = requireTimestamp(this.clock());
		const reviewNote = note === undefined ? undefined : requireText(note, "Patch review note");
		this.snapshotValue = {
			...this.snapshotValue,
			revision: this.snapshotValue.revision + 1,
			layers: this.snapshotValue.layers.map((layer) =>
				layer.status === "pending"
					? { ...layer, status: "approved", reviewedAt: now, ...(reviewNote ? { reviewNote } : {}) }
					: layer,
			),
			updatedAt: now,
		};
	}

	getApprovedPatchSet(): WorkspacePatchSet {
		this.assertActive();
		if (this.snapshotValue.layers.length === 0) throw new Error("Reviewable patch stack has no layers");
		const rejected = this.snapshotValue.layers.find((layer) => layer.status === "rejected");
		if (rejected) throw new Error(`Patch layer ${rejected.id} was rejected`);
		const pending = this.snapshotValue.layers.find((layer) => layer.status === "pending");
		if (pending) throw new Error(`Patch layer ${pending.id} has not been approved`);
		return clonePatchSet(this.snapshotValue.layers.at(-1)!.patchSet);
	}

	async apply(
		overlay: WorkspaceOverlay,
		expectedRevision: number,
		options: { signal?: AbortSignal } = {},
	): Promise<WorkspaceOverlayApplyResult> {
		this.assertActive();
		this.assertRevision(expectedRevision);
		if (
			overlay.getId() !== this.snapshotValue.overlayId ||
			overlay.getBaseSnapshotId() !== this.snapshotValue.baseSnapshotId
		) {
			throw new Error("Workspace overlay does not belong to this patch stack");
		}
		const now = requireTimestamp(this.clock());
		const patchSet = this.getApprovedPatchSet();
		this.applyInFlight = true;
		try {
			const result = await overlay.applyPatchSet(patchSet, options);
			this.snapshotValue = {
				...this.snapshotValue,
				revision: this.snapshotValue.revision + 1,
				state: "applied",
				updatedAt: now,
				apply: { ...result, appliedPaths: [...result.appliedPaths] },
			};
			return result;
		} finally {
			this.applyInFlight = false;
		}
	}
}
