import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { atomicWriteFile, computeFileRevision } from "../src/core/tools/file-transaction.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-file-transaction-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("file revisions", () => {
	it("makes read revisions model-visible and accepts them as edit preconditions", async () => {
		const directory = await createTempDir();
		const filePath = join(directory, "revision.txt");
		const original = "before\n";
		await writeFile(filePath, original, "utf8");

		const readResult = await createReadTool(directory).execute("read", { path: "revision.txt" });
		const revision = computeFileRevision(original);
		expect(readResult.details?.revision).toBe(revision);
		expect(readResult.content[0]?.type).toBe("text");
		if (readResult.content[0]?.type === "text") {
			expect(readResult.content[0].text).toContain(`[Revision: ${revision}]`);
		}

		const editResult = await createEditTool(directory).execute("edit", {
			path: "revision.txt",
			expectedRevision: revision,
			edits: [{ oldText: "before", newText: "after" }],
		});
		expect(editResult.details?.beforeRevision).toBe(revision);
		expect(editResult.details?.afterRevision).toBe(computeFileRevision("after\n"));
		expect(applyPatch(original, editResult.details?.patch ?? "")).toBe("after\n");
	});

	it("rejects stale edit and write revisions without changing the file", async () => {
		const directory = await createTempDir();
		const filePath = join(directory, "conflict.txt");
		const staleRevision = computeFileRevision("old\n");
		await writeFile(filePath, "changed elsewhere\n", "utf8");

		await expect(
			createEditTool(directory).execute("edit", {
				path: "conflict.txt",
				expectedRevision: staleRevision,
				edits: [{ oldText: "changed elsewhere", newText: "agent edit" }],
			}),
		).rejects.toThrow(
			`File revision conflict for conflict.txt: expected ${staleRevision}, found ${computeFileRevision("changed elsewhere\n")}. Re-read the file and retry.`,
		);

		await expect(
			createWriteTool(directory).execute("write", {
				path: "conflict.txt",
				content: "agent rewrite\n",
				expectedRevision: staleRevision,
			}),
		).rejects.toThrow("File revision conflict for conflict.txt");
		expect(await readFile(filePath, "utf8")).toBe("changed elsewhere\n");
	});

	it("supports missing as a create-only write precondition and returns patch evidence", async () => {
		const directory = await createTempDir();
		const tool = createWriteTool(directory);
		const result = await tool.execute("write", {
			path: "new.txt",
			content: "created\n",
			expectedRevision: "missing",
		});

		expect(result.details?.beforeRevision).toBe("missing");
		expect(result.details?.afterRevision).toBe(computeFileRevision("created\n"));
		expect(result.details?.patch).toContain("+created");
		expect(applyPatch("", result.details?.patch ?? "")).toBe("created\n");

		await expect(
			tool.execute("write-again", {
				path: "new.txt",
				content: "replaced\n",
				expectedRevision: "missing",
			}),
		).rejects.toThrow("expected missing, found sha256:");
	});
});

