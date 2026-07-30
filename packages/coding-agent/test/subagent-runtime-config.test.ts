import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../examples/extensions/subagent/agents.ts";
import {
	createSubagentStateEvent,
	getPiInvocation,
	summarizeTaskForStatus,
} from "../examples/extensions/subagent/index.ts";
import {
	type AgentRuntimeOverridesFile,
	buildRuntimeArgs,
	loadRuntimeOverrides,
	parseRuntimeOverrides,
	resolveAgentRuntime,
	resolveAndValidateAgentRuntime,
	saveRuntimeOverrides,
	updateRuntimeOverride,
	validateAgentRuntime,
} from "../examples/extensions/subagent/runtime-config.ts";

const model = (provider: string, id: string, reasoning = true): Model<Api> => ({
	id,
	name: id,
	provider,
	api: "openai-responses",
	baseUrl: "https://example.test/v1",
	reasoning,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

describe("subagent runtime config", () => {
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("applies task overrides over personal and agent defaults", () => {
		expect(
			resolveAgentRuntime(
				{ provider: "anthropic", model: "sonnet", thinking: "medium" },
				{ provider: "google", model: "gemini", thinking: "high" },
				{ provider: "openai", model: "gpt", thinking: "xhigh" },
			),
		).toEqual({ provider: "openai", model: "gpt", thinking: "xhigh" });
	});

	it("falls back field-by-field from task to personal to frontmatter", () => {
		expect(
			resolveAgentRuntime(
				{ provider: "anthropic", model: "sonnet", thinking: "medium" },
				{ model: "opus" },
				{ thinking: "high" },
			),
		).toEqual({ provider: "anthropic", model: "opus", thinking: "high" });
	});

	it("loads provider, model, and thinking defaults from agent frontmatter", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-frontmatter-"));
		temporaryDirectories.push(directory);
		const agentsDirectory = join(directory, ".pi", "agents");
		mkdirSync(agentsDirectory, { recursive: true });
		writeFileSync(
			join(agentsDirectory, "scout.md"),
			"---\nname: scout\ndescription: Scout\nprovider: openai\nmodel: gpt\nthinking: high\n---\nPrompt\n",
			"utf8",
		);
		expect(discoverAgents(directory, "project").agents[0]).toMatchObject({
			name: "scout",
			provider: "openai",
			model: "gpt",
			thinking: "high",
		});
	});

	it("reports non-string frontmatter fields without crashing discovery", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-invalid-frontmatter-"));
		temporaryDirectories.push(directory);
		const agentsDirectory = join(directory, ".pi", "agents");
		mkdirSync(agentsDirectory, { recursive: true });
		writeFileSync(
			join(agentsDirectory, "scout.md"),
			"---\nname: scout\ndescription: Scout\nprovider:\n  - openai\nthinking: 3\n---\nPrompt\n",
			"utf8",
		);
		expect(discoverAgents(directory, "project").agents[0]).toMatchObject({
			name: "scout",
			runtimeErrors: {
				provider: 'Agent "scout" has invalid provider',
				thinking: 'Agent "scout" has invalid thinking level "3"',
			},
		});
	});

	it("builds independent provider, model, and thinking CLI arguments", () => {
		expect(buildRuntimeArgs({ provider: "openai", model: "gpt", thinking: "high" })).toEqual([
			"--provider",
			"openai",
			"--model",
			"gpt",
			"--thinking",
			"high",
		]);
		const parallelRuntimes = [
			buildRuntimeArgs({ provider: "anthropic", model: "claude", thinking: "low" }),
			buildRuntimeArgs({ provider: "google", model: "gemini", thinking: "high" }),
		];
		expect(parallelRuntimes).toEqual([
			["--provider", "anthropic", "--model", "claude", "--thinking", "low"],
			["--provider", "google", "--model", "gemini", "--thinking", "high"],
		]);
	});

	it("preserves the tsx loader when restarting a TypeScript source CLI", () => {
		const currentScript = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const invocation = getPiInvocation(["--mode", "json"], {
			currentScript,
			execPath: "/usr/local/bin/node",
			execArgv: [
				"--inspect",
				"--require",
				"/repo/node_modules/tsx/dist/preflight.cjs",
				"--import",
				"file:///repo/node_modules/tsx/dist/loader.mjs",
			],
			cwd: "/repo",
			environment: { TSX_TSCONFIG_PATH: "tsconfig.json" },
		});

		expect(invocation).toEqual({
			command: "/usr/local/bin/node",
			args: [
				"--require",
				"/repo/node_modules/tsx/dist/preflight.cjs",
				"--import",
				"file:///repo/node_modules/tsx/dist/loader.mjs",
				currentScript,
				"--mode",
				"json",
			],
			env: { TSX_TSCONFIG_PATH: "/repo/tsconfig.json" },
		});
	});

	it("writes versioned overrides atomically with private permissions", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-runtime-"));
		temporaryDirectories.push(directory);
		const filePath = join(directory, "nested", "agent-runtimes.json");
		const config: AgentRuntimeOverridesFile = {
			version: 1,
			agents: { scout: { provider: "openai", model: "gpt", thinking: "low" } },
		};
		saveRuntimeOverrides(config, filePath);
		expect(parseRuntimeOverrides(readFileSync(filePath, "utf8"))).toEqual(config);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
	});

	it("reports invalid files without replacing their contents", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-runtime-invalid-"));
		temporaryDirectories.push(directory);
		const filePath = join(directory, "agent-runtimes.json");
		writeFileSync(filePath, "not-json", "utf8");
		const loaded = loadRuntimeOverrides(filePath);
		expect(loaded.error).toBeTruthy();
		await expect(updateRuntimeOverride("scout", { model: "gpt" }, filePath)).rejects.toThrow("Cannot edit");
		expect(readFileSync(filePath, "utf8")).toBe("not-json");
	});

	it("merges concurrent per-agent updates under a cross-process lock", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-runtime-concurrent-"));
		temporaryDirectories.push(directory);
		const filePath = join(directory, "agent-runtimes.json");
		await Promise.all([
			updateRuntimeOverride("scout", { provider: "openai", model: "gpt", thinking: "low" }, filePath),
			updateRuntimeOverride("reviewer", { provider: "anthropic", model: "claude", thinking: "high" }, filePath),
		]);
		expect(loadRuntimeOverrides(filePath).config.agents).toEqual({
			scout: { provider: "openai", model: "gpt", thinking: "low" },
			reviewer: { provider: "anthropic", model: "claude", thinking: "high" },
		});
	});

	it("validates authentication and model-specific effort", () => {
		const configured = model("openai", "gpt");
		const registry = {
			getAll: () => [configured],
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		expect(validateAgentRuntime({ provider: "openai", model: "gpt", thinking: "high" }, registry).runtime).toEqual({
			provider: "openai",
			model: "gpt",
			thinking: "high",
		});
		expect(validateAgentRuntime({ provider: "openai", model: "gpt", thinking: "xhigh" }, registry).error).toContain(
			"does not support effort",
		);
		expect(
			validateAgentRuntime({ provider: "openai", model: "gpt" }, { ...registry, getAvailable: () => [] }).error,
		).toContain("authentication");
	});

	it("rejects unknown models before process arguments are used", () => {
		const configured = model("openai", "gpt");
		const registry = {
			getAll: () => [configured],
			getAvailable: () => [configured],
			find: () => undefined,
		};
		expect(validateAgentRuntime({ provider: "openai", model: "missing" }, registry).error).toContain("was not found");
	});

	it("allows higher-priority overrides to replace invalid frontmatter fields", () => {
		const configured = model("openai", "gpt");
		const registry = {
			getAll: () => [configured],
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		expect(
			resolveAndValidateAgentRuntime(
				{ provider: "openai", model: "gpt" },
				undefined,
				{ thinking: "high" },
				{ thinking: "invalid frontmatter thinking" },
				registry,
			).runtime,
		).toEqual({ provider: "openai", model: "gpt", thinking: "high" });
		expect(
			resolveAndValidateAgentRuntime(
				{ provider: "openai", model: "gpt" },
				undefined,
				{},
				{ thinking: "invalid frontmatter thinking" },
				registry,
			).error,
		).toBe("invalid frontmatter thinking");
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ model: "openai/gpt" },
				{ provider: "invalid frontmatter provider" },
				registry,
			).runtime,
		).toEqual({ provider: "openai", model: "gpt" });
		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ model: "gpt" },
				{},
				{ provider: "invalid frontmatter provider" },
				registry,
			).runtime,
		).toEqual({ provider: "openai", model: "gpt" });
	});

	it("redacts credential-shaped values from task status summaries", () => {
		const summary = summarizeTaskForStatus(
			"Inspect token=secret-token-value and Bearer abc.def.ghi with key sk-1234567890abcdef",
		);
		expect(summary).not.toContain("secret-token-value");
		expect(summary).not.toContain("abc.def.ghi");
		expect(summary).not.toContain("sk-1234567890abcdef");
		expect(summary).toContain("[redacted]");
	});

	it("publishes a state DTO without raw tasks, messages, stderr, or credentials", () => {
		const event = createSubagentStateEvent({
			toolCallId: "call:1",
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				{
					taskId: "call:1:0",
					agent: "scout",
					agentSource: "user",
					task: "MODEL_OUTPUT_SENTINEL",
					taskSummary: "Inspect token=SECRET_CREDENTIAL",
					exitCode: 1,
					status: "failed",
					messages: [],
					stderr: "STDERR_SECRET",
					errorMessage: "ERROR_SECRET",
					usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 5, turns: 1 },
				},
			],
		});
		const serialized = JSON.stringify(event);
		expect(serialized).not.toContain("MODEL_OUTPUT_SENTINEL");
		expect(serialized).not.toContain("SECRET_CREDENTIAL");
		expect(serialized).not.toContain("STDERR_SECRET");
		expect(serialized).not.toContain("ERROR_SECRET");
		expect(event.results[0].taskSummary).toBe("Inspect token=[redacted]");
	});
});
