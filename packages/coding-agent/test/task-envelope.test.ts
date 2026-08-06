import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import {
	type BoundaryEnforcementCapabilities,
	type BoundaryProfile,
	createBoundaryProfileDigest,
	type ExecutionBoundary,
} from "../src/core/execution-boundary.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	assertValidatedTaskEnvelope,
	loadTaskEnvelope,
	summarizeTaskEnvelope,
	type ValidatedTaskEnvelope,
	validateTaskEnvelope,
} from "../src/core/task-envelope.ts";
import { createAllToolDefinitions, createAllTools, createToolDefinition } from "../src/core/tools/index.ts";
import type { WorkspaceOverlay } from "../src/core/workspace-overlay.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function workspace(): Promise<{ root: string; child: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-task-envelope-"));
	cleanup.push(root);
	const child = join(root, "child");
	await mkdir(child);
	return { root: await realpath(root), child: await realpath(child) };
}

const boundaryCapabilities: BoundaryEnforcementCapabilities = {
	isolation: "virtual-machine",
	workspace: { mountIsolation: true, accessModes: ["read-only", "read-write"] },
	process: { modes: ["deny", "isolated"] },
	network: { modes: ["deny"] },
	environment: { allowlist: true },
};

function createTaskBoundary(
	cwd: string,
	readableRoots: readonly string[],
	writableRoots: readonly string[],
): ExecutionBoundary {
	const profile: BoundaryProfile = {
		scope: "built-in-tools",
		workspace: {
			workingDirectory: cwd,
			mounts: readableRoots.map((root) => ({
				source: root,
				target: root,
				access: writableRoots.includes(root) ? "read-write" : "read-only",
			})),
		},
		process: { mode: "isolated" },
		network: { mode: "deny" },
		environment: { allow: [] },
	};
	return {
		profile,
		backend: {
			id: "task-envelope-test",
			attest: () => ({
				backendId: "task-envelope-test",
				profileDigest: createBoundaryProfileDigest(profile),
				capabilities: boundaryCapabilities,
			}),
			operations: {
				read: {
					realpath: async (path) => path,
					readFile: async () => Buffer.from("content"),
					access: async () => {},
				},
				bash: { exec: async () => ({ exitCode: 0 }) },
				edit: {
					realpath: async (path) => path,
					readFile: async () => Buffer.from("content"),
					writeFile: async () => {},
					access: async () => {},
				},
				write: {
					realpath: async (path) => path,
					readFile: async () => Buffer.from("content"),
					writeFile: async () => {},
					mkdir: async () => {},
				},
				grep: {
					realpath: async (path) => path,
					isDirectory: async () => true,
					readFile: async () => "content",
					search: async () => [],
				},
				find: {
					realpath: async (path) => path,
					exists: async () => true,
					glob: async () => [],
				},
				ls: {
					realpath: async (path) => path,
					exists: async () => true,
					stat: async () => ({ isDirectory: () => true }),
					readdir: async () => [],
				},
			},
		},
	};
}

