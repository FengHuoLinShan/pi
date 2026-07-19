import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type BoundaryEnforcementCapabilities,
	type BoundaryProfile,
	createBoundaryProfileDigest,
	type ExecutionBoundary,
	ExecutionBoundaryError,
	filterBoundaryEnvironment,
	resolveExecutionBoundary,
} from "../src/core/execution-boundary.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createTool } from "../src/core/tools/index.ts";
import type { ReadOperations } from "../src/core/tools/read.ts";

const profile: BoundaryProfile = {
	scope: "built-in-tools",
	workspace: {
		workingDirectory: "/sandbox/workspace",
		mounts: [
			{ source: "/host/project", target: "/sandbox/workspace", access: "read-write" },
			{ source: "/host/reference", target: "/sandbox/reference", access: "read-only" },
		],
	},
	process: { mode: "isolated" },
	network: { mode: "allowlist", allowedHosts: ["api.example.com"] },
	environment: { allow: ["PI_BOUNDARY_ALLOWED"] },
};

const capabilities: BoundaryEnforcementCapabilities = {
	isolation: "virtual-machine",
	workspace: { mountIsolation: true, accessModes: ["read-only", "read-write"] },
	process: { modes: ["deny", "isolated"] },
	network: { modes: ["deny", "allowlist"] },
	environment: { allowlist: true },
};

function createBoundary(
	operations: ExecutionBoundary["backend"]["operations"],
	overrides?: {
		profile?: BoundaryProfile;
		capabilities?: BoundaryEnforcementCapabilities;
		profileDigest?: string;
	},
): ExecutionBoundary {
	const requestedProfile = overrides?.profile ?? profile;
	return {
		profile: requestedProfile,
		backend: {
			id: "test-vm",
			operations,
			attest: () => ({
				backendId: "test-vm",
				profileDigest: overrides?.profileDigest ?? createBoundaryProfileDigest(requestedProfile),
				capabilities: overrides?.capabilities ?? capabilities,
			}),
		},
	};
}

describe("execution boundary validation", () => {
	it("resolves an exact attested profile and derives readable and writable roots", () => {
		const bash: BashOperations = {
			exec: async () => ({ exitCode: 0 }),
		};
		const resolved = resolveExecutionBoundary(createBoundary({ bash }), ["bash"]);

		expect(resolved.cwd).toBe("/sandbox/workspace");
		expect(resolved.readableRoots).toEqual(["/sandbox/workspace", "/sandbox/reference"]);
		expect(resolved.writableRoots).toEqual(["/sandbox/workspace"]);
	});

	it("fails closed when the attestation covers a different profile", () => {
		const boundary = createBoundary(
			{ bash: { exec: async () => ({ exitCode: 0 }) } },
			{ profileDigest: "not-the-requested-profile" },
		);

		expect(() => resolveExecutionBoundary(boundary, ["bash"])).toThrowError(ExecutionBoundaryError);
		expect(() => resolveExecutionBoundary(boundary, ["bash"])).toThrow(/does not cover/);
	});

	it("fails closed when the backend cannot enforce the requested network policy", () => {
		const boundary = createBoundary(
			{ bash: { exec: async () => ({ exitCode: 0 }) } },
			{ capabilities: { ...capabilities, network: { modes: ["deny"] } } },
		);

		expect(() => resolveExecutionBoundary(boundary, ["bash"])).toThrow(/network mode allowlist/);
	});

	it("fails closed when a JavaScript backend omits an external isolation kind", () => {
		const boundary = createBoundary(
			{ bash: { exec: async () => ({ exitCode: 0 }) } },
			{
				capabilities: {
					...capabilities,
					isolation: undefined as unknown as BoundaryEnforcementCapabilities["isolation"],
				},
			},
		);

		expect(() => resolveExecutionBoundary(boundary, ["bash"])).toThrow(/out-of-process isolation kind/);
	});

	it("requires backend operations and canonical path support for bounded file tools", () => {
		const incompleteRead: ReadOperations = {
			readFile: async () => Buffer.from("content"),
			access: async () => {},
		};

		expect(() => resolveExecutionBoundary(createBoundary({}), ["bash"])).toThrow(/operations.*bash/);
		expect(() => resolveExecutionBoundary(createBoundary({ read: incompleteRead }), ["read"])).toThrow(/realpath/);
	});

	it("rejects invalid workspace and environment policy before asking the backend", () => {
		const invalidProfile: BoundaryProfile = {
			...profile,
			workspace: { ...profile.workspace, workingDirectory: "relative/path" },
			environment: { allow: ["INVALID-NAME"] },
		};
		const boundary = createBoundary({ bash: { exec: async () => ({ exitCode: 0 }) } }, { profile: invalidProfile });

		expect(() => resolveExecutionBoundary(boundary, ["bash"])).toThrow(/workingDirectory must be absolute/);
	});
});

