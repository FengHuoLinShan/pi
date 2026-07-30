import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loadGoalCompletionPlan,
	parseGoalCompletionConfig,
	verifyGoalCompletion,
} from "../src/core/goal-completion.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-completion-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("goal completion gate", () => {
	it("strictly parses the versioned direct-command format", () => {
		expect(
			parseGoalCompletionConfig({
				version: 1,
				checks: [{ id: "check", command: "npm", args: ["run", "check"] }],
			}),
		).toEqual({
			version: 1,
			checks: [{ id: "check", command: "npm", args: ["run", "check"], timeoutMs: 120_000 }],
		});
		expect(() =>
			parseGoalCompletionConfig({
				version: 1,
				checks: [
					{ id: "duplicate", command: "first" },
					{ id: "duplicate", command: "second" },
				],
			}),
		).toThrow("goal completion check ids must be unique");
		expect(() =>
			parseGoalCompletionConfig({
				version: 1,
				checks: [{ id: "check", command: "npm", shell: true }],
			}),
		).toThrow("unknown checks[0] field: shell");
	});

	it("loads a regular project config with a content-addressed revision", async () => {
		const root = await createTemporaryDirectory();
		await mkdir(join(root, ".pi"));
		await writeFile(
			join(root, ".pi", "goal.json"),
			JSON.stringify({ version: 1, checks: [{ id: "tests", command: "node", args: ["test.mjs"] }] }),
		);

		const first = await loadGoalCompletionPlan(root);
		const second = await loadGoalCompletionPlan(root);

		expect(first).toMatchObject({
			configPath: join(root, ".pi", "goal.json"),
			configRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			checks: [{ id: "tests", command: "node", args: ["test.mjs"], timeoutMs: 120_000 }],
		});
		expect(second?.configRevision).toBe(first?.configRevision);
	});

	it("rejects a config reached through a directory symlink outside the project", async () => {
		const root = await createTemporaryDirectory();
		const outside = await createTemporaryDirectory();
		await writeFile(
			join(outside, "goal.json"),
			JSON.stringify({ version: 1, checks: [{ id: "tests", command: "node" }] }),
		);
		await symlink(outside, join(root, ".pi"));

		await expect(loadGoalCompletionPlan(root)).rejects.toThrow("outside the allowed roots");
	});

	it("returns structured reports while keeping bounded process diagnostics out of persisted evidence", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "passed", stderr: "", code: 0, killed: false })
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "private failure detail",
				code: 2,
				killed: false,
			});
		const verification = await verifyGoalCompletion(
			"ship safely",
			{
				configPath: "/project/.pi/goal.json",
				configRevision: `sha256:${"a".repeat(64)}`,
				checks: [
					{ id: "types", command: "npm", args: ["run", "check"], timeoutMs: 5_000 },
					{ id: "tests", command: "node", args: ["test.mjs"], timeoutMs: 6_000 },
				],
			},
			"/logical/workspace",
			execute,
		);

		expect(verification.report.status).toBe("fail");
		expect(verification.checks).toEqual([
			{ id: "types", status: "pass", exitCode: 0, killed: false, diagnostic: undefined },
			{
				id: "tests",
				status: "fail",
				exitCode: 2,
				killed: false,
				diagnostic: "stderr:\nprivate failure detail",
			},
		]);
		expect(JSON.stringify(verification.report)).not.toContain("private failure detail");
		expect(execute).toHaveBeenNthCalledWith(
			2,
			"node",
			["test.mjs"],
			expect.objectContaining({ cwd: "/logical/workspace", timeout: 6_000 }),
		);
	});
});
