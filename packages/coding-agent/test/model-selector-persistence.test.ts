import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";

function model(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("ModelSelectorComponent persistence", () => {
	it("leaves persistence to the authenticated AgentSession selection", () => {
		const onSelectCallback = vi.fn();
		const setDefaultModelAndProvider = vi.fn();
		const fakeThis = {
			close: vi.fn(),
			settingsManager: { setDefaultModelAndProvider },
			onSelectCallback,
		};
		const selected = model();

		(ModelSelectorComponent as any).prototype.handleSelect.call(fakeThis, selected);

		expect(onSelectCallback).toHaveBeenCalledWith(selected);
		expect(setDefaultModelAndProvider).not.toHaveBeenCalled();
	});
});
