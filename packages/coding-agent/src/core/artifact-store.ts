import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { captureFilePathSnapshot, isMissingPathError, revalidateFilePathSnapshot } from "./tools/file-transaction.ts";

export type ArtifactRef = `sha256:${string}`;

export type ArtifactAttributeValue = string | number | boolean | null;

export interface ArtifactProvenance {
	/** Stable producer name, for example a tool or process backend id. */
	producer: string;
	/** Source URI or logical input identifier when one exists. */
	source?: string;
	/** Durable process session that produced this artifact. */
	processSessionId?: string;
	attributes?: Record<string, ArtifactAttributeValue>;
}

export interface ArtifactMetadata {
	mediaType?: string;
	name?: string;
	provenance: ArtifactProvenance;
}

export interface StoredArtifactMetadata extends ArtifactMetadata {
	id: string;
	createdAt: string;
}

export interface ArtifactDescriptor {
	ref: ArtifactRef;
	byteLength: number;
	mediaType?: string;
	name?: string;
	provenance: StoredArtifactMetadata[];
	/** True when the object was recovered without a surviving metadata sidecar. */
	recovered: boolean;
}

export interface ArtifactStoreRecoveryReport {
	artifacts: number;
	metadataRecords: number;
	recoveredObjects: number;
	invalidObjects: string[];
	invalidMetadata: string[];
}

export interface ArtifactStoreOptions {
	root: string;
	/** Canonical host roots that may contain the store. Defaults to the store root. */
	allowedRoots?: string[];
}

interface ArtifactMetadataRecord extends StoredArtifactMetadata {
	version: 1;
	ref: ArtifactRef;
	byteLength: number;
}

const ARTIFACT_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isArtifactAttributes(value: unknown): value is Record<string, ArtifactAttributeValue> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every(
			(attribute) =>
				attribute === null ||
				typeof attribute === "string" ||
				(typeof attribute === "number" && Number.isFinite(attribute)) ||
				typeof attribute === "boolean",
		)
	);
}