describe("task envelope tool factory boundaries", () => {
	it("rejects forged envelopes, cwd mismatches, overlays, and tool overrides", async () => {
		const first = await workspace();
		const second = await workspace();
		const forged = {
			version: 1,
			task: "forged",
			targetCwd: first.child,
			readableRoots: [first.child],
			writableRoots: [first.child],
			nonGoals: [],
		} as unknown as ValidatedTaskEnvelope;
		expect(() => createToolDefinition("read", first.child, { taskEnvelope: forged })).toThrow(
			"must be created by validateTaskEnvelope",
		);

		const taskEnvelope = await validateTaskEnvelope({ version: 1, task: "Inspect", targetCwd: first.child });
		expect(() => createToolDefinition("read", second.child, { taskEnvelope })).toThrow("cwd must exactly match");
		expect(() =>
			createToolDefinition("read", first.child, {
				taskEnvelope,
				overlay: {} as WorkspaceOverlay,
			}),
		).toThrow("cannot be combined with workspace overlay");
		expect(() =>
			createToolDefinition("read", first.child, {
				taskEnvelope,
				read: {
					operations: {
						realpath: async (path) => path,
						readFile: async () => Buffer.from("content"),
						access: async () => {},
					},
				},
			}),
		).toThrow("Cannot override read.operations");
		expect(() =>
			createToolDefinition("read", first.child, {
				taskEnvelope,
				read: { allowedRoots: [first.child] },
			}),
		).toThrow("Cannot override read.allowedRoots");
		expect(() =>
			createToolDefinition("bash", first.child, {
				taskEnvelope,
				bash: { spawnHook: (context) => context },
			}),
		).toThrow("Cannot override bash.spawnHook");
	});

	it("rejects narrower boundaries and accepts only an exact scope", async () => {
		const { root, child } = await workspace();
		const taskEnvelope = await validateTaskEnvelope({
			version: 1,
			task: "Inspect",
			targetCwd: child,
			readableRoots: [root],
			writableRoots: [child],
		});
		const narrowerBoundary = createTaskBoundary(child, [child], [child]);
		expect(() => createAllToolDefinitions(child, { taskEnvelope, boundary: narrowerBoundary })).toThrow(
			"must exactly match taskEnvelope authorization",
		);
		expect(() => createAllTools(child, { taskEnvelope, boundary: narrowerBoundary })).toThrow(
			"must exactly match taskEnvelope authorization",
		);

		const exactEnvelope = await validateTaskEnvelope({ version: 1, task: "Inspect", targetCwd: child });
		const exactBoundary = createTaskBoundary(child, exactEnvelope.readableRoots, exactEnvelope.writableRoots);
		expect(
			Object.keys(createAllToolDefinitions(child, { taskEnvelope: exactEnvelope, boundary: exactBoundary })),
		).toHaveLength(7);
		expect(Object.keys(createAllTools(child, { taskEnvelope: exactEnvelope, boundary: exactBoundary }))).toHaveLength(
			7,
		);
	});
});

