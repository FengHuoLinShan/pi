export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	atomicWriteFile,
	computeFileRevision,
	type FilePathOperations,
	type FilePathPolicy,
	type FileRevision,
	type FileRevisionState,
} from "./file-transaction.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepSearchMatch,
	type GrepSearchRequest,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolDetails,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ExecutionBoundary, filterBoundaryEnvironment, resolveExecutionBoundary } from "../execution-boundary.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { assertValidatedTaskEnvelope, type ValidatedTaskEnvelope } from "../task-envelope.ts";
import type { WorkspaceOverlay } from "../workspace-overlay.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
	/** Route built-in tool operations through an attested external execution boundary. */
	boundary?: ExecutionBoundary;
	/** Run built-in tools against an explicit materialized workspace overlay. */
	overlay?: WorkspaceOverlay;
	/** Restrict built-in tools according to a validated task envelope. */
	taskEnvelope?: ValidatedTaskEnvelope;
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

function assertOverlayOptionsAreNotOverridden(options: ToolsOptions, toolNames: readonly ToolName[]): void {
	for (const toolName of toolNames) {
		if (options[toolName]?.operations) {
			throw new Error(`Cannot override ${toolName}.operations when a workspace overlay is configured`);
		}
	}
	for (const toolName of ["read", "edit", "write", "grep", "find", "ls"] as const) {
		if (toolNames.includes(toolName) && options[toolName]?.allowedRoots !== undefined) {
			throw new Error(`Cannot override ${toolName}.allowedRoots when a workspace overlay is configured`);
		}
	}
}

function assertBoundaryOptionsAreNotOverridden(options: ToolsOptions, toolNames: readonly ToolName[]): void {
	for (const toolName of toolNames) {
		const toolOptions = options[toolName];
		if (toolOptions?.operations) {
			throw new Error(`Cannot override ${toolName}.operations when an execution boundary is configured`);
		}
	}
	for (const toolName of ["read", "edit", "write", "grep", "find", "ls"] as const) {
		if (toolNames.includes(toolName) && options[toolName]?.allowedRoots !== undefined) {
			throw new Error(`Cannot override ${toolName}.allowedRoots when an execution boundary is configured`);
		}
	}
	if (toolNames.includes("bash") && options.bash?.spawnHook) {
		throw new Error("Cannot override bash.spawnHook when an execution boundary is configured");
	}
}

function assertTaskEnvelopeOptionsAreNotOverridden(options: ToolsOptions): void {
	for (const toolName of allToolNames) {
		if (options[toolName]?.operations) {
			throw new Error(`Cannot override ${toolName}.operations when a task envelope is configured`);
		}
	}
	for (const toolName of ["read", "edit", "write", "grep", "find", "ls"] as const) {
		if (options[toolName]?.allowedRoots !== undefined) {
			throw new Error(`Cannot override ${toolName}.allowedRoots when a task envelope is configured`);
		}
	}
	if (options.bash?.spawnHook) {
		throw new Error("Cannot override bash.spawnHook when a task envelope is configured");
	}
}

function sameRootSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((root) => right.includes(root));
}

function applyTaskEnvelopeScope(
	options: ToolsOptions,
	taskEnvelope: ValidatedTaskEnvelope | undefined,
	toolNames: readonly ToolName[],
): ToolsOptions {
	if (!taskEnvelope) return options;
	const resolved: ToolsOptions = { ...options, taskEnvelope: undefined };
	const readableRoots = [...taskEnvelope.readableRoots];
	const writableRoots = [...taskEnvelope.writableRoots];
	if (toolNames.includes("read")) {
		resolved.read = { ...options.read, allowedRoots: readableRoots, redactPathErrors: true };
	}
	if (toolNames.includes("grep")) {
		resolved.grep = { ...options.grep, allowedRoots: readableRoots, redactPathErrors: true };
	}
	if (toolNames.includes("find")) {
		resolved.find = { ...options.find, allowedRoots: readableRoots, redactPathErrors: true };
	}
	if (toolNames.includes("ls")) {
		resolved.ls = { ...options.ls, allowedRoots: readableRoots, redactPathErrors: true };
	}
	if (toolNames.includes("edit")) {
		resolved.edit = { ...options.edit, allowedRoots: writableRoots, redactPathErrors: true };
	}
	if (toolNames.includes("write")) {
		resolved.write = { ...options.write, allowedRoots: writableRoots, redactPathErrors: true };
	}
	if (toolNames.includes("bash")) {
		resolved.bash = { ...options.bash, commandPolicy: taskEnvelope.commandPolicy };
	}
	return resolved;
}

function applyTaskEnvelopeCommandPolicy(
	options: ToolsOptions,
	taskEnvelope: ValidatedTaskEnvelope,
	toolNames: readonly ToolName[],
): ToolsOptions {
	const resolved: ToolsOptions = { ...options, taskEnvelope: undefined };
	if (toolNames.includes("read")) resolved.read = { ...options.read, redactPathErrors: true };
	if (toolNames.includes("grep")) resolved.grep = { ...options.grep, redactPathErrors: true };
	if (toolNames.includes("find")) resolved.find = { ...options.find, redactPathErrors: true };
	if (toolNames.includes("ls")) resolved.ls = { ...options.ls, redactPathErrors: true };
	if (toolNames.includes("edit")) resolved.edit = { ...options.edit, redactPathErrors: true };
	if (toolNames.includes("write")) resolved.write = { ...options.write, redactPathErrors: true };
	if (toolNames.includes("bash")) {
		resolved.bash = { ...options.bash, commandPolicy: taskEnvelope.commandPolicy };
	}
	return resolved;
}

