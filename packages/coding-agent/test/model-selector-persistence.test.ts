import type { Model } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent, resolveModelSelection } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function model(provider = "test", id = "test-model"): Model<"openai-completions"> {
	return {
		id,
		name: `Test model from ${provider}`,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

interface SelectorHarness {
	component: ModelSelectorComponent;
	onSelect: ReturnType<typeof vi.fn<(selected: Model<"openai-completions">) => void>>;
	render(): string;
}

async function createSelectorHarness(
	models: Model<"openai-completions">[],
	currentModel?: Model<"openai-completions">,
): Promise<SelectorHarness> {
	const onSelect = vi.fn<(selected: Model<"openai-completions">) => void>();
	const modelRuntime = {
		getAvailableSnapshot: () => models,
		getModel: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
		refresh: async () => ({ aborted: false, errors: new Map(), models }),
		getError: () => undefined,
	} as unknown as ModelRuntime;
	const component = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		currentModel,
		{} as SettingsManager,
		modelRuntime,
		[],
		onSelect,
		vi.fn(),
	);
	await Promise.resolve();
	return {
		component,
		onSelect,
		render: () => component.render(120).join("\n"),
	};
}

function typeInput(component: ModelSelectorComponent, value: string): void {
	for (const character of value) component.handleInput(character);
}

describe("ModelSelectorComponent selection", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	it("prefers the current provider for an exact duplicate model ID", () => {
		const opencode = model("opencode", "gpt-5.6-sol");
		const codex = model("openai-codex", "gpt-5.6-sol");

		expect(resolveModelSelection([opencode, codex], "gpt-5.6-sol", "openai-codex", opencode, false)).toEqual({
			model: codex,
		});
	});

	it("requires disambiguation when the current provider does not offer an exact duplicate model ID", () => {
		const opencode = model("opencode", "gpt-5.6-sol");
		const codex = model("openai-codex", "gpt-5.6-sol");

		expect(resolveModelSelection([opencode, codex], "gpt-5.6-sol", "anthropic", opencode, false)).toEqual({
			ambiguousProviders: ["openai-codex", "opencode"],
		});
		expect(
			resolveModelSelection([opencode, codex], "openai-codex/gpt-5.6-sol", "anthropic", opencode, false),
		).toEqual({
			model: codex,
		});
		expect(resolveModelSelection([opencode, codex], "gpt-5.6-sol", "anthropic", codex, true)).toEqual({
			model: codex,
		});
	});

	it("wires Enter to select a unique exact model ID", async () => {
		const current = model("anthropic", "current-model");
		const unique = model("opencode", "unique-model");
		const harness = await createSelectorHarness([current, unique], current);

		typeInput(harness.component, "unique-model");
		harness.component.handleInput("\r");
		expect(harness.onSelect).toHaveBeenCalledOnce();
		expect(harness.onSelect).toHaveBeenCalledWith(unique);
	});

	it("wires Enter on a non-exact fuzzy query to the currently selected result", async () => {
		const current = model("anthropic", "current-model");
		const fuzzyMatch = model("openai-codex", "alpha-two");
		const harness = await createSelectorHarness([current, fuzzyMatch], current);

		typeInput(harness.component, "two");
		harness.component.handleInput("\r");
		expect(harness.onSelect).toHaveBeenCalledOnce();
		expect(harness.onSelect).toHaveBeenCalledWith(fuzzyMatch);
	});

	it("wires Enter to an ambiguity prompt and clears it when input changes", async () => {
		const opencode = model("opencode", "gpt-5.6-sol");
		const codex = model("openai-codex", "gpt-5.6-sol");
		const harness = await createSelectorHarness([opencode, codex], model("anthropic", "other"));

		typeInput(harness.component, "gpt-5.6-sol");
		harness.component.handleInput("\r");
		expect(harness.onSelect).not.toHaveBeenCalled();
		expect(harness.render()).toContain("Model ID is available from multiple providers");

		harness.component.handleInput("x");
		expect(harness.render()).not.toContain("Model ID is available from multiple providers");
	});

	it("wires Enter to prefer the current provider", async () => {
		const opencode = model("opencode", "gpt-5.6-sol");
		const codex = model("openai-codex", "gpt-5.6-sol");
		const harness = await createSelectorHarness([opencode, codex], model("openai-codex", "other"));

		typeInput(harness.component, "gpt-5.6-sol");
		harness.component.handleInput("\r");
		expect(harness.onSelect).toHaveBeenCalledOnce();
		expect(harness.onSelect).toHaveBeenCalledWith(codex);
	});

	it("wires Enter to an explicit provider/model selection", async () => {
		const opencode = model("opencode", "gpt-5.6-sol");
		const codex = model("openai-codex", "gpt-5.6-sol");
		const harness = await createSelectorHarness([opencode, codex], model("anthropic", "other"));

		typeInput(harness.component, "openai-codex/gpt-5.6-sol");
		harness.component.handleInput("\r");
		expect(harness.onSelect).toHaveBeenCalledOnce();
		expect(harness.onSelect).toHaveBeenCalledWith(codex);
	});

	it("wires arrow navigation to an explicit duplicate-model selection", async () => {
		const opencode = model("opencode", "gpt-5.6-sol");
		const codex = model("openai-codex", "gpt-5.6-sol");
		const harness = await createSelectorHarness([opencode, codex], model("anthropic", "other"));

		typeInput(harness.component, "gpt-5.6-sol");
		harness.component.handleInput("\r");
		harness.component.handleInput("\x1b[A");
		harness.component.handleInput("\r");
		expect(harness.onSelect).toHaveBeenCalledOnce();
		expect(harness.onSelect).toHaveBeenCalledWith(codex);
	});
});
