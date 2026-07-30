import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import taskContract, {
	parseTaskContractConfig,
	parseTaskContractStatus,
} from "../examples/extensions/task-contract.ts";
import { execCommand } from "../src/core/exec.ts";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "../src/core/extensions/index.ts";
import type { SessionEntry } from "../src/index.ts";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
type ToolResultHandler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void>;
type AgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;

interface TaskConfigOverrides {
	allowedPaths?: string[];
	deniedPaths?: string[];
	minChangedFiles?: number;
	maxChangedFiles?: number;
	checks?: {
		id: string;
		command: string;
		args: string[];
		timeoutMs?: number;
	}[];
	maxAttempts?: number;
}

function runGit(repositoryRoot: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
}

function createRepository(overrides: TaskConfigOverrides = {}): string {
	const repositoryRoot = mkdtempSync(join(tmpdir(), "pi-task-contract-"));
	runGit(repositoryRoot, ["init", "--quiet"]);
	runGit(repositoryRoot, ["config", "user.email", "contract@example.test"]);
	runGit(repositoryRoot, ["config", "user.name", "Contract Test"]);
	mkdirSync(join(repositoryRoot, ".pi"), { recursive: true });
	mkdirSync(join(repositoryRoot, "src", "generated"), { recursive: true });
	const config = {
		allowedPaths: ["src/**"],
		deniedPaths: ["src/generated/**"],
		minChangedFiles: 1,
		maxChangedFiles: 5,
		checks: [
			{
				id: "node-check",
				command: process.execPath,
				args: ["-e", "process.exit(0)"],
				timeoutMs: 10_000,
			},
		],
		maxAttempts: 3,
		...overrides,
	};
	writeFileSync(join(repositoryRoot, ".pi", "task-contract.json"), JSON.stringify(config));
	writeFileSync(join(repositoryRoot, "src", "app.ts"), "export const value = 1;\n");
	runGit(repositoryRoot, ["add", "."]);
	runGit(repositoryRoot, ["commit", "--quiet", "-m", "base"]);
	return repositoryRoot;
}

