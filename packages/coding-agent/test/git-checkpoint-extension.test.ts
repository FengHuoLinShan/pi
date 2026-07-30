import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import gitCheckpointExtension from "../examples/extensions/git-checkpoint.ts";
import { execCommand } from "../src/core/exec.ts";
import type { SessionBeforeForkResult } from "../src/core/extensions/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionEntry,
	SessionStartEvent,
	TurnStartEvent,
} from "../src/index.ts";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
type TurnStartHandler = (event: TurnStartEvent, ctx: ExtensionContext) => Promise<void>;
type SessionBeforeForkHandler = (
	event: SessionBeforeForkEvent,
	ctx: ExtensionContext,
) => Promise<SessionBeforeForkResult | undefined>;

interface CheckpointData {
	purpose: "turn" | "safety";
	indexTree: string;
	worktreeCommit: string;
	ref: string;
}

interface FixtureOptions {
	entries?: SessionEntry[];
	leafId?: string;
	selection?: string;
	trusted?: boolean;
}

function runGit(repositoryRoot: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
}

function createRepository(): string {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "pi-git-checkpoint-"));
	runGit(repositoryRoot, ["init", "--quiet"]);
	runGit(repositoryRoot, ["config", "user.email", "checkpoint@example.test"]);
	runGit(repositoryRoot, ["config", "user.name", "Checkpoint Test"]);
	writeFileSync(join(repositoryRoot, "tracked.txt"), "base\n");
	runGit(repositoryRoot, ["add", "tracked.txt"]);
	runGit(repositoryRoot, ["commit", "--quiet", "-m", "base"]);
	return repositoryRoot;
}

function checkpointData(entry: SessionEntry): CheckpointData | undefined {
	if (
		entry.type !== "custom" ||
		entry.customType !== "git-checkpoint-v1" ||
		typeof entry.data !== "object" ||
		entry.data === null
	) {
		return undefined;
	}
	return entry.data as CheckpointData;
}

