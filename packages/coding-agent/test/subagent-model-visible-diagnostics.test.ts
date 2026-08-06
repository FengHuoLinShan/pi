import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentExtension from "../examples/extensions/subagent/index.ts";
import * as runtimeConfig from "../examples/extensions/subagent/runtime-config.ts";
import { localProcessRuntime } from "../src/core/process-runtime.ts";

const DIAGNOSTIC = [
	"Error code: SUBAGENT_MODEL_EFFORT_UNSUPPORTED",
	"Message: Selected subagent model does not support effort.",
	"Resolved runtime: opencode/deepseek-v4-flash-free:low",
	"Supported thinking: high, max",
	"Canonical cwd: ",
	"Effective timeout: 180000 ms",
];

function getSubagentTool(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	subagentExtension({
		on: () => () => {},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand: () => {},
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI);
	if (!tool) throw new Error("Subagent tool was not registered");
	return tool;
}

function diagnosticModel(): Model<Api> {
	return {
		id: "deepseek-v4-flash-free",
		name: "diagnostic fixture",
		provider: "opencode",
		api: "openai-responses",
		baseUrl: "https://CONFIG_VALUE_SENTINEL.test/v1",
		headers: {
			Authorization: "Bearer HEADER_CREDENTIAL_SENTINEL",
			"X-Api-Key": "API_KEY_SENTINEL",
			"X-Auth": "AUTH_SENTINEL",
			"X-Env": "ENV_SENTINEL",
			"X-Stderr": "STDERR_SENTINEL",
		},
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

describe("subagent model-visible preflight diagnostics", () => {
	const temporaryDirectories: string[] = [];
	const originalAgentDir = process.env.PI_AGENT_DIR;

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = originalAgentDir;
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("returns the same fixed safe diagnostic to the model for single, parallel, and chain preflight failures", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-visible-diagnostic-"));
		const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-visible-agent-dir-"));
		temporaryDirectories.push(workspace, agentDir);
		process.env.PI_AGENT_DIR = agentDir;
		const agentsDir = join(workspace, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "diagnostic-fixture-agent.md"),
			"---\nname: diagnostic-fixture-agent\ndescription: Diagnostic fixture\n---\nFixture prompt\n",
			"utf8",
		);

		const model = diagnosticModel();
		const registry = {
			getAll: () => [model],
			getAvailable: () => [model],
			find: (provider: string, modelId: string) =>
				provider === model.provider && modelId === model.id ? model : undefined,
		};
		const preflightSpy = vi.spyOn(runtimeConfig, "createChildRuntimePreflight").mockResolvedValue({ registry });
		const start = vi.spyOn(localProcessRuntime, "start");
		const context = {
			cwd: workspace,
			hasUI: false,
			model,
			modelRegistry: registry,
			isProjectTrusted: () => true,
			ui: {
				setStatus: () => {},
				setWidget: () => {},
			},
		} as unknown as ExtensionContext;
		const common = {
			agent: "diagnostic-fixture-agent",
			task: "Inspect safely",
			timeoutMs: 180_000,
			provider: model.provider,
			model: model.id,
			thinking: "low",
			agentScope: "project",
			confirmProjectAgents: false,
		};
		const paramsByMode = [
			common,
			{ tasks: [common], timeoutMs: 180_000, agentScope: "project", confirmProjectAgents: false },
			{ chain: [common], timeoutMs: 180_000, agentScope: "project", confirmProjectAgents: false },
		];

		for (const [index, params] of paramsByMode.entries()) {
			const result = await getSubagentTool().execute(
				`call-${index}`,
				params as never,
				undefined,
				undefined,
				context,
			);
			const content = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			expect(Reflect.has(result, "isError")).toBe(false);
			expect(result.details).toMatchObject({
				results: [expect.objectContaining({ status: "failed", errorMessage: expect.any(String) })],
			});
			for (const line of DIAGNOSTIC) {
				expect(content).toContain(line === "Canonical cwd: " ? `${line}${realpathSync(workspace)}` : line);
			}
			for (const forbidden of [
				"STDERR_SENTINEL",
				"API_KEY_SENTINEL",
				"AUTH_SENTINEL",
				"HEADER_CREDENTIAL_SENTINEL",
				"ENV_SENTINEL",
				"CONFIG_VALUE_SENTINEL",
			]) {
				expect(content).not.toContain(forbidden);
			}
		}

		const updates: string[] = [];
		const failedParallel = await getSubagentTool().execute(
			"parallel-counts",
			{ tasks: [common, common], timeoutMs: 180_000, agentScope: "project", confirmProjectAgents: false } as never,
			undefined,
			(partial) => {
				updates.push(partial.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
			},
			context,
		);
		expect(updates).toContain("Parallel: 2/2 done, 0 running, 0 queued...");
		expect(failedParallel.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Parallel: 0/2 succeeded"),
		});

		const invalidCwdCommon = { ...common, cwd: ".." };
		const invalidCwdParamsByMode = [
			invalidCwdCommon,
			{ tasks: [invalidCwdCommon], timeoutMs: 180_000, agentScope: "project", confirmProjectAgents: false },
			{ chain: [invalidCwdCommon], timeoutMs: 180_000, agentScope: "project", confirmProjectAgents: false },
		];
		for (const [index, params] of invalidCwdParamsByMode.entries()) {
			const result = await getSubagentTool().execute(
				`invalid-cwd-${index}`,
				params as never,
				undefined,
				undefined,
				context,
			);
			const content = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			expect(content).toContain("outside workspace");
			expect(content).not.toContain("SUBAGENT_MODEL_EFFORT_UNSUPPORTED");
		}

		const exceptionSecret = "RAW_PREFLIGHT_EXCEPTION_SENTINEL";
		preflightSpy.mockResolvedValue({
			registry: {
				getAll: () => [model],
				getAvailable: () => [model],
				find: () => {
					throw new Error(exceptionSecret);
				},
			},
		});
		for (const [index, params] of paramsByMode.entries()) {
			const result = await getSubagentTool().execute(
				`exception-${index}`,
				params as never,
				undefined,
				undefined,
				context,
			);
			const content = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			expect(content).toContain("SUBAGENT_CHILD_RESOURCE_UNAVAILABLE");
			expect(content).toContain("Child model resources could not be loaded for subagent preflight.");
			expect(content).not.toContain(exceptionSecret);
		}
		expect(start).not.toHaveBeenCalled();
	});
});
