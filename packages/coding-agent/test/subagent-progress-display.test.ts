import { describe, expect, it } from "vitest";
import {
	SubagentProgressDisplay,
	type SubagentProgressEvent,
	type SubagentProgressStatus,
} from "../examples/extensions/subagent/progress-display.ts";

function task(
	taskId: string,
	agent: string,
	status: SubagentProgressStatus,
	taskSummary: string,
	lastActivity?: string,
) {
	return {
		taskId,
		agent,
		taskSummary,
		status,
		lastActivity,
		usage: {
			input: status === "running" ? 1_200 : 0,
			output: status === "running" ? 300 : 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: status === "running" ? 2 : 0,
		},
		provider: "faux",
		model: "worker",
		thinking: "low",
	};
}

function event(
	toolCallId: string,
	mode: SubagentProgressEvent["mode"],
	results: SubagentProgressEvent["results"],
): SubagentProgressEvent {
	return { toolCallId, mode, results };
}

describe("subagent progress display", () => {
	it("shows tasks from multiple simultaneous tool calls and merges streaming updates", () => {
		const display = new SubagentProgressDisplay();
		display.begin("call-a", "parallel", 2);
		display.update(
			event("call-a", "parallel", [
				task("call-a:0", "scout", "running", "Inspect model registry", "grep"),
				task("call-a:1", "planner", "queued", "Plan the change"),
			]),
		);
		display.begin("call-b", "single", 1);
		display.update(
			event("call-b", "single", [task("call-b:0", "reviewer", "running", "Review concurrency", "read")]),
		);

		expect(display.getStatusText()).toBe("subagents 2 calls · 2 running · 1 queued");
		expect(display.getLines()).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Subagents · 2 calls · 2 running · 1 queued"),
				expect.stringContaining("scout · running · grep · Inspect model registry"),
				expect.stringContaining("planner · queued · Plan the change"),
				expect.stringContaining("reviewer · running · read · Review concurrency"),
			]),
		);

		display.update(event("call-a", "parallel", [task("call-a:0", "scout", "completed", "Inspect model registry")]));
		expect(display.getLines()).toEqual(
			expect.arrayContaining([
				expect.stringContaining("scout · completed"),
				expect.stringContaining("planner · queued"),
				expect.stringContaining("reviewer · running"),
			]),
		);

		display.finish("call-b");
		expect(display.getLines()?.join("\n")).not.toContain("reviewer");
		display.finish("call-a");
		expect(display.getStatusText()).toBeUndefined();
		expect(display.getLines()).toBeUndefined();
	});

	it("sanitizes terminal controls and bounds a busy progress panel", () => {
		const display = new SubagentProgressDisplay();
		display.begin("call-many", "parallel", 17);
		display.update(
			event(
				"call-many",
				"parallel",
				Array.from({ length: 17 }, (_, index) =>
					task(
						`call-many:${index}`,
						index === 0 ? "\u001b[31mscout\nspoof" : `worker-${index}`,
						"running",
						index === 0 ? "Inspect\u0000 status\u001b[2J" : `Task ${index}`,
					),
				),
			),
		);

		const lines = display.getLines()!;
		expect(lines).toHaveLength(15);
		expect(lines.join("\n")).not.toContain("\u001b");
		expect(lines).toContain("  … 5 more tasks");
		expect(lines.some((line) => line.includes("scout spoof · running · Inspect status"))).toBe(true);
	});
});