function setup(repositoryRoot: string, options: FixtureOptions = {}) {
	const entries =
		options.entries ??
		([
			{
				type: "session_info",
				id: "user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "checkpoint test",
			},
		] satisfies SessionEntry[]);
	let leafId = options.leafId ?? "user-1";
	let entryCounter = entries.length;
	let failNextIndexRestore = false;
	const handlers: {
		sessionStart?: SessionStartHandler;
		turnStart?: TurnStartHandler;
		sessionBeforeFork?: SessionBeforeForkHandler;
	} = {};
	const exec = vi.fn<ExtensionAPI["exec"]>().mockImplementation(async (command, args, execOptions) => {
		if (command === "git" && args[0] === "read-tree" && args.length === 2 && failNextIndexRestore) {
			failNextIndexRestore = false;
			return {
				stdout: "",
				stderr: "injected index restore failure",
				code: 1,
				killed: false,
			};
		}
		const cwd = execOptions?.cwd ?? repositoryRoot;
		return execCommand(command, args, cwd, {
			signal: execOptions?.signal,
			timeout: execOptions?.timeout,
		});
	});
	const appendEntry = vi.fn((customType: string, data?: unknown) => {
		const entry: SessionEntry = {
			type: "custom",
			id: `custom-${++entryCounter}`,
			parentId: leafId,
			timestamp: new Date().toISOString(),
			customType,
			data,
		};
		entries.push(entry);
		leafId = entry.id;
	});
	const api = {
		on(event: string, handler: unknown) {
			if (event === "session_start") handlers.sessionStart = handler as SessionStartHandler;
			if (event === "turn_start") handlers.turnStart = handler as TurnStartHandler;
			if (event === "session_before_fork") {
				handlers.sessionBeforeFork = handler as SessionBeforeForkHandler;
			}
		},
		exec,
		appendEntry,
	} as unknown as ExtensionAPI;
	const select = vi.fn(async () => options.selection ?? "Restore checkpoint (untracked files stay untouched)");
	const notify = vi.fn();
	const sessionManager = {
		getSessionId: () => "session-1",
		getLeafId: () => leafId,
		getEntries: () => entries,
		getBranch: (fromId?: string) => {
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const branch: SessionEntry[] = [];
			let current = fromId ? byId.get(fromId) : byId.get(leafId);
			while (current) {
				branch.push(current);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
			return branch.reverse();
		},
	};
	const ctx = {
		cwd: repositoryRoot,
		hasUI: true,
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager,
		ui: { notify, select },
	} as unknown as ExtensionContext;

	gitCheckpointExtension(api);

	async function start(reason: SessionStartEvent["reason"] = "startup"): Promise<void> {
		await handlers.sessionStart!({ type: "session_start", reason }, ctx);
	}

	async function startTurn(): Promise<void> {
		await handlers.turnStart!({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
	}

	async function fork(
		entryId = "user-1",
		position: SessionBeforeForkEvent["position"] = "at",
	): Promise<SessionBeforeForkResult | undefined> {
		return handlers.sessionBeforeFork!({ type: "session_before_fork", entryId, position }, ctx);
	}

	return {
		appendEntry,
		entries,
		exec,
		failNextIndexRestore: () => {
			failNextIndexRestore = true;
		},
		fork,
		notify,
		select,
		start,
		startTurn,
	};
}

describe("git-checkpoint example extension", () => {
	const repositories: string[] = [];

	afterEach(() => {
		for (const repositoryRoot of repositories) {
			rmSync(repositoryRoot, { recursive: true, force: true });
		}
		repositories.length = 0;
	});

	it("restores persisted tracked worktree and index state after an extension reload", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "checkpoint index\n");
		runGit(repositoryRoot, ["add", "tracked.txt"]);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "checkpoint worktree\n");

		const firstRun = setup(repositoryRoot);
		await firstRun.start();
		await firstRun.startTurn();
		const turnCheckpoint = firstRun.entries.map(checkpointData).find((data) => data?.purpose === "turn");
		expect(turnCheckpoint).toBeDefined();
		expect(runGit(repositoryRoot, ["rev-parse", "--verify", turnCheckpoint!.ref])).toBe(
			turnCheckpoint!.worktreeCommit,
		);

		writeFileSync(join(repositoryRoot, "tracked.txt"), "later index\n");
		runGit(repositoryRoot, ["add", "tracked.txt"]);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "later worktree\n");
		writeFileSync(join(repositoryRoot, "untracked.txt"), "leave untouched\n");

		const reloaded = setup(repositoryRoot, { entries: firstRun.entries });
		await reloaded.start("reload");
		await expect(reloaded.fork()).resolves.toBeUndefined();

		expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("checkpoint worktree\n");
		expect(runGit(repositoryRoot, ["show", ":tracked.txt"])).toBe("checkpoint index");
		expect(readFileSync(join(repositoryRoot, "untracked.txt"), "utf8")).toBe("leave untouched\n");
		expect(runGit(repositoryRoot, ["status", "--porcelain"])).toContain("?? untracked.txt");

		const safetyCheckpoints = reloaded.entries
			.map(checkpointData)
			.filter((data): data is CheckpointData => data?.purpose === "safety");
		const safetyCheckpoint = safetyCheckpoints[safetyCheckpoints.length - 1];
		expect(safetyCheckpoint).toBeDefined();
		expect(runGit(repositoryRoot, ["rev-parse", "--verify", safetyCheckpoint!.ref])).toBe(
			safetyCheckpoint!.worktreeCommit,
		);
		expect(reloaded.notify).toHaveBeenCalledWith(expect.stringContaining("Untracked files were untouched"), "info");
	});

	it("refuses restoration when HEAD changed after the checkpoint", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "checkpoint\n");

		const firstRun = setup(repositoryRoot);
		await firstRun.start();
		await firstRun.startTurn();

		runGit(repositoryRoot, ["add", "tracked.txt"]);
		runGit(repositoryRoot, ["commit", "--quiet", "-m", "new head"]);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "current worktree\n");

		const reloaded = setup(repositoryRoot, { entries: firstRun.entries });
		await reloaded.start("reload");
		await expect(reloaded.fork()).resolves.toEqual({ cancel: true });

		expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("current worktree\n");
		expect(reloaded.notify).toHaveBeenCalledWith("Git HEAD changed since this checkpoint; fork cancelled", "error");
		expect(reloaded.entries.map(checkpointData).filter((data) => data?.purpose === "safety")).toHaveLength(0);
	});

	it("rolls back the tracked worktree and index when restoration fails midway", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "checkpoint index\n");
		runGit(repositoryRoot, ["add", "tracked.txt"]);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "checkpoint worktree\n");

		const firstRun = setup(repositoryRoot);
		await firstRun.start();
		await firstRun.startTurn();

		writeFileSync(join(repositoryRoot, "tracked.txt"), "current index\n");
		runGit(repositoryRoot, ["add", "tracked.txt"]);
		writeFileSync(join(repositoryRoot, "tracked.txt"), "current worktree\n");
		writeFileSync(join(repositoryRoot, "untracked.txt"), "current untracked\n");

		const reloaded = setup(repositoryRoot, { entries: firstRun.entries });
		await reloaded.start("reload");
		reloaded.failNextIndexRestore();
		await expect(reloaded.fork()).resolves.toEqual({ cancel: true });

		expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("current worktree\n");
		expect(runGit(repositoryRoot, ["show", ":tracked.txt"])).toBe("current index");
		expect(readFileSync(join(repositoryRoot, "untracked.txt"), "utf8")).toBe("current untracked\n");
		expect(reloaded.notify).toHaveBeenCalledWith(
			expect.stringContaining("Current tracked state was restored from refs/pi/checkpoints/"),
			"error",
		);
	});

	it("keeps the current state when restoration is declined", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		const fixture = setup(repositoryRoot, { selection: "Keep current code" });
		await fixture.start();
		await fixture.startTurn();
		writeFileSync(join(repositoryRoot, "tracked.txt"), "current\n");

		await expect(fixture.fork()).resolves.toBeUndefined();

		expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("current\n");
		expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
		expect(fixture.notify).not.toHaveBeenCalled();
	});

	it("does not create or restore checkpoints for untrusted projects", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		const fixture = setup(repositoryRoot, { trusted: false });
		await fixture.start();
		await fixture.startTurn();

		expect(fixture.appendEntry).not.toHaveBeenCalled();
		expect(fixture.exec).not.toHaveBeenCalled();
		await expect(fixture.fork()).resolves.toBeUndefined();
		expect(fixture.select).not.toHaveBeenCalled();
	});
});
