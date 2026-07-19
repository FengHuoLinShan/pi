import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { mkdir as fsMkdir, readFile as fsReadFile, realpath as fsRealpath } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { generateDiffString, generateUnifiedPatch } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	assertExpectedRevision,
	atomicWriteFile,
	captureFilePathSnapshot,
	computeFileRevision,
	type FilePathOperations,
	type FilePathPolicy,
	type FileRevision,
	type FileRevisionState,
	readRevisionState,
	revalidateFilePathSnapshot,
} from "./file-transaction.ts";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
	expectedRevision: Type.Optional(
		Type.String({
			description: 'SHA-256 revision returned by read/edit/write. Use "missing" to require creation of a new file.',
		}),
	),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	/** Revision before the write, or missing/unknown when the backend cannot provide one. */
	beforeRevision: FileRevisionState;
	/** Revision verified after the write when the backend supports readback; otherwise the intended content revision. */
	afterRevision: FileRevision;
	/** Display-oriented diff when the previous content was available. */
	diff?: string;
	/** Standard unified patch when the previous content was available. */
	patch?: string;
	/** Line number of the first change in the new file. */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations extends FilePathOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/** Read existing content for revision checks and mutation evidence. */
	readFile?: (absolutePath: string) => Promise<Buffer>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: atomicWriteFile,
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	readFile: (path) => fsReadFile(path),
	realpath: (path) => fsRealpath(path),
};

export interface WriteToolOptions extends FilePathPolicy {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}

function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	const ops = options?.operations ?? defaultWriteOperations;
	const allowedRoots = options?.allowedRoots?.map((root) => resolveToCwd(root, cwd));
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: [
			"Use write only for new files or complete rewrites.",
			"When write follows read, pass the revision from read as expectedRevision; use expectedRevision=missing when creating a file that must not already exist.",
		],
		parameters: writeSchema,
		async execute(
			_toolCallId,
			{ path, content, expectedRevision }: { path: string; content: string; expectedRevision?: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				const pathSnapshot = await captureFilePathSnapshot(absolutePath, path, allowedRoots, ops.realpath, true);
				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dirname(pathSnapshot.targetPath));
				await revalidateFilePathSnapshot(pathSnapshot, path, allowedRoots, ops.realpath);
				throwIfAborted();
				const before = await readRevisionState(pathSnapshot.targetPath, ops.readFile);
				assertExpectedRevision(path, expectedRevision, before.revision);
				throwIfAborted();

				// Write the file contents.
				await revalidateFilePathSnapshot(pathSnapshot, path, allowedRoots, ops.realpath);
				const current = await readRevisionState(pathSnapshot.targetPath, ops.readFile);
				if (before.revision !== "unknown") {
					assertExpectedRevision(path, before.revision, current.revision);
				}
				throwIfAborted();
				await ops.writeFile(pathSnapshot.targetPath, content);
				throwIfAborted();

				const intendedRevision = computeFileRevision(content);
				const verified = await readRevisionState(pathSnapshot.targetPath, ops.readFile);
				const afterRevision = verified.revision === "unknown" ? intendedRevision : verified.revision;
				if (afterRevision !== intendedRevision) {
					throw new Error(
						`Could not verify write to ${path}: expected revision ${intendedRevision}, found ${afterRevision}.`,
					);
				}

				const previousContent = before.revision === "missing" ? "" : before.content?.toString("utf8");
				const diffResult = previousContent === undefined ? undefined : generateDiffString(previousContent, content);

				return {
					content: [
						{
							type: "text",
							text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}. Revision: ${before.revision} -> ${afterRevision}.`,
						},
					],
					details: {
						beforeRevision: before.revision,
						afterRevision,
						diff: diffResult?.diff,
						patch:
							previousContent === undefined ? undefined : generateUnifiedPatch(path, previousContent, content),
						firstChangedLine: diffResult?.firstChangedLine,
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
			const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
			const fileContent = str(renderArgs?.content);
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			if (fileContent !== null) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath, fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
			} else {
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
					context.cwd,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const output = formatWriteResult({ ...result, isError: context.isError }, theme);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
