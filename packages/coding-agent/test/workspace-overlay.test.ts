import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionConfig } from "../src/core/agent-session.ts";
import { createTool } from "../src/core/tools/index.ts";
import {
	WorkspaceOverlay,
	type WorkspaceOverlayCommitBackend,
	WorkspaceOverlayError,
} from "../src/core/workspace-overlay.ts";

const tempRoots: string[] = [];

async function tempDirectory(name: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `${name}-`));
	tempRoots.push(path);
	return path;
}

async function createWorkspace(files: Record<string, string>): Promise<string> {
	const root = await tempDirectory("pi-overlay-workspace");
	for (const [path, content] of Object.entries(files)) {
		const absolutePath = join(root, path);
		await mkdir(join(absolutePath, ".."), { recursive: true });
		await writeFile(absolutePath, content, "utf8");
	}
	return root;
}

function localBackend(failInstallPath?: string): WorkspaceOverlayCommitBackend {
	return {
		readFile: (path) => readFile(path),
		writeFile: (path, content, options) => writeFile(path, content, options),
		mkdir: (path) => mkdir(path).then(() => {}),
		rename: async (from, to) => {
			if (
				failInstallPath &&
				basename(to) === basename(failInstallPath) &&
				!to.includes("pi-overlay-backup") &&
				from.includes(".pi-overlay-") &&
				!from.includes("pi-overlay-backup")
			) {
				throw new Error("injected install failure");
			}
			await rename(from, to);
		},
		remove: (path) => rm(path, { force: true }),
		rmdir: (path) => rmdir(path),
		lstat: (path) => lstat(path),
		realpath: (path) => realpath(path),
		chmod: (path, mode) => chmod(path, mode),
	};
}

afterEach(async () => {
	while (tempRoots.length > 0) {
		const path = tempRoots.pop();
		if (path) await rm(path, { recursive: true, force: true });
	}
});

