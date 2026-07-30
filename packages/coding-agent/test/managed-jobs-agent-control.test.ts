import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/index.ts";
import {
	createManagedJobControlTool,
	MANAGED_JOBS_AGENT_CONTROL_TOOL,
} from "../src/extensions/managed-jobs/agent-control.ts";
import type { LoadedManagedJobsConfig } from "../src/extensions/managed-jobs/config.ts";
import { type ManagedJobsRuntime, openManagedJobsRuntime } from "../src/extensions/managed-jobs/runtime.ts";

const temporaryDirectories: string[] = [];
const openedRuntimes: ManagedJobsRuntime[] = [];

async function createRuntime(): Promise<ManagedJobsRuntime> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-managed-jobs-control-"));
	temporaryDirectories.push(cwd);
	const runtime = await openManagedJobsRuntime({
		cwd,
		agentDir: join(cwd, "agent"),
		maxOutputBytesPerSession: 1024 * 1024,
	});
	openedRuntimes.push(runtime);
	return runtime;
}

async function stopActiveJobs(runtime: ManagedJobsRuntime): Promise<void> {
	const active = runtime.manager
		.list()
		.filter((record) => record.state === "created" || record.state === "running" || record.state === "terminating");
	await Promise.all(active.map((record) => runtime.manager.terminate(record.id)));
	await Promise.all(active.map((record) => runtime.manager.waitForExit(record.id)));
	await runtime.manager.flush();
}

afterEach(async () => {
	await Promise.all(openedRuntimes.splice(0).map(stopActiveJobs));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createContext(cwd: string, options?: { trusted?: boolean; boundary?: boolean }): ExtensionContext {
	return {
		cwd,
		hasExecutionBoundary: options?.boundary ?? false,
		isProjectTrusted: () => options?.trusted ?? true,
	} as unknown as ExtensionContext;
}

function createLoadedConfig(): LoadedManagedJobsConfig {
	return {
		revision: "a".repeat(64),
		config: {
			version: 1,
			recipes: [
				{
					id: "api",
					command: process.execPath,
					args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
					readiness: { contains: "ready", stream: "stdout", timeoutSeconds: 1 },
				},
			],
		},
	};
}

describe("managed job agent control", () => {
	it("starts only a fixed recipe, waits for readiness, and stops only its own job", async () => {
		const runtime = await createRuntime();
		const loaded = createLoadedConfig();
		const expectedArguments = [...loaded.config.recipes[0]!.args];
		const tool = createManagedJobControlTool({ runtime, loaded, cwd: temporaryDirectories.at(-1)! });
		const ctx = createContext(temporaryDirectories.at(-1)!);
		loaded.config.recipes[0]!.command = "unapproved-after-load";
		loaded.config.recipes[0]!.args = ["unapproved-after-load"];

		const started = await tool.execute("start-call", { action: "start", recipe: "api" }, undefined, undefined, ctx);
		const startDetails = started.details as ManagedJobControlStartDetails;
		const record = runtime.manager.status(startDetails.jobId);

		expect(tool.name).toBe(MANAGED_JOBS_AGENT_CONTROL_TOOL);
		expect(startDetails).toMatchObject({
			action: "start",
			configRevision: loaded.revision,
			recipeId: "api",
			readinessStatus: "matched",
			state: "running",
		});
		expect(record.command).toBe(process.execPath);
		expect(record.args).toEqual(expectedArguments);
		expect(JSON.stringify(started)).not.toContain(process.execPath);
		await expect(
			tool.execute("duplicate-call", { action: "start", recipe: "api" }, undefined, undefined, ctx),
		).rejects.toThrow("already has an active tool-controlled run");

		const human = await runtime.manager.start({
			id: "human-job",
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
		});
		await expect(
			tool.execute("foreign-stop-call", { action: "stop", id: human.id }, undefined, undefined, ctx),
		).rejects.toThrow("was not started by this control tool");

		const stopped = await tool.execute(
			"stop-call",
			{ action: "stop", id: startDetails.jobId },
			undefined,
			undefined,
			ctx,
		);
		expect(stopped.details).toMatchObject({ action: "stop", recipeId: "api", state: "terminated" });
		expect(runtime.manager.status(startDetails.jobId).state).toBe("terminated");
	});

	it("rejects unknown recipes, untrusted projects, and execution boundaries", async () => {
		const runtime = await createRuntime();
		const cwd = temporaryDirectories.at(-1)!;
		const tool = createManagedJobControlTool({ runtime, loaded: createLoadedConfig(), cwd });

		await expect(
			tool.execute(
				"unknown-call",
				{ action: "start", recipe: "arbitrary-command" },
				undefined,
				undefined,
				createContext(cwd),
			),
		).rejects.toThrow("recipe is not approved");
		await expect(
			tool.execute(
				"untrusted-call",
				{ action: "start", recipe: "api" },
				undefined,
				undefined,
				createContext(cwd, { trusted: false }),
			),
		).rejects.toThrow("requires a trusted project");
		await expect(
			tool.execute(
				"boundary-call",
				{ action: "start", recipe: "api" },
				undefined,
				undefined,
				createContext(cwd, { boundary: true }),
			),
		).rejects.toThrow("cannot execute across an execution boundary");
		expect(runtime.manager.list()).toHaveLength(0);
	});
});

interface ManagedJobControlStartDetails {
	jobId: string;
	action: "start";
	configRevision: string;
	recipeId: string;
	readinessStatus: string;
	state: string;
}
