/**
 * Git Checkpoint Extension
 *
 * Persists tracked worktree and index checkpoints at each turn so /fork can
 * restore the repository to that point. Untracked files are never modified.
 */
import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "git-checkpoint-v1";
const CHECKPOINT_VERSION = 1;
const HASH_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

interface GitCheckpointData {
	version: 1;
	purpose: "turn" | "safety";
	anchorEntryId: string;
	repositoryRoot: string;
	head: string;
	indexTree: string;
	worktreeCommit: string;
	ref: string;
	createdAt: string;
}

interface GitCheckpointEntry extends CustomEntry<GitCheckpointData> {
	customType: typeof CUSTOM_TYPE;
	data: GitCheckpointData;
}

interface RestoreResult {
	cancel?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCheckpointData(value: unknown): value is GitCheckpointData {
	if (!isRecord(value)) return false;
	return (
		value.version === CHECKPOINT_VERSION &&
		(value.purpose === "turn" || value.purpose === "safety") &&
		typeof value.anchorEntryId === "string" &&
		typeof value.repositoryRoot === "string" &&
		typeof value.head === "string" &&
		HASH_PATTERN.test(value.head) &&
		typeof value.indexTree === "string" &&
		HASH_PATTERN.test(value.indexTree) &&
		typeof value.worktreeCommit === "string" &&
		HASH_PATTERN.test(value.worktreeCommit) &&
		typeof value.ref === "string" &&
		value.ref.startsWith("refs/pi/checkpoints/") &&
		typeof value.createdAt === "string"
	);
}

function isCheckpointEntry(entry: SessionEntry): entry is GitCheckpointEntry {
	return entry.type === "custom" && entry.customType === CUSTOM_TYPE && isCheckpointData(entry.data);
}

function sanitizeRefComponent(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/(?:^[-.]|[.]$)/g, "_");
	return sanitized || "unknown";
}

function findCheckpoint(
	event: SessionBeforeForkEvent,
	ctx: ExtensionContext,
	turnCheckpoints: Map<string, GitCheckpointData>,
): GitCheckpointData | undefined {
	if (event.position === "at") {
		const exact = turnCheckpoints.get(event.entryId);
		if (exact) return exact;
	}

	const branch = ctx.sessionManager.getBranch(event.entryId);
	const startIndex = event.position === "before" ? branch.length - 2 : branch.length - 1;
	for (let index = startIndex; index >= 0; index--) {
		const entry = branch[index];
		if (isCheckpointEntry(entry) && entry.data.purpose === "turn") return entry.data;
	}
	return undefined;
}

