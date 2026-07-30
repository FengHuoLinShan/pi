import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { WorkspaceOverlay } from "../src/core/workspace-overlay.ts";
import { parseShadowRunsConfig } from "../src/extensions/shadow-runs/config.ts";
import {
	createShadowRunsExtension,
	type ShadowRunsExtensionDependencies,
} from "../src/extensions/shadow-runs/index.ts";
import {
	runShadowCandidateAgent,
	type ShadowCandidateRunner,
	type ShadowCandidateRunnerFactory,
} from "../src/extensions/shadow-runs/runner.ts";
import { fauxModel } from "./test-harness.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

const temporaryDirectories: string[] = [];

function createWorkspace(): string {
	const workspace = mkdtempSync(join(tmpdir(), "pi-shadow-runs-extension-"));
	temporaryDirectories.push(workspace);
	writeFileSync(join(workspace, "answer.txt"), "base");
	return workspace;
}

function createConfig(options: { rejectCandidate?: string } = {}) {
	const script = options.rejectCandidate
		? `const fs=require("node:fs");process.exit(fs.readFileSync("answer.txt","utf8")===${JSON.stringify(options.rejectCandidate)}?1:0)`
		: 'require("node:fs").accessSync("answer.txt")';
	return {
		version: 1,
		execution: "sequential",
		candidates: [
			{ id: "minimal", label: "Minimal", instructions: "Make the smallest complete change." },
			{ id: "defensive", label: "Defensive", instructions: "Prioritize failure handling.", thinkingLevel: "high" },
		],
		checks: [
			{
				id: "verify",
				command: process.execPath,
				args: ["-e", script],
				timeoutMs: 10_000,
			},
		],
		budget: {
			maxModelCalls: 4,
			maxToolCalls: 20,
			maxWallTimeMs: 60_000,
			maxModelTokens: 100_000,
			maxCost: 1,
		},
	};
}

function writeConfig(workspace: string, config: unknown): void {
	mkdirSync(join(workspace, ".pi"));
	writeFileSync(join(workspace, ".pi", "shadow-runs.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function createFakeRunner(failingCandidate?: string): ShadowCandidateRunner {
	return async ({ candidate, overlay }, options) => {
		if (candidate.id === failingCandidate) throw new Error(`${candidate.id} failed`);
		writeFileSync(join(overlay.getWorkingDirectory(), "answer.txt"), candidate.id);
		return {
			response: `Implemented ${candidate.id}`,
			model: { provider: options.model.provider, id: options.model.id },
			thinkingLevel: candidate.config.thinkingLevel ?? options.baseThinkingLevel,
			usage: { assistantTurns: 2, toolCalls: 3, tokens: 500, cost: 0.01 },
			warnings: [],
		};
	};
}

function setupExtension(
	workspace: string,
	options: {
		flagEnabled?: boolean;
		projectTrusted?: boolean;
		failingCandidate?: string;
	} = {},
) {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler[]>();
	const appendEntry = vi.fn();
	const createCandidateRunner: ShadowCandidateRunnerFactory = vi.fn(() => createFakeRunner(options.failingCandidate));
	const api = {
		registerFlag: vi.fn(),
		registerCommand(name: string, registration: { handler: CommandHandler }) {
			commands.set(name, registration.handler);
		},
		on(event: string, handler: EventHandler) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
		},
		appendEntry,
		getFlag(name: string) {
			return name === "shadow-runs" ? (options.flagEnabled ?? true) : undefined;
		},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
	const dependencies: ShadowRunsExtensionDependencies = { createCandidateRunner };
	createShadowRunsExtension(dependencies)(api);
	const notify = vi.fn();
	const setStatus = vi.fn();
	const confirm = vi.fn(async () => true);
	const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);
	const editor = vi.fn(async () => undefined);
	const sessionId = `session-${temporaryDirectories.length}-${Math.random()}`;
	const ctx = {
		cwd: workspace,
		mode: "rpc",
		hasUI: true,
		model: fauxModel,
		modelRegistry: {},
		sessionManager: { getSessionId: () => sessionId },
		isProjectTrusted: () => options.projectTrusted ?? true,
		ui: { confirm, editor, notify, select, setStatus },
	} as unknown as ExtensionCommandContext;
	const command = commands.get("shadow");
	if (!command) throw new Error("shadow command was not registered");
	return {
		appendEntry,
		command,
		confirm,
		createCandidateRunner,
		ctx,
		emit: async (event: string) => {
			const results = [];
			for (const handler of events.get(event) ?? []) {
				results.push(await handler({ type: event }, ctx));
			}
			return results;
		},
		notify,
		setStatus,
	};
}

afterEach(() => {
	for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true });
	temporaryDirectories.length = 0;
});

