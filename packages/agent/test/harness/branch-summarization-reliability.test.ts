import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary } from "../../src/harness/compaction/branch-summarization.ts";
import type { SessionTreeEntry } from "../../src/harness/types.ts";

let providerCount = 0;

describe("branch summarization tool-result reliability", () => {
	it("never sends oversized canonical tool-result text to the summarizer", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: `branch-summary-reliability-${++providerCount}`,
			models: [{ id: "summary-model", contextWindow: 32_768, maxTokens: 2_048 }],
		});
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const canonicalToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "branch-tool-call",
			toolName: "branch_tool",
			content: [{ type: "text", text: `VISIBLE_TOOL_HEAD:${"x".repeat(2_000_000)}:PRIVATE_TOOL_TAIL` }],
			isError: false,
			timestamp: Date.now(),
		};
		const entries: SessionTreeEntry[] = [
			{
				type: "message",
				id: "user-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "visible branch request", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "assistant-tool-entry",
				parentId: "user-entry",
				timestamp: new Date().toISOString(),
				message: fauxAssistantMessage(fauxToolCall("branch_tool", {}, { id: "branch-tool-call" }), {
					stopReason: "toolUse",
				}),
			},
			{
				type: "message",
				id: "tool-result-entry",
				parentId: "assistant-tool-entry",
				timestamp: new Date().toISOString(),
				message: canonicalToolResult,
			},
			{
				type: "message",
				id: "assistant-entry",
				parentId: "tool-result-entry",
				timestamp: new Date().toISOString(),
				message: fauxAssistantMessage("visible branch answer"),
			},
		];
		let providerContext: Context | undefined;
		faux.setResponses([
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("safe branch summary");
			},
		]);

		const result = await generateBranchSummary(entries, {
			models,
			model,
			signal: new AbortController().signal,
			reserveTokens: 4_096,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		const serializedProviderContext = JSON.stringify(providerContext);
		expect(serializedProviderContext).toContain("visible branch request");
		expect(serializedProviderContext).toContain("visible branch answer");
		expect(serializedProviderContext).not.toContain("VISIBLE_TOOL_HEAD");
		expect(serializedProviderContext).not.toContain("PRIVATE_TOOL_TAIL");
		expect(canonicalToolResult.content[0]).toMatchObject({ text: expect.stringContaining("PRIVATE_TOOL_TAIL") });
		expect(result.value.summary).toContain("safe branch summary");
	});
});
