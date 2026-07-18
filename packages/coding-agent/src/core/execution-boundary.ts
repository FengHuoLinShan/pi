import { createHash } from "node:crypto";
import { isAbsolute, relative, win32 } from "node:path";
import type { BashOperations } from "./tools/bash.ts";
import type { EditOperations } from "./tools/edit.ts";
import type { FindOperations } from "./tools/find.ts";
import type { GrepOperations } from "./tools/grep.ts";
import type { ToolName } from "./tools/index.ts";
import type { LsOperations } from "./tools/ls.ts";
import type { ReadOperations } from "./tools/read.ts";
import type { WriteOperations } from "./tools/write.ts";

export type BoundaryWorkspaceAccess = "read-only" | "read-write";
export type BoundaryProcessMode = "deny" | "isolated";
export type BoundaryNetworkMode = "deny" | "allowlist" | "unrestricted";
export type BoundaryIsolationKind = "operating-system" | "container" | "virtual-machine" | "remote-sandbox";

export interface BoundaryWorkspaceMount {
	/** Host or remote source made available by the backend. Must be absolute. */
	source: string;
	/** Absolute path in the backend namespace. */
	target: string;
	access: BoundaryWorkspaceAccess;
}

/**
 * Policy requested from an external enforcement backend.
 *
 * The scope is deliberately explicit: this contract covers pi's built-in tool
 * operations. It does not sandbox extension module loading or model-provider
 * requests performed by the host pi process.
 */
export interface BoundaryProfile {
	scope: "built-in-tools";
	workspace: {
		workingDirectory: string;
		mounts: readonly BoundaryWorkspaceMount[];
	};
	process: {
		mode: BoundaryProcessMode;
	};
	network: {
		mode: BoundaryNetworkMode;
		allowedHosts?: readonly string[];
	};
	/** Only these host environment variable names may enter tool processes. */
	environment: {
		allow: readonly string[];
	};
}

export interface BoundaryEnforcementCapabilities {
	/** Must name an out-of-process OS, container, VM, or remote boundary. */
	isolation: BoundaryIsolationKind;
	workspace: {
		/** True only when filesystem scope and mount access modes are enforced outside pi's process. */
		mountIsolation: boolean;
		accessModes: readonly BoundaryWorkspaceAccess[];
	};
	process: {
		modes: readonly BoundaryProcessMode[];
	};
	network: {
		modes: readonly BoundaryNetworkMode[];
	};
	environment: {
		/** True only when the backend prevents undeclared host environment and secrets from entering tool processes. */
		allowlist: boolean;
	};
}

/** Backend assertion bound to one exact policy digest. */
export interface BoundaryAttestation {
	backendId: string;
	profileDigest: string;
	capabilities: BoundaryEnforcementCapabilities;
}

export interface BoundaryToolOperations {
	read?: ReadOperations;
	bash?: BashOperations;
	edit?: EditOperations;
	write?: WriteOperations;
	grep?: GrepOperations;
	find?: FindOperations;
	ls?: LsOperations;
}

/**
 * Trusted adapter for a real enforcement system such as a container, VM, or
 * remote sandbox. Pi validates the assertion; the backend remains responsible
 * for truthfully implementing it outside pi's process.
 */
export interface ExecutionBoundaryBackend {
	id: string;
	attest: (profile: BoundaryProfile) => BoundaryAttestation;
	operations: BoundaryToolOperations;
}

export interface ExecutionBoundary {
	profile: BoundaryProfile;
	backend: ExecutionBoundaryBackend;
}

export interface ResolvedExecutionBoundary {
	cwd: string;
	readableRoots: readonly string[];
	writableRoots: readonly string[];
	operations: BoundaryToolOperations;
	profile: BoundaryProfile;
}

export class ExecutionBoundaryError extends Error {
	readonly code: "invalid_profile" | "attestation_failed" | "capability_missing" | "operation_missing";

	constructor(
		code: "invalid_profile" | "attestation_failed" | "capability_missing" | "operation_missing",
		message: string,
	) {
		super(message);
		this.name = "ExecutionBoundaryError";
		this.code = code;
	}
}

function isAbsoluteBoundaryPath(value: string): boolean {
	return isAbsolute(value) || win32.isAbsolute(value);
}

