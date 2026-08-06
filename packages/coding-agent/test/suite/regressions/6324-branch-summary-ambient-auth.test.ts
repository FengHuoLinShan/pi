import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #6324 branch summary ambient auth", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("never sends oversized canonical tool-result text to the summarizer", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const targetId = harness.sessionManager.appendMessage(userMsg("branch anchor"));
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("branch_tool", {}, { id: "branch-tool-call" }), {
				stopReason: "toolUse",
			}),
		);
		const toolResultId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "branch-tool-call",
			toolName: "branch_tool",
			content: [{ type: "text", text: `VISIBLE_TOOL_HEAD:${"x".repeat(2_000_000)}:PRIVATE_TOOL_TAIL` }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(assistantMsg("visible branch answer"));
		let serializedProviderContext = "";
		harness.setResponses([
			(context) => {
				serializedProviderContext = JSON.stringify(context);
				return fauxAssistantMessage("safe branch summary");
			},
		]);

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
		expect(serializedProviderContext).toContain("visible branch answer");
		expect(serializedProviderContext).not.toContain("VISIBLE_TOOL_HEAD");
		expect(serializedProviderContext).not.toContain("PRIVATE_TOOL_TAIL");
		const storedToolResult = harness.sessionManager.getEntry(toolResultId);
		expect(storedToolResult).toMatchObject({
			type: "message",
			message: { content: [{ text: expect.stringContaining("PRIVATE_TOOL_TAIL") }] },
		});
		expect(result.summaryEntry?.summary).toContain("safe branch summary");
	});

	it("summarizes tree branches when request auth has no API key", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		let streamCallCount = 0;
		harness.session.agent.streamFn = (model, _context, options) => {
			streamCallCount++;
			expect(options?.apiKey).toBeUndefined();

			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "branch summary text" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			return stream;
		};

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(streamCallCount).toBe(1);
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toContain("branch summary text");
	});
});
