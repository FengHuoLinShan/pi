import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type FileRevision = `sha256:${string}`;
export type FileRevisionState = FileRevision | "missing" | "unknown";

export interface FilePathOperations {
	/** Resolve symlinks and return a canonical path in the same path namespace. */
	realpath?: (absolutePath: string) => Promise<string>;
}

export interface FilePathPolicy {
	/** Optional roots that the tool may access. Paths are resolved relative to the tool cwd. */
	allowedRoots?: string[];
	/** Replace path-bearing errors with stable restricted-mode diagnostics. Default: false. */
	redactPathErrors?: boolean;
}

export type RestrictedFileErrorCode =
	| "FILE_PATH_DENIED"
	| "FILE_PATH_CHANGED"
	| "FILE_REVISION_INVALID"
	| "FILE_REVISION_CONFLICT"
	| "FILE_OPERATION_FAILED";

class RestrictedFileError extends Error {
	readonly code: RestrictedFileErrorCode;

	constructor(code: RestrictedFileErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

const restrictedFileErrorMessages: Record<RestrictedFileErrorCode, string> = {
	FILE_PATH_DENIED: "File path access was denied. Use a path within the authorized workspace.",
	FILE_PATH_CHANGED: "File path authorization changed during the operation. Re-read the target and retry.",
	FILE_REVISION_INVALID: "Expected revision is invalid. Re-read the target and use the returned revision.",
	FILE_REVISION_CONFLICT: "File revision changed. Re-read the target and retry with the returned revision.",
	FILE_OPERATION_FAILED: "File operation failed. Verify the path is authorized, re-read the target, and retry.",
};

export function redactFileError(error: unknown, redactPathErrors: boolean, code: RestrictedFileErrorCode): Error {
	const normalized = error instanceof Error ? error : new Error(String(error));
	if (!redactPathErrors || normalized.message === "Operation aborted") return normalized;
	if (normalized instanceof RestrictedFileError) return normalized;
	return new RestrictedFileError(code, restrictedFileErrorMessages[code]);
}

export interface FilePathSnapshot {
	requestedPath: string;
	targetPath: string;
	canonicalRoots: string[];
}

export function computeFileRevision(content: Buffer | string): FileRevision {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function canonicalizeExistingOrPlannedPath(
	absolutePath: string,
	realpathOperation: (path: string) => Promise<string>,
): Promise<string> {
	const suffix: string[] = [];
	let candidate = resolve(absolutePath);

	while (true) {
		try {
			const canonical = await realpathOperation(candidate);
			return suffix.length === 0 ? canonical : resolve(canonical, ...suffix.reverse());
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(candidate);
			if (parent === candidate) throw error;
			suffix.push(basename(candidate));
			candidate = parent;
		}
	}
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = relative(rootPath, targetPath);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function assertAllowedPath(
	displayPath: string,
	targetPath: string,
	canonicalRoots: string[],
	policyEnabled: boolean,
): void {
	if (!policyEnabled || canonicalRoots.some((root) => isWithinRoot(targetPath, root))) return;
	throw new Error(
		`File path policy violation for ${displayPath}: resolved path ${targetPath} is outside the allowed roots.`,
	);
}

export async function captureFilePathSnapshot(
	absolutePath: string,
	displayPath: string,
	allowedRoots: string[] | undefined,
	realpathOperation: FilePathOperations["realpath"],
	canonicalizeTarget: boolean,
	redactPathErrors = false,
): Promise<FilePathSnapshot> {
	try {
		if (!realpathOperation) {
			if (allowedRoots !== undefined) {
				if (allowedRoots.length === 0) {
					assertAllowedPath(displayPath, absolutePath, [], true);
				}
				throw new Error(
					`File path policy for ${displayPath} requires operations.realpath so symlink boundaries can be verified.`,
				);
			}
			return { requestedPath: absolutePath, targetPath: absolutePath, canonicalRoots: [] };
		}

		const canonicalRoots = await Promise.all(
			(allowedRoots ?? []).map((root) => canonicalizeExistingOrPlannedPath(root, realpathOperation)),
		);
		const canonicalTarget = await canonicalizeExistingOrPlannedPath(absolutePath, realpathOperation);
		assertAllowedPath(displayPath, canonicalTarget, canonicalRoots, allowedRoots !== undefined);
		return {
			requestedPath: absolutePath,
			targetPath: canonicalizeTarget ? canonicalTarget : absolutePath,
			canonicalRoots,
		};
	} catch (error) {
		throw redactFileError(error, redactPathErrors, "FILE_PATH_DENIED");
	}
}

export async function revalidateFilePathSnapshot(
	snapshot: FilePathSnapshot,
	displayPath: string,
	allowedRoots: string[] | undefined,
	realpathOperation: FilePathOperations["realpath"],
	redactPathErrors = false,
): Promise<void> {
	try {
		if (!realpathOperation) return;
		const currentRoots = await Promise.all(
			(allowedRoots ?? []).map((root) => canonicalizeExistingOrPlannedPath(root, realpathOperation)),
		);
		if (
			currentRoots.length !== snapshot.canonicalRoots.length ||
			currentRoots.some((root, index) => root !== snapshot.canonicalRoots[index])
		) {
			throw new Error(`File path policy changed while operating on ${displayPath}. Re-run the operation.`);
		}
		const currentTarget = await canonicalizeExistingOrPlannedPath(snapshot.requestedPath, realpathOperation);
		assertAllowedPath(displayPath, currentTarget, currentRoots, allowedRoots !== undefined);
		if (currentTarget !== snapshot.targetPath) {
			throw new Error(
				`File path changed while operating on ${displayPath}: expected ${snapshot.targetPath}, found ${currentTarget}. Re-read the file and retry.`,
			);
		}
	} catch (error) {
		throw redactFileError(error, redactPathErrors, "FILE_PATH_CHANGED");
	}
}

export function assertExpectedRevision(
	displayPath: string,
	expectedRevision: string | undefined,
	actualRevision: FileRevisionState,
	redactPathErrors = false,
): void {
	if (expectedRevision === undefined) return;
	if (expectedRevision !== "missing" && !/^sha256:[0-9a-f]{64}$/.test(expectedRevision)) {
		throw redactFileError(
			new Error(
				`Invalid expected revision for ${displayPath}: use "missing" or copy the complete sha256:<64 lowercase hex> token, including the "sha256:" prefix, returned by read, edit, or write.`,
			),
			redactPathErrors,
			"FILE_REVISION_INVALID",
		);
	}
	if (expectedRevision === actualRevision) return;
	throw redactFileError(
		new Error(
			`File revision conflict for ${displayPath}: expected ${expectedRevision}, found ${actualRevision}. Re-read the file and retry.`,
		),
		redactPathErrors,
		"FILE_REVISION_CONFLICT",
	);
}

export async function readRevisionState(
	absolutePath: string,
	readFileOperation: ((path: string) => Promise<Buffer>) | undefined,
): Promise<{ content?: Buffer; revision: FileRevisionState }> {
	if (!readFileOperation) return { revision: "unknown" };
	try {
		const content = await readFileOperation(absolutePath);
		return { content, revision: computeFileRevision(content) };
	} catch (error) {
		if (isMissingPathError(error)) return { revision: "missing" };
		throw error;
	}
}

/**
 * Commit UTF-8 content through a same-directory staging file and atomic rename.
 * Existing mode bits are preserved when the target exists. The staging file is
 * removed after every failed or successful attempt.
 */
export async function atomicWriteFile(absolutePath: string, content: string): Promise<void> {
	const directory = dirname(absolutePath);
	const stagingPath = join(directory, `.${basename(absolutePath)}.pi-stage-${process.pid}-${randomUUID()}`);
	let mode: number | undefined;
	try {
		try {
			mode = (await stat(absolutePath)).mode & 0o777;
			await access(absolutePath, constants.W_OK);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		await writeFile(stagingPath, content, { encoding: "utf8", mode });
		await rename(stagingPath, absolutePath);
	} finally {
		await rm(stagingPath, { force: true });
	}
}
