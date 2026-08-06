import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerSubagentExtension,
	type SingleResult,
	type SubagentDetails,
	type SubagentExtensionDependencies,
} from "../examples/extensions/subagent/index.ts";
import type { ProcessRuntimeStartRequest } from "../src/core/process-runtime.ts";

function model(): Model<Api> {
	return {
		id: "normalized-model",
		name: "normalized model",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

const testModel = model();
const registry = {
	getAll: () => [testModel],
	getAvailable: () => [testModel],
	find: (provider: string, id: string) =>
		provider === testModel.provider && id === testModel.id ? testModel : undefined,
};

function completionLine(text = "done"): string {
	return `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: testModel.provider,
			model: testModel.id,
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
	})}\n`;
}

function createHarness(
	exitCode = 0,
	emitProcessOutput: (request: ProcessRuntimeStartRequest) => void = (request) => {
		request.onOutput?.("stdout", Buffer.from(completionLine()));
	},
) {
	let tool: ToolDefinition | undefined;
	const starts: ProcessRuntimeStartRequest[] = [];
	const dependencies: SubagentExtensionDependencies = {
		discoverAgents: () => ({
			agents: [
				{
					name: "role-default",
					description: "role default",
					provider: testModel.provider,
					model: testModel.id,
					thinking: "max",
					systemPrompt: "role prompt",
					source: "user",
					filePath: "/fixture/role-default.md",
				},
				{
					name: "personal-default",
					description: "personal default",
					systemPrompt: "personal prompt",
					source: "user",
					filePath: "/fixture/personal-default.md",
				},
				{
					name: "config-error",
					description: "invalid configuration",
					provider: testModel.provider,
					model: testModel.id,
					thinking: "max",
					systemPrompt: "invalid prompt",
					source: "user",
					filePath: "/fixture/config-error.md",
					configError: "Invalid fixture agent configuration",
				},
			],
			projectAgentsDir: null,
		}),
		loadRuntimeOverrides: () => ({
			config: {
				version: 1,
				agents: {
					"personal-default": { provider: testModel.provider, model: testModel.id, thinking: "max" },
				},
			},
		}),
		createChildRuntimePreflight: async () => ({ registry }),
		processRuntime: {
			start: (request) => {
				starts.push(request);
				emitProcessOutput(request);
				return {
					id: `fixture-${starts.length}`,
					pid: undefined,
					wait: async () => ({ exitCode, reason: "exited" as const }),
					terminate: () => true,
				};
			},
		},
	};
	registerSubagentExtension(
		{
			on: () => () => {},
			events: { on: () => () => {}, emit: () => {} },
			registerCommand: () => {},
			registerTool: (definition: ToolDefinition) => {
				tool = definition;
			},
		} as unknown as ExtensionAPI,
		dependencies,
	);
	if (!tool) throw new Error("Subagent tool was not registered");
	return { tool, starts };
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		model: testModel,
		modelRegistry: registry,
		isProjectTrusted: () => true,
		ui: { setStatus: () => {}, setWidget: () => {} },
	} as unknown as ExtensionContext;
}

function params(mode: "single" | "parallel" | "chain", agent: string, extra: Record<string, unknown> = {}) {
	const task = { agent, task: "bounded fixture", ...extra };
	if (mode === "single") return { ...task, timeoutMs: 180_000 };
	if (mode === "parallel") return { tasks: [task], timeoutMs: 180_000 };
	return { chain: [task], timeoutMs: 180_000 };
}

function detailsOf(value: unknown): SubagentDetails {
	if (!value || typeof value !== "object" || !("details" in value)) throw new Error("Expected tool result details");
	return value.details as SubagentDetails;
}

function expectNormalizedSnapshots(updates: SubagentDetails[], expectedStatuses: SingleResult["status"][]): void {
	const snapshots = updates.flatMap((update) => update.results);
	for (const status of expectedStatuses) expect(snapshots.some((snapshot) => snapshot.status === status)).toBe(true);
	for (const snapshot of snapshots) {
		expect(snapshot).toMatchObject({
			provider: testModel.provider,
			model: testModel.id,
			thinking: "high",
			thinkingAdjustment: { from: "max", to: "high" },
		});
	}
}

describe("subagent extension orchestration", () => {
	const workspaces: string[] = [];
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "pi-subagent-orchestration-"));
		workspaces.push(workspace);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const directory of workspaces.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	for (const mode of ["single", "parallel", "chain"] as const) {
		for (const [agent, source] of [
			["role-default", "agent"],
			["personal-default", "personal"],
		] as const) {
			it(`normalizes omitted unsupported ${source} thinking through ${mode}`, async () => {
				const { tool, starts } = createHarness();
				const updates: SubagentDetails[] = [];
				const result = await tool.execute(
					`${mode}-${source}`,
					params(mode, agent) as never,
					undefined,
					(update) => {
						if (update.details) updates.push(structuredClone(update.details as SubagentDetails));
					},
					context(workspace),
				);
				const details = detailsOf(result);
				expectNormalizedSnapshots(updates, ["queued", "running", "completed"]);
				expect(details.results[0]).toMatchObject({
					status: "completed",
					provider: testModel.provider,
					model: testModel.id,
					thinking: "high",
					thinkingAdjustment: { from: "max", to: "high" },
				});
				expect(starts).toHaveLength(1);
				const thinkingIndex = starts[0].args.indexOf("--thinking");
				expect(starts[0].args[thinkingIndex + 1]).toBe("high");
			});
		}
	}

	for (const mode of ["single", "parallel", "chain"] as const) {
		it(`retains normalization in every emitted ${mode} cancelled snapshot`, async () => {
			const { tool, starts } = createHarness();
			const updates: SubagentDetails[] = [];
			const controller = new AbortController();
			const cancelled = await tool.execute(
				`cancelled-${mode}`,
				params(mode, "role-default") as never,
				controller.signal,
				(update) => {
					if (!update.details) return;
					const details = structuredClone(update.details as SubagentDetails);
					updates.push(details);
					if (details.results.some((result) => result.status === "running")) controller.abort();
				},
				context(workspace),
			);
			expectNormalizedSnapshots(updates, ["queued", "running", "cancelled"]);
			expect(detailsOf(cancelled).results[0]).toMatchObject({
				status: "cancelled",
				provider: testModel.provider,
				model: testModel.id,
				thinking: "high",
				thinkingAdjustment: { from: "max", to: "high" },
			});
			expect(starts).toHaveLength(1);
		});

		it(`retains normalization in every emitted ${mode} child-error snapshot`, async () => {
			const { tool, starts } = createHarness(1);
			const updates: SubagentDetails[] = [];
			const failed = await tool.execute(
				`child-error-${mode}`,
				params(mode, "personal-default") as never,
				undefined,
				(update) => {
					if (update.details) updates.push(structuredClone(update.details as SubagentDetails));
				},
				context(workspace),
			);
			expectNormalizedSnapshots(updates, ["queued", "running", "failed"]);
			expect(detailsOf(failed).results[0]).toMatchObject({
				status: "failed",
				provider: testModel.provider,
				model: testModel.id,
				thinking: "high",
				thinkingAdjustment: { from: "max", to: "high" },
			});
			expect(starts).toHaveLength(1);
		});
	}

	it("keeps a redacted stderr tail and separates child-reported outcome from process status", async () => {
		const secret = "stderr-secret-value";
		const { tool } = createHarness(0, (request) => {
			request.onOutput?.(
				"stderr",
				Buffer.from(`${"old stderr\n".repeat(8_000)}api_key="${secret}"\n\u001b[31mrecent stderr\u001b[0m\n`),
			);
			request.onOutput?.(
				"stdout",
				Buffer.from(completionLine("RESULT: blocked\nSUMMARY: waiting\nEVIDENCE: fixture\nOPEN_ISSUES: one")),
			);
		});
		const result = await tool.execute(
			"reported-outcome",
			params("single", "personal-default") as never,
			undefined,
			undefined,
			context(workspace),
		);
		const child = detailsOf(result).results[0];
		expect(child.status).toBe("completed");
		expect(child.reportedOutcome).toBe("blocked");
		expect(Buffer.byteLength(child.stderr, "utf8")).toBeLessThanOrEqual(64 * 1024);
		expect(child.stderr).toContain("[stderr truncated:");
		expect(child.stderr).toContain("recent stderr");
		expect(child.stderr).toContain("[redacted]");
		expect(child.stderr).not.toContain(secret);
		expect(child.stderr).not.toContain("\u001b");
	});

	for (const mode of ["single", "parallel", "chain"] as const) {
		it(`emits one normalized terminal ${mode} snapshot for agent config errors without starting a child`, async () => {
			const { tool, starts } = createHarness();
			const updates: SubagentDetails[] = [];
			const failed = await tool.execute(
				`config-error-${mode}`,
				params(mode, "config-error") as never,
				undefined,
				(update) => {
					if (update.details) updates.push(structuredClone(update.details as SubagentDetails));
				},
				context(workspace),
			);
			expectNormalizedSnapshots(updates, ["queued", "failed"]);
			const emittedResults = updates.flatMap((update) => update.results);
			expect(emittedResults.every((snapshot) => snapshot.status === "queued" || snapshot.status === "failed")).toBe(
				true,
			);
			expect(emittedResults.filter((snapshot) => snapshot.status === "failed")).toHaveLength(1);
			expect(detailsOf(failed).results[0]).toMatchObject({
				status: "failed",
				provider: testModel.provider,
				model: testModel.id,
				thinking: "high",
				thinkingAdjustment: { from: "max", to: "high" },
				errorMessage: "Invalid fixture agent configuration",
			});
			expect(starts).toHaveLength(0);
		});

		it(`retains normalization in ${mode} pre-execution failures`, async () => {
			const { tool, starts } = createHarness();
			const result = await tool.execute(
				`pre-execution-${mode}`,
				params(mode, "personal-default", { cwd: "missing" }) as never,
				undefined,
				undefined,
				context(workspace),
			);
			expect(detailsOf(result).results[0]).toMatchObject({
				status: "failed",
				thinking: "high",
				thinkingAdjustment: { from: "max", to: "high" },
			});
			expect(starts).toHaveLength(0);
		});

		it(`fails closed without starting ${mode} for explicit unsupported task thinking`, async () => {
			const { tool, starts } = createHarness();
			const result = await tool.execute(
				`unsupported-${mode}`,
				params(mode, "personal-default", { thinking: "max" }) as never,
				undefined,
				undefined,
				context(workspace),
			);
			expect(detailsOf(result).results[0]).toMatchObject({
				status: "failed",
				errorCode: "SUBAGENT_MODEL_EFFORT_UNSUPPORTED",
			});
			expect(starts).toHaveLength(0);
		});
	}
});
