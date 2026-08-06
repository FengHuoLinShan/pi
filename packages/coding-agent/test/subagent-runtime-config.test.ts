import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../examples/extensions/subagent/agents.ts";
import {
	buildSubagentRuntimeArgs,
	captureParentModelSnapshot,
	createSubagentStateEvent,
	DEFAULT_TASK_TIMEOUT_MS,
	formatParentVisibleResult,
	getPiInvocation,
	normalizeTaskTimeout,
	parseSubagentMessageEvent,
	resolveTaskCwd,
	summarizeTaskForStatus,
	updateSubagentActivity,
} from "../examples/extensions/subagent/index.ts";
import {
	type AgentRuntimeOverridesFile,
	buildRuntimeArgs,
	createChildRuntimePreflight,
	loadRuntimeOverrides,
	MODEL_POLICY_VALUES,
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

const runtimeRegistry = (...configured: Model<Api>[]) => ({
	getAll: () => configured,
	getAvailable: () => configured,
	find: (provider: string, id: string) =>
		configured.find((candidate) => candidate.provider === provider && candidate.id === id),
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
		expect(
			resolveAgentRuntime(
				{ modelPolicy: "child-default" },
				{ modelPolicy: "inherit-parent" },
				{ modelPolicy: "child-default" },
			),
		).toEqual({ modelPolicy: "child-default" });
	});

	it("lets a task child-default policy replace an explicit persona model", () => {
		expect(
			resolveAgentRuntime({ provider: "anthropic", model: "sonnet" }, undefined, { modelPolicy: "child-default" }),
		).toEqual({ modelPolicy: "child-default" });
	});

	it("lets an explicit task model replace the researcher inherit-parent policy", () => {
		expect(
			resolveAgentRuntime({ modelPolicy: "inherit-parent" }, undefined, { provider: "openai", model: "gpt" }),
		).toEqual({ provider: "openai", model: "gpt" });
	});

	it("lets a personal child-default policy replace an explicit persona model", () => {
		expect(
			resolveAgentRuntime({ provider: "anthropic", model: "sonnet" }, { modelPolicy: "child-default" }, {}),
		).toEqual({ modelPolicy: "child-default" });
	});

	it("lets a personal explicit model replace a persona child-default policy", () => {
		expect(resolveAgentRuntime({ modelPolicy: "child-default" }, { provider: "openai", model: "gpt" }, {})).toEqual({
			provider: "openai",
			model: "gpt",
		});
	});

	it("completes a task model from a lower explicit provider layer", () => {
		expect(
			resolveAgentRuntime(
				{ provider: "anthropic", model: "sonnet" },
				{ modelPolicy: "inherit-parent" },
				{ model: "opus" },
			),
		).toEqual({ provider: "anthropic", model: "opus" });
	});

	it("does not complete a task provider from a lower policy layer", () => {
		const configured = model("openai", "gpt");
		const registry = {
			getAll: () => [configured],
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		expect(
			resolveAndValidateAgentRuntime(
				{ modelPolicy: "inherit-parent" },
				undefined,
				{ provider: "openai" },
				undefined,
				registry,
				{
					parentModel: { provider: "openai", id: "gpt" },
				},
			),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_NOT_FOUND" });
	});

	it("drops lower-layer thinking when a task selects child-default", () => {
		expect(
			resolveAgentRuntime(
				{ provider: "anthropic", model: "sonnet", thinking: "high" },
				{ thinking: "medium" },
				{ modelPolicy: "child-default" },
			),
		).toEqual({ modelPolicy: "child-default" });
	});

	it("keeps the fixed conflict diagnostic for same-layer child-default and thinking", () => {
		const configured = model("openai", "gpt");
		const registry = {
			getAll: () => [configured],
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ modelPolicy: "child-default", thinking: "high" },
				undefined,
				registry,
			),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_POLICY_CONFLICT" });
	});

	it("reports frontmatter errors before errors introduced by higher selector resolution", () => {
		const configured = model("openai", "gpt");
		const registry = {
			getAll: () => [configured],
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ provider: "openai" },
				{ model: "invalid frontmatter model" },
				registry,
			),
		).toEqual({ error: "invalid frontmatter model" });
	});

	it("accepts only documented model policies in persisted overrides", () => {
		expect(MODEL_POLICY_VALUES).toEqual(["inherit-parent", "child-default"]);
		expect(
			parseRuntimeOverrides(
				JSON.stringify({ version: 1, agents: { scout: { modelPolicy: "inherit-parent", thinking: "low" } } }),
			),
		).toEqual({ version: 1, agents: { scout: { modelPolicy: "inherit-parent", thinking: "low" } } });
		expect(() =>
			parseRuntimeOverrides(JSON.stringify({ version: 1, agents: { scout: { modelPolicy: "unsafe-policy" } } })),
		).toThrow("modelPolicy");
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

	it("discovers the bundled researcher persona with evidence-focused tools and inherited model policy", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-researcher-"));
		temporaryDirectories.push(directory);
		const agentsDirectory = join(directory, ".pi", "agents");
		mkdirSync(agentsDirectory, { recursive: true });
		const source = fileURLToPath(new URL("../examples/extensions/subagent/agents/researcher.md", import.meta.url));
		writeFileSync(join(agentsDirectory, "researcher.md"), readFileSync(source, "utf8"), "utf8");
		expect(discoverAgents(directory, "project").agents[0]).toMatchObject({
			name: "researcher",
			tools: ["read", "bash"],
			modelPolicy: "inherit-parent",
			description: expect.stringContaining("evidence"),
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

	it("disables recursive extensions and prompt templates while retaining skills and context files", () => {
		const args = buildSubagentRuntimeArgs({ provider: "openai", model: "gpt", thinking: "low" }, ["read"]);
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-prompt-templates");
		expect(args).not.toContain("--no-skills");
		expect(args).not.toContain("--no-context-files");
		expect(args).toEqual(expect.arrayContaining(["--tools", "read", "--provider", "openai", "--model", "gpt"]));
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
			agents: {
				scout: { provider: "openai", model: "gpt", thinking: "low", modelPolicy: "inherit-parent" },
			},
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
		expect(validateAgentRuntime({ provider: "openai", model: "missing" }, registry)).toMatchObject({
			errorCode: "SUBAGENT_MODEL_NOT_FOUND",
			error: "Selected subagent model is not available in the child runtime.",
		});
	});

	it("inherits one captured parent model for thinking-only runtime overrides", () => {
		const parent = model("openai", "gpt");
		const registry = {
			getAll: () => [parent],
			getAvailable: () => [parent],
			find: (provider: string, id: string) =>
				provider === parent.provider && id === parent.id ? parent : undefined,
		};
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { thinking: "high" }, undefined, registry, {
				parentModel: { provider: "openai", id: "gpt" },
				childRegistry: registry,
			}),
		).toEqual({
			runtime: { provider: "openai", model: "gpt", thinking: "high", modelPolicy: "inherit-parent" },
		});
	});

	it("reports credential-blind diagnostics when task thinking is unsupported by a personal model", () => {
		const personal = {
			...model("opencode", "deepseek-v4-flash-free"),
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
		};
		const parent = model("openai-codex", "gpt-5.6-sol");
		const registry = runtimeRegistry(personal, parent);

		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ provider: personal.provider, model: personal.id, thinking: "high" },
				{ thinking: "low" },
				undefined,
				registry,
				{
					parentModel: { provider: parent.provider, id: parent.id },
					childRegistry: registry,
				},
			),
		).toEqual({
			errorCode: "SUBAGENT_MODEL_EFFORT_UNSUPPORTED",
			error: "Selected subagent model does not support effort.",
			diagnostic: {
				provider: "opencode",
				model: "deepseek-v4-flash-free",
				thinking: "low",
				supportedThinking: ["high", "max"],
			},
		});
	});

	it("adjusts unsupported role and personal default thinking levels with the official model clamp", () => {
		const personal = {
			...model("opencode", "deepseek-v4-flash-free"),
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
		};
		const registry = runtimeRegistry(personal);

		const expected = {
			runtime: { provider: "opencode", model: "deepseek-v4-flash-free", thinking: "high" },
			adjustment: {
				from: "medium",
				to: "high",
				message: "Adjusted default thinking from medium to high for model compatibility.",
			},
		};
		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ provider: personal.provider, model: personal.id, thinking: "medium" },
				{},
				undefined,
				registry,
				{ childRegistry: registry },
			),
		).toEqual(expected);
		expect(
			resolveAndValidateAgentRuntime(
				{ provider: personal.provider, model: personal.id, thinking: "medium" },
				undefined,
				{},
				undefined,
				registry,
				{ childRegistry: registry },
			),
		).toEqual(expected);
	});

	it("leaves a supported role default thinking level unchanged", () => {
		const selected = model("openai", "gpt");
		const registry = runtimeRegistry(selected);

		expect(
			resolveAndValidateAgentRuntime(
				{ provider: selected.provider, model: selected.id, thinking: "high" },
				undefined,
				{},
				undefined,
				registry,
				{ childRegistry: registry },
			),
		).toEqual({ runtime: { provider: "openai", model: "gpt", thinking: "high" } });
	});

	it("reports an adjusted resolved runtime to the parent", () => {
		const content = formatParentVisibleResult({
			taskId: "call:adjusted:0",
			agent: "reviewer",
			agentSource: "user",
			task: "Review",
			taskSummary: "Review",
			exitCode: 0,
			status: "completed",
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			provider: "opencode",
			model: "deepseek-v4-flash-free",
			thinking: "high",
			thinkingAdjustment: {
				from: "medium",
				to: "high",
				message: "Adjusted default thinking from medium to high for model compatibility.",
			},
		});

		expect(content).toContain('provider="opencode" model="deepseek-v4-flash-free" thinking="high"');
		expect(content).toContain("runtime adjustment: Adjusted default thinking from medium to high");
	});

	it("lets task inherit-parent override a personal explicit model while retaining task thinking", () => {
		const personal = model("opencode", "deepseek-v4-flash-free");
		const parent = model("openai-codex", "gpt-5.6-sol");
		const registry = runtimeRegistry(personal, parent);

		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ provider: personal.provider, model: personal.id, thinking: "high" },
				{ modelPolicy: "inherit-parent", thinking: "low" },
				undefined,
				registry,
				{
					parentModel: { provider: parent.provider, id: parent.id },
					childRegistry: registry,
				},
			),
		).toEqual({
			runtime: {
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				thinking: "low",
				modelPolicy: "inherit-parent",
			},
		});
	});

	it("returns fixed diagnostics for policy conflicts, absent parents, and parent-only runtime state", () => {
		const parentOnly = model("extension-provider", "runtime-model");
		const parentRegistry = {
			getAll: () => [parentOnly],
			getAvailable: () => [],
			find: (provider: string, id: string) =>
				provider === parentOnly.provider && id === parentOnly.id ? parentOnly : undefined,
		};
		const childRegistry = { getAll: () => [], getAvailable: () => [], find: () => undefined };
		expect(validateAgentRuntime({ provider: "openai" }, childRegistry)).toMatchObject({
			errorCode: "SUBAGENT_MODEL_NOT_FOUND",
		});
		expect(
			validateAgentRuntime({ provider: "openai", model: "gpt", modelPolicy: "inherit-parent" }, parentRegistry),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_POLICY_CONFLICT" });
		expect(
			resolveAndValidateAgentRuntime({}, undefined, {}, undefined, parentRegistry, { childRegistry }),
		).toMatchObject({ errorCode: "SUBAGENT_PARENT_MODEL_UNAVAILABLE" });
		expect(
			resolveAndValidateAgentRuntime({}, undefined, {}, undefined, parentRegistry, {
				parentModel: { provider: parentOnly.provider, id: parentOnly.id },
				childRegistry,
			}),
		).toMatchObject({ errorCode: "SUBAGENT_PARENT_RUNTIME_ONLY" });
	});

	it("keeps child-default model selection in the child CLI and rejects unsupported inherited effort", () => {
		const unsupported = model("openai", "gpt", false);
		const registry = {
			getAll: () => [unsupported],
			getAvailable: () => [unsupported],
			find: (provider: string, id: string) =>
				provider === unsupported.provider && id === unsupported.id ? unsupported : undefined,
		};
		expect(validateAgentRuntime({ modelPolicy: "child-default" }, registry)).toEqual({
			runtime: { modelPolicy: "child-default" },
		});
		expect(buildRuntimeArgs({ modelPolicy: "child-default" })).toEqual([]);
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { thinking: "high" }, undefined, registry, {
				parentModel: { provider: unsupported.provider, id: unsupported.id },
				childRegistry: registry,
			}),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_EFFORT_UNSUPPORTED" });
	});

	it("never exposes credential or header sentinels through argv or runtime diagnostics", () => {
		const secret = "SECRET_AUTH_TOKEN_HEADER_SENTINEL";
		const throwingRegistry = {
			getAll: () => {
				throw new Error(secret);
			},
			getAvailable: () => [],
			find: () => {
				throw new Error(secret);
			},
		};
		const result = validateAgentRuntime({ provider: "openai", model: "gpt" }, throwingRegistry);
		const serialized = JSON.stringify({ result, argv: buildRuntimeArgs({ modelPolicy: "child-default" }) });
		expect(result).toMatchObject({ errorCode: "SUBAGENT_CHILD_RESOURCE_UNAVAILABLE" });
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("--api-key");
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
				{},
				{ thinking: "invalid frontmatter thinking without parent" },
				registry,
			).error,
		).toBe("invalid frontmatter thinking without parent");
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
			),
		).toEqual({ error: "invalid frontmatter provider" });
	});

	it("keeps an invalid persona provider unless a higher model names a known provider", () => {
		const registry = runtimeRegistry(
			model("openai", "gpt"),
			model("openai", "family/gpt"),
			model("openai", "unknown/gpt"),
		);
		for (const higherModel of ["/gpt", "openai/", "unknown/gpt"]) {
			expect(
				resolveAndValidateAgentRuntime(
					{},
					undefined,
					{ model: higherModel },
					{ provider: "invalid persona provider" },
					registry,
				),
			).toEqual({ error: "invalid persona provider" });
		}
	});

	it("lets a higher model replace an invalid persona provider only for known provider qualification", () => {
		const registry = runtimeRegistry(model("openai", "gpt"), model("openai", "family/gpt"));
		for (const [higherModel, expectedModel] of [
			["openai/gpt", "gpt"],
			["openai/family/gpt", "family/gpt"],
		] as const) {
			expect(
				resolveAndValidateAgentRuntime(
					{},
					undefined,
					{ model: higherModel },
					{ provider: "invalid persona provider" },
					registry,
				),
			).toEqual({ runtime: { provider: "openai", model: expectedModel } });
		}
	});

	it("does not bypass a consumed persona provider error through a child raw-ID collision", () => {
		const parentRegistry = runtimeRegistry(model("openai", "gpt"));
		const childRegistry = runtimeRegistry(model("collision-provider", "openai/gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ model: "openai/gpt" },
				{ provider: "invalid persona provider" },
				parentRegistry,
				{ childRegistry },
			),
		).toEqual({ error: "invalid persona provider" });
	});

	it("uses child qualification for both persona error consumption and final selection", () => {
		const parentRegistry = runtimeRegistry(model("parent-provider", "parent-model"));
		const childRegistry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ model: "openai/gpt" },
				{ provider: "invalid persona provider" },
				parentRegistry,
				{ childRegistry },
			),
		).toEqual({ runtime: { provider: "openai", model: "gpt" } });
	});

	it("loads child configured models exactly once for model-only qualification", () => {
		const parentRegistry = runtimeRegistry(model("parent-provider", "parent-model"));
		const configured = model("openai", "gpt");
		let childGetAllCalls = 0;
		const childRegistry = {
			getAll: () => {
				childGetAllCalls++;
				return [configured];
			},
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { model: "openai/gpt" }, undefined, parentRegistry, {
				childRegistry,
			}),
		).toEqual({ runtime: { provider: "openai", model: "gpt" } });
		expect(childGetAllCalls).toBe(1);
	});

	it("does not reinterpret a child raw-ID collision through parent qualification", () => {
		const parentModel = model("openai", "gpt");
		const childModel = model("collision-provider", "openai/gpt");
		const parentRegistry = runtimeRegistry(parentModel);
		const childRegistry = {
			...runtimeRegistry(childModel),
			getAvailable: () => [],
		};
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { model: "openai/gpt" }, undefined, parentRegistry, {
				childRegistry,
			}),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_AUTH_UNAVAILABLE" });
	});

	it("does not reinterpret a child qualified model through a parent raw-ID collision", () => {
		const parentModel = model("collision-provider", "openai/gpt");
		const childModel = model("openai", "gpt");
		const parentRegistry = runtimeRegistry(parentModel);
		const childRegistry = {
			...runtimeRegistry(childModel),
			getAvailable: () => [],
		};
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { model: "openai/gpt" }, undefined, parentRegistry, {
				childRegistry,
			}),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_AUTH_UNAVAILABLE" });
	});

	it("canonicalizes qualified provider casing while matching model IDs exactly", () => {
		const parentRegistry = runtimeRegistry(model("parent-provider", "parent-model"));
		const childRegistry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { model: "OPENAI/gpt" }, undefined, parentRegistry, {
				childRegistry,
			}),
		).toEqual({ runtime: { provider: "openai", model: "gpt" } });
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { model: "OPENAI/GPT" }, undefined, parentRegistry, {
				childRegistry,
			}),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_NOT_FOUND" });
	});

	it("fails closed when child model-only qualification cannot load configured models", () => {
		const secret = "CHILD_GET_ALL_FAILURE_SENTINEL";
		const parentRegistry = runtimeRegistry(model("openai", "gpt"));
		const childRegistry = {
			getAll: () => {
				throw new Error(secret);
			},
			getAvailable: () => [],
			find: () => undefined,
		};
		const result = resolveAndValidateAgentRuntime({}, undefined, { model: "openai/gpt" }, undefined, parentRegistry, {
			childRegistry,
		});
		expect(result).toEqual({
			errorCode: "SUBAGENT_CHILD_RESOURCE_UNAVAILABLE",
			error: "Child model resources could not be loaded for subagent preflight.",
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it("does not load configured model lists for complete explicit or policy-only selectors", () => {
		const configured = model("openai", "gpt");
		let parentGetAllCalls = 0;
		let childGetAllCalls = 0;
		const parentRegistry = {
			getAll: () => {
				parentGetAllCalls++;
				return [configured];
			},
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		const childRegistry = {
			getAll: () => {
				childGetAllCalls++;
				return [configured];
			},
			getAvailable: () => [configured],
			find: (provider: string, id: string) =>
				provider === configured.provider && id === configured.id ? configured : undefined,
		};
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ provider: "openai", model: "gpt" },
				undefined,
				parentRegistry,
				{ childRegistry },
			),
		).toEqual({ runtime: { provider: "openai", model: "gpt" } });
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { modelPolicy: "child-default" }, undefined, parentRegistry, {
				childRegistry,
			}),
		).toEqual({ runtime: { modelPolicy: "child-default" } });
		expect(
			resolveAndValidateAgentRuntime({}, undefined, { modelPolicy: "inherit-parent" }, undefined, parentRegistry, {
				parentModel: { provider: "openai", id: "gpt" },
				childRegistry,
			}),
		).toEqual({ runtime: { provider: "openai", model: "gpt", modelPolicy: "inherit-parent" } });
		expect({ parentGetAllCalls, childGetAllCalls }).toEqual({ parentGetAllCalls: 0, childGetAllCalls: 0 });
	});

	it("drops invalid persona thinking when a personal child-default selector wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ modelPolicy: "child-default" },
				{},
				{ thinking: "invalid persona thinking" },
				registry,
			),
		).toEqual({ runtime: { modelPolicy: "child-default" } });
	});

	it("drops invalid persona thinking when a task child-default selector wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ modelPolicy: "child-default" },
				{ thinking: "invalid persona thinking" },
				registry,
			),
		).toEqual({ runtime: { modelPolicy: "child-default" } });
	});

	it("drops an invalid persona provider when a higher child-default selector wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ modelPolicy: "child-default" },
				{ provider: "invalid persona provider" },
				registry,
			),
		).toEqual({ runtime: { modelPolicy: "child-default" } });
	});

	it("drops an invalid persona model when a higher child-default selector wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ modelPolicy: "child-default" },
				{},
				{ model: "invalid persona model" },
				registry,
			),
		).toEqual({ runtime: { modelPolicy: "child-default" } });
	});

	it("drops an invalid persona provider when a higher inherit-parent selector wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ modelPolicy: "inherit-parent" },
				{},
				{ provider: "invalid persona provider" },
				registry,
				{ parentModel: { provider: "openai", id: "gpt" } },
			),
		).toEqual({ runtime: { provider: "openai", model: "gpt", modelPolicy: "inherit-parent" } });
	});

	it("drops an invalid persona model when a higher inherit-parent selector wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ modelPolicy: "inherit-parent" },
				{ model: "invalid persona model" },
				registry,
				{ parentModel: { provider: "openai", id: "gpt" } },
			),
		).toEqual({ runtime: { provider: "openai", model: "gpt", modelPolicy: "inherit-parent" } });
	});

	it("drops an invalid persona model policy when a higher explicit selector wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ provider: "openai", model: "gpt" },
				{ modelPolicy: "invalid persona model policy" },
				registry,
			),
		).toEqual({ runtime: { provider: "openai", model: "gpt" } });
	});

	it("drops an invalid persona model policy when a higher policy wins", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ modelPolicy: "inherit-parent" },
				{},
				{ modelPolicy: "invalid persona model policy" },
				registry,
				{ parentModel: { provider: "openai", id: "gpt" } },
			),
		).toEqual({ runtime: { provider: "openai", model: "gpt", modelPolicy: "inherit-parent" } });
	});

	it("keeps an invalid persona model error when a higher explicit selector still needs that model", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ provider: "openai" },
				{ model: "invalid persona model" },
				registry,
			),
		).toEqual({ error: "invalid persona model" });
	});

	it("keeps an invalid persona provider error when a higher explicit selector still needs that provider", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ model: "gpt" },
				{ provider: "invalid persona provider" },
				registry,
			),
		).toEqual({ error: "invalid persona provider" });
	});

	it("keeps invalid persona thinking when inherit-parent wins without a higher thinking value", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				undefined,
				{ modelPolicy: "inherit-parent" },
				{ thinking: "invalid persona thinking" },
				registry,
				{ parentModel: { provider: "openai", id: "gpt" } },
			),
		).toEqual({ error: "invalid persona thinking" });
	});

	it("drops invalid persona thinking when inherit-parent and higher thinking both win", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{},
				{ modelPolicy: "inherit-parent", thinking: "high" },
				{},
				{ thinking: "invalid persona thinking" },
				registry,
				{ parentModel: { provider: "openai", id: "gpt" } },
			),
		).toEqual({
			runtime: { provider: "openai", model: "gpt", thinking: "high", modelPolicy: "inherit-parent" },
		});
	});

	it("keeps the fixed conflict for same-layer child-default and valid thinking", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		expect(
			resolveAndValidateAgentRuntime(
				{ modelPolicy: "child-default", thinking: "high" },
				undefined,
				{},
				undefined,
				registry,
			),
		).toMatchObject({ errorCode: "SUBAGENT_MODEL_POLICY_CONFLICT" });
	});

	it("keeps the fixed conflict for same-layer child-default and invalid fields", () => {
		const registry = runtimeRegistry(model("openai", "gpt"));
		for (const frontmatterErrors of [{ thinking: "invalid persona thinking" }, { model: "invalid persona model" }]) {
			expect(
				resolveAndValidateAgentRuntime(
					{ modelPolicy: "child-default" },
					undefined,
					{},
					frontmatterErrors,
					registry,
				),
			).toMatchObject({ errorCode: "SUBAGENT_MODEL_POLICY_CONFLICT" });
		}
	});

	it("keeps README explicit-model and policy-only examples semantically separate and parseable", () => {
		const readme = readFileSync(
			fileURLToPath(new URL("../examples/extensions/subagent/README.md", import.meta.url)),
			"utf8",
		);
		const frontmatterExample = readme.match(/```markdown\n(---\n[\s\S]*?\n---)/)?.[1];
		expect(frontmatterExample).toBeDefined();
		expect(frontmatterExample).toContain("provider: anthropic");
		expect(frontmatterExample).toContain("model: claude-haiku-4-5");
		expect(frontmatterExample).not.toContain("modelPolicy:");

		const overrideExamples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
			parseRuntimeOverrides(match[1]),
		);
		expect(overrideExamples).toHaveLength(2);
		expect(overrideExamples[0].agents.scout).toMatchObject({
			provider: "openai-codex",
			model: "gpt-5.6-codex",
		});
		expect(overrideExamples[0].agents.scout.modelPolicy).toBeUndefined();
		expect(overrideExamples[1]).toEqual({
			version: 1,
			agents: { researcher: { modelPolicy: "inherit-parent", thinking: "high" } },
		});
	});

	it("captures an immutable parent model snapshot once for a tool execution", () => {
		const current = { provider: "openai", id: "gpt" };
		const snapshot = captureParentModelSnapshot(current);
		current.provider = "changed-provider";
		current.id = "changed-model";
		expect(snapshot).toEqual({ provider: "openai", id: "gpt" });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(captureParentModelSnapshot(undefined)).toBeUndefined();
	});

	it("preflights child-equivalent auth and models without exposing stored credentials", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-subagent-preflight-"));
		temporaryDirectories.push(directory);
		const secret = "CHILD_PREFLIGHT_SECRET_SENTINEL";
		writeFileSync(
			join(directory, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: secret } }),
			"utf8",
		);
		const preflight = await createChildRuntimePreflight(directory);
		expect(preflight.error).toBeUndefined();
		expect(preflight.registry?.getAvailable().some((candidate) => candidate.provider === "anthropic")).toBe(true);
		expect(JSON.stringify(preflight)).not.toContain(secret);
	});

	it("normalizes finite task timeouts and applies the documented default", () => {
		expect(normalizeTaskTimeout(undefined)).toBe(DEFAULT_TASK_TIMEOUT_MS);
		expect(normalizeTaskTimeout(12.2)).toBe(13);
		for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
			expect(() => normalizeTaskTimeout(invalid)).toThrow("timeoutMs");
		}
	});

	it("resolves omitted and relative task cwd inside the canonical workspace", () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-cwd-"));
		temporaryDirectories.push(workspace);
		mkdirSync(join(workspace, "nested"));
		expect(resolveTaskCwd(workspace, undefined)).toBe(realpathSync(workspace));
		expect(resolveTaskCwd(workspace, "nested")).toBe(realpathSync(join(workspace, "nested")));
	});

	it("rejects missing, parent, and symlink cwd escapes", () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-contained-"));
		const outside = mkdtempSync(join(tmpdir(), "pi-subagent-outside-"));
		temporaryDirectories.push(workspace, outside);
		symlinkSync(outside, join(workspace, "escape"), "dir");
		expect(() => resolveTaskCwd(workspace, "missing")).toThrow("existing directory");
		expect(() => resolveTaskCwd(workspace, "..")).toThrow("outside workspace");
		expect(() => resolveTaskCwd(workspace, "escape")).toThrow("outside workspace");
	});

	it("publishes bounded activity metadata without assistant text or private reasoning", () => {
		let activity = updateSubagentActivity(
			undefined,
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "x".repeat(3000) },
			}),
			100,
		);
		expect(activity).toMatchObject({ phase: "responding", lastActivityAt: 100 });
		if (!activity) throw new Error("Expected text activity");
		expect(activity.output).toBe("[responding]");
		activity = updateSubagentActivity(
			activity,
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					partial: { name: "read", arguments: { token: "secret" } },
				},
			}),
			200,
		);
		expect(activity).toMatchObject({ phase: "tool:read", lastActivityAt: 200 });
		if (!activity) throw new Error("Expected tool activity");
		expect(activity.output).toContain("[tool: read]");
		expect(activity.output).not.toContain("secret");
		const unchanged = updateSubagentActivity(activity, "{malformed", 300);
		expect(unchanged).toEqual(activity);
		const hidden = updateSubagentActivity(
			activity,
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE_REASONING" },
			}),
			400,
		);
		expect(JSON.stringify(hidden)).not.toContain("PRIVATE_REASONING");
	});

	it("withholds fragmented deltas and live tool arguments from activity snapshots", () => {
		let activity = updateSubagentActivity(
			undefined,
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Bearer " } }),
			100,
		);
		for (const [delta, now] of [
			["credential", 200],
			["token", 300],
			["=credential", 400],
		] as const) {
			activity = updateSubagentActivity(
				activity,
				JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }),
				now,
			);
		}
		activity = updateSubagentActivity(
			activity,
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					partial: { name: "read", arguments: { authorization: "Bearer credential" } },
				},
			}),
			500,
		);
		const details = {
			toolCallId: "call:fragments",
			mode: "single" as const,
			revision: 1,
			expectedTasks: 1,
			agentScope: "user" as const,
			projectAgentsDir: null,
			results: [
				{
					taskId: "call:fragments:0",
					agent: "scout",
					agentSource: "user" as const,
					task: "safe task",
					taskSummary: "safe task",
					exitCode: -1,
					status: "running" as const,
					activityOutput: activity?.output,
					lastActivityAt: activity?.lastActivityAt,
					phase: activity?.phase,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				},
			],
		};
		const serialized = JSON.stringify({ activity, details, event: createSubagentStateEvent(details) });
		expect(serialized).toContain("tool:read");
		expect(serialized).not.toContain("Bearer");
		expect(serialized).not.toContain("credential");
		expect(serialized).not.toContain("token");
		expect(serialized).not.toContain("authorization");
	});

	it("ignores role-only and malformed child message events", () => {
		for (const line of [
			JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: null } }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text" }] } }),
			JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", content: "bad" } }),
		]) {
			expect(parseSubagentMessageEvent(line)).toBeUndefined();
		}
		expect(() => parseSubagentMessageEvent("{malformed")).not.toThrow();
		expect(parseSubagentMessageEvent("{malformed")).toBeUndefined();
	});

	it("withholds child tool arguments from result details while preserving output and tool identity", () => {
		const parsed = parseSubagentMessageEvent(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "SAFE_FINAL_OUTPUT" },
						{
							type: "toolCall",
							id: "tool-call-1",
							name: "read",
							arguments: {
								path: "/harmless/original/path",
								authorization: "Bearer ORIGINAL_AUTHORIZATION_VALUE",
								token: "ORIGINAL_TOKEN_VALUE",
								nested: { secret: "ORIGINAL_NESTED_VALUE" },
							},
						},
						{ type: "thinking", thinking: "ORIGINAL_PRIVATE_REASONING" },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			}),
		);
		expect(parsed?.type).toBe("message_end");
		if (!parsed || parsed.type !== "message_end") throw new Error("Expected valid assistant message_end");
		const result = {
			taskId: "call:details:0",
			agent: "scout",
			agentSource: "user" as const,
			task: "safe task",
			taskSummary: "safe task",
			exitCode: 0,
			status: "completed" as const,
			messages: [parsed.message],
			stderr: "",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		};
		const details = {
			toolCallId: "call:details",
			mode: "single" as const,
			revision: 1,
			expectedTasks: 1,
			agentScope: "user" as const,
			projectAgentsDir: null,
			results: [result],
		};
		const serializedResult = JSON.stringify({
			content: [{ type: "text", text: "SAFE_FINAL_OUTPUT" }],
			details,
		});
		expect(parsed.message.content).toEqual([
			{ type: "text", text: "SAFE_FINAL_OUTPUT" },
			{
				type: "toolCall",
				id: "tool-call-1",
				name: "read",
				arguments: {},
				argumentMetadata: { visibility: "redacted", count: 4 },
			},
		]);
		expect(serializedResult).toContain('"argumentMetadata":{"visibility":"redacted","count":4}');
		expect(serializedResult).toContain('"arguments":{}');
		expect(serializedResult).toContain("SAFE_FINAL_OUTPUT");
		expect(serializedResult).toContain("tool-call-1");
		expect(serializedResult).toContain('"name":"read"');
		for (const rawValue of [
			"/harmless/original/path",
			"Bearer ORIGINAL_AUTHORIZATION_VALUE",
			"ORIGINAL_TOKEN_VALUE",
			"ORIGINAL_NESTED_VALUE",
			"ORIGINAL_PRIVATE_REASONING",
			'"path"',
			'"authorization"',
			'"token"',
			'"nested"',
		]) {
			expect(serializedResult).not.toContain(rawValue);
		}
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
			revision: 4,
			expectedTasks: 1,
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
		expect(event).toMatchObject({ revision: 4, expectedTasks: 1 });
		expect(Object.isFrozen(event)).toBe(true);
		expect(Object.isFrozen(event.results)).toBe(true);
		expect(Object.isFrozen(event.results[0])).toBe(true);
		expect(Object.isFrozen(event.results[0].usage)).toBe(true);
	});

	it("rejects state snapshots that change authoritative call cardinality", () => {
		expect(() =>
			createSubagentStateEvent({
				toolCallId: "call:cardinality",
				mode: "parallel",
				revision: 2,
				expectedTasks: 3,
				agentScope: "user",
				projectAgentsDir: null,
				results: [],
			}),
		).toThrow("expectedTasks");
	});
});
