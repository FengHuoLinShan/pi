import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	type BoundaryProfile,
	createBoundaryProfileDigest,
	type ExecutionBoundary,
} from "../src/core/execution-boundary.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { WorkspaceOverlay } from "../src/core/workspace-overlay.ts";
import { createWorkspaceView, type WorkspaceView } from "../src/core/workspace-view.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const temporaryDirectories: string[] = [];

const profile: BoundaryProfile = {
	scope: "built-in-tools",
	workspace: {
		workingDirectory: "/sandbox/project",
		mounts: [
			{ source: "/host/project", target: "/sandbox/project", access: "read-write" },
			{ source: "/host/reference", target: "/sandbox/reference", access: "read-only" },
		],
	},
	process: { mode: "isolated" },
	network: { mode: "allowlist", allowedHosts: ["registry.example.com"] },
	environment: { allow: ["PATH"] },
};

function createBoundary(): ExecutionBoundary {
	return {
		profile,
		backend: {
			id: "workspace-view-test",
			operations: {},
			attest: () => ({
				backendId: "workspace-view-test",
				profileDigest: createBoundaryProfileDigest(profile),
				capabilities: {
					isolation: "virtual-machine",
					workspace: { mountIsolation: true, accessModes: ["read-only", "read-write"] },
					process: { modes: ["isolated"] },
					network: { modes: ["allowlist"] },
					environment: { allowlist: true },
				},
			}),
		},
	};
}

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

function createContextActions(getWorkspaceView: () => WorkspaceView): ExtensionContextActions {
	return {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getWorkspaceView,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspaceView", () => {
	it("describes a direct host workspace without inventing a revision", () => {
		expect(createWorkspaceView("/host/project")).toEqual({
			kind: "host",
			sourceRoot: "/host/project",
			logicalRoot: "/host/project",
			state: "active",
			mounts: [{ source: "/host/project", target: "/host/project", access: "read-write" }],
			execution: {
				target: "host",
				process: "host",
				network: "host",
			},
		});
	});

	it("describes boundary-visible roots and binds the view to the exact profile", () => {
		const view = createWorkspaceView("/host/project", { executionBoundary: createBoundary() });

		expect(view).toMatchObject({
			kind: "execution-boundary",
			sourceRoot: "/host/project",
			logicalRoot: "/sandbox/project",
			state: "active",
			mounts: profile.workspace.mounts,
			revision: {
				kind: "boundary-profile",
				value: createBoundaryProfileDigest(profile),
			},
			execution: {
				target: "boundary",
				process: "isolated",
				network: "allowlist",
			},
		});
		expect(view.mounts).not.toBe(profile.workspace.mounts);
	});

	it("tracks the materialized overlay root, base revision, and lifecycle state", async () => {
		const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-workspace-view-source-"));
		const overlayRoot = await mkdtemp(join(tmpdir(), "pi-workspace-view-overlay-"));
		temporaryDirectories.push(workspaceRoot, overlayRoot);
		await writeFile(join(workspaceRoot, "tracked.txt"), "base\n");
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });

		const active = createWorkspaceView(workspaceRoot, { workspaceOverlay: overlay });
		expect(active).toMatchObject({
			kind: "overlay",
			sourceRoot: overlay.getWorkspaceRoot(),
			logicalRoot: overlay.getWorkingDirectory(),
			state: "active",
			mounts: [
				{
					source: overlay.getWorkspaceRoot(),
					target: overlay.getWorkingDirectory(),
					access: "read-write",
				},
			],
			revision: {
				kind: "overlay-base",
				value: overlay.getBaseSnapshotId(),
			},
			execution: {
				target: "host",
				process: "host",
				network: "host",
			},
		});

		await overlay.discard();
		expect(createWorkspaceView(workspaceRoot, { workspaceOverlay: overlay }).state).toBe("discarded");
	});

	it("resolves the runner context view at use time", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-workspace-view-runner-"));
		temporaryDirectories.push(agentDir);
		const modelRegistry = await createModelRegistry(AuthStorage.create(join(agentDir, "auth.json")));
		const runner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			"/host/project",
			SessionManager.inMemory("/host/project"),
			modelRegistry,
		);
		let view = createWorkspaceView("/host/project");
		runner.bindCore(
			extensionActions,
			createContextActions(() => view),
		);
		const context = runner.createContext();

		expect(context.cwd).toBe("/host/project");
		expect(context.workspace.kind).toBe("host");
		view = createWorkspaceView("/host/project", { executionBoundary: createBoundary() });
		expect(context.workspace.logicalRoot).toBe("/sandbox/project");
		expect(context.workspace.execution.target).toBe("boundary");
	});
});