describe("task envelope validation", () => {
	it("rejects structurally forged validated envelopes and preserves validated identity", async () => {
		expect(() =>
			assertValidatedTaskEnvelope({
				version: 1,
				task: "forged",
				targetCwd: "/tmp",
				readableRoots: ["/tmp"],
				writableRoots: ["/tmp"],
				nonGoals: [],
			}),
		).toThrow("must be created by validateTaskEnvelope");

		const { child } = await workspace();
		const envelope = await validateTaskEnvelope({ version: 1, task: "validated", targetCwd: child });
		await expect(validateTaskEnvelope(envelope)).resolves.toBe(envelope);
	});

	it("rejects reflected brand clones and freezes nested privacy metadata", async () => {
		const first = await workspace();
		const second = await workspace();
		const envelope = await validateTaskEnvelope({
			version: 1,
			task: "validated",
			targetCwd: first.child,
			privacy: { classification: "restricted", handling: ["do-not-log"] },
		});
		const forgedClone = { ...envelope, targetCwd: second.child };

		expect(() => assertValidatedTaskEnvelope(forgedClone)).toThrow("must be created by validateTaskEnvelope");
		await expect(validateTaskEnvelope(forgedClone)).rejects.toThrow("outside readableRoots");
		expect(Object.isFrozen(envelope.privacy?.handling)).toBe(true);
	});

	it("canonicalizes roots and defaults omitted roots to targetCwd", async () => {
		const { child } = await workspace();
		const envelope = await validateTaskEnvelope({ version: 1, task: "Do one thing", targetCwd: child });

		expect(envelope.targetCwd).toBe(child);
		expect(envelope.readableRoots).toEqual([child]);
		expect(envelope.writableRoots).toEqual([child]);
	});

	it("rejects relative paths, parent traversal, wrong path types, and write scope expansion", async () => {
		const { root, child } = await workspace();
		const file = join(root, "file.txt");
		await writeFile(file, "x");

		await expect(validateTaskEnvelope({ version: 1, task: "x", targetCwd: "." })).rejects.toThrow("absolute");
		await expect(validateTaskEnvelope({ version: 1, task: "x", targetCwd: `${child}/../child` })).rejects.toThrow(
			"must not contain '..'",
		);
		await expect(validateTaskEnvelope({ version: 1, task: "x", targetCwd: file })).rejects.toThrow(
			"existing directory",
		);
		await expect(
			validateTaskEnvelope({
				version: 1,
				task: "x",
				targetCwd: child,
				readableRoots: [child],
				writableRoots: [root],
			}),
		).rejects.toThrow("contained by readableRoots");
	});

	it("rejects a symlink target that escapes an authorized canonical root", async () => {
		const first = await workspace();
		const second = await workspace();
		const link = join(first.root, "link");
		await symlink(second.child, link, "dir");

		await expect(
			validateTaskEnvelope({
				version: 1,
				task: "x",
				targetCwd: link,
				readableRoots: [first.root],
				writableRoots: [],
			}),
		).rejects.toThrow("outside readableRoots");
	});

	it("validates expected-hang timeout authorization and its hard cap", async () => {
		const { child } = await workspace();
		const base = { version: 1 as const, task: "x", targetCwd: child };

		await expect(validateTaskEnvelope({ ...base, commandPolicy: { expectedHangMaxTimeoutMs: 0 } })).rejects.toThrow(
			"positive integer in milliseconds",
		);
		await expect(validateTaskEnvelope({ ...base, commandPolicy: { expectedHangMaxTimeoutMs: 1.5 } })).rejects.toThrow(
			"positive integer in milliseconds",
		);
		await expect(
			validateTaskEnvelope({ ...base, commandPolicy: { expectedHangMaxTimeoutMs: 30_001 } }),
		).rejects.toThrow("must not exceed 30000 ms");
		await expect(
			validateTaskEnvelope({
				...base,
				commandPolicy: { maxTimeoutMs: 1_000, expectedHangMaxTimeoutMs: 1_001 },
			}),
		).rejects.toThrow("must not exceed maxTimeoutMs");
		await expect(validateTaskEnvelope({ ...base, commandPolicy: { allowExpectedHang: true } })).rejects.toThrow(
			"unknown commandPolicy field",
		);

		const envelope = await validateTaskEnvelope({
			...base,
			commandPolicy: { maxTimeoutMs: 30_000, expectedHangMaxTimeoutMs: 30_000 },
		});
		expect(envelope.commandPolicy?.expectedHangMaxTimeoutMs).toBe(30_000);
		expect(summarizeTaskEnvelope(envelope, false)).toContain("expected-hang cap 30000 ms");
	});

	it("does not disclose task, path, non-goals, or privacy handling in the prompt summary", async () => {
		const { child } = await workspace();
		const secret = "never-disclose-this";
		const envelope = await validateTaskEnvelope({
			version: 1,
			task: secret,
			targetCwd: child,
			nonGoals: [secret],
			privacy: { classification: "restricted", handling: [secret] },
		});

		const summary = summarizeTaskEnvelope(envelope, false);
		expect(summary).not.toContain(secret);
		expect(summary).not.toContain(child);
		expect(summary).toContain("local shell is not a filesystem sandbox");
		expect(summary).toContain("expected-hang disallowed");
	});

	it("loads JSON without including the envelope path in parse errors", async () => {
		const { root } = await workspace();
		const path = join(root, "sensitive-name.json");
		await writeFile(path, "not-json");

		await expect(loadTaskEnvelope(path)).rejects.not.toThrow(path);
	});
});

