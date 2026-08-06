import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BoundaryEnforcementCapabilities,
	type BoundaryProfile,
	createBoundaryProfileDigest,
	type ExecutionBoundary,
} from "../src/core/execution-boundary.ts";
import { validateTaskEnvelope } from "../src/core/task-envelope.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { createAllTools, createTool } from "../src/core/tools/index.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<{
	root: string;
	allowed: string;
	outside: string;
	outsideFile: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-task-envelope-file-errors-"));
	cleanup.push(root);
	const allowed = join(root, "authorized-root");
	const outside = join(root, "outside-scope");
	const outsideFile = join(outside, "private-target.txt");
	await mkdir(allowed);
	await mkdir(outside);
	await writeFile(outsideFile, "private\n", "utf8");
	return {
		root: await realpath(root),
		allowed: await realpath(allowed),
		outside: await realpath(outside),
		outsideFile: await realpath(outsideFile),
	};
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`Expected an Error rejection, received ${String(error)}`);
	}
	throw new Error("Expected operation to reject");
}

function expectRedacted(error: Error, secrets: readonly string[]): void {
	expect(error.message).toMatch(/^FILE_(?:PATH_DENIED|PATH_CHANGED|OPERATION_FAILED):/);
	expect(error.message).toMatch(/authorized|Re-read|retry|Verify/);
	for (const secret of secrets) {
		expect(error.message).not.toContain(secret);
	}
}

const boundaryCapabilities: BoundaryEnforcementCapabilities = {
	isolation: "virtual-machine",
	workspace: { mountIsolation: true, accessModes: ["read-only", "read-write"] },
	process: { modes: ["deny", "isolated"] },
	network: { modes: ["deny"] },
	environment: { allowlist: true },
};

function createRedirectingBoundary(
	cwd: string,
	targetPath: string,
	outsidePath: string,
	onMutation: () => void,
): ExecutionBoundary {
	const profile: BoundaryProfile = {
		scope: "built-in-tools",
		workspace: {
			workingDirectory: cwd,
			mounts: [{ source: cwd, target: cwd, access: "read-write" }],
		},
		process: { mode: "isolated" },
		network: { mode: "deny" },
		environment: { allow: [] },
	};
	let targetResolutions = 0;
	const redirectingRealpath = async (path: string): Promise<string> => {
		if (path !== targetPath) return path;
		targetResolutions++;
		return targetResolutions === 1 ? targetPath : outsidePath;
	};
	const readFile = async (): Promise<Buffer> => Buffer.from("before\n");
	return {
		profile,
		backend: {
			id: "task-envelope-file-errors",
			attest: () => ({
				backendId: "task-envelope-file-errors",
				profileDigest: createBoundaryProfileDigest(profile),
				capabilities: boundaryCapabilities,
			}),
			operations: {
				read: {
					realpath: async (path) => path,
					readFile,
					access: async () => {},
				},
				bash: { exec: async () => ({ exitCode: 0 }) },
				edit: {
					realpath: redirectingRealpath,
					readFile,
					writeFile: async () => onMutation(),
					access: async () => {},
				},
				write: {
					realpath: redirectingRealpath,
					readFile,
					writeFile: async () => onMutation(),
					mkdir: async () => onMutation(),
				},
				grep: {
					realpath: async (path) => path,
					isDirectory: async () => true,
					readFile: async () => "before\n",
					search: async () => [],
				},
				find: {
					realpath: async (path) => path,
					exists: async () => true,
					glob: async () => [],
				},
				ls: {
					realpath: async (path) => path,
					exists: async () => true,
					stat: async () => ({ isDirectory: () => true }),
					readdir: async () => [],
				},
			},
		},
	};
}

