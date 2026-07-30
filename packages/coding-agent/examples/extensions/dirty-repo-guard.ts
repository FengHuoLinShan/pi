/**
 * Dirty Repo Guard Extension
 *
 * Protects changes that existed before the current session and prevents
 * session changes while the working tree is dirty.
 *
 * The baseline guard covers the built-in edit and write tools. It also adds
 * prompt guidance telling the agent not to bypass the guard with bash.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";

interface ReadyBaseline {
	kind: "ready";
	repositoryRoot: string;
	dirtyPaths: ReadonlySet<string>;
	approvedPaths: Set<string>;
}

type RepoBaseline = ReadyBaseline | { kind: "not_repository" } | { kind: "unavailable"; reason: string };

type RepositoryPath = { kind: "inside"; path: string } | { kind: "outside" } | { kind: "unavailable"; reason: string };

function removeTrailingLineBreak(value: string): string {
	return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * Rename and copy records include a second NUL-delimited source path. Both
 * paths are protected because either may contain user-owned work.
 */
export function parsePorcelainV1Z(output: string): Set<string> {
	const fields = output.split("\0");
	const paths = new Set<string>();

	for (let index = 0; index < fields.length; index++) {
		const record = fields[index]!;
		if (record === "") continue;
		if (record.length < 4 || record[2] !== " ") {
			throw new Error("Malformed git status record");
		}

		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (!path) throw new Error("Git status record has an empty path");
		paths.add(path);

		if (status.includes("R") || status.includes("C")) {
			const sourcePath = fields[++index];
			if (!sourcePath) throw new Error("Git rename or copy record is missing its source path");
			paths.add(sourcePath);
		}
	}

	return paths;
}

function canonicalizeExistingOrPlannedPath(path: string): string {
	let existingPath = resolve(path);
	const missingSegments: string[] = [];

	while (true) {
		try {
			return resolve(realpathSync(existingPath), ...missingSegments);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = dirname(existingPath);
			if (parent === existingPath) throw error;
			missingSegments.unshift(basename(existingPath));
			existingPath = parent;
		}
	}
}

function toRepositoryRelativePath(repositoryRoot: string, cwd: string, inputPath: string): RepositoryPath {
	let absolutePath: string;
	try {
		absolutePath = canonicalizeExistingOrPlannedPath(
			isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath),
		);
	} catch (error) {
		return {
			kind: "unavailable",
			reason: error instanceof Error ? error.message : "the target path could not be resolved",
		};
	}

	const relativePath = relative(repositoryRoot, absolutePath);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
		return { kind: "outside" };
	}
	if (isAbsolute(relativePath)) return { kind: "outside" };
	return { kind: "inside", path: relativePath.replaceAll("\\", "/") };
}

async function captureBaseline(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RepoBaseline> {
	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd: ctx.cwd,
		timeout: 5_000,
	});
	if (rootResult.killed) {
		return { kind: "unavailable", reason: "git repository discovery timed out" };
	}
	if (rootResult.code !== 0) return { kind: "not_repository" };

	const rootOutput = removeTrailingLineBreak(rootResult.stdout);
	if (!rootOutput) {
		return { kind: "unavailable", reason: "git returned an empty repository root" };
	}
	let repositoryRoot: string;
	try {
		repositoryRoot = canonicalizeExistingOrPlannedPath(resolve(ctx.cwd, rootOutput));
	} catch (error) {
		return {
			kind: "unavailable",
			reason: error instanceof Error ? error.message : "the repository root could not be resolved",
		};
	}
	const statusResult = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: repositoryRoot,
		timeout: 5_000,
	});
	if (statusResult.code !== 0 || statusResult.killed) {
		return { kind: "unavailable", reason: statusResult.stderr.trim() || "git status failed" };
	}

	try {
		return {
			kind: "ready",
			repositoryRoot,
			dirtyPaths: parsePorcelainV1Z(statusResult.stdout),
			approvedPaths: new Set(),
		};
	} catch (error) {
		return {
			kind: "unavailable",
			reason: error instanceof Error ? error.message : "git status output could not be parsed",
		};
	}
}

async function checkDirtyRepo(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: string,
	baseline: RepoBaseline,
): Promise<{ cancel: boolean } | undefined> {
	const { stdout, code, killed } = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: ctx.cwd,
		timeout: 5_000,
	});

	if (code !== 0 || killed) {
		return baseline.kind === "not_repository" ? undefined : { cancel: true };
	}

	let changedPaths: Set<string>;
	try {
		changedPaths = parsePorcelainV1Z(stdout);
	} catch {
		return { cancel: true };
	}
	if (changedPaths.size === 0) return;

	if (!ctx.hasUI) {
		return { cancel: true };
	}

	const choice = await ctx.ui.select(`You have ${changedPaths.size} uncommitted path(s). ${action} anyway?`, [
		"Yes, proceed anyway",
		"No, let me commit first",
	]);

	if (choice !== "Yes, proceed anyway") {
		ctx.ui.notify("Commit your changes first", "warning");
		return { cancel: true };
	}
}

export default function (pi: ExtensionAPI) {
	let baseline: RepoBaseline = {
		kind: "unavailable",
		reason: "the repository baseline has not been captured",
	};

	pi.on("session_start", async (_event, ctx) => {
		baseline = await captureBaseline(pi, ctx);
		if (!ctx.hasUI) return;

		if (baseline.kind === "ready" && baseline.dirtyPaths.size > 0) {
			ctx.ui.notify(
				`Protecting ${baseline.dirtyPaths.size} path(s) that were already changed before this session`,
				"warning",
			);
		} else if (baseline.kind === "unavailable") {
			ctx.ui.notify(`Could not capture the git baseline: ${baseline.reason}`, "warning");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (baseline.kind !== "ready" || baseline.dirtyPaths.size === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}

## Pre-existing workspace changes

This session started with ${baseline.dirtyPaths.size} pre-existing Git-changed path(s). Treat them as user-owned. Use the built-in edit or write tool when an authorized task needs to modify one of them so the workspace guard can request approval. Do not bypass the guard with bash or custom mutation tools.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		if (baseline.kind === "not_repository") return;
		if (baseline.kind === "unavailable") {
			return {
				block: true,
				reason: `Cannot safely modify files because the git baseline is unavailable: ${baseline.reason}`,
			};
		}

		const resolvedPath = toRepositoryRelativePath(baseline.repositoryRoot, ctx.cwd, event.input.path);
		if (resolvedPath.kind === "unavailable") {
			return {
				block: true,
				reason: `Cannot safely resolve the target path: ${resolvedPath.reason}`,
			};
		}
		if (resolvedPath.kind === "outside") return;
		const { path } = resolvedPath;
		if (!baseline.dirtyPaths.has(path) || baseline.approvedPaths.has(path)) return;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Blocked modification of pre-existing change "${path}" because approval UI is unavailable`,
			};
		}

		const approved = await ctx.ui.confirm(
			"Modify pre-existing change?",
			`${path} was already changed before this session. Allow edits to this path for the rest of the session?`,
		);
		if (!approved) {
			return {
				block: true,
				reason: `User declined modification of pre-existing change "${path}"`,
			};
		}
		baseline.approvedPaths.add(path);
	});

	pi.on("session_before_switch", async (event, ctx) => {
		const action = event.reason === "new" ? "new session" : "switch session";
		return checkDirtyRepo(pi, ctx, action, baseline);
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		return checkDirtyRepo(pi, ctx, "fork", baseline);
	});
}
