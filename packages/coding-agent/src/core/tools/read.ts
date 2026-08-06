import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, realpath as fsRealpath } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	captureFilePathSnapshot,
	computeFileRevision,
	type FilePathOperations,
	type FilePathPolicy,
	type FileRevision,
	redactFileError,
	revalidateFilePathSnapshot,
} from "./file-transaction.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	truncateStringToBytesFromStart,
} from "./truncate.ts";

/** Maximum preview bytes before reserving space for metadata, continuation guidance, and revision. */
export const OVERSIZED_READ_LINE_PREVIEW_BYTES = 40 * 1024;
const READ_REUSE_FINGERPRINT_LINES = 64;
const MAX_READ_REUSE_PATHS = 128;

function quoteBashAnsiCString(value: string): string {
	let quoted = "$'";
	for (const character of value) {
		if (character === "\\") quoted += "\\\\";
		else if (character === "'") quoted += "\\'";
		else if (character === "\n") quoted += "\\n";
		else if (character === "\r") quoted += "\\r";
		else if (character === "\t") quoted += "\\t";
		else if ((character.codePointAt(0) ?? 0) < 0x20 || character === "\u007f") {
			for (const byte of Buffer.from(character, "utf8")) quoted += `\\x${byte.toString(16).padStart(2, "0")}`;
		} else quoted += character;
	}
	return `${quoted}'`;
}

function oversizedLineMetadata(
	canonicalPath: string,
	lineNumber: number,
	previewBytes: number,
	lineBytes: number,
): string {
	const command = `FILE=${quoteBashAnsiCString(canonicalPath)}; sed -n '${lineNumber}p' < "$FILE" | dd bs=1 skip=${previewBytes} count=${OVERSIZED_READ_LINE_PREVIEW_BYTES} 2>/dev/null | iconv -c -f UTF-8 -t UTF-8`;
	return `\n\n[single line truncated: showing ${formatSize(previewBytes)} of line ${lineNumber} (${formatSize(lineBytes)} total). Source file: ${JSON.stringify(canonicalPath)}. Continuation (bash): ${command}]`;
}

function boundedOversizedLineOutput(
	line: string,
	canonicalPath: string,
	lineNumber: number,
	lineBytes: number,
	revision: FileRevision,
): { outputText: string; preview: string; previewBytes: number } {
	const revisionSuffix = `\n\n[Revision: ${revision}]`;
	let metadata = oversizedLineMetadata(canonicalPath, lineNumber, OVERSIZED_READ_LINE_PREVIEW_BYTES, lineBytes);
	if (Buffer.byteLength(metadata + revisionSuffix, "utf8") >= DEFAULT_MAX_BYTES) {
		metadata = `\n\n[single line truncated: source line ${lineNumber} is ${formatSize(lineBytes)}. The canonical source path is too long to include safely; re-run read through a shorter canonical path before continuing.]`;
	}
	const availablePreviewBytes = Math.max(
		0,
		Math.min(
			OVERSIZED_READ_LINE_PREVIEW_BYTES,
			DEFAULT_MAX_BYTES - Buffer.byteLength(metadata + revisionSuffix, "utf8"),
		),
	);
	const preview = truncateStringToBytesFromStart(line, availablePreviewBytes);
	const previewBytes = Buffer.byteLength(preview, "utf8");
	if (metadata.includes("Continuation (bash):")) {
		metadata = oversizedLineMetadata(canonicalPath, lineNumber, previewBytes, lineBytes);
	}
	const outputText = `${preview}${metadata}`;
	if (Buffer.byteLength(outputText + revisionSuffix, "utf8") > DEFAULT_MAX_BYTES) {
		const exactPreviewBudget = Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(metadata + revisionSuffix, "utf8"));
		const exactPreview = truncateStringToBytesFromStart(preview, exactPreviewBudget);
		return {
			outputText: `${exactPreview}${metadata}`,
			preview: exactPreview,
			previewBytes: Buffer.byteLength(exactPreview, "utf8"),
		};
	}
	return { outputText, preview, previewBytes };
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	/** SHA-256 revision of the complete raw file, including content outside a requested line range. */
	revision: FileRevision;
	truncation?: TruncationResult;
	reuse?: {
		/** First unchanged line omitted from this result because it was already returned in the current turn. */
		omittedStartLine: number;
		/** Last unchanged line omitted from this result because it was already returned in the current turn. */
		omittedEndLine: number;
		/** Whether the complete requested range was already available to the model. */
		fullyCovered: boolean;
	};
}

interface LineRange {
	startLine: number;
	endLine: number;
}

interface CoveredLineRange extends LineRange {
	fingerprint: FileRevision;
}