describe("shadow runs config", () => {
	it("normalizes explicit candidates, checks, and budgets", () => {
		expect(parseShadowRunsConfig(createConfig())).toMatchObject({
			version: 1,
			execution: "sequential",
			candidates: [{ id: "minimal" }, { id: "defensive", thinkingLevel: "high" }],
			checks: [{ id: "verify", timeoutMs: 10_000 }],
			budget: { maxModelCalls: 4, maxToolCalls: 20, maxWallTimeMs: 60_000 },
		});
	});

	it("rejects duplicate candidates and incomplete budgets", () => {
		const duplicate = createConfig();
		duplicate.candidates[1]!.id = "minimal";
		expect(() => parseShadowRunsConfig(duplicate)).toThrow("candidate ids must be unique");
		expect(() =>
			parseShadowRunsConfig({
				...createConfig(),
				budget: { maxModelCalls: 4, maxToolCalls: 20 },
			}),
		).toThrow("budget.maxWallTimeMs");
	});

	it("allows empty direct-command arguments but rejects shell-shaped unknown fields", () => {
		const config = createConfig();
		config.checks[0]!.args.push("");
		expect(parseShadowRunsConfig(config).checks[0]?.args.at(-1)).toBe("");
		expect(() =>
			parseShadowRunsConfig({
				...createConfig(),
				checks: [{ ...createConfig().checks[0], shell: true }],
			}),
		).toThrow("unknown checks[0] field: shell");
	});

	it("rejects sparse candidate, check, and argument arrays", () => {
		const sparseCandidates = createConfig();
		delete sparseCandidates.candidates[0];
		expect(() => parseShadowRunsConfig(sparseCandidates)).toThrow("candidates must not contain sparse entries");

		const sparseChecks = createConfig();
		delete sparseChecks.checks[0];
		expect(() => parseShadowRunsConfig(sparseChecks)).toThrow("checks must not contain sparse entries");

		const sparseArguments = createConfig();
		delete sparseArguments.checks[0]!.args[0];
		expect(() => parseShadowRunsConfig(sparseArguments)).toThrow("checks[0].args must not contain sparse entries");
	});
});

