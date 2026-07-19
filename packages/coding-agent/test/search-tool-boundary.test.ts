import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createLsTool } from "../src/core/tools/ls.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("read-only search tool boundaries", () => {
	it("rejects custom find results outside the requested search root", async () => {
		const find = createFindTool("/sandbox/workspace", {
			allowedRoots: ["/sandbox/workspace", "/sandbox/reference"],
			operations: {
				realpath: async (path) => path,
				exists: async () => true,
				glob: async () => ["/sandbox/reference/secret.txt"],
			},
		});

		await expect(find.execute("find", { path: ".", pattern: "**/*" })).rejects.toThrow("outside the allowed roots");
	});

	it("delegates custom grep search without starting a host search process", async () => {
		const requests: Array<{ path: string; pattern: string }> = [];
		const grep = createGrepTool("/sandbox/workspace", {
			allowedRoots: ["/sandbox/workspace"],
			operations: {
				realpath: async (path) => path,
				isDirectory: async () => true,
				readFile: async () => "match\n",
				search: async (request) => {
					requests.push({ path: request.path, pattern: request.pattern });
					return [{ path: "/sandbox/workspace/a.txt", lineNumber: 1, lineText: "match\n" }];
				},
			},
		});

		const result = await grep.execute("grep", { pattern: "match" });
		expect(requests).toEqual([{ path: "/sandbox/workspace", pattern: "match" }]);
		expect(result.content).toEqual([{ type: "text", text: "a.txt:1: match" }]);
	});

	it("rejects traversal-shaped entries returned by a bounded ls backend", async () => {
		const ls = createLsTool("/sandbox/workspace", {
			allowedRoots: ["/sandbox/workspace"],
			operations: {
				realpath: async (path) => path,
				exists: async () => true,
				stat: async () => ({ isDirectory: () => true }),
				readdir: async () => ["../secret"],
			},
		});

		await expect(ls.execute("ls", { path: "." })).rejects.toThrow("outside the allowed roots");
	});

	it("does not follow nested symlinks while searching a bounded local tree", async () => {
		const root = await createTempDirectory("pi-search-root");
		const outside = await createTempDirectory("pi-search-outside");
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "safe.txt"), "safe\n", "utf8");
		await writeFile(join(outside, "secret.txt"), "secret-marker\n", "utf8");
		await symlink(join(outside, "secret.txt"), join(root, "src", "escape.txt"));

		const grep = createGrepTool(root, { allowedRoots: [root] });
		const result = await grep.execute("grep", { path: root, pattern: "secret-marker" });
		expect(result.content).toEqual([{ type: "text", text: "No matches found" }]);

		const find = createFindTool(root, { allowedRoots: [root] });
		await expect(find.execute("find", { path: root, pattern: "**/*" })).rejects.toThrow("outside the allowed roots");

		const ls = createLsTool(root, { allowedRoots: [root] });
		await expect(ls.execute("ls", { path: join(root, "src") })).rejects.toThrow("outside the allowed roots");
	});
});