interface ReadCoverage {
	revision: FileRevision;
	ranges: CoveredLineRange[];
	markerPending: boolean;
	fallbackUsed: boolean;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations extends FilePathOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	realpath: (path) => fsRealpath(path),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions extends FilePathPolicy {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function getReadReuseScope(ctx: ExtensionContext | undefined): string | undefined {
	const branch = ctx?.sessionManager.getBranch();
	if (!branch) return undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "compaction") return `compaction:${entry.id}`;
		if (entry.type === "message" && entry.message.role === "user") return `user:${entry.id}`;
	}
	return undefined;
}

function fingerprintLineRange(allLines: string[], range: LineRange): FileRevision {
	return computeFileRevision(Buffer.from(allLines.slice(range.startLine - 1, range.endLine).join("\n"), "utf8"));
}

function refreshCoverageRevision(coverage: ReadCoverage, revision: FileRevision, allLines: string[]): void {
	if (coverage.revision === revision) return;
	coverage.ranges = coverage.ranges.filter(
		(range) => range.endLine <= allLines.length && range.fingerprint === fingerprintLineRange(allLines, range),
	);
	coverage.revision = revision;
	coverage.markerPending = false;
	coverage.fallbackUsed = false;
}

function addCoveredLineRange(ranges: CoveredLineRange[], startLine: number, endLine: number, allLines: string[]): void {
	if (endLine < startLine) return;
	const merged: LineRange[] = [];
	let nextStart = startLine;
	let nextEnd = endLine;
	let inserted = false;
	for (const range of ranges) {
		if (range.endLine + 1 < nextStart) {
			merged.push(range);
			continue;
		}
		if (nextEnd + 1 < range.startLine) {
			if (!inserted) {
				merged.push({ startLine: nextStart, endLine: nextEnd });
				inserted = true;
			}
			merged.push(range);
			continue;
		}
		nextStart = Math.min(nextStart, range.startLine);
		nextEnd = Math.max(nextEnd, range.endLine);
	}
	if (!inserted) merged.push({ startLine: nextStart, endLine: nextEnd });
	const fingerprinted: CoveredLineRange[] = [];
	for (const range of merged) {
		for (let chunkStart = range.startLine; chunkStart <= range.endLine; chunkStart += READ_REUSE_FINGERPRINT_LINES) {
			const chunk = {
				startLine: chunkStart,
				endLine: Math.min(range.endLine, chunkStart + READ_REUSE_FINGERPRINT_LINES - 1),
			};
			fingerprinted.push({ ...chunk, fingerprint: fingerprintLineRange(allLines, chunk) });
		}
	}
	ranges.splice(0, ranges.length, ...fingerprinted);
}

