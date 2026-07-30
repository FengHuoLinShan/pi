import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { captureFilePathSnapshot, isMissingPathError, revalidateFilePathSnapshot } from "./tools/file-transaction.ts";

export interface VerifiedProjectFile {
	readonly path: string;
	readonly content: Buffer;
	readonly revision: string;
}

function sameFileSnapshot(expected: Stats, actual: Stats): boolean {
	return (
		expected.dev === actual.dev &&
		expected.ino === actual.ino &&
		expected.mode === actual.mode &&
		expected.size === actual.size &&
		expected.mtimeMs === actual.mtimeMs &&
		expected.ctimeMs === actual.ctimeMs
	);
}

async function readBoundedFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
	const buffer = Buffer.alloc(maxBytes + 1);
	let offset = 0;
	while (offset < buffer.byteLength) {
		const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

export async function loadVerifiedProjectFile(
	sourceRoot: string,
	relativePath: string,
	maxBytes: number,
): Promise<VerifiedProjectFile | undefined> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("Verified project file size limit must be a positive safe integer");
	}
	const path = join(sourceRoot, relativePath);
	let initialInfo: Stats;
	try {
		initialInfo = await lstat(path);
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
	if (!initialInfo.isFile() || initialInfo.isSymbolicLink()) {
		throw new Error(`${relativePath} must be a regular non-symbolic-link file`);
	}
	if (initialInfo.size > maxBytes) {
		throw new Error(`${relativePath} exceeds ${maxBytes} bytes`);
	}

	const snapshot = await captureFilePathSnapshot(path, relativePath, [sourceRoot], realpath, true);
	await revalidateFilePathSnapshot(snapshot, relativePath, [sourceRoot], realpath);
	const handle = await open(snapshot.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let content: Buffer;
	try {
		const openedInfo = await handle.stat();
		if (!openedInfo.isFile() || !sameFileSnapshot(initialInfo, openedInfo)) {
			throw new Error(`${relativePath} changed while being loaded; retry`);
		}
		content = await readBoundedFile(handle, maxBytes);
		const finalInfo = await handle.stat();
		if (!sameFileSnapshot(openedInfo, finalInfo)) {
			throw new Error(`${relativePath} changed while being loaded; retry`);
		}
	} finally {
		await handle.close();
	}
	await revalidateFilePathSnapshot(snapshot, relativePath, [sourceRoot], realpath);
	if (content.byteLength > maxBytes) {
		throw new Error(`${relativePath} exceeds ${maxBytes} bytes`);
	}
	return {
		path,
		content,
		revision: `sha256:${createHash("sha256").update(content).digest("hex")}`,
	};
}