function setup(
	repositoryRoot: string,
	options: {
		entries?: SessionEntry[];
		enabled?: boolean;
		trusted?: boolean;
	} = {},
) {
	const entries =
		options.entries ??
		([
			{
				type: "session_info",
				id: "user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "task contract",
			},
		] satisfies SessionEntry[]);
	let leafId = entries.at(-1)?.id ?? null;
	let entryCounter = entries.length;
	const handlers: {
		sessionStart?: SessionStartHandler;
		toolCall?: ToolCallHandler;
		toolResult?: ToolResultHandler;
		agentEnd?: AgentEndHandler;
	} = {};
	const exec = vi.fn<ExtensionAPI["exec"]>().mockImplementation(async (command, args, options) => {
		const cwd = options?.cwd ?? repositoryRoot;
		return execCommand(command, args, cwd, {
			signal: options?.signal,
			timeout: options?.timeout,
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
	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>();
	const api = {
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => options.enabled ?? true),
		on(event: string, handler: unknown) {
			if (event === "session_start") handlers.sessionStart = handler as SessionStartHandler;
			if (event === "tool_call") handlers.toolCall = handler as ToolCallHandler;
			if (event === "tool_result") handlers.toolResult = handler as ToolResultHandler;
			if (event === "agent_end") handlers.agentEnd = handler as AgentEndHandler;
		},
		exec,
		appendEntry,
		sendUserMessage,
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const sessionManager = {
		getBranch: () => {
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const branch: SessionEntry[] = [];
			let current = leafId ? byId.get(leafId) : undefined;
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
		ui: { notify },
	} as unknown as ExtensionContext;
	taskContract(api);

	async function start(reason: SessionStartEvent["reason"] = "startup"): Promise<void> {
		await handlers.sessionStart!({ type: "session_start", reason }, ctx);
	}

	async function edit(path: string): Promise<ToolCallEventResult | undefined> {
		return handlers.toolCall!(
			{
				type: "tool_call",
				toolCallId: "edit-1",
				toolName: "edit",
				input: { path, edits: [{ oldText: "old", newText: "new" }] },
			},
			ctx,
		);
	}

	async function bashCall(): Promise<ToolCallEventResult | undefined> {
		return handlers.toolCall!(
			{
				type: "tool_call",
				toolCallId: "bash-1",
				toolName: "bash",
				input: { command: "touch outside.txt" },
			},
			ctx,
		);
	}

	async function mutationResult(toolName: "bash" | "edit" = "edit"): Promise<void> {
		await handlers.toolResult!(
			{
				type: "tool_result",
				toolCallId: `${toolName}-1`,
				toolName,
				input:
					toolName === "bash"
						? { command: "touch outside.txt" }
						: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
				content: [{ type: "text", text: "completed" }],
				isError: false,
				details: undefined,
			},
			ctx,
		);
	}

	async function finish(): Promise<void> {
		await handlers.agentEnd!({ type: "agent_end", messages: [] }, ctx);
	}

	return {
		appendEntry,
		bashCall,
		edit,
		entries,
		exec,
		finish,
		mutationResult,
		notify,
		sendUserMessage,
		start,
	};
}

function taskEntries(entries: SessionEntry[]): Record<string, unknown>[] {
	return entries.flatMap((entry) =>
		entry.type === "custom" &&
		entry.customType === "task-contract-v1" &&
		typeof entry.data === "object" &&
		entry.data !== null
			? [entry.data as Record<string, unknown>]
			: [],
	);
}

describe("task-contract example extension", () => {
	const repositories: string[] = [];

	afterEach(() => {
		for (const repositoryRoot of repositories) {
			rmSync(repositoryRoot, { recursive: true, force: true });
		}
		repositories.length = 0;
	});

	it("strictly parses contracts and porcelain rename records", () => {
		expect(() =>
			parseTaskContractConfig({
				allowedPaths: ["src/**"],
				maxChangedFiles: 5,
				checks: [{ id: "check", command: "npm", typo: true }],
			}),
		).toThrow("unknown checks[0] field: typo");
		expect(() =>
			parseTaskContractConfig({
				allowedPaths: ["../outside/**"],
				maxChangedFiles: 5,
				checks: [{ id: "check", command: "npm" }],
			}),
		).toThrow("unsafe repository-relative glob");
		expect([...parseTaskContractStatus("R  src/new.ts\0src/old.ts\0?? src/untracked.ts\0")]).toEqual([
			"src/new.ts",
			"src/old.ts",
			"src/untracked.ts",
		]);
	});

	it("preflights built-in file paths and persists passing completion evidence", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		const fixture = setup(repositoryRoot);
		await fixture.start();

		await expect(fixture.edit("src/app.ts")).resolves.toBeUndefined();
		await expect(fixture.edit("src/generated/model.ts")).resolves.toEqual({
			block: true,
			reason: 'Task contract blocks out-of-scope path "src/generated/model.ts"',
		});
		await expect(fixture.edit("../outside.ts")).resolves.toEqual({
			block: true,
			reason: "Task contract blocks paths outside the Git repository",
		});

		writeFileSync(join(repositoryRoot, "src", "app.ts"), "export const value = 2;\n");
		await fixture.mutationResult();
		await fixture.finish();

		expect(fixture.sendUserMessage).not.toHaveBeenCalled();
		expect(fixture.notify).toHaveBeenCalledWith("task-contract: passed for 1 changed path(s) and 1 check(s)", "info");
		expect(taskEntries(fixture.entries)).toEqual([
			expect.objectContaining({ kind: "baseline" }),
			expect.objectContaining({
				kind: "attempt",
				status: "pass",
				changedPaths: ["src/app.ts"],
				checks: [{ id: "node-check", code: 0, killed: false }],
			}),
		]);
	});

	it("detects out-of-scope bash changes before running checks", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		const fixture = setup(repositoryRoot);
		await fixture.start();
		writeFileSync(join(repositoryRoot, "outside.txt"), "outside\n");
		await fixture.mutationResult("bash");
		await fixture.finish();

		expect(fixture.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("out-of-scope changed paths: outside.txt"),
			{ deliverAs: "followUp" },
		);
		expect(fixture.exec.mock.calls.some(([command]) => command === process.execPath)).toBe(false);
		expect(taskEntries(fixture.entries).at(-1)).toMatchObject({
			kind: "attempt",
			status: "fail",
			checks: [],
		});
	});

	it("postflights workspace changes made by a verification command", async () => {
		const repositoryRoot = createRepository({
			checks: [
				{
					id: "mutating-check",
					command: process.execPath,
					args: ["-e", "require('node:fs').writeFileSync('generated-by-check.txt', 'generated\\n')"],
				},
			],
		});
		repositories.push(repositoryRoot);
		const fixture = setup(repositoryRoot);
		await fixture.start();
		writeFileSync(join(repositoryRoot, "src", "app.ts"), "export const value = 4;\n");
		await fixture.mutationResult();
		await fixture.finish();

		expect(fixture.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("verification checks changed the Git workspace"),
			{ deliverAs: "followUp" },
		);
		expect(fixture.sendUserMessage.mock.calls[0]![0]).toContain("out-of-scope changed paths: generated-by-check.txt");
		expect(taskEntries(fixture.entries).at(-1)).toMatchObject({
			kind: "attempt",
			status: "fail",
			changedPaths: ["generated-by-check.txt", "src/app.ts"],
		});
	});

	it("resumes a persisted clean baseline and verifies existing task changes", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		const firstRun = setup(repositoryRoot);
		await firstRun.start();
		writeFileSync(join(repositoryRoot, "src", "app.ts"), "export const value = 3;\n");

		const resumed = setup(repositoryRoot, { entries: firstRun.entries });
		await resumed.start("resume");
		await resumed.finish();

		expect(resumed.notify).toHaveBeenCalledWith("task-contract: passed for 1 changed path(s) and 1 check(s)", "info");
		expect(resumed.sendUserMessage).not.toHaveBeenCalled();
	});

	it("fails closed when a new task starts from a dirty baseline", async () => {
		const repositoryRoot = createRepository();
		repositories.push(repositoryRoot);
		writeFileSync(join(repositoryRoot, "src", "app.ts"), "dirty\n");
		const fixture = setup(repositoryRoot);
		await fixture.start();

		await expect(fixture.edit("src/app.ts")).resolves.toEqual({
			block: true,
			reason: "Task contract unavailable: task contracts require a clean Git baseline; found 1 changed path(s)",
		});
		await expect(fixture.bashCall()).resolves.toEqual({
			block: true,
			reason: "Task contract unavailable: task contracts require a clean Git baseline; found 1 changed path(s)",
		});
		expect(fixture.appendEntry).not.toHaveBeenCalled();
	});
});