function findCoveredPrefixEnd(
	ranges: LineRange[],
	requestedStartLine: number,
	requestedEndLine: number,
): number | undefined {
	let nextLine = requestedStartLine;
	for (const range of ranges) {
		if (range.endLine < nextLine) continue;
		if (range.startLine > nextLine) break;
		nextLine = Math.max(nextLine, range.endLine + 1);
		if (nextLine > requestedEndLine) return requestedEndLine;
	}
	return nextLine > requestedStartLine ? nextLine - 1 : undefined;
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	const allowedRoots = options?.allowedRoots?.map((root) => resolveToCwd(root, cwd));
	const redactPathErrors = options?.redactPathErrors ?? false;
	let reuseScope: string | undefined;
	const coverageByPath = new Map<string, ReadCoverage>();
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file and return its SHA-256 revision for conflict-safe edits. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Within one user turn, unchanged ranges already returned may be omitted with a reuse marker, including fingerprint-verified ranges after unrelated file changes. Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Use read to examine files instead of cat or sed.",
			"Reuse unchanged file content already returned in the current turn; do not repeat the same path and range unless the prior result was truncated, a mutation may have occurred, or the user explicitly asks to re-verify.",
			"When read returns a reuse marker, use the earlier tool result still present in context; do not retry the same or a narrower covered range.",
			"For continued large-file reads, request only the missing non-overlapping range; do not restart at line 1 after a bounded read.",
		],
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, cwd);
							if (aborted) return;
							const pathSnapshot = await captureFilePathSnapshot(
								absolutePath,
								path,
								allowedRoots,
								ops.realpath,
								true,
								redactPathErrors,
							);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(pathSnapshot.targetPath);
							if (aborted) return;
							await revalidateFilePathSnapshot(pathSnapshot, path, allowedRoots, ops.realpath, redactPathErrors);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType
								? await ops.detectImageMimeType(pathSnapshot.targetPath)
								: undefined;
							const buffer = await ops.readFile(pathSnapshot.targetPath);
							const revision = computeFileRevision(buffer);
							let content: (TextContent | ImageContent)[];
							const details: ReadToolDetails = { revision };
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									textNote += `\n[Revision: ${revision}]`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									textNote += `\n[Revision: ${revision}]`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const requestedStartLine = offset ? Math.max(0, offset - 1) : 0;
								// Check if offset is out of bounds.
								if (requestedStartLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								const requestedEndLine =
									limit !== undefined
										? Math.min(requestedStartLine + limit, allLines.length)
										: allLines.length;
								let startLine = requestedStartLine;
								let reusedPrefix: LineRange | undefined;
								let repeatedAfterReuseMarker = false;
								const currentReuseScope = getReadReuseScope(ctx);
								if (currentReuseScope !== reuseScope) {
									coverageByPath.clear();
									reuseScope = currentReuseScope;
								}
								let pathCoverage: ReadCoverage | undefined;
								if (currentReuseScope && requestedEndLine > requestedStartLine) {
									const existingCoverage = coverageByPath.get(pathSnapshot.targetPath);
									if (existingCoverage) {
										coverageByPath.delete(pathSnapshot.targetPath);
										coverageByPath.set(pathSnapshot.targetPath, existingCoverage);
										refreshCoverageRevision(existingCoverage, revision, allLines);
										pathCoverage = existingCoverage;
									} else {
										if (coverageByPath.size >= MAX_READ_REUSE_PATHS) {
											const oldestPath = coverageByPath.keys().next().value;
											if (oldestPath !== undefined) coverageByPath.delete(oldestPath);
										}
										pathCoverage = {
											revision,
											ranges: [],
											markerPending: false,
											fallbackUsed: false,
										};
										coverageByPath.set(pathSnapshot.targetPath, pathCoverage);
									}
									const requestedStartDisplay = requestedStartLine + 1;
									const requestedEndDisplay = requestedEndLine;
									const coveredPrefixEnd = findCoveredPrefixEnd(
										pathCoverage.ranges,
										requestedStartDisplay,
										requestedEndDisplay,
									);
									if (coveredPrefixEnd !== undefined) {
										const fullyCovered = coveredPrefixEnd >= requestedEndDisplay;
										if (fullyCovered && pathCoverage.markerPending && !pathCoverage.fallbackUsed) {
											pathCoverage.markerPending = false;
											pathCoverage.fallbackUsed = true;
											repeatedAfterReuseMarker = true;
										} else if (fullyCovered) {
											pathCoverage.markerPending = !pathCoverage.fallbackUsed;
											details.reuse = {
												omittedStartLine: requestedStartDisplay,
												omittedEndLine: coveredPrefixEnd,
												fullyCovered: true,
											};
											content = [
												{
													type: "text",
													text: `[Read reuse: unchanged lines ${requestedStartDisplay}-${requestedEndDisplay} remain available in an earlier tool result in this turn. No file content repeated; use that earlier result and do not retry this range. After one fallback for this path, unchanged covered content will not be repeated again in this turn.]\n\n[Revision: ${revision}]`,
												},
											];
											if (aborted) return;
											signal?.removeEventListener("abort", onAbort);
											resolve({ content, details });
											return;
										} else if (!fullyCovered) {
											pathCoverage.markerPending = false;
											reusedPrefix = {
												startLine: requestedStartDisplay,
												endLine: coveredPrefixEnd,
											};
											details.reuse = {
												omittedStartLine: requestedStartDisplay,
												omittedEndLine: coveredPrefixEnd,
												fullyCovered: false,
											};
											startLine = coveredPrefixEnd;
										}
									}
									if (coveredPrefixEnd === undefined) pathCoverage.markerPending = false;
								}
								const startLineDisplay = startLine + 1;
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									selectedContent = allLines.slice(startLine, requestedEndLine).join("\n");
									userLimitedLines = requestedEndLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									const firstLine = allLines[startLine];
									const firstLineBytes = Buffer.byteLength(firstLine, "utf8");
									const bounded = boundedOversizedLineOutput(
										firstLine,
										pathSnapshot.targetPath,
										startLineDisplay,
										firstLineBytes,
										revision,
									);
									const boundedTruncation: TruncationResult = {
										...truncation,
										content: bounded.preview,
										outputBytes: bounded.previewBytes,
										lastLinePartial: true,
									};
									outputText = bounded.outputText;
									details.truncation = boundedTruncation;
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details.truncation = truncation;
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								if (reusedPrefix) {
									outputText = `[Read reuse: unchanged lines ${reusedPrefix.startLine}-${reusedPrefix.endLine} remain available in an earlier tool result in this turn. Do not retry that prefix; only lines ${startLineDisplay}-${requestedEndLine} are shown below.]\n\n${outputText}`;
								} else if (repeatedAfterReuseMarker) {
									outputText = `[Read reuse fallback: a previous reuse marker for this path was retried, so the unchanged requested content is repeated. Use this result and do not reread covered ranges.]\n\n${outputText}`;
								}
								if (pathCoverage) {
									const returnedEndLine = truncation.truncated
										? startLineDisplay + truncation.outputLines - 1
										: requestedEndLine;
									addCoveredLineRange(pathCoverage.ranges, startLineDisplay, returnedEndLine, allLines);
								}
								outputText += `\n\n[Revision: ${revision}]`;
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: unknown) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) {
								reject(redactFileError(error, redactPathErrors, "FILE_OPERATION_FAILED"));
							}
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