describe("shadow runs built-in extension", () => {
	it("runs the real nested candidate session with the faux provider and isolated built-in tools", async () => {
		const workspace = createWorkspace();
		const agentDir = createWorkspace();
		const faux = fauxProvider({ provider: `shadow-runner-${temporaryDirectories.length}` });
		let systemPrompt = "";
		faux.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("candidate complete");
			},
		]);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		const opened = await WorkspaceOverlay.open({ workspaceRoot: workspace });

		try {
			const output = await runShadowCandidateAgent(
				{
					candidate: {
						id: "nested",
						config: {
							id: "nested",
							instructions: "Inspect first, then make a minimal change.",
							thinkingLevel: "high",
						},
					},
					overlay: opened.overlay,
					signal: new AbortController().signal,
				},
				{
					objective: "Return a deterministic test response",
					model: faux.getModel(),
					baseThinkingLevel: "medium",
					modelRuntime,
					agentDir,
					budget: { maxModelCalls: 2, maxToolCalls: 5, maxWallTimeMs: 30_000 },
				},
			);

			expect(output).toMatchObject({
				response: "candidate complete",
				model: { provider: faux.provider.id, id: faux.getModel().id },
				thinkingLevel: "off",
				usage: { assistantTurns: 1, toolCalls: 0 },
				warnings: [],
			});
			expect(systemPrompt).toContain("Inspect first, then make a minimal change.");
			expect(systemPrompt).toContain("isolated workspace overlay");
			expect(faux.state.callCount).toBe(1);
			expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("base");
			expect((await opened.overlay.createPatchSet()).entries).toHaveLength(0);
		} finally {
			await opened.overlay.discard();
		}
	});

	it("runs isolated candidates, verifies them, and applies only the explicit selection", async () => {
		const workspace = createWorkspace();
		writeConfig(workspace, createConfig());
		const extension = setupExtension(workspace);

		await extension.command("run Implement the answer", extension.ctx);

		expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("base");
		expect(extension.createCandidateRunner).toHaveBeenCalledTimes(1);
		expect(extension.confirm).toHaveBeenNthCalledWith(
			1,
			"Run isolated coding candidates?",
			expect.stringContaining(
				"2 sequential candidate(s), up to 8 model calls and up to $2.00. 1 trusted project command(s) run per candidate",
			),
		);
		expect(extension.appendEntry).toHaveBeenCalledWith(
			"shadow-runs-completed-v1",
			expect.objectContaining({
				version: 1,
				status: "completed",
				candidates: [
					expect.objectContaining({ id: "minimal", completionStatus: "pass" }),
					expect.objectContaining({ id: "defensive", completionStatus: "pass" }),
				],
			}),
		);

		await extension.command("apply defensive", extension.ctx);

		expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("defensive");
		expect(extension.appendEntry).toHaveBeenCalledWith(
			"shadow-runs-applied-v1",
			expect.objectContaining({
				version: 1,
				candidateId: "defensive",
				appliedPaths: ["answer.txt"],
				completionStatus: "pass",
			}),
		);
		expect(extension.notify).toHaveBeenCalledWith("Applied candidate defensive: 1 path(s)", "info");
	});

	it("prevents applying a candidate that fails a configured completion command", async () => {
		const workspace = createWorkspace();
		writeConfig(workspace, createConfig({ rejectCandidate: "defensive" }));
		const extension = setupExtension(workspace);

		await extension.command("run Implement safely", extension.ctx);
		await extension.command("apply defensive", extension.ctx);

		expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("base");
		expect(extension.notify).toHaveBeenCalledWith("Candidate defensive is not eligible for apply", "warning");

		await extension.command("apply minimal", extension.ctx);
		expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("minimal");
	});

	it("isolates a candidate agent failure while retaining a verified peer", async () => {
		const workspace = createWorkspace();
		writeConfig(workspace, createConfig());
		const extension = setupExtension(workspace, { failingCandidate: "minimal" });

		await extension.command("run Implement with isolation", extension.ctx);
		await extension.command("apply defensive", extension.ctx);

		expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("defensive");
		expect(extension.appendEntry).toHaveBeenCalledWith(
			"shadow-runs-completed-v1",
			expect.objectContaining({
				status: "partial",
				candidates: [
					expect.objectContaining({ id: "minimal", status: "failed" }),
					expect.objectContaining({ id: "defensive", status: "completed", completionStatus: "pass" }),
				],
			}),
		);
	});

	it("retains every candidate after an external apply conflict and allows explicit discard", async () => {
		const workspace = createWorkspace();
		writeConfig(workspace, createConfig());
		const extension = setupExtension(workspace);

		await extension.command("run Implement conflict handling", extension.ctx);
		writeFileSync(join(workspace, "answer.txt"), "external");
		await extension.command("apply minimal", extension.ctx);

		expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("external");
		expect(extension.notify).toHaveBeenCalledWith(
			expect.stringContaining("Shadow candidate apply failed; all candidates were retained:"),
			"error",
		);

		await extension.command("discard", extension.ctx);
		expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("external");
		expect(extension.notify).toHaveBeenCalledWith("Shadow run candidates discarded", "info");
	});

	it("blocks session changes while candidates are retained and cleans them on shutdown", async () => {
		const workspace = createWorkspace();
		writeConfig(workspace, createConfig());
		const extension = setupExtension(workspace);

		await extension.command("run Implement before switching", extension.ctx);

		await expect(extension.emit("session_before_switch")).resolves.toEqual([{ cancel: true }]);
		await extension.emit("session_shutdown");
		await expect(extension.emit("session_before_switch")).resolves.toEqual([undefined]);
	});

	it("requires explicit enablement and project trust before reading config or running candidates", async () => {
		const workspace = createWorkspace();
		writeConfig(workspace, createConfig());
		const disabled = setupExtension(workspace, { flagEnabled: false });

		await disabled.command("run Never start", disabled.ctx);
		expect(disabled.createCandidateRunner).not.toHaveBeenCalled();
		expect(disabled.notify).toHaveBeenCalledWith(
			"Start pi with --shadow-runs to enable multi-candidate coding runs",
			"warning",
		);

		const untrusted = setupExtension(workspace, { projectTrusted: false });
		await untrusted.command("run Never start", untrusted.ctx);
		expect(untrusted.createCandidateRunner).not.toHaveBeenCalled();
		expect(untrusted.notify).toHaveBeenCalledWith(expect.stringContaining("require a trusted project"), "error");
	});

	it("rejects malformed config before creating a candidate runner", async () => {
		const workspace = createWorkspace();
		writeConfig(workspace, { version: 1, candidates: [], checks: [], budget: {} });
		const extension = setupExtension(workspace);

		await extension.command("run Never start", extension.ctx);

		expect(extension.createCandidateRunner).not.toHaveBeenCalled();
		expect(extension.notify).toHaveBeenCalledWith("candidates must contain between 2 and 4 entries", "error");
	});
});
