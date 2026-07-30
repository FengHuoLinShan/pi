import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	vi.unstubAllEnvs();
});

function createContext(
	cwd: string,
	options?: {
		trusted?: boolean;
		boundary?: boolean;
		hasUI?: boolean;
		confirm?: (title: string, message: string) => Promise<boolean>;
	},
): ExtensionContext {
	return {
		cwd,
		hasExecutionBoundary: options?.boundary ?? false,
		hasUI: options?.hasUI ?? true,
		isProjectTrusted: () => options?.trusted ?? true,
		ui: {
			confirm: options?.confirm ?? (async () => true),
		},
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
					description: "Start the local API",
					command: process.execPath,
					args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
					inheritEnv: ["PI_MANAGED_JOBS_ALLOWED"],
					maxAgentStarts: 1,
					readiness: { contains: "ready", stream: "stdout", timeoutSeconds: 1 },
				},
			],
		},
	};
}

async function rejectedMessage(operation: Promise<unknown>): Promise<string> {
	try {
		await operation;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("managed job agent control", () => {
	it("starts only a fixed recipe, waits for readiness, and stops only its own job", async () => {
		const runtime = await createRuntime();
		const loaded = createLoadedConfig();
		const expectedArguments = [...loaded.config.recipes[0]!.args];
		const tool = createManagedJobControlTool({ runtime, loaded, cwd: temporaryDirectories.at(-1)! });
		const ctx = createContext(temporaryDirectories.at(-1)!);
		vi.stubEnv("PI_MANAGED_JOBS_ALLOWED", "allowed");
		vi.stubEnv("PI_MANAGED_JOBS_BLOCKED", "blocked");
		loaded.config.recipes[0]!.command = "unapproved-after-load";
		loaded.config.recipes[0]!.args = ["unapproved-after-load"];
		loaded.config.recipes[0]!.inheritEnv = ["PI_MANAGED_JOBS_BLOCKED"];
		loaded.config.recipes[0]!.description = "Unapproved description";

		const started = await tool.execute("start-call", { action: "start", recipe: "api" }, undefined, undefined, ctx);
		const startDetails = started.details as ManagedJobControlStartDetails;
		const record = runtime.manager.status(startDetails.jobId);

		expect(tool.name).toBe(MANAGED_JOBS_AGENT_CONTROL_TOOL);
		expect(tool.description).toContain("Start the local API");
		expect(tool.description).not.toContain("Unapproved description");
		expect(startDetails).toMatchObject({
			action: "start",
			configRevision: loaded.revision,
			recipeId: "api",
			readinessStatus: "matched",
			state: "running",
		});
		expect(record.command).toBe(process.execPath);
		expect(record.args).toEqual(expectedArguments);
		const created = runtime.manager.getEvents(record.id).find((event) => event.type === "process_created");
		if (!created || created.type !== "process_created") throw new Error("Expected process creation event");
		expect(created.environmentNames).toContain("PI_MANAGED_JOBS_ALLOWED");
		expect(created.environmentNames).not.toContain("PI_MANAGED_JOBS_BLOCKED");
		expect(created.environmentNames.some((name) => name.toLowerCase() === "path")).toBe(true);
		expect(JSON.stringify(started)).not.toContain(process.execPath);
		const catalog = await tool.execute("recipes-call", { action: "recipes" }, undefined, undefined, ctx);
		expect(catalog.details).toMatchObject({
			action: "recipes",
			recipeIds: ["api"],
			activeJobIds: [startDetails.jobId],
		});
		expect(catalog.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('"startsRemaining": 0'),
		});
		expect(catalog.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`"activeJobId": "${startDetails.jobId}"`),
		});
		expect(JSON.stringify(catalog)).not.toContain(process.execPath);
		expect(JSON.stringify(catalog)).not.toContain("PI_MANAGED_JOBS_ALLOWED");
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
		await expect(
			tool.execute("foreign-wait-call", { action: "wait", id: human.id }, undefined, undefined, ctx),
		).rejects.toThrow("was not started by this control tool");

		const controller = new AbortController();
		controller.abort();
		const waiting = await tool.execute(
			"wait-call",
			{ action: "wait", id: startDetails.jobId },
			controller.signal,
			undefined,
			ctx,
		);
		expect(waiting.details).toMatchObject({ action: "wait", waitStatus: "aborted", state: "running" });

		const stopped = await tool.execute(
			"stop-call",
			{ action: "stop", id: startDetails.jobId },
			undefined,
			undefined,
			ctx,
		);
		expect(stopped.details).toMatchObject({ action: "stop", recipeId: "api", state: "terminated" });
		expect(runtime.manager.status(startDetails.jobId).state).toBe("terminated");
		const stoppedCatalog = await tool.execute(
			"stopped-recipes-call",
			{ action: "recipes" },
			undefined,
			undefined,
			ctx,
		);
		expect(stoppedCatalog.details).toMatchObject({ activeJobIds: [] });
		await expect(
			tool.execute("budget-call", { action: "start", recipe: "api" }, undefined, undefined, ctx),
		).rejects.toThrow("reached its agent start budget: api (1/1)");
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

	it("waits for a tool-owned one-shot recipe without returning its output", async () => {
		const runtime = await createRuntime();
		const cwd = temporaryDirectories.at(-1)!;
		const secretOutput = "local completion output";
		const loaded: LoadedManagedJobsConfig = {
			revision: "b".repeat(64),
			config: {
				version: 1,
				recipes: [
					{
						id: "check",
						command: process.execPath,
						args: ["-e", `process.stdout.write(${JSON.stringify(secretOutput)})`],
					},
				],
			},
		};
		const tool = createManagedJobControlTool({ runtime, loaded, cwd });
		const ctx = createContext(cwd);

		const started = await tool.execute(
			"start-check",
			{ action: "start", recipe: "check" },
			undefined,
			undefined,
			ctx,
		);
		const startDetails = started.details as ManagedJobControlStartDetails;
		const waited = await tool.execute(
			"wait-check",
			{ action: "wait", id: startDetails.jobId, timeoutSeconds: 1 },
			undefined,
			undefined,
			ctx,
		);

		expect(waited.details).toMatchObject({
			action: "wait",
			recipeId: "check",
			waitStatus: "terminal",
			state: "exited",
		});
		expect(JSON.stringify(waited)).not.toContain(secretOutput);
		expect(JSON.stringify(waited)).not.toContain(process.execPath);
	});

	it("automatically terminates a tool-owned recipe at its runtime limit", async () => {
		const runtime = await createRuntime();
		const cwd = temporaryDirectories.at(-1)!;
		const loaded: LoadedManagedJobsConfig = {
			revision: "c".repeat(64),
			config: {
				version: 1,
				recipes: [
					{
						id: "bounded",
						command: process.execPath,
						args: ["-e", "setInterval(() => {}, 1000)"],
						maxRuntimeSeconds: 1,
					},
				],
			},
		};
		const tool = createManagedJobControlTool({ runtime, loaded, cwd });
		const ctx = createContext(cwd);

		const started = await tool.execute(
			"start-bounded",
			{ action: "start", recipe: "bounded" },
			undefined,
			undefined,
			ctx,
		);
		const startDetails = started.details as ManagedJobControlStartDetails;
		const waited = await tool.execute(
			"wait-bounded",
			{ action: "wait", id: startDetails.jobId, timeoutSeconds: 2 },
			undefined,
			undefined,
			ctx,
		);

		expect(waited.details).toMatchObject({ action: "wait", waitStatus: "terminal", state: "terminated" });
		expect(tool.description).toContain("runtime <= 1s");
	});

	it("requires fresh UI approval before each protected recipe start", async () => {
		const runtime = await createRuntime();
		const cwd = temporaryDirectories.at(-1)!;
		const loaded: LoadedManagedJobsConfig = {
			revision: "d".repeat(64),
			config: {
				version: 1,
				recipes: [
					{
						id: "deploy",
						description: "Deploy the reviewed build",
						command: process.execPath,
						args: ["-e", "setInterval(() => {}, 1000)", "x".repeat(5_000)],
						maxAgentStarts: 1,
						requireApproval: true,
					},
				],
			},
		};
		const tool = createManagedJobControlTool({ runtime, loaded, cwd });
		const confirm = vi.fn<(title: string, message: string) => Promise<boolean>>();
		confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		await expect(
			tool.execute(
				"headless-start",
				{ action: "start", recipe: "deploy" },
				undefined,
				undefined,
				createContext(cwd, { hasUI: false, confirm }),
			),
		).rejects.toThrow("requires approval UI");
		await expect(
			tool.execute(
				"declined-start",
				{ action: "start", recipe: "deploy" },
				undefined,
				undefined,
				createContext(cwd, { confirm }),
			),
		).rejects.toThrow("was not approved by the user");
		expect(runtime.manager.list()).toHaveLength(0);

		const started = await tool.execute(
			"approved-start",
			{ action: "start", recipe: "deploy" },
			undefined,
			undefined,
			createContext(cwd, { confirm }),
		);
		expect(started.details).toMatchObject({ action: "start", recipeId: "deploy", state: "running" });
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(confirm).toHaveBeenLastCalledWith(
			"Run agent-managed job recipe?",
			expect.stringContaining(process.execPath),
		);
		expect(confirm).toHaveBeenLastCalledWith(
			"Run agent-managed job recipe?",
			expect.stringContaining("Deploy the reviewed build"),
		);
		const approvalMessage = confirm.mock.calls.at(-1)?.[1] ?? "";
		expect(approvalMessage).not.toContain("x".repeat(4_100));
		expect(approvalMessage).toContain("...");
		expect(tool.description).toContain("approval required");
	});

	it("redacts host operation errors from tool failures", async () => {
		const runtime = await createRuntime();
		const cwd = temporaryDirectories.at(-1)!;
		const loaded = createLoadedConfig();
		const tool = createManagedJobControlTool({ runtime, loaded, cwd });
		const ctx = createContext(cwd);
		const sensitiveError = `sensitive host path ${process.execPath}`;
		const start = vi.spyOn(runtime.manager, "start").mockRejectedValueOnce(new Error(sensitiveError));

		const startMessage = await rejectedMessage(
			tool.execute("start-failure", { action: "start", recipe: "api" }, undefined, undefined, ctx),
		);
		expect(startMessage).toContain("Managed job start failed for approved recipe api");
		expect(startMessage).not.toContain(sensitiveError);
		start.mockRestore();

		const output = vi.spyOn(runtime.manager, "readOutputTail").mockRejectedValueOnce(new Error(sensitiveError));
		const readinessMessage = await rejectedMessage(
			tool.execute("readiness-failure", { action: "start", recipe: "api" }, undefined, undefined, ctx),
		);
		expect(readinessMessage).toContain("Managed job readiness check failed for approved recipe api");
		expect(readinessMessage).not.toContain(sensitiveError);
		output.mockRestore();

		const jobId = runtime.manager.list().find((record) => record.id.startsWith("agent-api-"))?.id;
		if (!jobId) throw new Error("Expected a tool-controlled job");
		const status = vi.spyOn(runtime.manager, "status").mockImplementationOnce(() => {
			throw new Error(sensitiveError);
		});
		const waitMessage = await rejectedMessage(
			tool.execute("wait-failure", { action: "wait", id: jobId }, undefined, undefined, ctx),
		);
		expect(waitMessage).toContain("Managed job wait failed for approved recipe api");
		expect(waitMessage).not.toContain(sensitiveError);
		status.mockRestore();

		const terminate = vi.spyOn(runtime.manager, "terminate").mockRejectedValueOnce(new Error(sensitiveError));
		const stopMessage = await rejectedMessage(
			tool.execute("stop-failure", { action: "stop", id: jobId }, undefined, undefined, ctx),
		);
		expect(stopMessage).toContain("Managed job stop failed for approved recipe api");
		expect(stopMessage).not.toContain(sensitiveError);
		terminate.mockRestore();
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
