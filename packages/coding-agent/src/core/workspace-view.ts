import {
	type BoundaryNetworkMode,
	type BoundaryProcessMode,
	createBoundaryProfileDigest,
	type ExecutionBoundary,
} from "./execution-boundary.ts";
import type { WorkspaceOverlay, WorkspaceOverlayState } from "./workspace-overlay.ts";

export type WorkspaceViewKind = "host" | "overlay" | "execution-boundary";
export type WorkspaceViewState = "active" | WorkspaceOverlayState;
export type WorkspaceExecutionTarget = "host" | "boundary";
export type WorkspaceProcessMode = "host" | BoundaryProcessMode;
export type WorkspaceNetworkMode = "host" | BoundaryNetworkMode;

export interface WorkspaceViewMount {
	/** Host or remote source represented by this mount. */
	readonly source: string;
	/** Path visible to built-in tools in their execution namespace. */
	readonly target: string;
	readonly access: "read-only" | "read-write";
}

export type WorkspaceViewRevision =
	| {
			readonly kind: "overlay-base";
			readonly value: string;
	  }
	| {
			readonly kind: "boundary-profile";
			readonly value: string;
	  };

/**
 * Describes the filesystem and execution namespace used by built-in tools.
 *
 * Extensions still execute in the host process. This descriptor lets them
 * reason about tool-visible paths without implying that extension code is
 * sandboxed or can directly access boundary paths.
 */
export interface WorkspaceView {
	readonly kind: WorkspaceViewKind;
	/** Original project root from which the session was created. */
	readonly sourceRoot: string;
	/** Current working directory visible to built-in tools. */
	readonly logicalRoot: string;
	readonly state: WorkspaceViewState;
	readonly mounts: readonly WorkspaceViewMount[];
	readonly revision?: WorkspaceViewRevision;
	readonly execution: {
		readonly target: WorkspaceExecutionTarget;
		readonly process: WorkspaceProcessMode;
		readonly network: WorkspaceNetworkMode;
	};
}

export interface WorkspaceViewOptions {
	readonly workspaceOverlay?: WorkspaceOverlay;
	readonly executionBoundary?: ExecutionBoundary;
}

export function createWorkspaceView(sourceRoot: string, options: WorkspaceViewOptions = {}): WorkspaceView {
	if (options.workspaceOverlay && options.executionBoundary) {
		throw new Error("workspaceOverlay cannot be combined with executionBoundary");
	}

	if (options.workspaceOverlay) {
		const overlay = options.workspaceOverlay;
		return {
			kind: "overlay",
			sourceRoot: overlay.getWorkspaceRoot(),
			logicalRoot: overlay.getWorkingDirectory(),
			state: overlay.getState(),
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
		};
	}

	if (options.executionBoundary) {
		const { profile } = options.executionBoundary;
		return {
			kind: "execution-boundary",
			sourceRoot,
			logicalRoot: profile.workspace.workingDirectory,
			state: "active",
			mounts: profile.workspace.mounts.map((mount) => ({ ...mount })),
			revision: {
				kind: "boundary-profile",
				value: createBoundaryProfileDigest(profile),
			},
			execution: {
				target: "boundary",
				process: profile.process.mode,
				network: profile.network.mode,
			},
		};
	}

	return {
		kind: "host",
		sourceRoot,
		logicalRoot: sourceRoot,
		state: "active",
		mounts: [{ source: sourceRoot, target: sourceRoot, access: "read-write" }],
		execution: {
			target: "host",
			process: "host",
			network: "host",
		},
	};
}
