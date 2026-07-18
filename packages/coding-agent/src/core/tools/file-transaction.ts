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
): Promise<FilePathSnapshot> {
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
}

export async function revalidateFilePathSnapshot(
	snapshot: FilePathSnapshot,
	displayPath: string,
	allowedRoots: string[] | undefined,
	realpathOperation: FilePathOperations["realpath"],
): Promise<void> {
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
}

export function assertExpectedRevision(
	displayPath: string,
	expectedRevision: string | undefined,
	actualRevision: FileRevisionState,
): void {
	if (expectedRevision === undefined) return;
	if (expectedRevision !== "missing" && !/^sha256:[0-9a-f]{64}$/.test(expectedRevision)) {
		throw new Error(
			`Invalid expected revision for ${displayPath}: use "missing" or a sha256 revision returned by read, edit, or write.`,
		);
	}
	if (expectedRevision === actualRevision) return;
	throw new Error(
		`File revision conflict for ${displayPath}: expected ${expectedRevision}, found ${actualRevision}. Re-read the file and retry.`,
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
