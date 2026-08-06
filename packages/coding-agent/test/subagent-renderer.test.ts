import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import subagentExtension, { type SingleResult, type SubagentDetails } from "../examples/extensions/subagent/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function getSubagentTool(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	subagentExtension({
		on: () => () => {},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: () => {},
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI);
	if (!tool) throw new Error("Subagent tool was not registered");
	return tool;
}

function failureResult(): SingleResult {
	return {
		taskId: "call:0",
		agent: "researcher",
		agentSource: "user",
		task: "Inspect the runtime",
		taskSummary: "Inspect the runtime",
		exitCode: 1,
		status: "failed",
		cwd: "/canonical/workspace",
		timeoutMs: 180_000,
		messages: [],
		stderr: "AUTH_SENTINEL API_KEY_SENTINEL HEADER_SENTINEL ENV_SENTINEL",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		provider: "opencode",
		model: "deepseek-v4-flash-free",
		thinking: "low",
		supportedThinking: ["high", "max"],
		errorCode: "SUBAGENT_MODEL_EFFORT_UNSUPPORTED",
		errorMessage: "Selected subagent model does not support effort.",
	};
}

function taskResult(index: number, status: SingleResult["status"]): SingleResult {
	const exitCodes: Record<SingleResult["status"], number> = {
		queued: -1,
		running: 0,
		completed: 0,
		failed: 1,
		cancelled: 130,
		timed_out: 124,
		skipped: 1,
	};
	return {
		taskId: `call:${index}`,
		agent: `scout-${index}`,
		agentSource: "user",
		task: `Task ${index}`,
		taskSummary: `Task ${index}`,
		exitCode: exitCodes[status],
		status,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function renderParallel(results: SingleResult[], expectedTasks = results.length): string {
	const details: SubagentDetails = {
		toolCallId: "call",
		mode: "parallel",
		revision: 1,
		expectedTasks,
		agentScope: "user",
		projectAgentsDir: null,
		results,
	};
	const result: AgentToolResult<SubagentDetails> = {
		content: [{ type: "text", text: "parallel snapshot" }],
		details,
	};
	const component = getSubagentTool().renderResult?.(result, { expanded: false, isPartial: true }, theme, {} as never);
	if (!component) throw new Error("Subagent result renderer was not registered");
	return stripAnsi(component.render(160).join("\n"));
}

function toolCallMessage(name: string, legacy = false): Message {
	const toolCall = legacy
		? { type: "toolCall" as const, id: "tool-call", name, arguments: {} }
		: {
				type: "toolCall" as const,
				id: "tool-call",
				name,
				arguments: {},
				argumentMetadata: { visibility: "redacted", count: 2 },
			};
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function renderToolCall(
	mode: "single" | "parallel" | "chain",
	expanded: boolean,
	name: string,
	legacy = false,
): string {
	const task = { ...taskResult(0, "completed"), messages: [toolCallMessage(name, legacy)] };
	const details: SubagentDetails = {
		toolCallId: "call",
		mode,
		revision: 1,
		expectedTasks: 1,
		agentScope: "user",
		projectAgentsDir: null,
		results: [{ ...task, step: mode === "chain" ? 1 : undefined }],
	};
	const result: AgentToolResult<SubagentDetails> = {
		content: [{ type: "text", text: "tool snapshot" }],
		details,
	};
	const component = getSubagentTool().renderResult?.(result, { expanded, isPartial: false }, theme, {} as never);
	if (!component) throw new Error("Subagent result renderer was not registered");
	return stripAnsi(component.render(160).join("\n"));
}

function renderFailure(mode: "single" | "parallel" | "chain", expanded: boolean): string {
	const task = failureResult();
	const details: SubagentDetails = {
		toolCallId: "call",
		mode,
		revision: 1,
		expectedTasks: 1,
		agentScope: "user",
		projectAgentsDir: null,
		results: [{ ...task, step: mode === "chain" ? 1 : undefined }],
	};
	const result: AgentToolResult<SubagentDetails> = {
		content: [{ type: "text", text: "PUBLIC_FIXED_FAILURE" }],
		details,
	};
	const component = getSubagentTool().renderResult?.(result, { expanded, isPartial: false }, theme, {} as never);
	if (!component) throw new Error("Subagent result renderer was not registered");
	return stripAnsi(component.render(160).join("\n"));
}

describe("subagent renderer", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("counts two running parallel tasks as zero done", () => {
		const rendered = renderParallel([taskResult(0, "running"), taskResult(1, "running")]);
		expect(rendered).toContain("parallel 0/2 done, 2 running, 0 queued");
	});

	it("counts only terminal statuses as done in a mixed parallel snapshot", () => {
		const statuses: SingleResult["status"][] = [
			"queued",
			"running",
			"completed",
			"failed",
			"timed_out",
			"skipped",
			"cancelled",
		];
		const rendered = renderParallel(statuses.map((status, index) => taskResult(index, status)));
		expect(rendered).toContain("parallel 5/7 done, 1 running, 1 queued");
	});

	it("uses expectedTasks for partial and terminal denominators", () => {
		expect(renderParallel([taskResult(0, "running")], 3)).toContain("parallel 0/3 done, 1 running, 0 queued");
		expect(renderParallel([taskResult(0, "completed"), taskResult(1, "failed")], 3)).toContain(
			"parallel 1/3 succeeded",
		);
	});

	it("keeps malformed snapshots within the authoritative cardinality", () => {
		const rendered = renderParallel([taskResult(0, "completed"), taskResult(1, "failed")], 1);
		expect(rendered).toContain("parallel 1/1 succeeded");
		expect(rendered).not.toMatch(/(?:2|3)\/1 (?:done|succeeded)/);
	});

	for (const mode of ["single", "parallel", "chain"] as const) {
		for (const expanded of [false, true]) {
			it(`labels redacted built-in and custom tool arguments in ${mode} when ${expanded ? "expanded" : "collapsed"}`, () => {
				for (const name of ["read", "bash", "ls", "custom-tool"]) {
					const rendered = renderToolCall(mode, expanded, name);
					expect(rendered).toContain(`tool call ${name} — arguments redacted (2 supplied)`);
					expect(rendered).not.toContain("read ...");
					expect(rendered).not.toContain("$ ...");
					expect(rendered).not.toContain("ls .");
					expect(rendered).not.toContain("custom-tool {}");
				}
			});

			it(`treats legacy empty arguments as redacted with unknown count in ${mode} when ${expanded ? "expanded" : "collapsed"}`, () => {
				const rendered = renderToolCall(mode, expanded, "read", true);
				expect(rendered).toContain("tool call read — arguments redacted (count unknown)");
				expect(rendered).not.toContain("read ...");
			});

			it(`shows fixed ${mode} preflight diagnostics when ${expanded ? "expanded" : "collapsed"}`, () => {
				const rendered = renderFailure(mode, expanded);
				expect(rendered).toContain("researcher");
				expect(rendered).toContain("SUBAGENT_MODEL_EFFORT_UNSUPPORTED");
				expect(rendered).toContain("Selected subagent model does not support effort.");
				expect(rendered).toContain("opencode/deepseek-v4-flash-free:low");
				expect(rendered).toContain("Supported thinking: high, max");
				expect(rendered).toContain("Canonical cwd: /canonical/workspace");
				expect(rendered).toContain("Effective timeout: 180000 ms");
				for (const secret of ["AUTH_SENTINEL", "API_KEY_SENTINEL", "HEADER_SENTINEL", "ENV_SENTINEL"]) {
					expect(rendered).not.toContain(secret);
				}
			});
		}
	}
});