function hashArtifact(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function toArtifactRef(digest: string): ArtifactRef {
	return `sha256:${digest}`;
}

function parseArtifactRef(ref: ArtifactRef): string {
	const digest = ref.slice("sha256:".length);
	if (!ARTIFACT_HEX_PATTERN.test(digest)) throw new Error(`Invalid artifact reference: ${ref}`);
	return digest;
}

function isArtifactMetadataRecord(value: unknown): value is ArtifactMetadataRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<ArtifactMetadataRecord>;
	return (
		record.version === 1 &&
		typeof record.id === "string" &&
		typeof record.createdAt === "string" &&
		typeof record.ref === "string" &&
		/^sha256:[0-9a-f]{64}$/.test(record.ref) &&
		typeof record.byteLength === "number" &&
		Number.isSafeInteger(record.byteLength) &&
		record.byteLength >= 0 &&
		(record.mediaType === undefined || typeof record.mediaType === "string") &&
		(record.name === undefined || typeof record.name === "string") &&
		typeof record.provenance === "object" &&
		record.provenance !== null &&
		typeof record.provenance.producer === "string" &&
		(record.provenance.source === undefined || typeof record.provenance.source === "string") &&
		(record.provenance.processSessionId === undefined || typeof record.provenance.processSessionId === "string") &&
		(record.provenance.attributes === undefined || isArtifactAttributes(record.provenance.attributes))
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

/** Same-directory staging plus rename keeps each object or sidecar all-or-nothing. */
async function atomicWriteBuffer(path: string, content: Buffer): Promise<void> {
	const stagingPath = join(dirname(path), `.${basename(path)}.pi-stage-${process.pid}-${randomUUID()}`);
	try {
		await writeFile(stagingPath, content, { flag: "wx" });
		await rename(stagingPath, path);
	} finally {
		await rm(stagingPath, { force: true });
	}
}

/**
 * Local content-addressed artifact storage.
 *
 * Object bytes never enter the recoverable index. Immutable objects live under
 * `objects/sha256`, while small append-only provenance sidecars live under
 * `metadata/sha256`. The in-memory index is rebuilt by scanning both trees.
 */
export class ArtifactStore {
	private readonly root: string;
	private readonly allowedRoots: string[];
	private readonly descriptors = new Map<ArtifactRef, ArtifactDescriptor>();

	private constructor(options: ArtifactStoreOptions) {
		this.root = resolve(options.root);
		this.allowedRoots = (options.allowedRoots ?? [this.root]).map((root) => resolve(root));
	}

	static async open(options: ArtifactStoreOptions): Promise<{
		store: ArtifactStore;
		recovery: ArtifactStoreRecoveryReport;
	}> {
		const store = new ArtifactStore(options);
		await store.initialize();
		const recovery = await store.rebuildIndex();
		return { store, recovery };
	}

	getRoot(): string {
		return this.root;
	}

	private async initialize(): Promise<void> {
		const snapshot = await captureFilePathSnapshot(this.root, this.root, this.allowedRoots, realpath, true);
		await mkdir(this.objectRoot(), { recursive: true });
		await mkdir(this.metadataRoot(), { recursive: true });
		await revalidateFilePathSnapshot(snapshot, this.root, this.allowedRoots, realpath);
	}

	private objectRoot(): string {
		return join(this.root, "objects", "sha256");
	}

	private metadataRoot(): string {
		return join(this.root, "metadata", "sha256");
	}

	private objectPath(digest: string): string {
		return join(this.objectRoot(), digest.slice(0, 2), digest);
	}

	private metadataDirectory(digest: string): string {
		return join(this.metadataRoot(), digest.slice(0, 2), digest);
	}

	private async assertStorePath(path: string) {
		return captureFilePathSnapshot(path, path, this.allowedRoots, realpath, true);
	}

	async put(content: Buffer | Uint8Array | string, metadata: ArtifactMetadata): Promise<ArtifactDescriptor> {
		if (!metadata.provenance.producer.trim()) throw new Error("Artifact provenance producer must not be empty");
		if (metadata.provenance.attributes && !isArtifactAttributes(metadata.provenance.attributes)) {
			throw new Error("Artifact provenance attributes must contain only finite scalar values");
		}
		const metadataValue: ArtifactMetadata = {
			mediaType: metadata.mediaType,
			name: metadata.name,
			provenance: {
				...metadata.provenance,
				attributes: metadata.provenance.attributes ? { ...metadata.provenance.attributes } : undefined,
			},
		};
		const bytes =
			typeof content === "string"
				? Buffer.from(content, "utf8")
				: Buffer.isBuffer(content)
					? Buffer.from(content)
					: Buffer.from(content);
		const digest = hashArtifact(bytes);
		const ref = toArtifactRef(digest);
		const objectPath = this.objectPath(digest);
		const objectSnapshot = await this.assertStorePath(objectPath);
		await mkdir(dirname(objectPath), { recursive: true });

		if (await pathExists(objectPath)) {
			const existing = await readFile(objectPath);
			if (hashArtifact(existing) !== digest) throw new Error(`Artifact object is corrupt: ${ref}`);
			await revalidateFilePathSnapshot(objectSnapshot, objectPath, this.allowedRoots, realpath);
		} else {
			await revalidateFilePathSnapshot(objectSnapshot, objectPath, this.allowedRoots, realpath);
			await atomicWriteBuffer(objectPath, bytes);
		}

		const storedMetadata: ArtifactMetadataRecord = {
			version: 1,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			ref,
			byteLength: bytes.length,
			mediaType: metadataValue.mediaType,
			name: metadataValue.name,
			provenance: metadataValue.provenance,
		};
		const metadataDirectory = this.metadataDirectory(digest);
		const metadataPath = join(metadataDirectory, `${storedMetadata.id}.json`);
		const metadataSnapshot = await this.assertStorePath(metadataPath);
		await mkdir(metadataDirectory, { recursive: true });
		await revalidateFilePathSnapshot(metadataSnapshot, metadataPath, this.allowedRoots, realpath);
		await atomicWriteBuffer(metadataPath, Buffer.from(`${JSON.stringify(storedMetadata)}\n`, "utf8"));

		const descriptor = this.descriptors.get(ref) ?? {
			ref,
			byteLength: bytes.length,
			provenance: [],
			recovered: false,
		};
		descriptor.byteLength = bytes.length;
		descriptor.mediaType = metadataValue.mediaType ?? descriptor.mediaType;
		descriptor.name = metadataValue.name ?? descriptor.name;
		descriptor.provenance.push(this.toStoredMetadata(storedMetadata));
		descriptor.recovered = false;
		this.descriptors.set(ref, descriptor);
		return this.copyDescriptor(descriptor);
	}

	get(ref: ArtifactRef): ArtifactDescriptor | undefined {
		const descriptor = this.descriptors.get(ref);
		return descriptor ? this.copyDescriptor(descriptor) : undefined;
	}

	list(): ArtifactDescriptor[] {
		return [...this.descriptors.values()]
			.sort((left, right) => left.ref.localeCompare(right.ref))
			.map((descriptor) => this.copyDescriptor(descriptor));
	}

	async read(ref: ArtifactRef): Promise<Buffer> {
		const digest = parseArtifactRef(ref);
		const path = this.objectPath(digest);
		await this.assertStorePath(path);
		const content = await readFile(path);
		if (hashArtifact(content) !== digest) throw new Error(`Artifact object is corrupt: ${ref}`);
		return content;
	}

	async rebuildIndex(): Promise<ArtifactStoreRecoveryReport> {
		this.descriptors.clear();
		const invalidObjects: string[] = [];
		const invalidMetadata: string[] = [];
		let metadataRecords = 0;

		for (const path of await this.listObjectPaths()) {
			const digest = basename(path);
			try {
				const content = await readFile(path);
				if (hashArtifact(content) !== digest) throw new Error("digest mismatch");
				const ref = toArtifactRef(digest);
				this.descriptors.set(ref, {
					ref,
					byteLength: content.length,
					provenance: [],
					recovered: true,
				});
			} catch {
				invalidObjects.push(path);
			}
		}

		for (const path of await this.listMetadataPaths()) {
			try {
				const record = JSON.parse(await readFile(path, "utf8")) as unknown;
				if (!isArtifactMetadataRecord(record)) throw new Error("invalid metadata record");
				const digest = parseArtifactRef(record.ref);
				if (basename(dirname(path)) !== digest) throw new Error("metadata path does not match artifact");
				const descriptor = this.descriptors.get(record.ref);
				if (!descriptor || descriptor.byteLength !== record.byteLength) throw new Error("missing object");
				descriptor.mediaType = record.mediaType ?? descriptor.mediaType;
				descriptor.name = record.name ?? descriptor.name;
				descriptor.provenance.push(this.toStoredMetadata(record));
				descriptor.recovered = false;
				metadataRecords++;
			} catch {
				invalidMetadata.push(path);
			}
		}

		for (const descriptor of this.descriptors.values()) {
			descriptor.provenance.sort(
				(left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
			);
			const latest = descriptor.provenance.at(-1);
			if (latest) {
				descriptor.mediaType = latest.mediaType;
				descriptor.name = latest.name;
			}
		}
		return {
			artifacts: this.descriptors.size,
			metadataRecords,
			recoveredObjects: [...this.descriptors.values()].filter((descriptor) => descriptor.recovered).length,
			invalidObjects,
			invalidMetadata,
		};
	}

	private async listObjectPaths(): Promise<string[]> {
		return this.listLeafFiles(this.objectRoot(), (name) => ARTIFACT_HEX_PATTERN.test(name));
	}

	private async listMetadataPaths(): Promise<string[]> {
		return this.listLeafFiles(this.metadataRoot(), (name) => name.endsWith(".json"));
	}

	private async listLeafFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
		const paths: string[] = [];
		const stack = [root];
		while (stack.length > 0) {
			const directory = stack.pop();
			if (!directory) continue;
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				if (isMissingPathError(error)) continue;
				throw error;
			}
			for (const entry of entries) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) stack.push(path);
				else if (entry.isFile() && accept(entry.name)) {
					const info = await lstat(path);
					if (info.isFile() && !info.isSymbolicLink()) paths.push(path);
				}
			}
		}
		return paths.sort();
	}

	private copyDescriptor(descriptor: ArtifactDescriptor): ArtifactDescriptor {
		return {
			...descriptor,
			provenance: descriptor.provenance.map((metadata) => ({
				...metadata,
				provenance: {
					...metadata.provenance,
					attributes: metadata.provenance.attributes ? { ...metadata.provenance.attributes } : undefined,
				},
			})),
		};
	}

	private toStoredMetadata(record: ArtifactMetadataRecord): StoredArtifactMetadata {
		return {
			id: record.id,
			createdAt: record.createdAt,
			mediaType: record.mediaType,
			name: record.name,
			provenance: {
				...record.provenance,
				attributes: record.provenance.attributes ? { ...record.provenance.attributes } : undefined,
			},
		};
	}
}
