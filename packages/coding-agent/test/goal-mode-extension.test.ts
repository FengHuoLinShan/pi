import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecOptions, ExecResult } from "../src/core/exec.ts";
import type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
	SessionTreeEvent,
} from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { findWorkGraph } from "../src/core/work-graph-session.ts";
import { findWorkingSet } from "../src/core/working-set-session.ts";
import { createWorkspaceView, type WorkspaceView } from "../src/core/workspace-view.ts";
import goalModeExtension, { findGoalState, type GoalState, parseGoalState } from "../src/extensions/goal-mode/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createHarness, getAssistantTexts } from "./suite/harness.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type AgentStartHandler = (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
type AgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;
type AgentSettledHandler = (event: AgentSettledEvent, ctx: ExtensionContext) => Promise<void>;
type BeforeAgentStartHandler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined>;
type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
type SessionTreeHandler = (event: SessionTreeEvent, ctx: ExtensionContext) => Promise<void>;

interface GoalToolParams {
	action: "status" | "update" | "complete" | "blocked";
	note?: string;
}

interface GoalTool {
	execute(
		toolCallId: string,
		params: GoalToolParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<{ state: GoalState | undefined }>>;
}

interface SetupOptions {
	cwd?: string;
	workspace?: WorkspaceView;
	exec?: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
	projectTrusted?: boolean;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeGoalConfig(root: string, checks: unknown[]): Promise<void> {
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "goal.json"), JSON.stringify({ version: 1, checks }));
}

function setupExtension(sessionManager = SessionManager.inMemory(), options: SetupOptions = {}) {
	const commands = new Map<string, CommandHandler>();
	let goalTool: GoalTool | undefined;
	let agentStart: AgentStartHandler | undefined;
	let agentEnd: AgentEndHandler | undefined;
	let agentSettled: AgentSettledHandler | undefined;
	let beforeAgentStart: BeforeAgentStartHandler | undefined;
	let sessionStart: SessionStartHandler | undefined;
	let sessionTree: SessionTreeHandler | undefined;
	const sendMessage = vi.fn();
	const appendEntry = vi.fn((customType: string, data?: unknown) => {
		sessionManager.appendCustomEntry(customType, data);
	});
	const execute =
		options.exec ??
		(async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}));
	const api = {
		appendEntry,
		exec: execute,
		getActiveTools: () => ["goal", "read", "bash", "edit", "write"],
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		registerTool(tool: unknown) {
			goalTool = tool as GoalTool;
		},
		sendMessage,
		on(event: string, handler: unknown) {
			if (event === "agent_start") agentStart = handler as AgentStartHandler;
			if (event === "agent_end") agentEnd = handler as AgentEndHandler;
			if (event === "agent_settled") agentSettled = handler as AgentSettledHandler;
			if (event === "before_agent_start") beforeAgentStart = handler as BeforeAgentStartHandler;
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
			if (event === "session_tree") sessionTree = handler as SessionTreeHandler;
		},
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	const abort = vi.fn();
	const cwd = options.cwd ?? process.cwd();
	const ctx = {
		abort,
		cwd,
		hasPendingMessages: () => false,
		isIdle: () => true,
		isProjectTrusted: () => options.projectTrusted ?? true,
		sessionManager,
		ui: { notify, setStatus, setWidget },
		workspace: options.workspace ?? createWorkspaceView(cwd),
	} as unknown as ExtensionCommandContext;
	goalModeExtension(api);
	return {
		abort,
		agentEnd: (messages: AgentMessage[]) => agentEnd!({ type: "agent_end", messages }, ctx),
		agentSettled: () => agentSettled!({ type: "agent_settled" }, ctx),
		agentStart: () => agentStart!({ type: "agent_start" }, ctx),
		appendEntry,
		beforeAgentStart: () =>
			beforeAgentStart!(
				{
					type: "before_agent_start",
					prompt: "continue",
					systemPrompt: "base prompt",
					systemPromptOptions: {},
				} as BeforeAgentStartEvent,
				ctx,
			),
		command: commands.get("goal")!,
		ctx,
		goalTool: goalTool!,
		notify,
		sendMessage,
		sessionManager,
		sessionStart: (reason: SessionStartEvent["reason"] = "startup") =>
			sessionStart!({ type: "session_start", reason }, ctx),
		sessionTree: () =>
			sessionTree!({ type: "session_tree", newLeafId: null, oldLeafId: null, fromExtension: false }, ctx),
		setStatus,
		setWidget,
	};
}

