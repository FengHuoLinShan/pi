import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
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
import goalModeExtension, { findGoalState, type GoalState } from "../src/extensions/goal-mode/index.ts";
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

function setupExtension(sessionManager = SessionManager.inMemory()) {
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
	const api = {
		appendEntry,
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
	const ctx = {
		abort,
		hasPendingMessages: () => false,
		isIdle: () => true,
		sessionManager,
		ui: { notify, setStatus, setWidget },
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

		const promptUpdate = await extension.beforeAgentStart();
		expect(promptUpdate?.systemPrompt).toContain("implement and verify the feature");
		expect(promptUpdate?.systemPrompt).toContain('goal tool with action "complete"');

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
		expect(findGoalState(extension.sessionManager.getBranch())).toMatchObject({
			status: "completed",
			note: "targeted verification passed",
		});
		expect(extension.setStatus).toHaveBeenLastCalledWith("goal-mode", undefined);

		await extension.agentEnd([fauxAssistantMessage("done")]);
		expect(extension.sendMessage).toHaveBeenCalledTimes(2);
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