describe("task envelope CLI and SDK bridge", () => {
	it("accepts print/json fresh sessions and rejects prompt and session-selection conflicts", () => {
		expect(parseArgs(["--task-envelope", "task.json", "--print"]).diagnostics).toEqual([]);
		expect(parseArgs(["--task-envelope", "task.json", "--mode", "json"]).diagnostics).toEqual([]);
		expect(parseArgs(["--task-envelope", "task.json", "prompt"]).diagnostics).toContainEqual(
			expect.objectContaining({ type: "error" }),
		);
		for (const selection of [
			["--continue"],
			["--resume"],
			["--session", "x"],
			["--session-id", "x"],
			["--fork", "x"],
		]) {
			expect(parseArgs(["--task-envelope", "task.json", ...selection]).diagnostics).toContainEqual(
				expect.objectContaining({ type: "error" }),
			);
		}
		for (const conflict of [
			["--export", "session.jsonl"],
			["--list-models"],
			["--system-prompt", "override"],
			["--append-system-prompt", "override"],
			["--extension", "extension.ts"],
			["--skill", "SKILL.md"],
			["--prompt-template", "prompt.md"],
			["--theme", "theme.json"],
		]) {
			expect(parseArgs(["--task-envelope", "task.json", ...conflict]).diagnostics).toContainEqual(
				expect.objectContaining({ type: "error" }),
			);
		}
	});

	it("adopts targetCwd before creating an SDK session", async () => {
		const { child } = await workspace();
		const sessionManager = SessionManager.inMemory(child);
		const { session } = await createAgentSession({
			taskEnvelope: { version: 1, task: "Inspect", targetCwd: child },
			sessionManager,
		});

		expect(session.sessionManager.getCwd()).toBe(child);
		expect(session.systemPrompt).toContain("Task envelope v1 is active");
	});

	it("enforces readable and writable roots in SDK-created file tools", async () => {
		const first = await workspace();
		const second = await workspace();
		const outside = join(second.child, "outside.txt");
		const escapedLink = join(first.child, "escaped.txt");
		await writeFile(outside, "secret");
		await symlink(outside, escapedLink);
		const { session } = await createAgentSession({
			taskEnvelope: {
				version: 1,
				task: "Inspect",
				targetCwd: first.child,
				writableRoots: [],
			},
			sessionManager: SessionManager.inMemory(first.child),
		});
		const readTool = session.agent.state.tools.find((tool) => tool.name === "read");
		const writeTool = session.agent.state.tools.find((tool) => tool.name === "write");
		expect(readTool).toBeDefined();
		expect(writeTool).toBeDefined();
		if (!readTool || !writeTool) throw new Error("Expected built-in file tools");

		await expect(readTool.execute("read-outside", { path: outside })).rejects.toThrow(/^FILE_PATH_DENIED:/);
		await expect(readTool.execute("read-link", { path: escapedLink })).rejects.toThrow(/^FILE_PATH_DENIED:/);
		await expect(
			writeTool.execute("write-denied", { path: join(first.child, "new.txt"), content: "x" }),
		).rejects.toThrow(/^FILE_PATH_DENIED:/);
	});

	it("rejects a direct SDK custom loader before loader callbacks execute", async () => {
		const { root, child } = await workspace();
		const agentDir = join(root, "agent");
		await mkdir(agentDir);
		let factoryRuns = 0;
		let overrideRuns = 0;
		const resourceLoader = new DefaultResourceLoader({
			cwd: child,
			agentDir,
			extensionFactories: [
				() => {
					factoryRuns++;
				},
			],
			extensionsOverride: (result) => {
				overrideRuns++;
				return result;
			},
		});

		await expect(
			createAgentSession({
				taskEnvelope: { version: 1, task: "Inspect", targetCwd: child },
				resourceLoader,
			}),
		).rejects.toThrow("resourceLoader is not authorized");
		expect(factoryRuns).toBe(0);
		expect(overrideRuns).toBe(0);
	});

	it("suppresses service extension callbacks and accepts the exact loader-envelope pair", async () => {
		const { root, child } = await workspace();
		const agentDir = join(root, "agent");
		await mkdir(agentDir);
		const taskEnvelope = await validateTaskEnvelope({ version: 1, task: "Inspect", targetCwd: child });
		let factoryRuns = 0;
		let overrideRuns = 0;
		let resourceOverrideRuns = 0;
		const services = await createAgentSessionServices({
			cwd: child,
			agentDir,
			taskEnvelope,
			resourceLoaderOptions: {
				extensionFactories: [
					() => {
						factoryRuns++;
					},
				],
				extensionsOverride: (result) => {
					overrideRuns++;
					return result;
				},
				skillsOverride: (result) => {
					resourceOverrideRuns++;
					return result;
				},
				promptsOverride: (result) => {
					resourceOverrideRuns++;
					return result;
				},
				themesOverride: (result) => {
					resourceOverrideRuns++;
					return result;
				},
				agentsFilesOverride: (result) => {
					resourceOverrideRuns++;
					return result;
				},
				systemPromptOverride: (result) => {
					resourceOverrideRuns++;
					return result;
				},
				appendSystemPromptOverride: (result) => {
					resourceOverrideRuns++;
					return result;
				},
			},
		});

		expect(factoryRuns).toBe(0);
		expect(overrideRuns).toBe(0);
		expect(resourceOverrideRuns).toBe(0);
		expect(services.resourceLoader.getSkills()).toEqual({ skills: [], diagnostics: [] });
		expect(services.resourceLoader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
		expect(services.resourceLoader.getThemes()).toEqual({ themes: [], diagnostics: [] });
		expect(services.resourceLoader.getAgentsFiles()).toEqual({ agentsFiles: [] });
		expect(services.resourceLoader.getSystemPrompt()).toBeUndefined();
		expect(services.resourceLoader.getAppendSystemPrompt()).toEqual([]);
		services.resourceLoader
			.getAgentsFiles()
			.agentsFiles.push({ path: join(root, "injected-agents.md"), content: "injected context" });
		services.resourceLoader.getAppendSystemPrompt().push("injected prompt");
		expect(services.resourceLoader.getAgentsFiles()).toEqual({ agentsFiles: [] });
		expect(services.resourceLoader.getAppendSystemPrompt()).toEqual([]);
		expect(() =>
			services.resourceLoader.extendResources({
				skillPaths: [
					{
						path: join(root, "external-skill.md"),
						metadata: { source: "cli", scope: "temporary", origin: "top-level" },
					},
				],
			}),
		).toThrow("disabled for task-envelope sessions");
		await services.resourceLoader.reload();
		expect(resourceOverrideRuns).toBe(0);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(child),
		});
		expect(session.systemPrompt).toContain("Task envelope v1 is active");
		expect(session.systemPrompt).not.toContain("injected context");
		expect(session.systemPrompt).not.toContain("injected prompt");
	});

	it("rejects invalid direct AgentSession task-envelope configurations before loader callbacks", async () => {
		const first = await workspace();
		const second = await workspace();
		const agentDir = join(first.root, "agent");
		await mkdir(agentDir);
		const taskEnvelope = await validateTaskEnvelope({
			version: 1,
			task: "Inspect",
			targetCwd: first.child,
			readableRoots: [first.root],
			writableRoots: [first.child],
		});
		const services = await createAgentSessionServices({ cwd: first.child, agentDir, taskEnvelope });
		const normal = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(first.child),
		});
		expect(normal.session.systemPrompt).toContain("Task envelope v1 is active");

		const baseConfig = {
			agent: normal.session.agent,
			sessionManager: SessionManager.inMemory(first.child),
			settingsManager: services.settingsManager,
			cwd: first.child,
			resourceLoader: services.resourceLoader,
			taskEnvelope,
			modelRuntime: services.modelRuntime,
		};
		const forged = {
			version: 1,
			task: "forged",
			targetCwd: first.child,
			readableRoots: [first.root],
			writableRoots: [first.child],
			nonGoals: [],
		} as unknown as ValidatedTaskEnvelope;
		expect(() => new AgentSession({ ...baseConfig, taskEnvelope: forged })).toThrow(
			"must be created by validateTaskEnvelope",
		);

		let factoryRuns = 0;
		let overrideRuns = 0;
		const arbitraryLoader = new DefaultResourceLoader({
			cwd: first.child,
			agentDir,
			extensionFactories: [
				() => {
					factoryRuns++;
				},
			],
			extensionsOverride: (result) => {
				overrideRuns++;
				return result;
			},
		});
		expect(() => new AgentSession({ ...baseConfig, resourceLoader: arbitraryLoader })).toThrow(
			"resourceLoader is not authorized",
		);
		expect(factoryRuns).toBe(0);
		expect(overrideRuns).toBe(0);

		expect(() => new AgentSession({ ...baseConfig, cwd: second.child })).toThrow("cwd and session cwd must match");
		expect(
			() =>
				new AgentSession({
					...baseConfig,
					sessionManager: SessionManager.inMemory(second.child),
				}),
		).toThrow("cwd and session cwd must match");

		const resumedSession = SessionManager.inMemory(first.child);
		resumedSession.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		expect(() => new AgentSession({ ...baseConfig, sessionManager: resumedSession })).toThrow(
			"fresh session with no messages",
		);

		const narrowerBoundary = createTaskBoundary(first.child, [first.child], [first.child]);
		expect(() => new AgentSession({ ...baseConfig, executionBoundary: narrowerBoundary })).toThrow(
			"must exactly match taskEnvelope authorization",
		);
	});

	it("rejects SDK cwd and resumed-session conflicts", async () => {
		const first = await workspace();
		const second = await workspace();
		await expect(
			createAgentSession({
				cwd: second.child,
				taskEnvelope: { version: 1, task: "Inspect", targetCwd: first.child },
			}),
		).rejects.toThrow("cwd must match");

		const sessionManager = SessionManager.inMemory(first.child);
		sessionManager.appendThinkingLevelChange("medium");
		sessionManager.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		await expect(
			createAgentSession({
				taskEnvelope: { version: 1, task: "Inspect", targetCwd: first.child },
				sessionManager,
			}),
		).rejects.toThrow("fresh session");
	});
});
