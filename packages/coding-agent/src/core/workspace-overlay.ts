import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
	access,
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { generateUnifiedPatch } from "./tools/edit-diff.ts";
import {
	atomicWriteFile,
	captureFilePathSnapshot,
	computeFileRevision,
	type FilePathSnapshot,
	type FileRevision,
	type FileRevisionState,
	isMissingPathError,
	readRevisionState,
	revalidateFilePathSnapshot,
} from "./tools/file-transaction.ts";

export type WorkspaceOverlayState = "active" | "applied" | "discarded";
export type WorkspaceOverlayChangeKind = "create" | "update" | "delete";

export interface WorkspaceOverlayFileSnapshot {
	revision: FileRevision;
	byteLength: number;
	mode: number;
}

export interface WorkspaceOverlaySymlinkSnapshot {
	target: string;
}

export interface WorkspaceOverlaySnapshot {
	files: Readonly<Record<string, WorkspaceOverlayFileSnapshot>>;
	symlinks: Readonly<Record<string, WorkspaceOverlaySymlinkSnapshot>>;
}

export interface WorkspaceOverlayChange {
	kind: WorkspaceOverlayChangeKind;
	path: string;
	beforeRevision: FileRevisionState;
	afterRevision: FileRevisionState;
	beforeByteLength?: number;
	afterByteLength?: number;
	beforeMode?: number;
	afterMode?: number;
	/** Unified text patch when both sides are valid UTF-8 text. */
	patch?: string;
}

export interface WorkspacePatchSetEntry extends WorkspaceOverlayChange {
	/** Immutable application payload. Undefined only for deletions. */
	afterContent?: Buffer;
}

export interface WorkspacePatchSet {
	version: 1;
	id: string;
	overlayId: string;
	baseSnapshotId: string;
	createdAt: string;
	entries: readonly WorkspacePatchSetEntry[];
}

export interface WorkspaceOverlayApplyResult {
	applyId: string;
	patchSetId: string;
	appliedPaths: string[];
	state: "applied";
}

export interface WorkspaceOverlayRecoveryReport {
	action: "none" | "rolled_back" | "finalized";
	applyId?: string;
	paths: string[];
}

export interface WorkspaceOverlayOptions {
	workspaceRoot: string;
	/** Owned overlay directory. When omitted, a directory is created under the OS temp root. */
	overlayRoot?: string;
	/** Relative path prefixes omitted from the materialized view and PatchSets. Default: [".git"]. */
	exclude?: readonly string[];
	/** Include a directory-form .git tree. Worktree-style .git files are always rejected. */
	includeGitMetadata?: boolean;
	commitBackend?: WorkspaceOverlayCommitBackend;
}

export interface WorkspaceOverlayCommitBackend {
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: Buffer, options: { flag: "wx"; mode?: number }): Promise<void>;
	mkdir(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	rmdir(path: string): Promise<void>;
	lstat(path: string): Promise<{ mode: number; isFile(): boolean; isSymbolicLink(): boolean }>;
	realpath(path: string): Promise<string>;
	chmod(path: string, mode: number): Promise<void>;
}

export class WorkspaceOverlayError extends Error {
	readonly code:
		| "invalid_overlay"
		| "invalid_path"
		| "snapshot_changed"
		| "workspace_conflict"
		| "apply_failed"
		| "recovery_failed";

	constructor(
		code:
			| "invalid_overlay"
			| "invalid_path"
			| "snapshot_changed"
			| "workspace_conflict"
			| "apply_failed"
			| "recovery_failed",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "WorkspaceOverlayError";
		this.code = code;
	}
}

interface WorkspaceOverlayMetadata {
	version: 1;
	overlayId: string;
	createdAt: string;
	workspaceRoot: string;
	state: Exclude<WorkspaceOverlayState, "discarded">;
	exclude: string[];
	baseSnapshotId: string;
	baseSnapshot: WorkspaceOverlaySnapshot;
}

interface WorkspaceApplyJournalEntry {
	kind: WorkspaceOverlayChangeKind;
	path: string;
	targetPath: string;
	stagingPath?: string;
	backupPath?: string;
	beforeRevision: FileRevisionState;
	afterRevision: FileRevisionState;
}

interface WorkspaceApplyJournal {
	version: 1;
	applyId: string;
	patchSetId: string;
	state: "prepared" | "committed";
	createdDirectories: string[];
	entries: WorkspaceApplyJournalEntry[];
}

interface SnapshotScanResult {
	snapshot: WorkspaceOverlaySnapshot;
	contents: Map<string, Buffer>;
}

interface PreparedApplyEntry extends WorkspaceApplyJournalEntry {
	content?: Buffer;
	mode?: number;
	pathSnapshot: FilePathSnapshot;
}

const METADATA_FILE = "overlay.json";
const JOURNAL_FILE = "apply-journal.json";
const WORKTREE_DIRECTORY = "workspace";

const localCommitBackend: WorkspaceOverlayCommitBackend = {
	readFile: (path) => readFile(path),
	writeFile: (path, content, options) => writeFile(path, content, options),
	mkdir: (path) => mkdir(path, { recursive: false }).then(() => {}),
	rename: (from, to) => rename(from, to),
	remove: (path) => rm(path, { force: true }),
	rmdir: (path) => rmdir(path),
	lstat: (path) => lstat(path),
	realpath: (path) => realpath(path),
	chmod: (path, mode) => chmod(path, mode),
};

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function toPortablePath(path: string): string {
	return path.split(sep).join("/");
}