describe("goal mode built-in extension", () => {
	it("is registered as a hidden built-in extension", () => {
		expect(builtInExtensions).toContainEqual(
			expect.objectContaining({ name: "goal-mode", factory: goalModeExtension, hidden: true }),
		);
	});

	it("starts explicitly, persists progress, and continues until the goal tool completes it", async () => {
		const extension = setupExtension();

		await extension.command("implement and verify the feature", extension.ctx);
		const initialState = findGoalState(extension.sessionManager.getBranch());
		expect(initialState).toMatchObject({
			objective: "implement and verify the feature",
			status: "active",
			turns: 0,
			turnLimit: 25,
		});
		expect(extension.sendMessage).toHaveBeenCalledTimes(1);
		expect(extension.setStatus).toHaveBeenLastCalledWith("goal-mode", "goal 0/25");
		expect(findWorkingSet(extension.sessionManager.getBranch(), initialState!.id)?.entries).toEqual([
			expect.objectContaining({
				id: "goal:objective",
				kind: "objective",
				content: "implement and verify the feature",
				required: true,
			}),
		]);

		const promptUpdate = await extension.beforeAgentStart();
		expect(promptUpdate?.systemPrompt).toContain("implement and verify the feature");
		expect(promptUpdate?.systemPrompt).toContain('goal tool with action "complete"');
		expect(promptUpdate?.systemPrompt).toContain("## Durable working set");

		await extension.agentStart();
		await extension.agentEnd([fauxAssistantMessage("more work remains")]);
		expect(extension.sendMessage).toHaveBeenCalledTimes(2);
		expect(findGoalState(extension.sessionManager.getBranch())).toMatchObject({ turns: 1, status: "active" });

		const progress = await extension.goalTool.execute(
			"goal-1",
			{ action: "update", note: "implementation done; verification remains" },
			undefined,
			undefined,
			extension.ctx,
		);
		expect(progress.content[0]).toEqual({
			type: "text",
			text: "Goal updated: implementation done; verification remains",
		});
		expect(findGoalState(extension.sessionManager.getBranch())).toMatchObject({
			status: "active",
			note: "implementation done; verification remains",
		});
		expect(
			findWorkingSet(extension.sessionManager.getBranch(), initialState!.id)?.entries.some(
				(entry) => entry.kind === "attempt" && entry.content === "implementation done; verification remains",
			),
		).toBe(true);

		const completion = await extension.goalTool.execute(
			"goal-2",
			{ action: "complete", note: "targeted verification passed" },
			undefined,
			undefined,
			extension.ctx,
		);
		expect(completion.content[0]).toEqual({
			type: "text",
			text: "Goal completed: targeted verification passed",
		});
		const completedState = findGoalState(extension.sessionManager.getBranch());
		expect(completedState).toMatchObject({
			status: "completed",
			note: "targeted verification passed",
		});
		expect(findWorkGraph(extension.sessionManager.getBranch(), completedState!.id)?.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "work", status: "succeeded" }),
				expect.objectContaining({ id: "complete", status: "succeeded" }),
			]),
		);
		expect(extension.setStatus).toHaveBeenLastCalledWith("goal-mode", undefined);

		await extension.agentEnd([fauxAssistantMessage("done")]);
		expect(extension.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("requires a revision-locked completion gate to pass in the logical workspace", async () => {
		const sourceRoot = await createTemporaryDirectory("pi-goal-source-");
		const logicalRoot = await createTemporaryDirectory("pi-goal-logical-");
		await writeGoalConfig(sourceRoot, [
			{ id: "targeted-test", command: "node", args: ["verify.mjs"], timeoutMs: 5_000 },
		]);
		const execute = vi
			.fn<(command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>>()
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "expected value did not match",
				code: 1,
				killed: false,
			})
			.mockResolvedValueOnce({ stdout: "ok", stderr: "", code: 0, killed: false });
		const extension = setupExtension(SessionManager.inMemory(), {
			cwd: sourceRoot,
			exec: execute,
			workspace: {
				...createWorkspaceView(sourceRoot),
				kind: "overlay",
				logicalRoot,
				revision: { kind: "overlay-base", value: "test-base" },
			},
		});

		await extension.command("finish only after verification", extension.ctx);
		expect(findGoalState(extension.sessionManager.getBranch())?.verification).toMatchObject({
			status: "pending",
			checkIds: ["targeted-test"],
		});

		const failed = await extension.goalTool.execute(
			"goal-fail",
			{ action: "complete", note: "implementation appears complete" },
			undefined,
			undefined,
			extension.ctx,
		);
		expect(failed.content[0]).toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("expected value did not match") }),
		);
		const failedState = findGoalState(extension.sessionManager.getBranch());
		expect(failedState).toMatchObject({
			status: "active",
			verification: {
				status: "fail",
				checks: [{ id: "targeted-test", status: "fail", exitCode: 1, killed: false }],
			},
		});
		expect(JSON.stringify(failedState)).not.toContain("expected value did not match");
		const failedGraph = findWorkGraph(extension.sessionManager.getBranch(), failedState!.id)!;
		expect(failedGraph.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "work", status: "running" }),
				expect.objectContaining({
					id: "verify:targeted-test",
					status: "pending",
					evidence: [expect.objectContaining({ kind: "process" })],
				}),
			]),
		);
		expect(failedGraph.events.some((event) => event.nodeId === "verify:targeted-test" && event.to === "failed")).toBe(
			true,
		);
		expect(execute).toHaveBeenNthCalledWith(
			1,
			"node",
			["verify.mjs"],
			expect.objectContaining({ cwd: logicalRoot, timeout: 5_000 }),
		);

		const completed = await extension.goalTool.execute(
			"goal-pass",
			{ action: "complete", note: "completion gate passed" },
			undefined,
			undefined,
			extension.ctx,
		);
		expect(completed.content[0]).toEqual({
			type: "text",
			text: "Goal completed after the completion gate passed: completion gate passed",
		});
		const completedState = findGoalState(extension.sessionManager.getBranch());
		expect(completedState).toMatchObject({
			status: "completed",
			note: "completion gate passed",
			verification: { status: "pass" },
		});
		expect(findWorkGraph(extension.sessionManager.getBranch(), completedState!.id)?.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "verify:targeted-test", status: "succeeded" }),
				expect.objectContaining({ id: "complete", status: "succeeded" }),
			]),
		);
	});

	it("blocks completion when the frozen gate configuration drifts", async () => {
		const sourceRoot = await createTemporaryDirectory("pi-goal-drift-");
		await writeGoalConfig(sourceRoot, [{ id: "check", command: "node", args: ["first.mjs"] }]);
		const execute = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const extension = setupExtension(SessionManager.inMemory(), { cwd: sourceRoot, exec: execute });

		await extension.command("guard configuration drift", extension.ctx);
		await writeGoalConfig(sourceRoot, [{ id: "check", command: "node", args: ["changed.mjs"] }]);
		const result = await extension.goalTool.execute(
			"goal-drift",
			{ action: "complete", note: "done" },
			undefined,
			undefined,
			extension.ctx,
		);

		expect(result.content[0]).toEqual({
			type: "text",
			text: "Goal blocked: Completion gate configuration changed after the goal started.",
		});
		expect(findGoalState(extension.sessionManager.getBranch())).toMatchObject({
			status: "blocked",
			verification: { status: "blocked" },
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects host-only completion gates in an execution-boundary workspace", async () => {
		const sourceRoot = await createTemporaryDirectory("pi-goal-boundary-");
		await writeGoalConfig(sourceRoot, [{ id: "check", command: "node", args: ["verify.mjs"] }]);
		const execute = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		const hostWorkspace = createWorkspaceView(sourceRoot);
		const boundaryWorkspace: WorkspaceView = {
			...hostWorkspace,
			kind: "execution-boundary",
			logicalRoot: "/sandbox/project",
			revision: { kind: "boundary-profile", value: "test-profile" },
			execution: { target: "boundary", process: "isolated", network: "deny" },
		};
		const extension = setupExtension(SessionManager.inMemory(), {
			cwd: sourceRoot,
			exec: execute,
			workspace: boundaryWorkspace,
		});

		await extension.command("verify inside the boundary", extension.ctx);

		expect(findGoalState(extension.sessionManager.getBranch())).toBeUndefined();
		expect(extension.notify).toHaveBeenCalledWith(
			"Goal could not be started because its completion gate cannot run through an execution boundary.",
			"error",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects sparse verification state arrays", () => {
		const checkIds = new Array<string>(1);
		const checks = [
			{
				id: undefined,
				status: "pending",
				exitCode: null,
				killed: false,
			},
		];
		expect(
			parseGoalState({
				version: 1,
				id: "goal",
				objective: "reject corrupted state",
				status: "active",
				turns: 0,
				turnLimit: 25,
				createdAt: "2026-07-30T00:00:00.000Z",
				updatedAt: "2026-07-30T00:00:00.000Z",
				verification: {
					configRevision: `sha256:${"a".repeat(64)}`,
					checkIds,
					status: "pending",
					checks,
				},
			}),
		).toBeUndefined();
	});

	it("restores branch state without spending tokens and pauses an interrupted run", async () => {
		const first = setupExtension();
		await first.command("preserve this goal", first.ctx);
		await first.agentStart();

		const restored = setupExtension(first.sessionManager);
		await restored.sessionStart("resume");
		expect(restored.sendMessage).not.toHaveBeenCalled();
		expect(restored.notify).toHaveBeenCalledWith(
			"An active goal was restored. Run /goal resume or send a message to continue it.",
			"info",
		);
		expect(restored.setStatus).toHaveBeenLastCalledWith("goal-mode", "goal 1/25");

		await restored.beforeAgentStart();
		await restored.agentEnd([fauxAssistantMessage("", { stopReason: "aborted" })]);
		expect(findGoalState(restored.sessionManager.getBranch())).toMatchObject({
			status: "paused",
			note: "The agent run was interrupted.",
		});
		expect(restored.sendMessage).not.toHaveBeenCalled();
	});

	it("runs autonomous continuations through the real session loop and stops on explicit completion", async () => {
		const harness = await createHarness({ extensionFactories: [goalModeExtension] });
		try {
			harness.setResponses([
				fauxAssistantMessage("first pass finished"),
				fauxAssistantMessage(fauxToolCall("goal", { action: "complete", note: "verified in the faux run" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("final report"),
			]);
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});

			await harness.session.prompt("/goal exercise the continuation loop");
			await settled;

			expect(getAssistantTexts(harness)).toEqual(["first pass finished", "", "final report"]);
			expect(harness.eventsOfType("agent_end")).toHaveLength(2);
			expect(findGoalState(harness.sessionManager.getBranch())).toMatchObject({
				status: "completed",
				turns: 2,
				note: "verified in the faux run",
			});
			expect(
				harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "goal-mode-context",
				),
			).toHaveLength(2);
		} finally {
			harness.cleanup();
		}
	});
});
