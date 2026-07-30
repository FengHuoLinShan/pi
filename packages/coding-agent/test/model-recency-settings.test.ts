import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("model recency settings", () => {
	const testDir = join(process.cwd(), "test-model-recency-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("moves a selected model to the front and removes duplicates", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ recentModels: ["test/one", "test/two", "test/one"] }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		manager.recordRecentModel("test", "two");

		expect(manager.getRecentModels()).toEqual(["test/two", "test/one"]);
	});

	it("keeps at most twenty recent models", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		for (let index = 0; index < 25; index++) {
			manager.recordRecentModel("test", `model-${index}`);
		}

		expect(manager.getRecentModels()).toHaveLength(20);
		expect(manager.getRecentModels()[0]).toBe("test/model-24");
		expect(manager.getRecentModels().at(-1)).toBe("test/model-5");
	});

	it("ignores project recentModels overrides", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ recentModels: ["global/model"] }));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ recentModels: ["project/model"] }));

		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });

		expect(manager.getRecentModels()).toEqual(["global/model"]);
	});
});