function isPathInside(root: string, value: string): boolean {
	const pathApi = win32.isAbsolute(root) ? win32 : { relative, isAbsolute };
	const child = pathApi.relative(root, value);
	return child === "" || (!child.startsWith("..") && !pathApi.isAbsolute(child));
}

function assertUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) {
		throw new ExecutionBoundaryError("invalid_profile", `${label} must not contain duplicates`);
	}
}

const ISOLATION_KINDS: readonly BoundaryIsolationKind[] = [
	"operating-system",
	"container",
	"virtual-machine",
	"remote-sandbox",
];
const WORKSPACE_ACCESS_MODES: readonly BoundaryWorkspaceAccess[] = ["read-only", "read-write"];
const PROCESS_MODES: readonly BoundaryProcessMode[] = ["deny", "isolated"];
const NETWORK_MODES: readonly BoundaryNetworkMode[] = ["deny", "allowlist", "unrestricted"];

function validateProfileModes(profile: BoundaryProfile): void {
	for (const mount of profile.workspace.mounts) {
		if (!WORKSPACE_ACCESS_MODES.includes(mount.access)) {
			throw new ExecutionBoundaryError("invalid_profile", `Invalid workspace access mode: ${mount.access}`);
		}
	}
	if (!PROCESS_MODES.includes(profile.process.mode)) {
		throw new ExecutionBoundaryError("invalid_profile", `Invalid process mode: ${profile.process.mode}`);
	}
	if (!NETWORK_MODES.includes(profile.network.mode)) {
		throw new ExecutionBoundaryError("invalid_profile", `Invalid network mode: ${profile.network.mode}`);
	}
}

function validateProfile(profile: BoundaryProfile): void {
	if (profile.scope !== "built-in-tools") {
		throw new ExecutionBoundaryError("invalid_profile", 'Boundary scope must be "built-in-tools"');
	}
	if (!isAbsoluteBoundaryPath(profile.workspace.workingDirectory)) {
		throw new ExecutionBoundaryError("invalid_profile", "Boundary workspace workingDirectory must be absolute");
	}
	if (profile.workspace.mounts.length === 0) {
		throw new ExecutionBoundaryError("invalid_profile", "Boundary workspace must declare at least one mount");
	}
	validateProfileModes(profile);
	for (const mount of profile.workspace.mounts) {
		if (!isAbsoluteBoundaryPath(mount.source) || !isAbsoluteBoundaryPath(mount.target)) {
			throw new ExecutionBoundaryError(
				"invalid_profile",
				"Boundary workspace mount source and target must be absolute",
			);
		}
	}
	if (!profile.workspace.mounts.some((mount) => isPathInside(mount.target, profile.workspace.workingDirectory))) {
		throw new ExecutionBoundaryError(
			"invalid_profile",
			"Boundary workspace workingDirectory must be inside a declared mount target",
		);
	}
	assertUnique(
		profile.workspace.mounts.map((mount) => mount.target),
		"Boundary workspace mount targets",
	);

	const allowedHosts = profile.network.allowedHosts ?? [];
	assertUnique(allowedHosts, "Boundary network allowedHosts");
	if (profile.network.mode === "allowlist" && allowedHosts.length === 0) {
		throw new ExecutionBoundaryError("invalid_profile", "Boundary network allowlist must contain at least one host");
	}
	if (profile.network.mode !== "allowlist" && allowedHosts.length > 0) {
		throw new ExecutionBoundaryError(
			"invalid_profile",
			"Boundary network allowedHosts are only valid in allowlist mode",
		);
	}

	assertUnique(profile.environment.allow, "Boundary environment allowlist");
	for (const name of profile.environment.allow) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new ExecutionBoundaryError("invalid_profile", `Invalid environment variable name: ${name}`);
		}
	}
}

export function createBoundaryProfileDigest(profile: BoundaryProfile): string {
	const canonical = JSON.stringify({
		scope: profile.scope,
		workspace: {
			workingDirectory: profile.workspace.workingDirectory,
			mounts: profile.workspace.mounts.map((mount) => ({
				source: mount.source,
				target: mount.target,
				access: mount.access,
			})),
		},
		process: { mode: profile.process.mode },
		network: {
			mode: profile.network.mode,
			allowedHosts: profile.network.allowedHosts ? [...profile.network.allowedHosts] : undefined,
		},
		environment: { allow: [...profile.environment.allow] },
	});
	return createHash("sha256").update(canonical).digest("hex");
}