describe("file path policy", () => {
	it("blocks lexical and symlink escapes for read, edit, and write", async () => {
		const directory = await createTempDir();
		const allowed = join(directory, "allowed");
		const outside = join(directory, "outside");
		await mkdir(allowed);
		await mkdir(outside);
		await writeFile(join(outside, "target.txt"), "outside\n", "utf8");
		await symlink(outside, join(allowed, "escape"));

		await expect(
			createReadTool(allowed, { allowedRoots: [allowed] }).execute("read", {
				path: join(outside, "target.txt"),
			}),
		).rejects.toThrow("File path policy violation");
		await expect(
			createEditTool(allowed, { allowedRoots: [allowed] }).execute("edit", {
				path: "escape/target.txt",
				edits: [{ oldText: "outside", newText: "escaped" }],
			}),
		).rejects.toThrow("File path policy violation");
		await expect(
			createWriteTool(allowed, { allowedRoots: [allowed] }).execute("write", {
				path: "escape/new.txt",
				content: "escaped\n",
			}),
		).rejects.toThrow("File path policy violation");
		expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside\n");
		await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			computeEditsDiff("escape/target.txt", [{ oldText: "outside", newText: "escaped" }], allowed, {
				allowedRoots: [allowed],
			}),
		).resolves.toMatchObject({ error: expect.stringContaining("File path policy violation") });
	});

	it("preserves an in-root symlink while atomically editing its canonical target", async () => {
		const directory = await createTempDir();
		const target = join(directory, "target.txt");
		const alias = join(directory, "alias.txt");
		await writeFile(target, "before\n", "utf8");
		await symlink(target, alias);

		await createEditTool(directory, { allowedRoots: [directory] }).execute("edit", {
			path: alias,
			edits: [{ oldText: "before", newText: "after" }],
		});

		expect((await lstat(alias)).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe("after\n");
	});

	it("requires remote operations to provide realpath before enforcing roots", async () => {
		const tool = createWriteTool("/workspace", {
			allowedRoots: ["/workspace"],
			operations: {
				mkdir: async () => {},
				writeFile: async () => {},
			},
		});

		await expect(tool.execute("write", { path: "file.txt", content: "content" })).rejects.toThrow(
			"requires operations.realpath",
		);
	});

	it("treats an explicit empty root allowlist as deny-all", async () => {
		const directory = await createTempDir();
		await expect(
			createWriteTool(directory, { allowedRoots: [] }).execute("write", {
				path: "blocked.txt",
				content: "blocked\n",
			}),
		).rejects.toThrow("File path policy violation");
	});

	it("supports revision checks and evidence through a complete remote operations backend", async () => {
		const files = new Map<string, Buffer>();
		const tool = createWriteTool("/workspace", {
			allowedRoots: ["/workspace"],
			operations: {
				mkdir: async () => {},
				readFile: async (path) => {
					const content = files.get(path);
					if (content) return content;
					throw Object.assign(new Error(`Missing ${path}`), { code: "ENOENT" });
				},
				writeFile: async (path, content) => {
					files.set(path, Buffer.from(content));
				},
				realpath: async (path) => {
					if (path === "/workspace" || files.has(path)) return path;
					if (dirname(path) === path) return path;
					throw Object.assign(new Error(`Missing ${path}`), { code: "ENOENT" });
				},
			},
		});

		const result = await tool.execute("write", {
			path: "remote.txt",
			content: "remote\n",
			expectedRevision: "missing",
		});
		expect(result.details?.beforeRevision).toBe("missing");
		expect(result.details?.afterRevision).toBe(computeFileRevision("remote\n"));
		expect(result.details?.patch).toContain("+remote");
		expect(files.get("/workspace/remote.txt")?.toString()).toBe("remote\n");
	});

	it("detects a canonical target change before a custom backend writes", async () => {
		let targetResolution = "/workspace/file.txt";
		let writes = 0;
		const content = Buffer.from("before\n");
		const tool = createEditTool("/workspace", {
			allowedRoots: ["/workspace"],
			operations: {
				access: async () => {},
				readFile: async () => content,
				writeFile: async () => {
					writes++;
				},
				realpath: async (path) => {
					if (path === "/workspace") return "/workspace";
					const result = targetResolution;
					targetResolution = "/outside/file.txt";
					return result;
				},
			},
		});

		await expect(
			tool.execute("edit", {
				path: "file.txt",
				edits: [{ oldText: "before", newText: "after" }],
			}),
		).rejects.toThrow("File path policy violation");
		expect(writes).toBe(0);
	});
});

describe("atomic local writes", () => {
	it("cleans same-directory staging files after success and rename failure", async () => {
		const directory = await createTempDir();
		const filePath = join(directory, "target.txt");
		await atomicWriteFile(filePath, "content\n");
		expect(await readFile(filePath, "utf8")).toBe("content\n");
		expect((await readdir(directory)).some((entry) => entry.includes(".pi-stage-"))).toBe(false);

		const directoryTarget = join(directory, "cannot-replace");
		await mkdir(directoryTarget);
		await expect(atomicWriteFile(directoryTarget, "content\n")).rejects.toThrow();
		expect((await readdir(directory)).some((entry) => entry.includes(".pi-stage-"))).toBe(false);
		expect((await lstat(directoryTarget)).isDirectory()).toBe(true);
	});

	it("does not use rename to bypass an existing file's write permissions", async () => {
		const directory = await createTempDir();
		const filePath = join(directory, "read-only.txt");
		await writeFile(filePath, "original\n", "utf8");
		await chmod(filePath, 0o444);

		await expect(atomicWriteFile(filePath, "replacement\n")).rejects.toMatchObject({ code: "EACCES" });
		expect(await readFile(filePath, "utf8")).toBe("original\n");
		expect((await readdir(directory)).some((entry) => entry.includes(".pi-stage-"))).toBe(false);
	});
});
