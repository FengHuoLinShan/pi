import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelStatusSidebar } from "../src/modes/interactive/components/model-status-sidebar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function model(id: string, reasoning = true): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("ModelStatusSidebar", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		initTheme("dark", false);
	});

	it("renders recent models in MRU order without exceeding its width", () => {
		const one = model("one");
		const two = model("two");
		const sidebar = new ModelStatusSidebar({
			models: [{ model: one }, { model: two }],
			currentModel: one,
			currentThinkingLevel: "low",
			recentModelIds: ["test/two", "test/one"],
			onConfirm: vi.fn(),
			onCancel: vi.fn(),
			requestRender: vi.fn(),
		});

		const lines = sidebar.render(18);

		expect(lines.join("\n")).toContain("Models");
		expect(lines.findIndex((line) => line.includes("two"))).toBeLessThan(
			lines.findIndex((line) => line.includes("one")),
		);
		expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
	});

	it("selects a model and reasoning effort before confirming", async () => {
		const one = model("one");
		const two = model("two");
		const selections: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }> = [];
		const sidebar = new ModelStatusSidebar({
			models: [{ model: one }, { model: two }],
			currentModel: one,
			currentThinkingLevel: "low",
			recentModelIds: ["test/two", "test/one"],
			onConfirm: async (selection) => {
				selections.push(selection);
			},
			onCancel: vi.fn(),
			requestRender: vi.fn(),
		});
		sidebar.focused = true;

		sidebar.handleInput("\x1b[B");
		sidebar.handleInput("\x1b[C");
		sidebar.handleInput("\r");
		await flushPromises();

		expect(selections).toEqual([{ model: two, thinkingLevel: "medium" }]);
	});

	it("uses off as the only effort for non-reasoning models", async () => {
		const plain = model("plain", false);
		const selections: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }> = [];
		const sidebar = new ModelStatusSidebar({
			models: [{ model: plain }],
			currentModel: plain,
			currentThinkingLevel: "high",
			recentModelIds: [],
			onConfirm: async (selection) => {
				selections.push(selection);
			},
			onCancel: vi.fn(),
			requestRender: vi.fn(),
		});
		sidebar.focused = true;

		sidebar.handleInput("\x1b[C");
		sidebar.handleInput("\r");
		await flushPromises();

		expect(selections[0]?.thinkingLevel).toBe("off");
	});

	it("cancels without confirming a draft selection", () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const sidebar = new ModelStatusSidebar({
			models: [{ model: model("one") }, { model: model("two") }],
			currentModel: model("one"),
			currentThinkingLevel: "low",
			recentModelIds: [],
			onConfirm,
			onCancel,
			requestRender: vi.fn(),
		});
		sidebar.focused = true;

		sidebar.handleInput("\x1b[B");
		sidebar.handleInput("\x1b");

		expect(onConfirm).not.toHaveBeenCalled();
		expect(onCancel).toHaveBeenCalledOnce();
	});
});