function validateAttestation(boundary: ExecutionBoundary, attestation: BoundaryAttestation): void {
	if (attestation.backendId !== boundary.backend.id) {
		throw new ExecutionBoundaryError("attestation_failed", "Boundary attestation backend id does not match");
	}
	if (attestation.profileDigest !== createBoundaryProfileDigest(boundary.profile)) {
		throw new ExecutionBoundaryError(
			"attestation_failed",
			"Boundary attestation does not cover the requested profile",
		);
	}

	const capabilities = attestation.capabilities;
	if (!capabilities || !ISOLATION_KINDS.includes(capabilities.isolation)) {
		throw new ExecutionBoundaryError(
			"capability_missing",
			"Boundary backend does not attest a supported out-of-process isolation kind",
		);
	}
	if (!capabilities?.workspace?.mountIsolation) {
		throw new ExecutionBoundaryError(
			"capability_missing",
			"Boundary backend does not attest out-of-process workspace mount isolation",
		);
	}
	if (!Array.isArray(capabilities.workspace.accessModes)) {
		throw new ExecutionBoundaryError("capability_missing", "Boundary backend does not attest workspace access modes");
	}
	const requiredAccessModes = new Set(boundary.profile.workspace.mounts.map((mount) => mount.access));
	for (const mode of requiredAccessModes) {
		if (!capabilities.workspace.accessModes.includes(mode)) {
			throw new ExecutionBoundaryError("capability_missing", `Boundary backend cannot enforce ${mode} mounts`);
		}
	}
	if (
		!Array.isArray(capabilities.process?.modes) ||
		!capabilities.process.modes.includes(boundary.profile.process.mode)
	) {
		throw new ExecutionBoundaryError(
			"capability_missing",
			`Boundary backend cannot enforce process mode ${boundary.profile.process.mode}`,
		);
	}
	if (
		!Array.isArray(capabilities.network?.modes) ||
		!capabilities.network.modes.includes(boundary.profile.network.mode)
	) {
		throw new ExecutionBoundaryError(
			"capability_missing",
			`Boundary backend cannot enforce network mode ${boundary.profile.network.mode}`,
		);
	}
	if (!capabilities.environment?.allowlist) {
		throw new ExecutionBoundaryError(
			"capability_missing",
			"Boundary backend cannot enforce the environment and secret allowlist",
		);
	}
}

function requireOperations(
	operations: BoundaryToolOperations,
	requiredTools: readonly ToolName[],
): BoundaryToolOperations {
	for (const toolName of requiredTools) {
		const toolOperations = operations[toolName];
		if (!toolOperations) {
			throw new ExecutionBoundaryError(
				"operation_missing",
				`Boundary backend does not provide operations for built-in tool ${toolName}`,
			);
		}
		if (
			(toolName === "read" || toolName === "edit" || toolName === "write") &&
			!("realpath" in toolOperations && typeof toolOperations.realpath === "function")
		) {
			throw new ExecutionBoundaryError(
				"operation_missing",
				`Boundary backend operations for ${toolName} must provide realpath for canonical root checks`,
			);
		}
	}
	return operations;
}

export function resolveExecutionBoundary(
	boundary: ExecutionBoundary,
	requiredTools: readonly ToolName[],
): ResolvedExecutionBoundary {
	validateProfile(boundary.profile);
	let attestation: BoundaryAttestation;
	try {
		attestation = boundary.backend.attest(boundary.profile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ExecutionBoundaryError("attestation_failed", `Boundary backend attestation failed: ${message}`);
	}
	validateAttestation(boundary, attestation);

	return {
		cwd: boundary.profile.workspace.workingDirectory,
		readableRoots: boundary.profile.workspace.mounts.map((mount) => mount.target),
		writableRoots: boundary.profile.workspace.mounts
			.filter((mount) => mount.access === "read-write")
			.map((mount) => mount.target),
		operations: requireOperations(boundary.backend.operations, requiredTools),
		profile: boundary.profile,
	};
}

export function filterBoundaryEnvironment(profile: BoundaryProfile, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};
	for (const name of profile.environment.allow) {
		const value = environment[name];
		if (value !== undefined) filtered[name] = value;
	}
	return filtered;
}
