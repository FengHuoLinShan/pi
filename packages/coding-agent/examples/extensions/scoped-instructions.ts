/**
 * Scoped Instructions Extension
 *
 * Requires the agent to read nested AGENTS.md or CLAUDE.md files before the
 * built-in edit and write tools may modify a file in their scope.
 *
 * Context files at the session cwd and its ancestors are already loaded by pi,
 * so this extension marks them as satisfied at session start. It adds prompt
 * guidance for bash and custom tools, which cannot be gated by target path.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	computeFileRevision,
	type ExtensionAPI,
	isReadToolResult,
	isToolCallEventType,
	type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

interface InstructionFile {
	path: string;
	revision: string;
}

interface ReadRange {
	start: number;
	end: number;
}

interface ReadCoverage {
	revision: string;
	ranges: ReadRange[];
}

function readInstructionFile(directory: string): InstructionFile | undefined {
	for (const fileName of INSTRUCTION_FILE_NAMES) {
		const path = resolve(directory, fileName);
		try {
			const content = readFileSync(path);
			return { path, revision: computeFileRevision(content) };
		} catch {}
	}
	return undefined;
}

function discoverAncestorInstructionFiles(startDirectory: string): InstructionFile[] {
	const files: InstructionFile[] = [];
	let directory = resolve(startDirectory);

	while (true) {
		const file = readInstructionFile(directory);
		if (file) files.unshift(file);

		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}

	return files;
}

export function discoverScopedInstructionFiles(cwd: string, targetPath: string): string[] {
	const absoluteTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(cwd, targetPath);
	return discoverAncestorInstructionFiles(dirname(absoluteTarget)).map((file) => file.path);
}

function mergeRanges(ranges: ReadRange[]): ReadRange[] {
	const ordered = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: ReadRange[] = [];

	for (const range of ordered) {
		const previous = merged.at(-1);
		if (!previous || previous.end + 1 < range.start) {
			merged.push({ ...range });
			continue;
		}
		previous.end = Math.max(previous.end, range.end);
	}

	return merged;
}

function recordReadCoverage(
	coverageByPath: Map<string, ReadCoverage>,
	path: string,
	input: Record<string, unknown>,
	details: ReadToolDetails,
): void {
	const offset = input.offset === undefined ? 1 : input.offset;
	if (!Number.isSafeInteger(offset) || (offset as number) < 1) return;

	let end: number;
	if (details.truncation?.truncated) {
		if (details.truncation.outputLines === 0) return;
		end = (offset as number) + details.truncation.outputLines - 1;
	} else if (input.limit === undefined) {
		end = Number.POSITIVE_INFINITY;
	} else {
		if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1) return;
		end = (offset as number) + (input.limit as number) - 1;
	}

	const existing = coverageByPath.get(path);
	const ranges = existing?.revision === details.revision ? existing.ranges : [];
	coverageByPath.set(path, {
		revision: details.revision,
		ranges: mergeRanges([...ranges, { start: offset as number, end }]),
	});
}

function markInstructionLoaded(coverageByPath: Map<string, ReadCoverage>, file: InstructionFile): void {
	coverageByPath.set(file.path, {
		revision: file.revision,
		ranges: [{ start: 1, end: Number.POSITIVE_INFINITY }],
	});
}

function hasCompleteCurrentRead(coverage: ReadCoverage | undefined, file: InstructionFile): boolean {
	if (!coverage || coverage.revision !== file.revision) return false;
	const first = coverage.ranges[0];
	return first !== undefined && first.start === 1 && first.end === Number.POSITIVE_INFINITY;
}

function formatPath(path: string, cwd: string): string {
	const relativePath = relative(cwd, path);
	if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
		return relativePath.replaceAll("\\", "/");
	}
	return path.replaceAll("\\", "/");
}

export default function scopedInstructions(pi: ExtensionAPI): void {
	const coverageByPath = new Map<string, ReadCoverage>();

	pi.on("session_start", async (_event, ctx) => {
		coverageByPath.clear();
		for (const file of discoverAncestorInstructionFiles(ctx.cwd)) {
			markInstructionLoaded(coverageByPath, file);
		}
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}

## Scoped project instructions

Nested AGENTS.md or CLAUDE.md files may apply to files below the current directory. If a file-tool call is blocked for unread instructions, read every listed file completely before retrying. Do not bypass this instruction gate with bash or custom mutation tools.`,
	}));

	pi.on("tool_result", async (event, ctx) => {
		if (!isReadToolResult(event) || event.isError || !event.details) return;
		const path = event.input.path;
		if (typeof path !== "string") return;

		const absolutePath = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path);
		recordReadCoverage(coverageByPath, absolutePath, event.input, event.details);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;

		const absoluteTarget = isAbsolute(event.input.path)
			? resolve(event.input.path)
			: resolve(ctx.cwd, event.input.path);
		const missing = discoverAncestorInstructionFiles(dirname(absoluteTarget)).filter(
			(file) => !hasCompleteCurrentRead(coverageByPath.get(file.path), file),
		);
		if (missing.length === 0) return;

		return {
			block: true,
			reason: `Read applicable project instructions before modifying ${formatPath(absoluteTarget, ctx.cwd)}: ${missing
				.map((file) => formatPath(file.path, ctx.cwd))
				.join(", ")}`,
		};
	});
}