export default function gitCheckpointExtension(pi: ExtensionAPI): void {
	const turnCheckpoints = new Map<string, GitCheckpointData>();
	let checkpointCounter = 0;
	let safetyCounter = 0;

	async function git(
		args: string[],
		repositoryRoot?: string,
	): Promise<{ stdout: string; stderr: string; code: number }> {
		return pi.exec("git", args, repositoryRoot ? { cwd: repositoryRoot } : undefined);
	}

	async function persistCheckpoint(
		ctx: ExtensionContext,
		purpose: GitCheckpointData["purpose"],
		anchorEntryId: string,
	): Promise<GitCheckpointData | undefined> {
		const rootResult = await git(["rev-parse", "--show-toplevel"], ctx.cwd);
		if (rootResult.code !== 0) return undefined;
		const repositoryRoot = rootResult.stdout.trim();

		const headResult = await git(["rev-parse", "HEAD"], repositoryRoot);
		const indexResult = await git(["write-tree"], repositoryRoot);
		const worktreeResult = await git(
			["stash", "create", `pi ${purpose} checkpoint for ${anchorEntryId}`],
			repositoryRoot,
		);
		if (headResult.code !== 0 || indexResult.code !== 0 || worktreeResult.code !== 0) {
			throw new Error(
				`Unable to create Git checkpoint: ${headResult.stderr || indexResult.stderr || worktreeResult.stderr}`,
			);
		}

		const head = headResult.stdout.trim();
		const indexTree = indexResult.stdout.trim();
		const worktreeCommit = worktreeResult.stdout.trim() || head;
		if (!HASH_PATTERN.test(head) || !HASH_PATTERN.test(indexTree) || !HASH_PATTERN.test(worktreeCommit)) {
			throw new Error("Git returned an invalid object ID while creating a checkpoint");
		}

		const sessionComponent = sanitizeRefComponent(ctx.sessionManager.getSessionId());
		const anchorComponent = sanitizeRefComponent(anchorEntryId);
		const suffix =
			purpose === "turn"
				? `turn-${Date.now()}-${checkpointCounter++}-${anchorComponent}`
				: `safety-${Date.now()}-${safetyCounter++}-${anchorComponent}`;
		const ref = `refs/pi/checkpoints/${sessionComponent}/${suffix}`;
		const refResult = await git(["update-ref", ref, worktreeCommit], repositoryRoot);
		if (refResult.code !== 0) {
			throw new Error(`Unable to persist Git checkpoint: ${refResult.stderr}`);
		}

		const checkpoint: GitCheckpointData = {
			version: CHECKPOINT_VERSION,
			purpose,
			anchorEntryId,
			repositoryRoot,
			head,
			indexTree,
			worktreeCommit,
			ref,
			createdAt: new Date().toISOString(),
		};
		pi.appendEntry(CUSTOM_TYPE, checkpoint);
		if (purpose === "turn") turnCheckpoints.set(anchorEntryId, checkpoint);
		return checkpoint;
	}

	async function applyTrackedState(checkpoint: GitCheckpointData): Promise<void> {
		const worktreeResult = await git(["read-tree", "--reset", "-u", checkpoint.ref], checkpoint.repositoryRoot);
		if (worktreeResult.code !== 0) {
			throw new Error(`Unable to restore tracked files: ${worktreeResult.stderr}`);
		}

		const indexResult = await git(["read-tree", checkpoint.indexTree], checkpoint.repositoryRoot);
		if (indexResult.code !== 0) {
			throw new Error(`Unable to restore the index: ${indexResult.stderr}`);
		}

		const worktreeVerification = await git(["diff", "--quiet", checkpoint.ref, "--"], checkpoint.repositoryRoot);
		const indexVerification = await git(
			["diff", "--cached", "--quiet", checkpoint.indexTree, "--"],
			checkpoint.repositoryRoot,
		);
		if (worktreeVerification.code !== 0 || indexVerification.code !== 0) {
			throw new Error("Git checkpoint verification failed after restore");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		turnCheckpoints.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (isCheckpointEntry(entry) && entry.data.purpose === "turn") {
				turnCheckpoints.set(entry.data.anchorEntryId, entry.data);
			}
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		const anchorEntryId = ctx.sessionManager.getLeafId();
		if (!anchorEntryId) return;
		try {
			await persistCheckpoint(ctx, "turn", anchorEntryId);
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Git checkpoint was not created: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	});

	pi.on("session_before_fork", async (event, ctx): Promise<RestoreResult | undefined> => {
		if (!ctx.isProjectTrusted()) return undefined;
		const checkpoint = findCheckpoint(event, ctx, turnCheckpoints);
		if (!checkpoint || !ctx.hasUI) return undefined;

		const choice = await ctx.ui.select("Restore tracked files and index?", [
			"Restore checkpoint (untracked files stay untouched)",
			"Keep current code",
		]);
		if (!choice?.startsWith("Restore")) return undefined;

		const rootResult = await git(["rev-parse", "--show-toplevel"], ctx.cwd);
		if (rootResult.code !== 0 || rootResult.stdout.trim() !== checkpoint.repositoryRoot) {
			ctx.ui.notify("Checkpoint belongs to a different Git repository; fork cancelled", "error");
			return { cancel: true };
		}

		const headResult = await git(["rev-parse", "HEAD"], checkpoint.repositoryRoot);
		if (headResult.code !== 0 || headResult.stdout.trim() !== checkpoint.head) {
			ctx.ui.notify("Git HEAD changed since this checkpoint; fork cancelled", "error");
			return { cancel: true };
		}

		const refResult = await git(["rev-parse", "--verify", checkpoint.ref], checkpoint.repositoryRoot);
		if (refResult.code !== 0 || refResult.stdout.trim() !== checkpoint.worktreeCommit) {
			ctx.ui.notify("Checkpoint Git ref is missing or changed; fork cancelled", "error");
			return { cancel: true };
		}

		let safetyCheckpoint: GitCheckpointData | undefined;
		try {
			safetyCheckpoint = await persistCheckpoint(ctx, "safety", event.entryId);
			if (!safetyCheckpoint) {
				ctx.ui.notify("Unable to create a safety checkpoint; fork cancelled", "error");
				return { cancel: true };
			}
			await applyTrackedState(checkpoint);
		} catch (error) {
			let rollbackMessage = "Safety rollback was not available";
			if (safetyCheckpoint) {
				try {
					await applyTrackedState(safetyCheckpoint);
					rollbackMessage = `Current tracked state was restored from ${safetyCheckpoint.ref}`;
				} catch {
					rollbackMessage = `Safety rollback failed; recover manually from ${safetyCheckpoint.ref}`;
				}
			}
			ctx.ui.notify(
				`Checkpoint restore failed: ${error instanceof Error ? error.message : String(error)}. ${rollbackMessage}. Fork cancelled`,
				"error",
			);
			return { cancel: true };
		}

		ctx.ui.notify(
			`Tracked files and index restored. Untracked files were untouched. Safety checkpoint: ${safetyCheckpoint.ref}`,
			"info",
		);
		return undefined;
	});
}