function resolveToolsContext(
	cwd: string,
	options: ToolsOptions | undefined,
	toolNames: readonly ToolName[],
): { cwd: string; options: ToolsOptions | undefined } {
	if (options?.taskEnvelope) {
		assertValidatedTaskEnvelope(options.taskEnvelope);
		if (cwd !== options.taskEnvelope.targetCwd) {
			throw new Error("cwd must exactly match taskEnvelope.targetCwd");
		}
		if (options.overlay) {
			throw new Error("taskEnvelope cannot be combined with workspace overlay");
		}
		assertTaskEnvelopeOptionsAreNotOverridden(options);
	}
	if (options?.boundary && options.overlay) {
		throw new Error("executionBoundary and workspace overlay cannot be configured together");
	}
	if (options?.overlay) {
		assertOverlayOptionsAreNotOverridden(options, toolNames);
		const workingDirectory = options.overlay.getWorkingDirectory();
		const resolved: ToolsOptions = { ...options, overlay: undefined };
		if (toolNames.includes("read")) {
			resolved.read = { ...options.read, allowedRoots: [workingDirectory] };
		}
		if (toolNames.includes("edit")) {
			resolved.edit = { ...options.edit, allowedRoots: [workingDirectory] };
		}
		if (toolNames.includes("write")) {
			resolved.write = { ...options.write, allowedRoots: [workingDirectory] };
		}
		if (toolNames.includes("grep")) {
			resolved.grep = { ...options.grep, allowedRoots: [workingDirectory] };
		}
		if (toolNames.includes("find")) {
			resolved.find = { ...options.find, allowedRoots: [workingDirectory] };
		}
		if (toolNames.includes("ls")) {
			resolved.ls = { ...options.ls, allowedRoots: [workingDirectory] };
		}
		return { cwd: workingDirectory, options: applyTaskEnvelopeScope(resolved, options.taskEnvelope, toolNames) };
	}
	if (!options?.boundary) {
		return options
			? { cwd, options: applyTaskEnvelopeScope(options, options.taskEnvelope, toolNames) }
			: { cwd, options };
	}
	assertBoundaryOptionsAreNotOverridden(options, toolNames);
	const boundary = resolveExecutionBoundary(options.boundary, toolNames);
	if (
		options.taskEnvelope &&
		(boundary.cwd !== options.taskEnvelope.targetCwd ||
			!sameRootSet(boundary.readableRoots, options.taskEnvelope.readableRoots) ||
			!sameRootSet(boundary.writableRoots, options.taskEnvelope.writableRoots))
	) {
		throw new Error("executionBoundary filesystem scope must exactly match taskEnvelope authorization");
	}
	const resolved: ToolsOptions = { ...options, boundary: undefined };

	if (toolNames.includes("read")) {
		resolved.read = {
			...options.read,
			operations: boundary.operations.read,
			allowedRoots: [...boundary.readableRoots],
		};
	}
	if (toolNames.includes("bash")) {
		resolved.bash = {
			...options.bash,
			operations: boundary.operations.bash,
			spawnHook: (context) => ({
				...context,
				env: filterBoundaryEnvironment(boundary.profile, context.env),
			}),
		};
	}
	if (toolNames.includes("edit")) {
		resolved.edit = {
			...options.edit,
			operations: boundary.operations.edit,
			allowedRoots: [...boundary.writableRoots],
		};
	}
	if (toolNames.includes("write")) {
		resolved.write = {
			...options.write,
			operations: boundary.operations.write,
			allowedRoots: [...boundary.writableRoots],
		};
	}
	if (toolNames.includes("grep")) {
		resolved.grep = {
			...options.grep,
			operations: boundary.operations.grep,
			allowedRoots: [...boundary.readableRoots],
		};
	}
	if (toolNames.includes("find")) {
		resolved.find = {
			...options.find,
			operations: boundary.operations.find,
			allowedRoots: [...boundary.readableRoots],
		};
	}
	if (toolNames.includes("ls")) {
		resolved.ls = {
			...options.ls,
			operations: boundary.operations.ls,
			allowedRoots: [...boundary.readableRoots],
		};
	}

	return {
		cwd: boundary.cwd,
		options: options.taskEnvelope
			? applyTaskEnvelopeCommandPolicy(resolved, options.taskEnvelope, toolNames)
			: resolved,
	};
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	const resolved = resolveToolsContext(cwd, options, [toolName]);
	cwd = resolved.cwd;
	options = resolved.options;
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const resolved = resolveToolsContext(cwd, options, [toolName]);
	cwd = resolved.cwd;
	options = resolved.options;
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const resolved = resolveToolsContext(cwd, options, ["read", "bash", "edit", "write"]);
	cwd = resolved.cwd;
	options = resolved.options;
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const resolved = resolveToolsContext(cwd, options, ["read", "grep", "find", "ls"]);
	cwd = resolved.cwd;
	options = resolved.options;
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const resolved = resolveToolsContext(cwd, options, [...allToolNames]);
	cwd = resolved.cwd;
	options = resolved.options;
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const resolved = resolveToolsContext(cwd, options, ["read", "bash", "edit", "write"]);
	cwd = resolved.cwd;
	options = resolved.options;
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const resolved = resolveToolsContext(cwd, options, ["read", "grep", "find", "ls"]);
	cwd = resolved.cwd;
	options = resolved.options;
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const resolved = resolveToolsContext(cwd, options, [...allToolNames]);
	cwd = resolved.cwd;
	options = resolved.options;
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
	};
}