describe("task envelope file error redaction", () => {
	it("redacts outside-path failures for every built-in file tool and cannot be disabled by tool options", async () => {
		const { root, allowed, outside, outsideFile } = await createWorkspace();
		const taskEnvelope = await validateTaskEnvelope({
			version: 1,
			task: "Use only the authorized workspace",
			targetCwd: allowed,
			readableRoots: [allowed],
			writableRoots: [allowed],
		});
		const tools = createAllTools(allowed, {
			taskEnvelope,
			read: { redactPathErrors: false },
			write: { redactPathErrors: false },
			edit: { redactPathErrors: false },
			grep: { redactPathErrors: false },
			find: { redactPathErrors: false },
			ls: { redactPathErrors: false },
		});
		const failures = [
			() => tools.read.execute("read", { path: outsideFile }),
			() => tools.write.execute("write", { path: outsideFile, content: "blocked\n" }),
			() =>
				tools.edit.execute("edit", {
					path: outsideFile,
					edits: [{ oldText: "private", newText: "blocked" }],
				}),
			() => tools.grep.execute("grep", { pattern: "private", path: outside }),
			() => tools.find.execute("find", { pattern: "*", path: outside }),
			() => tools.ls.execute("ls", { path: outside }),
		];
		const secrets = [
			root,
			allowed,
			outside,
			outsideFile,
			basename(allowed),
			basename(outside),
			basename(outsideFile),
		];

		for (const run of failures) {
			expectRedacted(await captureError(run), secrets);
		}
		expect(await readFile(outsideFile, "utf8")).toBe("private\n");
	});

	it("preserves detailed diagnostics when no task envelope requests redaction", async () => {
		const { allowed, outsideFile } = await createWorkspace();
		const error = await captureError(() =>
			createReadTool(allowed, { allowedRoots: [allowed] }).execute("read", { path: outsideFile }),
		);

		expect(error.message).toContain("File path policy violation");
		expect(error.message).toContain(outsideFile);
	});

	it("redacts edit preview failures before they reach the renderer", async () => {
		const { root, allowed, outsideFile } = await createWorkspace();
		const preview = await computeEditsDiff(outsideFile, [{ oldText: "private", newText: "blocked" }], allowed, {
			allowedRoots: [allowed],
			redactPathErrors: true,
		});

		expect(preview).toEqual({
			error: "FILE_PATH_DENIED: File path access was denied. Use a path within the authorized workspace.",
		});
		if (!("error" in preview)) throw new Error("Expected a redacted edit preview error");
		expect(preview.error).not.toContain(root);
		expect(preview.error).not.toContain(outsideFile);
	});

	it("redacts write and edit target changes through an exact execution boundary", async () => {
		const { allowed, outside } = await createWorkspace();
		const targetPath = join(allowed, "target.txt");
		const redirectedPath = join(outside, "redirected-target.txt");
		await writeFile(targetPath, "before\n", "utf8");
		const taskEnvelope = await validateTaskEnvelope({
			version: 1,
			task: "Mutate one authorized file",
			targetCwd: allowed,
			readableRoots: [allowed],
			writableRoots: [allowed],
		});
		const secrets = [
			allowed,
			outside,
			targetPath,
			redirectedPath,
			basename(allowed),
			basename(outside),
			basename(targetPath),
			basename(redirectedPath),
		];

		for (const toolName of ["write", "edit"] as const) {
			let mutations = 0;
			const boundary = createRedirectingBoundary(allowed, targetPath, redirectedPath, () => mutations++);
			const tool = createTool(toolName, allowed, { taskEnvelope, boundary });
			const error =
				toolName === "write"
					? await captureError(() =>
							tool.execute("write", {
								path: targetPath,
								content: "after\n",
							}),
						)
					: await captureError(() =>
							tool.execute("edit", {
								path: targetPath,
								edits: [{ oldText: "before", newText: "after" }],
							}),
						);

			expectRedacted(error, secrets);
			expect(error.message).toMatch(/^FILE_PATH_CHANGED:/);
			expect(mutations).toBe(0);
		}
	});

	it("keeps abort semantics stable while redaction is enabled", async () => {
		const { allowed } = await createWorkspace();
		const taskEnvelope = await validateTaskEnvelope({
			version: 1,
			task: "Read inside the workspace",
			targetCwd: allowed,
		});
		const controller = new AbortController();
		controller.abort();

		const error = await captureError(() =>
			createTool("ls", allowed, { taskEnvelope }).execute("ls", { path: "." }, controller.signal),
		);
		expect(error.message).toBe("Operation aborted");
	});
});
