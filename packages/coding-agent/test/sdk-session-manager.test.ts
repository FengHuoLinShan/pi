import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolPolicyAdapter } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CodingAgentHarnessRuntime } from "../src/core/coding-agent-harness-runtime.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { WorkspaceOverlay } from "../src/core/workspace-overlay.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("uses AgentHarness as the default runtime when a model is selected", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.agent).toBeInstanceOf(CodingAgentHarnessRuntime);
		const runtime = session.agent as CodingAgentHarnessRuntime;
		expect(runtime.harness).toBeDefined();
		runtime.steer({ role: "user", content: "steer later", timestamp: 1 });
		runtime.followUp({ role: "user", content: "follow up later", timestamp: 2 });
		runtime.clearSteeringQueue();
		await runtime.waitForIdle();
		expect(runtime.harness.getQueueSnapshot()).toEqual({
			steer: [],
			followUp: [{ role: "user", content: "follow up later", timestamp: 2 }],
			nextTurn: [],
		});

		session.dispose();
	});

	it("forwards SDK run controls and tool policy to AgentHarness", async () => {
		const faux = registerFauxProvider({ provider: "sdk-harness-controls" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }, { id: "read-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must remain pending"),
		]);
		const credentials = AuthStorage.inMemory();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			models: faux.models.map((candidate) => ({
				id: candidate.id,
				name: candidate.name,
				api: candidate.api,
				reasoning: candidate.reasoning,
				input: candidate.input,
				cost: candidate.cost,
				contextWindow: candidate.contextWindow,
				maxTokens: candidate.maxTokens,
				baseUrl: candidate.baseUrl,
			})),
		});
		const toolPolicy = createToolPolicyAdapter({
			policy: {
				revision: "sdk-controls@1",
				rules: [],
				default: { effect: "allow", reason: "Test allows declared reads" },
			},
			specs: [
				{
					name: "read",
					revision: "read@1",
					retrySafe: true,
					risk: { level: "low" },
					sideEffects: ["read_state"],
					resources: [{ kind: "workspace", access: ["read"], dynamic: true }],
					permissions: [{ id: "workspace.read", description: "Read workspace files" }],
				},
			],
		});
		const terminations: string[] = [];
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.inMemory(cwd),
			runBudget: { maxModelCalls: 1 },
			loopDetection: { maxConsecutiveToolCalls: 2 },
			toolPolicy,
		});
		try {
			session.subscribe((event) => {
				if (event.type === "agent_termination") terminations.push(event.termination.reason);
			});
			await session.prompt("read package metadata");
			const runtime = session.agent as CodingAgentHarnessRuntime;
			expect(runtime.harness.toolPolicy).toBe(toolPolicy);
			expect(terminations).toEqual(["max_model_calls"]);
			expect(faux.state.callCount).toBe(1);
			expect(faux.getPendingResponseCount()).toBe(1);
		} finally {
			session.dispose();
			faux.unregister();
		}
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("routes built-in file tools and session bash through an explicit workspace overlay", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		writeFileSync(join(cwd, "example.txt"), "base\n", "utf8");
		const { overlay } = await WorkspaceOverlay.open({
			workspaceRoot: cwd,
			overlayRoot: join(tempDir, "overlay"),
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
			workspaceOverlay: overlay,
		});
		try {
			const writeTool = session.agent.state.tools.find((tool) => tool.name === "write");
			expect(writeTool).toBeTruthy();
			await writeTool!.execute("overlay-write", { path: "example.txt", content: "staged\n" });
			const result = await session.executeBash("pwd && cat example.txt", undefined, { excludeFromContext: true });

			expect(session.workspaceOverlay).toBe(overlay);
			expect(result.output).toContain(realpathSync(overlay.getWorkingDirectory()));
			expect(result.output).toContain("staged");
			expect(readFileSync(join(cwd, "example.txt"), "utf8")).toBe("base\n");
			expect((await overlay.createPatchSet()).entries).toHaveLength(1);
			await expect(
				session.executeBash("host bypass", undefined, {
					operations: { exec: async () => ({ exitCode: 0 }) },
				}),
			).rejects.toThrow("Cannot override bash operations when a workspace overlay is configured");
			await overlay.applyPatchSet(await overlay.createPatchSet());
			await expect(session.executeBash("pwd")).rejects.toThrow(
				"Cannot execute bash with a applied workspace overlay",
			);
			await expect(
				createAgentSession({
					cwd,
					agentDir,
					model: model!,
					sessionManager: SessionManager.inMemory(cwd),
					workspaceOverlay: overlay,
				}),
			).rejects.toThrow("workspaceOverlay must be active, found applied");
		} finally {
			session.dispose();
			await overlay.discard();
		}
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});
});