describe("bounded tool factories", () => {
	it("routes bash through the backend cwd and passes only allowlisted environment variables", async () => {
		let receivedCwd: string | undefined;
		let receivedEnvironment: NodeJS.ProcessEnv | undefined;
		const bash: BashOperations = {
			exec: async (_command, cwd, options) => {
				receivedCwd = cwd;
				receivedEnvironment = options.env;
				options.onData(Buffer.from("bounded"));
				return { exitCode: 0 };
			},
		};
		const previousAllowed = process.env.PI_BOUNDARY_ALLOWED;
		const previousDenied = process.env.PI_BOUNDARY_DENIED;
		process.env.PI_BOUNDARY_ALLOWED = "allowed";
		process.env.PI_BOUNDARY_DENIED = "denied";
		try {
			const tool = createTool("bash", "/host/project", { boundary: createBoundary({ bash }) });
			const result = await tool.execute("call", { command: "pwd" });

			expect(result.content).toEqual([{ type: "text", text: "bounded" }]);
			expect(receivedCwd).toBe("/sandbox/workspace");
			expect(receivedEnvironment).toEqual({ PI_BOUNDARY_ALLOWED: "allowed" });
		} finally {
			if (previousAllowed === undefined) delete process.env.PI_BOUNDARY_ALLOWED;
			else process.env.PI_BOUNDARY_ALLOWED = previousAllowed;
			if (previousDenied === undefined) delete process.env.PI_BOUNDARY_DENIED;
			else process.env.PI_BOUNDARY_DENIED = previousDenied;
		}
	});

	it("uses the boundary namespace for file operations", async () => {
		let receivedPath: string | undefined;
		const read: ReadOperations = {
			realpath: async (path) => path,
			access: async () => {},
			readFile: async (path) => {
				receivedPath = path;
				return Buffer.from("content");
			},
		};
		const tool = createTool("read", "/host/project", { boundary: createBoundary({ read }) });
		await tool.execute("call", { path: "src/index.ts" });

		expect(receivedPath).toBe("/sandbox/workspace/src/index.ts");
	});

	it("does not allow callers to replace boundary-owned tool operations", () => {
		const bash: BashOperations = { exec: async () => ({ exitCode: 0 }) };
		expect(() =>
			createTool("bash", "/host/project", {
				boundary: createBoundary({ bash }),
				bash: { operations: bash },
			}),
		).toThrow(/Cannot override bash.operations/);
	});

	it("applies readable mount roots to boundary-owned search operations", async () => {
		const find = createTool("find", "/host/project", {
			boundary: createBoundary({
				find: {
					realpath: async (path) => path,
					exists: async () => true,
					glob: async () => ["/sandbox/outside/secret.txt"],
				},
			}),
		});

		await expect(find.execute("find", { pattern: "**/*" })).rejects.toThrow("outside the allowed roots");
	});

	it("requires canonical path and delegated search support for bounded search tools", () => {
		expect(() =>
			createTool("ls", "/host/project", {
				boundary: createBoundary({
					ls: {
						exists: async () => true,
						stat: async () => ({ isDirectory: () => true }),
						readdir: async () => [],
					},
				}),
			}),
		).toThrow("must provide realpath");
		expect(() =>
			createTool("grep", "/host/project", {
				boundary: createBoundary({
					grep: {
						realpath: async (path) => path,
						isDirectory: async () => true,
						readFile: async () => "",
					},
				}),
			}),
		).toThrow("must provide search");
	});
});

describe("boundary environment filtering", () => {
	it("omits every undeclared value, including likely secret variables", () => {
		expect(
			filterBoundaryEnvironment(profile, {
				PI_BOUNDARY_ALLOWED: "ok",
				AWS_SECRET_ACCESS_KEY: "secret",
				PATH: "/bin",
			}),
		).toEqual({ PI_BOUNDARY_ALLOWED: "ok" });
	});
});

describe("SDK execution boundary", () => {
	it("uses one attested backend for the complete built-in tool surface and session bash", async () => {
		let bashCwd: string | undefined;
		const operations: ExecutionBoundary["backend"]["operations"] = {
			read: {
				realpath: async (path) => path,
				readFile: async () => Buffer.from("content"),
				access: async () => {},
			},
			bash: {
				exec: async (_command, cwd, options) => {
					bashCwd = cwd;
					options.onData(Buffer.from("sdk-boundary"));
					return { exitCode: 0 };
				},
			},
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
		};
		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};
		const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-boundary-sdk-"));
		const boundary = createBoundary(operations);

		try {
			const { session } = await createAgentSession({
				cwd: "/host/project",
				agentDir: tempAgentDir,
				executionBoundary: boundary,
				resourceLoader,
				sessionManager: SessionManager.inMemory("/host/project"),
				settingsManager: SettingsManager.inMemory(),
			});
			try {
				expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
				const result = await session.executeBash("pwd");
				expect(result.output).toBe("sdk-boundary");
				expect(bashCwd).toBe("/sandbox/workspace");
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(tempAgentDir, { recursive: true, force: true });
		}
	});
});