function normalizeRelativePath(path: string): string {
	const normalized = toPortablePath(path).replace(/^\.\//, "").replace(/\/$/, "");
	const segments = normalized.split("/");
	if (
		!normalized ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
		isAbsolute(normalized)
	) {
		throw new WorkspaceOverlayError("invalid_path", `Invalid workspace-relative path: ${path}`);
	}
	return normalized;
}

function isNormalizedRelativePath(path: string): boolean {
	try {
		return normalizeRelativePath(path) === path;
	} catch {
		return false;
	}
}

function symlinkTargetStaysWithinSnapshot(path: string, target: string): boolean {
	if (!target || isAbsolute(target)) return false;
	const virtualRoot = resolve(sep, "pi-workspace-snapshot");
	const linkPath = resolve(virtualRoot, path);
	return isInside(virtualRoot, resolve(dirname(linkPath), target));
}

function normalizeExclusions(exclude: readonly string[] | undefined, includeGitMetadata: boolean): string[] {
	const values = [...(exclude ?? [])];
	if (!includeGitMetadata) values.push(".git");
	return [...new Set(values.map(normalizeRelativePath))].sort(compareStrings);
}

function pathIsExcluded(path: string, exclusions: readonly string[]): boolean {
	return exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertSeparateRoots(workspaceRoot: string, overlayRoot: string): void {
	if (isInside(workspaceRoot, overlayRoot) || isInside(overlayRoot, workspaceRoot)) {
		throw new WorkspaceOverlayError(
			"invalid_overlay",
			`Workspace and overlay roots must not overlap: ${workspaceRoot} and ${overlayRoot}`,
		);
	}
}

function stableSnapshotValue(snapshot: WorkspaceOverlaySnapshot): unknown {
	return {
		files: Object.entries(snapshot.files)
			.sort(([left], [right]) => compareStrings(left, right))
			.map(([path, file]) => ({ path, ...file })),
		symlinks: Object.entries(snapshot.symlinks)
			.sort(([left], [right]) => compareStrings(left, right))
			.map(([path, link]) => ({ path, target: link.target })),
	};
}

function computeSnapshotId(snapshot: WorkspaceOverlaySnapshot): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(stableSnapshotValue(snapshot)))
		.digest("hex")}`;
}

function snapshotsEqual(left: WorkspaceOverlaySnapshot, right: WorkspaceOverlaySnapshot): boolean {
	return JSON.stringify(stableSnapshotValue(left)) === JSON.stringify(stableSnapshotValue(right));
}

function cloneSnapshot(snapshot: WorkspaceOverlaySnapshot): WorkspaceOverlaySnapshot {
	return {
		files: Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, { ...file }])),
		symlinks: Object.fromEntries(Object.entries(snapshot.symlinks).map(([path, link]) => [path, { ...link }])),
	};
}

function isUtf8(content: Buffer): boolean {
	return Buffer.from(content.toString("utf8"), "utf8").equals(content);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

function validateSnapshot(value: unknown): value is WorkspaceOverlaySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const snapshot = value as Partial<WorkspaceOverlaySnapshot>;
	if (typeof snapshot.files !== "object" || snapshot.files === null) return false;
	if (typeof snapshot.symlinks !== "object" || snapshot.symlinks === null) return false;
	for (const [path, file] of Object.entries(snapshot.files)) {
		if (!isNormalizedRelativePath(path) || typeof file !== "object" || file === null) return false;
		const candidate = file as Partial<WorkspaceOverlayFileSnapshot>;
		if (
			typeof candidate.revision !== "string" ||
			!/^sha256:[0-9a-f]{64}$/.test(candidate.revision) ||
			!Number.isSafeInteger(candidate.byteLength) ||
			(candidate.byteLength ?? -1) < 0 ||
			!Number.isSafeInteger(candidate.mode) ||
			(candidate.mode ?? -1) < 0 ||
			(candidate.mode ?? 0) > 0o777
		) {
			return false;
		}
	}
	return Object.entries(snapshot.symlinks).every(
		([path, link]) =>
			isNormalizedRelativePath(path) &&
			typeof link === "object" &&
			link !== null &&
			typeof (link as { target?: unknown }).target === "string" &&
			symlinkTargetStaysWithinSnapshot(path, (link as { target: string }).target),
	);
}

function parseMetadata(value: unknown): WorkspaceOverlayMetadata {
	if (typeof value !== "object" || value === null) {
		throw new WorkspaceOverlayError("invalid_overlay", "Workspace overlay metadata must be an object");
	}
	const metadata = value as Partial<WorkspaceOverlayMetadata>;
	if (
		metadata.version !== 1 ||
		typeof metadata.overlayId !== "string" ||
		typeof metadata.createdAt !== "string" ||
		typeof metadata.workspaceRoot !== "string" ||
		!isAbsolute(metadata.workspaceRoot) ||
		(metadata.state !== "active" && metadata.state !== "applied") ||
		!Array.isArray(metadata.exclude) ||
		metadata.exclude.some((path) => typeof path !== "string") ||
		typeof metadata.baseSnapshotId !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(metadata.baseSnapshotId) ||
		!validateSnapshot(metadata.baseSnapshot)
	) {
		throw new WorkspaceOverlayError("invalid_overlay", "Workspace overlay metadata is invalid");
	}
	let normalizedExclude: string[];
	try {
		normalizedExclude = [...new Set(metadata.exclude.map(normalizeRelativePath))].sort(compareStrings);
	} catch (error) {
		throw new WorkspaceOverlayError("invalid_overlay", "Workspace overlay exclusions are invalid", {
			cause: error,
		});
	}
	if (JSON.stringify(normalizedExclude) !== JSON.stringify(metadata.exclude)) {
		throw new WorkspaceOverlayError("invalid_overlay", "Workspace overlay exclusions are invalid");
	}
	if (computeSnapshotId(metadata.baseSnapshot) !== metadata.baseSnapshotId) {
		throw new WorkspaceOverlayError("invalid_overlay", "Workspace overlay base snapshot checksum does not match");
	}
	return {
		version: 1,
		overlayId: metadata.overlayId,
		createdAt: metadata.createdAt,
		workspaceRoot: metadata.workspaceRoot,
		state: metadata.state,
		exclude: [...metadata.exclude],
		baseSnapshotId: metadata.baseSnapshotId,
		baseSnapshot: cloneSnapshot(metadata.baseSnapshot),
	};
}

function parseJournal(value: unknown): WorkspaceApplyJournal {
	if (typeof value !== "object" || value === null) {
		throw new WorkspaceOverlayError("recovery_failed", "Workspace apply journal must be an object");
	}
	const journal = value as Partial<WorkspaceApplyJournal>;
	if (
		journal.version !== 1 ||
		typeof journal.applyId !== "string" ||
		typeof journal.patchSetId !== "string" ||
		(journal.state !== "prepared" && journal.state !== "committed") ||
		!Array.isArray(journal.createdDirectories) ||
		journal.createdDirectories.some((path) => typeof path !== "string") ||
		!Array.isArray(journal.entries)
	) {
		throw new WorkspaceOverlayError("recovery_failed", "Workspace apply journal is invalid");
	}
	const entries: WorkspaceApplyJournalEntry[] = journal.entries.map((value) => {
		if (typeof value !== "object" || value === null) {
			throw new WorkspaceOverlayError("recovery_failed", "Workspace apply journal entry is invalid");
		}
		const entry = value as Partial<WorkspaceApplyJournalEntry>;
		const beforeRevision = entry.beforeRevision;
		const afterRevision = entry.afterRevision;
		const beforeRevisionValid =
			beforeRevision === "missing" ||
			(typeof beforeRevision === "string" && /^sha256:[0-9a-f]{64}$/.test(beforeRevision));
		const afterRevisionValid =
			afterRevision === "missing" ||
			(typeof afterRevision === "string" && /^sha256:[0-9a-f]{64}$/.test(afterRevision));
		if (
			(entry.kind !== "create" && entry.kind !== "update" && entry.kind !== "delete") ||
			typeof entry.path !== "string" ||
			typeof entry.targetPath !== "string" ||
			(entry.stagingPath !== undefined && typeof entry.stagingPath !== "string") ||
			(entry.backupPath !== undefined && typeof entry.backupPath !== "string") ||
			!beforeRevisionValid ||
			!afterRevisionValid ||
			(entry.kind === "create" && beforeRevision !== "missing") ||
			(entry.kind !== "create" && beforeRevision === "missing") ||
			(entry.kind === "delete" && afterRevision !== "missing") ||
			(entry.kind !== "delete" && afterRevision === "missing")
		) {
			throw new WorkspaceOverlayError("recovery_failed", "Workspace apply journal entry is invalid");
		}
		return {
			kind: entry.kind,
			path: entry.path,
			targetPath: entry.targetPath,
			stagingPath: entry.stagingPath,
			backupPath: entry.backupPath,
			beforeRevision: beforeRevision as FileRevisionState,
			afterRevision: afterRevision as FileRevisionState,
		};
	});
	return {
		version: 1,
		applyId: journal.applyId,
		patchSetId: journal.patchSetId,
		state: journal.state,
		createdDirectories: [...journal.createdDirectories],
		entries,
	};
}

async function scanSnapshot(
	root: string,
	exclusions: readonly string[],
	options: { captureContents: boolean; validateSymlinksAgainst?: WorkspaceOverlaySnapshot },
): Promise<SnapshotScanResult> {
	const files = Object.create(null) as Record<string, WorkspaceOverlayFileSnapshot>;
	const symlinks = Object.create(null) as Record<string, WorkspaceOverlaySymlinkSnapshot>;
	const contents = new Map<string, Buffer>();
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		if (!directory) continue;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isMissingPathError(error)) continue;
			throw error;
		}
		entries.sort((left, right) => compareStrings(left.name, right.name));
		for (const entry of entries) {
			const absolutePath = join(directory, entry.name);
			const relativePath = normalizeRelativePath(relative(root, absolutePath));
			if (pathIsExcluded(relativePath, exclusions)) continue;
			if (entry.isDirectory()) {
				stack.push(absolutePath);
				continue;
			}
			if (entry.isSymbolicLink()) {
				const target = await readlink(absolutePath);
				if (isAbsolute(target) || !isInside(root, resolve(dirname(absolutePath), target))) {
					throw new WorkspaceOverlayError(
						"invalid_path",
						`Workspace symlink escapes the overlay boundary: ${relativePath} -> ${target}`,
					);
				}
				const expected = options.validateSymlinksAgainst?.symlinks[relativePath];
				if (options.validateSymlinksAgainst && expected?.target !== target) {
					throw new WorkspaceOverlayError(
						"snapshot_changed",
						`Workspace symlink changed inside the overlay: ${relativePath}`,
					);
				}
				symlinks[relativePath] = { target };
				continue;
			}
			if (!entry.isFile()) {
				throw new WorkspaceOverlayError("invalid_path", `Unsupported workspace entry: ${relativePath}`);
			}
			const [content, info] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
			files[relativePath] = {
				revision: computeFileRevision(content),
				byteLength: content.length,
				mode: info.mode & 0o777,
			};
			if (options.captureContents) contents.set(relativePath, content);
		}
	}
	if (options.validateSymlinksAgainst) {
		const expectedPaths = Object.keys(options.validateSymlinksAgainst.symlinks).sort(compareStrings);
		const actualPaths = Object.keys(symlinks).sort(compareStrings);
		if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
			throw new WorkspaceOverlayError("snapshot_changed", "Workspace symlink set changed inside the overlay");
		}
	}
	return { snapshot: { files, symlinks }, contents };
}

async function assertOwnedWorkingDirectory(workingDirectory: string): Promise<void> {
	const info = await lstat(workingDirectory).catch((error: unknown) => {
		if (isMissingPathError(error)) return undefined;
		throw error;
	});
	if (!info?.isDirectory() || info.isSymbolicLink() || (await realpath(workingDirectory)) !== workingDirectory) {
		throw new WorkspaceOverlayError(
			"invalid_overlay",
			"Overlay workspace directory is missing or not a regular owned directory",
		);
	}
}

function createChanges(
	base: WorkspaceOverlaySnapshot,
	current: WorkspaceOverlaySnapshot,
	baseContents: ReadonlyMap<string, Buffer>,
	contents: ReadonlyMap<string, Buffer>,
): WorkspacePatchSetEntry[] {
	const paths = [...new Set([...Object.keys(base.files), ...Object.keys(current.files)])].sort(compareStrings);
	const changes: WorkspacePatchSetEntry[] = [];
	for (const path of paths) {
		const before = base.files[path];
		const after = current.files[path];
		if (before && after && before.revision === after.revision && before.mode === after.mode) continue;
		const kind: WorkspaceOverlayChangeKind = before ? (after ? "update" : "delete") : "create";
		const afterContent = after ? contents.get(path) : undefined;
		if (after && !afterContent) {
			throw new WorkspaceOverlayError("invalid_overlay", `Overlay content is missing for ${path}`);
		}
		let patch: string | undefined;
		const beforeContent = before ? baseContents.get(path) : Buffer.alloc(0);
		if (afterContent && isUtf8(afterContent) && beforeContent && isUtf8(beforeContent)) {
			patch = generateUnifiedPatch(path, beforeContent.toString("utf8"), afterContent.toString("utf8"));
		} else if (!after && beforeContent && isUtf8(beforeContent)) {
			patch = generateUnifiedPatch(path, beforeContent.toString("utf8"), "");
		}
		changes.push({
			kind,
			path,
			beforeRevision: before?.revision ?? "missing",
			afterRevision: after?.revision ?? "missing",
			beforeByteLength: before?.byteLength,
			afterByteLength: after?.byteLength,
			beforeMode: before?.mode,
			afterMode: after?.mode,
			patch,
			afterContent: afterContent ? Buffer.from(afterContent) : undefined,
		});
	}
	return changes;
}

function clonePatchSet(patchSet: WorkspacePatchSet): WorkspacePatchSet {
	return {
		...patchSet,
		entries: patchSet.entries.map((entry) => ({
			...entry,
			afterContent: entry.afterContent ? Buffer.from(entry.afterContent) : undefined,
		})),
	};
}

function patchSetSignature(patchSet: WorkspacePatchSet): string {
	return JSON.stringify(
		patchSet.entries.map((entry) => ({
			kind: entry.kind,
			path: entry.path,
			beforeRevision: entry.beforeRevision,
			afterRevision: entry.afterRevision,
			beforeMode: entry.beforeMode,
			afterMode: entry.afterMode,
			contentRevision: entry.afterContent ? computeFileRevision(entry.afterContent) : "missing",
		})),
	);
}

/**
 * Explicit copy-on-write workspace boundary for SDK hosts.
 *
 * The overlay never activates implicitly. Hosts point tools and commands at
 * `workingDirectory`, inspect a complete PatchSet, then explicitly apply or
 * discard it. Applying preflights every base revision and compensates any
 * partial filesystem mutation before returning an error.
 */
export class WorkspaceOverlay {
	private readonly overlayRoot: string;
	private readonly workingDirectory: string;
	private readonly backend: WorkspaceOverlayCommitBackend;
	private metadata: WorkspaceOverlayMetadata;
	private state: WorkspaceOverlayState;

	private constructor(
		overlayRoot: string,
		metadata: WorkspaceOverlayMetadata,
		backend: WorkspaceOverlayCommitBackend,
	) {
		this.overlayRoot = overlayRoot;
		this.workingDirectory = join(overlayRoot, WORKTREE_DIRECTORY);
		this.metadata = metadata;
		this.state = metadata.state;
		this.backend = backend;
	}

	static async open(options: WorkspaceOverlayOptions): Promise<{
		overlay: WorkspaceOverlay;
		recovery: WorkspaceOverlayRecoveryReport;
	}> {
		const requestedWorkspaceRoot = resolve(options.workspaceRoot);
		const workspaceRoot = await realpath(requestedWorkspaceRoot);
		let overlayRoot: string;
		if (options.overlayRoot) {
			const requestedOverlayRoot = resolve(options.overlayRoot);
			const overlayRootSnapshot = await captureFilePathSnapshot(
				requestedOverlayRoot,
				"workspace overlay root",
				undefined,
				realpath,
				true,
			);
			overlayRoot = overlayRootSnapshot.targetPath;
			assertSeparateRoots(workspaceRoot, overlayRoot);
			await mkdir(overlayRoot, { recursive: true });
			await revalidateFilePathSnapshot(overlayRootSnapshot, "workspace overlay root", undefined, realpath);
		} else {
			overlayRoot = await mkdtemp(join(tmpdir(), "pi-workspace-overlay-"));
			try {
				overlayRoot = await realpath(overlayRoot);
				assertSeparateRoots(workspaceRoot, overlayRoot);
			} catch (error) {
				await rm(overlayRoot, { recursive: true, force: true });
				throw error;
			}
		}
		const metadataPath = join(overlayRoot, METADATA_FILE);
		let metadata: WorkspaceOverlayMetadata;
		let cleanupFailedInitialization = false;
		try {
			if (await exists(metadataPath)) {
				const metadataInfo = await lstat(metadataPath);
				if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
					throw new WorkspaceOverlayError("invalid_overlay", "Workspace overlay metadata must be a regular file");
				}
				metadata = parseMetadata(JSON.parse(await readFile(metadataPath, "utf8")) as unknown);
				if ((await realpath(metadata.workspaceRoot)) !== workspaceRoot) {
					throw new WorkspaceOverlayError("invalid_overlay", "Overlay belongs to a different workspace root");
				}
				await assertOwnedWorkingDirectory(join(overlayRoot, WORKTREE_DIRECTORY));
			} else {
				const existing = await readdir(overlayRoot);
				if (existing.length > 0) {
					throw new WorkspaceOverlayError("invalid_overlay", "New overlay root must be empty");
				}
				cleanupFailedInitialization = true;
				const gitPath = join(workspaceRoot, ".git");
				if (options.includeGitMetadata && (await exists(gitPath)) && (await lstat(gitPath)).isFile()) {
					throw new WorkspaceOverlayError(
						"invalid_overlay",
						"includeGitMetadata cannot copy a worktree-style .git file because it points outside the overlay",
					);
				}
				const exclude = normalizeExclusions(options.exclude, options.includeGitMetadata ?? false);
				const source = await scanSnapshot(workspaceRoot, exclude, { captureContents: false });
				const workingDirectory = join(overlayRoot, WORKTREE_DIRECTORY);
				await cp(workspaceRoot, workingDirectory, {
					recursive: true,
					force: false,
					errorOnExist: true,
					preserveTimestamps: true,
					verbatimSymlinks: true,
					filter: (sourcePath) => {
						const relativePath = relative(workspaceRoot, sourcePath);
						return relativePath === "" || !pathIsExcluded(toPortablePath(relativePath), exclude);
					},
				});
				const copied = await scanSnapshot(workingDirectory, exclude, {
					captureContents: false,
					validateSymlinksAgainst: source.snapshot,
				});
				if (!snapshotsEqual(source.snapshot, copied.snapshot)) {
					throw new WorkspaceOverlayError(
						"snapshot_changed",
						"Workspace changed while the overlay snapshot was being materialized",
					);
				}
				metadata = {
					version: 1,
					overlayId: randomUUID(),
					createdAt: new Date().toISOString(),
					workspaceRoot,
					state: "active",
					exclude,
					baseSnapshotId: computeSnapshotId(source.snapshot),
					baseSnapshot: source.snapshot,
				};
				await atomicWriteFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
			}
			const overlay = new WorkspaceOverlay(overlayRoot, metadata, options.commitBackend ?? localCommitBackend);
			const recovery = await overlay.recoverPendingApply();
			cleanupFailedInitialization = false;
			return { overlay, recovery };
		} catch (error) {
			if (cleanupFailedInitialization) await rm(overlayRoot, { recursive: true, force: true });
			throw error;
		}
	}

	getId(): string {
		return this.metadata.overlayId;
	}

	getRoot(): string {
		return this.overlayRoot;
	}

	getWorkspaceRoot(): string {
		return this.metadata.workspaceRoot;
	}

	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	getState(): WorkspaceOverlayState {
		return this.state;
	}

	getBaseSnapshot(): WorkspaceOverlaySnapshot {
		return cloneSnapshot(this.metadata.baseSnapshot);
	}

	getBaseSnapshotId(): string {
		return this.metadata.baseSnapshotId;
	}

	private assertActive(): void {
		if (this.state !== "active") {
			throw new WorkspaceOverlayError("invalid_overlay", `Workspace overlay is ${this.state}`);
		}
	}

	async createPatchSet(): Promise<WorkspacePatchSet> {
		this.assertActive();
		await assertOwnedWorkingDirectory(this.workingDirectory);
		const current = await scanSnapshot(this.workingDirectory, this.metadata.exclude, {
			captureContents: true,
			validateSymlinksAgainst: this.metadata.baseSnapshot,
		});
		const baseContents = new Map<string, Buffer>();
		for (const [path, snapshot] of Object.entries(this.metadata.baseSnapshot.files)) {
			try {
				const content = await this.backend.readFile(this.resolveTargetPath(path));
				if (computeFileRevision(content) === snapshot.revision) baseContents.set(path, content);
			} catch (error) {
				if (!isMissingPathError(error)) throw error;
			}
		}
		return {
			version: 1,
			id: randomUUID(),
			overlayId: this.metadata.overlayId,
			baseSnapshotId: this.metadata.baseSnapshotId,
			createdAt: new Date().toISOString(),
			entries: createChanges(this.metadata.baseSnapshot, current.snapshot, baseContents, current.contents),
		};
	}

	private resolveTargetPath(relativePath: string): string {
		const normalized = normalizeRelativePath(relativePath);
		const targetPath = resolve(this.metadata.workspaceRoot, normalized);
		if (!isInside(this.metadata.workspaceRoot, targetPath)) {
			throw new WorkspaceOverlayError("invalid_path", `Patch path escapes workspace: ${relativePath}`);
		}
		return targetPath;
	}

	private async collectMissingDirectories(paths: readonly string[]): Promise<string[]> {
		const missing = new Set<string>();
		for (const path of paths) {
			let candidate = dirname(path);
			while (candidate !== this.metadata.workspaceRoot && isInside(this.metadata.workspaceRoot, candidate)) {
				if (await exists(candidate)) break;
				missing.add(candidate);
				candidate = dirname(candidate);
			}
		}
		return [...missing].sort((left, right) => left.split(sep).length - right.split(sep).length);
	}

	private async prepareApply(
		patchSet: WorkspacePatchSet,
		applyId: string,
	): Promise<{
		entries: PreparedApplyEntry[];
		createdDirectories: string[];
	}> {
		const entries: PreparedApplyEntry[] = [];
		for (const entry of patchSet.entries) {
			const targetPath = this.resolveTargetPath(entry.path);
			const pathSnapshot = await captureFilePathSnapshot(
				targetPath,
				entry.path,
				[this.metadata.workspaceRoot],
				this.backend.realpath,
				false,
			);
			await revalidateFilePathSnapshot(
				pathSnapshot,
				entry.path,
				[this.metadata.workspaceRoot],
				this.backend.realpath,
			);
			const current = await readRevisionState(targetPath, this.backend.readFile);
			if (current.revision !== entry.beforeRevision) {
				throw new WorkspaceOverlayError(
					"workspace_conflict",
					`Workspace changed for ${entry.path}: expected ${entry.beforeRevision}, found ${current.revision}`,
				);
			}
			if (entry.beforeRevision !== "missing" && entry.beforeMode !== undefined) {
				const info = await this.backend.lstat(targetPath);
				if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== entry.beforeMode) {
					throw new WorkspaceOverlayError(
						"workspace_conflict",
						`Workspace file mode or type changed for ${entry.path}`,
					);
				}
			}
			const suffix = `${process.pid}-${applyId}`;
			entries.push({
				kind: entry.kind,
				path: entry.path,
				targetPath,
				stagingPath:
					entry.kind === "delete"
						? undefined
						: join(dirname(targetPath), `.${basename(targetPath)}.pi-overlay-${suffix}`),
				backupPath:
					entry.beforeRevision === "missing"
						? undefined
						: join(dirname(targetPath), `.${basename(targetPath)}.pi-overlay-backup-${suffix}`),
				beforeRevision: entry.beforeRevision,
				afterRevision: entry.afterRevision,
				content: entry.afterContent ? Buffer.from(entry.afterContent) : undefined,
				mode: entry.afterMode,
				pathSnapshot,
			});
		}
		for (const entry of entries) {
			for (const artifactPath of [entry.stagingPath, entry.backupPath]) {
				if (artifactPath && (await this.lstatIfExists(artifactPath))) {
					throw new WorkspaceOverlayError(
						"workspace_conflict",
						`Workspace apply artifact path already exists for ${entry.path}`,
					);
				}
			}
		}
		return {
			entries,
			createdDirectories: await this.collectMissingDirectories(
				entries.filter((entry) => entry.stagingPath).map((entry) => entry.targetPath),
			),
		};
	}

	private validateJournalPaths(journal: WorkspaceApplyJournal): void {
		if (new Set(journal.createdDirectories).size !== journal.createdDirectories.length) {
			throw new WorkspaceOverlayError("recovery_failed", "Apply journal contains duplicate directory paths");
		}
		const operationPaths = new Set<string>();
		for (const directory of journal.createdDirectories) {
			if (
				directory === this.metadata.workspaceRoot ||
				!isInside(this.metadata.workspaceRoot, directory) ||
				!journal.entries.some((entry) => entry.stagingPath && isInside(directory, entry.targetPath))
			) {
				throw new WorkspaceOverlayError("recovery_failed", "Apply journal contains an unsafe directory path");
			}
		}
		for (const entry of journal.entries) {
			let expectedTargetPath: string;
			try {
				expectedTargetPath = resolve(this.metadata.workspaceRoot, normalizeRelativePath(entry.path));
			} catch (error) {
				throw new WorkspaceOverlayError("recovery_failed", "Apply journal contains an unsafe relative path", {
					cause: error,
				});
			}
			if (
				entry.targetPath !== expectedTargetPath ||
				entry.targetPath === this.metadata.workspaceRoot ||
				!isInside(this.metadata.workspaceRoot, entry.targetPath)
			) {
				throw new WorkspaceOverlayError("recovery_failed", "Apply journal contains an unsafe target path");
			}
			const targetName = basename(entry.targetPath);
			const stagingName = entry.stagingPath ? basename(entry.stagingPath) : undefined;
			const backupName = entry.backupPath ? basename(entry.backupPath) : undefined;
			if (
				(entry.stagingPath !== undefined &&
					(dirname(entry.stagingPath) !== dirname(entry.targetPath) ||
						stagingName === targetName ||
						!stagingName?.startsWith(`.${targetName}.pi-overlay-`) ||
						stagingName.startsWith(`.${targetName}.pi-overlay-backup-`) ||
						!stagingName.endsWith(`-${journal.applyId}`))) ||
				(entry.backupPath !== undefined &&
					(dirname(entry.backupPath) !== dirname(entry.targetPath) ||
						backupName === targetName ||
						!backupName?.startsWith(`.${targetName}.pi-overlay-backup-`) ||
						!backupName.endsWith(`-${journal.applyId}`))) ||
				(entry.stagingPath !== undefined && entry.stagingPath === entry.backupPath)
			) {
				throw new WorkspaceOverlayError("recovery_failed", "Apply journal staging path is not target-local");
			}
			for (const operationPath of [entry.targetPath, entry.stagingPath, entry.backupPath]) {
				if (!operationPath) continue;
				if (operationPaths.has(operationPath)) {
					throw new WorkspaceOverlayError("recovery_failed", "Apply journal contains duplicate operation paths");
				}
				operationPaths.add(operationPath);
			}
		}
	}

	private async revalidatePath(path: string, displayPath: string): Promise<void> {
		const snapshot = await captureFilePathSnapshot(
			path,
			displayPath,
			[this.metadata.workspaceRoot],
			this.backend.realpath,
			false,
		);
		await revalidateFilePathSnapshot(snapshot, displayPath, [this.metadata.workspaceRoot], this.backend.realpath);
	}

	private async revalidatePreparedEntry(entry: PreparedApplyEntry): Promise<void> {
		await revalidateFilePathSnapshot(
			entry.pathSnapshot,
			entry.path,
			[this.metadata.workspaceRoot],
			this.backend.realpath,
		);
	}

	private async revalidateJournalEntry(entry: WorkspaceApplyJournalEntry): Promise<void> {
		await this.revalidatePath(entry.targetPath, entry.path);
		if (entry.stagingPath) await this.revalidatePath(entry.stagingPath, `${entry.path} staging file`);
		if (entry.backupPath) await this.revalidatePath(entry.backupPath, `${entry.path} backup file`);
	}

	private async lstatIfExists(
		path: string,
	): Promise<{ mode: number; isFile(): boolean; isSymbolicLink(): boolean } | undefined> {
		try {
			return await this.backend.lstat(path);
		} catch (error) {
			if (isMissingPathError(error)) return undefined;
			throw error;
		}
	}

	private async assertRecoveryArtifact(
		path: string,
		expectedRevision: FileRevisionState,
		displayPath: string,
	): Promise<boolean> {
		const info = await this.lstatIfExists(path);
		if (!info) return false;
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new WorkspaceOverlayError("recovery_failed", `${displayPath} is not a regular recovery file`);
		}
		const current = await readRevisionState(path, this.backend.readFile);
		if (current.revision !== expectedRevision) {
			throw new WorkspaceOverlayError(
				"recovery_failed",
				`${displayPath} changed: expected ${expectedRevision}, found ${current.revision}`,
			);
		}
		return true;
	}

	private async writeJournal(journal: WorkspaceApplyJournal): Promise<void> {
		await atomicWriteFile(join(this.overlayRoot, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`);
	}

	private async removeEmptyDirectories(directories: readonly string[]): Promise<void> {
		for (const directory of [...directories].reverse()) {
			try {
				await this.revalidatePath(directory, "created workspace directory");
				await this.backend.rmdir(directory);
			} catch (error) {
				if (
					isMissingPathError(error) ||
					(typeof error === "object" && error !== null && "code" in error && error.code === "ENOTEMPTY")
				) {
					continue;
				}
				throw error;
			}
		}
	}

	private async rollbackJournal(journal: WorkspaceApplyJournal): Promise<void> {
		this.validateJournalPaths(journal);
		for (const entry of [...journal.entries].reverse()) {
			await this.revalidateJournalEntry(entry);
			const backupExists = entry.backupPath
				? await this.assertRecoveryArtifact(entry.backupPath, entry.beforeRevision, `${entry.path} backup`)
				: false;
			if (backupExists && entry.backupPath) {
				const current = await readRevisionState(entry.targetPath, this.backend.readFile);
				if (current.revision === entry.beforeRevision) {
					// The target is already original. Leave an unrelated artifact untouched.
				} else if (current.revision !== "missing" && current.revision !== entry.afterRevision) {
					throw new WorkspaceOverlayError(
						"recovery_failed",
						`Cannot roll back ${entry.path}: target changed after the overlay mutation`,
					);
				} else {
					await this.backend.remove(entry.targetPath);
					await this.backend.rename(entry.backupPath, entry.targetPath);
				}
			} else {
				const current = await readRevisionState(entry.targetPath, this.backend.readFile);
				if (entry.beforeRevision === "missing") {
					if (current.revision === entry.afterRevision) await this.backend.remove(entry.targetPath);
					else if (current.revision !== "missing") {
						throw new WorkspaceOverlayError(
							"recovery_failed",
							`Cannot roll back ${entry.path}: target no longer matches the staged create`,
						);
					}
				} else if (current.revision !== entry.beforeRevision) {
					throw new WorkspaceOverlayError(
						"recovery_failed",
						`Cannot roll back ${entry.path}: original backup is missing`,
					);
				}
			}
			if (
				entry.stagingPath &&
				(await this.assertRecoveryArtifact(entry.stagingPath, entry.afterRevision, `${entry.path} staging file`))
			) {
				await this.backend.remove(entry.stagingPath);
			}
		}
		await this.removeEmptyDirectories(journal.createdDirectories);
		await rm(join(this.overlayRoot, JOURNAL_FILE), { force: true });
	}

	private async finalizeJournal(journal: WorkspaceApplyJournal): Promise<void> {
		this.validateJournalPaths(journal);
		const nextMetadata: WorkspaceOverlayMetadata = { ...this.metadata, state: "applied" };
		await atomicWriteFile(join(this.overlayRoot, METADATA_FILE), `${JSON.stringify(nextMetadata, null, 2)}\n`);
		this.metadata = nextMetadata;
		this.state = "applied";
		for (const entry of journal.entries) {
			await this.revalidateJournalEntry(entry);
			if (
				entry.backupPath &&
				(await this.assertRecoveryArtifact(entry.backupPath, entry.beforeRevision, `${entry.path} backup`))
			) {
				await this.backend.remove(entry.backupPath);
			}
			if (
				entry.stagingPath &&
				(await this.assertRecoveryArtifact(entry.stagingPath, entry.afterRevision, `${entry.path} staging file`))
			) {
				await this.backend.remove(entry.stagingPath);
			}
		}
		await rm(join(this.overlayRoot, JOURNAL_FILE), { force: true });
	}

	async recoverPendingApply(): Promise<WorkspaceOverlayRecoveryReport> {
		const journalPath = join(this.overlayRoot, JOURNAL_FILE);
		if (!(await exists(journalPath))) return { action: "none", paths: [] };
		const journalInfo = await lstat(journalPath);
		if (!journalInfo.isFile() || journalInfo.isSymbolicLink()) {
			throw new WorkspaceOverlayError("recovery_failed", "Workspace apply journal must be a regular file");
		}
		const journal = parseJournal(JSON.parse(await readFile(journalPath, "utf8")) as unknown);
		try {
			if (journal.state === "committed") {
				await this.finalizeJournal(journal);
				return { action: "finalized", applyId: journal.applyId, paths: journal.entries.map((entry) => entry.path) };
			}
			await this.rollbackJournal(journal);
			return { action: "rolled_back", applyId: journal.applyId, paths: journal.entries.map((entry) => entry.path) };
		} catch (error) {
			throw new WorkspaceOverlayError("recovery_failed", "Workspace overlay recovery failed", { cause: error });
		}
	}

	async applyPatchSet(
		patchSet: WorkspacePatchSet,
		options: { signal?: AbortSignal } = {},
	): Promise<WorkspaceOverlayApplyResult> {
		this.assertActive();
		if (
			patchSet.version !== 1 ||
			patchSet.overlayId !== this.metadata.overlayId ||
			patchSet.baseSnapshotId !== this.metadata.baseSnapshotId
		) {
			throw new WorkspaceOverlayError("invalid_overlay", "PatchSet does not belong to this overlay snapshot");
		}
		if (patchSet.entries.length === 0) {
			throw new WorkspaceOverlayError("invalid_overlay", "Cannot apply an empty Workspace PatchSet");
		}
		const currentPatchSet = await this.createPatchSet();
		if (patchSetSignature(patchSet) !== patchSetSignature(currentPatchSet)) {
			throw new WorkspaceOverlayError("snapshot_changed", "Overlay changed after this PatchSet was created");
		}
		const throwIfAborted = (): void => {
			if (options.signal?.aborted) throw new WorkspaceOverlayError("apply_failed", "Workspace apply was aborted");
		};
		throwIfAborted();
		const applyId = randomUUID();
		const prepared = await this.prepareApply(clonePatchSet(patchSet), applyId);
		const journal: WorkspaceApplyJournal = {
			version: 1,
			applyId,
			patchSetId: patchSet.id,
			state: "prepared",
			createdDirectories: [],
			entries: prepared.entries.map(({ content: _content, mode: _mode, ...entry }) => entry),
		};
		await this.writeJournal(journal);
		let committed = false;
		try {
			for (const directory of prepared.createdDirectories) {
				throwIfAborted();
				await this.revalidatePath(directory, "created workspace directory");
				await this.backend.mkdir(directory);
				journal.createdDirectories.push(directory);
				await this.writeJournal(journal);
			}
			for (const entry of prepared.entries) {
				throwIfAborted();
				await this.revalidatePreparedEntry(entry);
				if (entry.stagingPath && entry.content) {
					await this.backend.writeFile(entry.stagingPath, entry.content, { flag: "wx", mode: entry.mode });
					if (entry.mode !== undefined) await this.backend.chmod(entry.stagingPath, entry.mode);
				}
			}
			for (const entry of prepared.entries) {
				throwIfAborted();
				await this.revalidatePreparedEntry(entry);
				const current = await readRevisionState(entry.targetPath, this.backend.readFile);
				if (current.revision !== entry.beforeRevision) {
					throw new WorkspaceOverlayError(
						"workspace_conflict",
						`Workspace changed during apply for ${entry.path}: expected ${entry.beforeRevision}, found ${current.revision}`,
					);
				}
				if (entry.backupPath) {
					if (await this.lstatIfExists(entry.backupPath)) {
						throw new WorkspaceOverlayError(
							"workspace_conflict",
							`Workspace backup path already exists for ${entry.path}`,
						);
					}
					await this.backend.rename(entry.targetPath, entry.backupPath);
					await this.assertRecoveryArtifact(entry.backupPath, entry.beforeRevision, `${entry.path} backup`);
				}
				if (entry.stagingPath) await this.backend.rename(entry.stagingPath, entry.targetPath);
			}
			for (const entry of prepared.entries) {
				await this.revalidatePreparedEntry(entry);
				const applied = await readRevisionState(entry.targetPath, this.backend.readFile);
				if (applied.revision !== entry.afterRevision) {
					throw new WorkspaceOverlayError(
						"apply_failed",
						`Workspace apply verification failed for ${entry.path}: expected ${entry.afterRevision}, found ${applied.revision}`,
					);
				}
				if (entry.afterRevision !== "missing" && entry.mode !== undefined) {
					const info = await this.backend.lstat(entry.targetPath);
					if ((info.mode & 0o777) !== entry.mode) {
						throw new WorkspaceOverlayError(
							"apply_failed",
							`Workspace apply mode verification failed for ${entry.path}`,
						);
					}
				}
			}
			await this.writeJournal({ ...journal, state: "committed" });
			committed = true;
			await this.finalizeJournal({ ...journal, state: "committed" });
			return {
				applyId,
				patchSetId: patchSet.id,
				appliedPaths: patchSet.entries.map((entry) => entry.path),
				state: "applied",
			};
		} catch (error) {
			if (committed) {
				throw new WorkspaceOverlayError(
					"recovery_failed",
					"Workspace PatchSet committed but cleanup is incomplete; reopen the overlay to recover",
					{ cause: error },
				);
			}
			try {
				await this.rollbackJournal(journal);
			} catch (rollbackError) {
				throw new WorkspaceOverlayError(
					"recovery_failed",
					"Workspace apply failed and automatic rollback could not restore the workspace",
					{ cause: new AggregateError([error, rollbackError]) },
				);
			}
			throw new WorkspaceOverlayError("apply_failed", "Workspace PatchSet apply failed and was rolled back", {
				cause: error,
			});
		}
	}

	async discard(): Promise<void> {
		if (this.state === "discarded") return;
		if (await exists(join(this.overlayRoot, JOURNAL_FILE))) {
			throw new WorkspaceOverlayError("invalid_overlay", "Cannot discard an overlay with pending recovery work");
		}
		await rm(this.overlayRoot, { recursive: true, force: true });
		this.state = "discarded";
	}
}