describe("WorkspaceOverlay", () => {
	it("materializes an isolated workspace and atomically applies a complete PatchSet", async () => {
		const workspaceRoot = await createWorkspace({ "src/a.txt": "alpha\n", "src/delete.txt": "remove\n" });
		const overlayRoot = await tempDirectory("pi-overlay-state");
		const { overlay, recovery } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });

		expect(recovery).toEqual({ action: "none", paths: [] });
		await writeFile(join(overlay.getWorkingDirectory(), "src/a.txt"), "beta\n", "utf8");
		await writeFile(join(overlay.getWorkingDirectory(), "src/new.txt"), "created\n", "utf8");
		await rm(join(overlay.getWorkingDirectory(), "src/delete.txt"));

		const patchSet = await overlay.createPatchSet();
		expect(patchSet.entries.map((entry) => [entry.kind, entry.path])).toEqual([
			["update", "src/a.txt"],
			["delete", "src/delete.txt"],
			["create", "src/new.txt"],
		]);
		expect(patchSet.entries.every((entry) => entry.patch?.includes(entry.path))).toBe(true);
		expect(await readFile(join(workspaceRoot, "src/a.txt"), "utf8")).toBe("alpha\n");

		const result = await overlay.applyPatchSet(patchSet);

		expect(result.appliedPaths).toEqual(["src/a.txt", "src/delete.txt", "src/new.txt"]);
		expect(overlay.getState()).toBe("applied");
		expect(await readFile(join(workspaceRoot, "src/a.txt"), "utf8")).toBe("beta\n");
		expect(await readFile(join(workspaceRoot, "src/new.txt"), "utf8")).toBe("created\n");
		await expect(readFile(join(workspaceRoot, "src/delete.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(overlay.applyPatchSet(patchSet)).rejects.toMatchObject({ code: "invalid_overlay" });
	});

	it("fails closed on a base revision conflict before mutating any file", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n", "b.txt": "two\n" });
		const overlayRoot = await tempDirectory("pi-overlay-conflict");
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		await writeFile(join(overlay.getWorkingDirectory(), "a.txt"), "overlay one\n", "utf8");
		await writeFile(join(overlay.getWorkingDirectory(), "b.txt"), "overlay two\n", "utf8");
		const patchSet = await overlay.createPatchSet();
		await writeFile(join(workspaceRoot, "b.txt"), "external\n", "utf8");

		await expect(overlay.applyPatchSet(patchSet)).rejects.toMatchObject({ code: "workspace_conflict" });
		expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("one\n");
		expect(await readFile(join(workspaceRoot, "b.txt"), "utf8")).toBe("external\n");
		expect(overlay.getState()).toBe("active");
	});

	it("compensates earlier file mutations when a later install fails", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n", "b.txt": "two\n" });
		const overlayRoot = await tempDirectory("pi-overlay-rollback");
		const { overlay } = await WorkspaceOverlay.open({
			workspaceRoot,
			overlayRoot,
			commitBackend: localBackend(join(workspaceRoot, "b.txt")),
		});
		await writeFile(join(overlay.getWorkingDirectory(), "a.txt"), "changed one\n", "utf8");
		await writeFile(join(overlay.getWorkingDirectory(), "b.txt"), "changed two\n", "utf8");
		const patchSet = await overlay.createPatchSet();

		await expect(overlay.applyPatchSet(patchSet)).rejects.toMatchObject({ code: "apply_failed" });
		expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("one\n");
		expect(await readFile(join(workspaceRoot, "b.txt"), "utf8")).toBe("two\n");
		expect(overlay.getState()).toBe("active");
	});

	it("recovers a prepared apply journal after rollback is interrupted", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "a-before\n", "b.txt": "b-before\n" });
		const overlayRoot = await tempDirectory("pi-overlay-recovery");
		const delegate = localBackend(join(workspaceRoot, "b.txt"));
		let failRestore = true;
		const backend: WorkspaceOverlayCommitBackend = {
			...delegate,
			rename: async (from, to) => {
				if (failRestore && from.includes("pi-overlay-backup") && basename(to) === "a.txt") {
					failRestore = false;
					throw new Error("injected rollback interruption");
				}
				await delegate.rename(from, to);
			},
		};
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot, commitBackend: backend });
		await writeFile(join(overlay.getWorkingDirectory(), "a.txt"), "a-after\n", "utf8");
		await writeFile(join(overlay.getWorkingDirectory(), "b.txt"), "b-after\n", "utf8");

		await expect(overlay.applyPatchSet(await overlay.createPatchSet())).rejects.toMatchObject({
			code: "recovery_failed",
		});
		const reopened = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		expect(reopened.recovery).toMatchObject({ action: "rolled_back", paths: ["a.txt", "b.txt"] });
		expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("a-before\n");
		expect(await readFile(join(workspaceRoot, "b.txt"), "utf8")).toBe("b-before\n");
		expect(reopened.overlay.getState()).toBe("active");
	});

	it("reopens a durable active overlay without losing staged changes", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const overlayRoot = await tempDirectory("pi-overlay-reopen");
		const first = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		await writeFile(join(first.overlay.getWorkingDirectory(), "a.txt"), "staged\n", "utf8");

		const reopened = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		const patchSet = await reopened.overlay.createPatchSet();

		expect(reopened.overlay.getId()).toBe(first.overlay.getId());
		expect(reopened.recovery).toEqual({ action: "none", paths: [] });
		expect(patchSet.entries).toHaveLength(1);
		expect(patchSet.entries[0]).toMatchObject({ kind: "update", path: "a.txt" });
	});

	it("rejects symlinks that escape the workspace boundary", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const outside = await tempDirectory("pi-overlay-outside");
		await symlink(join(outside, "secret.txt"), join(workspaceRoot, "escape"));
		const overlayRoot = await tempDirectory("pi-overlay-symlink");

		await expect(WorkspaceOverlay.open({ workspaceRoot, overlayRoot })).rejects.toBeInstanceOf(WorkspaceOverlayError);
	});

	it("canonicalizes a caller-supplied overlay root before checking workspace overlap", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const nestedRoot = join(workspaceRoot, "nested-overlay");
		await mkdir(nestedRoot);
		const holder = await tempDirectory("pi-overlay-root-link");
		const overlayRoot = join(holder, "overlay-link");
		await symlink(nestedRoot, overlayRoot);

		await expect(WorkspaceOverlay.open({ workspaceRoot, overlayRoot })).rejects.toMatchObject({
			code: "invalid_overlay",
		});
		expect(await readdir(nestedRoot)).toEqual([]);
	});

	it("rejects a missing nested overlay root without creating it", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const nestedRoot = join(workspaceRoot, "missing", "overlay");

		await expect(WorkspaceOverlay.open({ workspaceRoot, overlayRoot: nestedRoot })).rejects.toMatchObject({
			code: "invalid_overlay",
		});
		await expect(lstat(nestedRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a reopened overlay whose owned workspace directory became a symlink", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const overlayRoot = await tempDirectory("pi-overlay-owned-workspace-link");
		const first = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		const outside = await createWorkspace({ "outside.txt": "outside\n" });
		await rm(first.overlay.getWorkingDirectory(), { recursive: true });
		await symlink(outside, first.overlay.getWorkingDirectory());

		await expect(WorkspaceOverlay.open({ workspaceRoot, overlayRoot })).rejects.toMatchObject({
			code: "invalid_overlay",
		});
	});

	it("rejects an active overlay whose owned workspace directory became a symlink", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const overlayRoot = await tempDirectory("pi-overlay-active-workspace-link");
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		const outside = await createWorkspace({ "outside.txt": "outside\n" });
		await rm(overlay.getWorkingDirectory(), { recursive: true });
		await symlink(outside, overlay.getWorkingDirectory());

		await expect(overlay.createPatchSet()).rejects.toMatchObject({ code: "invalid_overlay" });
	});

	it("preserves workspace files named __proto__ in snapshots and PatchSets", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		await writeFile(join(workspaceRoot, "__proto__"), "before\n", "utf8");
		const overlayRoot = await tempDirectory("pi-overlay-proto-file");
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });

		expect(overlay.getBaseSnapshot().files.__proto__).toMatchObject({ byteLength: 7 });
		await writeFile(join(overlay.getWorkingDirectory(), "__proto__"), "after\n", "utf8");
		expect((await overlay.createPatchSet()).entries).toContainEqual(
			expect.objectContaining({ kind: "update", path: "__proto__" }),
		);
	});

	it("revalidates parent paths immediately before staging writes", async () => {
		const workspaceRoot = await createWorkspace({ "dir/a.txt": "before\n" });
		const canonicalWorkspaceRoot = await realpath(workspaceRoot);
		const overlayRoot = await tempDirectory("pi-overlay-parent-race");
		const outside = await createWorkspace({ "a.txt": "outside\n" });
		const targetDirectory = join(canonicalWorkspaceRoot, "dir");
		const savedDirectory = join(canonicalWorkspaceRoot, "dir-saved");
		const targetPath = join(targetDirectory, "a.txt");
		const delegate = localBackend();
		let targetRealpaths = 0;
		let swapped = false;
		const backend: WorkspaceOverlayCommitBackend = {
			...delegate,
			realpath: async (path) => {
				if (path === targetPath && ++targetRealpaths === 3) {
					await rename(targetDirectory, savedDirectory);
					await symlink(outside, targetDirectory);
					swapped = true;
				}
				const resolved = await realpath(path);
				if (path === targetPath && swapped) {
					await rm(targetDirectory);
					await rename(savedDirectory, targetDirectory);
					swapped = false;
				}
				return resolved;
			},
		};
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot, commitBackend: backend });
		await writeFile(join(overlay.getWorkingDirectory(), "dir/a.txt"), "after\n", "utf8");

		await expect(overlay.applyPatchSet(await overlay.createPatchSet())).rejects.toMatchObject({
			code: "apply_failed",
		});
		expect(await readFile(targetPath, "utf8")).toBe("before\n");
		expect(await readFile(join(outside, "a.txt"), "utf8")).toBe("outside\n");
	});

	it("refuses to restore a tampered recovery backup", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "a-before\n", "b.txt": "b-before\n" });
		const overlayRoot = await tempDirectory("pi-overlay-tampered-backup");
		const delegate = localBackend(join(workspaceRoot, "b.txt"));
		const backend: WorkspaceOverlayCommitBackend = {
			...delegate,
			rename: async (from, to) => {
				if (from.includes("pi-overlay-backup") && basename(to) === "a.txt") {
					throw new Error("injected rollback interruption");
				}
				await delegate.rename(from, to);
			},
		};
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot, commitBackend: backend });
		await writeFile(join(overlay.getWorkingDirectory(), "a.txt"), "a-after\n", "utf8");
		await writeFile(join(overlay.getWorkingDirectory(), "b.txt"), "b-after\n", "utf8");
		await expect(overlay.applyPatchSet(await overlay.createPatchSet())).rejects.toMatchObject({
			code: "recovery_failed",
		});

		const backupName = (await readdir(workspaceRoot)).find((name) => name.includes("a.txt.pi-overlay-backup"));
		expect(backupName).toBeTruthy();
		await writeFile(join(workspaceRoot, backupName!), "tampered\n", "utf8");

		await expect(WorkspaceOverlay.open({ workspaceRoot, overlayRoot })).rejects.toMatchObject({
			code: "recovery_failed",
		});
		await expect(readFile(join(workspaceRoot, "a.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects relative paths that normalize back to the workspace root", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const overlayRoot = await tempDirectory("pi-overlay-invalid-relative");
		await expect(WorkspaceOverlay.open({ workspaceRoot, overlayRoot, exclude: ["cache/.."] })).rejects.toMatchObject({
			code: "invalid_path",
		});
	});

	it("rejects path traversal injected into durable overlay metadata", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const overlayRoot = await tempDirectory("pi-overlay-invalid-metadata-path");
		await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		const metadataPath = join(overlayRoot, "overlay.json");
		const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { exclude: string[] };
		metadata.exclude = ["../outside"];
		await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

		await expect(WorkspaceOverlay.open({ workspaceRoot, overlayRoot })).rejects.toMatchObject({
			code: "invalid_overlay",
		});
	});

	it("confines read-only search tools to the overlay root", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const outside = await createWorkspace({ "secret.txt": "secret\n" });
		const overlayRoot = await tempDirectory("pi-overlay-search-tools");
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		const ls = createTool("ls", workspaceRoot, { overlay });
		const grep = createTool("grep", workspaceRoot, { overlay });
		const find = createTool("find", workspaceRoot, { overlay });

		await expect(ls.execute("outside-ls", { path: outside })).rejects.toThrow("outside the allowed roots");
		await expect(grep.execute("outside-grep", { path: outside, pattern: "secret" })).rejects.toThrow(
			"outside the allowed roots",
		);
		await expect(find.execute("outside-find", { path: outside, pattern: "**/*" })).rejects.toThrow(
			"outside the allowed roots",
		);
		await expect(ls.execute("inside-ls", { path: overlay.getWorkingDirectory() })).resolves.toMatchObject({
			content: [{ type: "text", text: "a.txt" }],
		});
	});

	it("rejects base tool overrides that could bypass the overlay", async () => {
		const workspaceRoot = await createWorkspace({ "a.txt": "one\n" });
		const overlayRoot = await tempDirectory("pi-overlay-base-tool-override");
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
		const incompleteConfig = {
			workspaceOverlay: overlay,
			baseToolsOverride: {},
		} as unknown as AgentSessionConfig;

		expect(() => new AgentSession(incompleteConfig)).toThrow(
			"baseToolsOverride cannot be combined with workspaceOverlay",
		);
	});
});
