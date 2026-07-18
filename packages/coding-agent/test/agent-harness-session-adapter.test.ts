import { Session } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AgentHarnessSessionStorageAdapter } from "../src/core/agent-harness-session-adapter.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("AgentHarnessSessionStorageAdapter", () => {
	it("keeps the coding-agent session log as the harness source of truth", async () => {
		const manager = SessionManager.inMemory("/workspace", { id: "adapter-test" });
		const storage = new AgentHarnessSessionStorageAdapter(manager);
		const session = new Session(storage);

		const userId = await session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.appendActiveToolsChange(["read", "edit"]);
		await session.appendModelChange("deepseek", "deepseek-v4-flash");
		await session.moveTo(userId);
		const assistantId = await session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});

		expect(manager.getSessionId()).toBe("adapter-test");
		expect(manager.getLeafId()).toBe(assistantId);
		expect(manager.getEntry(assistantId)?.parentId).toBe(userId);
		expect(manager.getEntries().some((entry) => entry.type === "leaf" && entry.targetId === userId)).toBe(true);
		expect(await storage.findEntries("active_tools_change")).toEqual([
			expect.objectContaining({ activeToolNames: ["read", "edit"] }),
		]);
		expect((await session.buildContext()).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("rejects duplicate externally assigned entry ids", async () => {
		const manager = SessionManager.inMemory();
		const storage = new AgentHarnessSessionStorageAdapter(manager);
		const entry = {
			type: "custom" as const,
			id: "fixed-id",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: "test",
		};

		await storage.appendEntry(entry);
		await expect(storage.appendEntry(entry)).rejects.toThrow("already exists");
	});
});
