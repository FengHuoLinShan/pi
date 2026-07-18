import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/core/artifact-store.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-artifact-store-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ArtifactStore", () => {
	it("deduplicates content and recovers provenance from atomic sidecars", async () => {
		const directory = await createTempDirectory();
		const root = join(directory, "artifacts");
		const { store } = await ArtifactStore.open({ root, allowedRoots: [directory] });

		const first = await store.put("same content", {
			mediaType: "text/plain",
			name: "first.txt",
			provenance: { producer: "read-tool", source: "workspace:first.txt" },
		});
		const second = await store.put(Buffer.from("same content"), {
			mediaType: "text/plain",
			name: "second.txt",
			provenance: { producer: "process", processSessionId: "process-1" },
		});

		expect(second.ref).toBe(first.ref);
		expect(second.provenance).toHaveLength(2);
		expect(await store.read(first.ref)).toEqual(Buffer.from("same content"));
		const objectFiles = await readdir(join(root, "objects", "sha256", first.ref.slice(7, 9)));
		expect(objectFiles).toEqual([first.ref.slice(7)]);

		const reopened = await ArtifactStore.open({ root, allowedRoots: [directory] });
		expect(reopened.recovery).toMatchObject({
			artifacts: 1,
			metadataRecords: 2,
			recoveredObjects: 0,
			invalidObjects: [],
			invalidMetadata: [],
		});
		expect(
			reopened.store
				.get(first.ref)
				?.provenance.map((entry) => entry.provenance.producer)
				.sort(),
		).toEqual(["process", "read-tool"]);
	});

	it("rebuilds an index for orphaned objects and reports corrupt content and metadata", async () => {
		const directory = await createTempDirectory();
		const root = join(directory, "artifacts");
		const { store } = await ArtifactStore.open({ root, allowedRoots: [directory] });
		const orphan = await store.put("orphan", { provenance: { producer: "test" } });
		await rm(join(root, "metadata"), { recursive: true, force: true });

		const recovered = await ArtifactStore.open({ root, allowedRoots: [directory] });
		expect(recovered.recovery.recoveredObjects).toBe(1);
		expect(recovered.store.get(orphan.ref)).toMatchObject({ recovered: true, provenance: [] });

		const corruptDigest = "a".repeat(64);
		const corruptObjectDirectory = join(root, "objects", "sha256", "aa");
		await mkdir(corruptObjectDirectory, { recursive: true });
		await writeFile(join(corruptObjectDirectory, corruptDigest), "wrong bytes", "utf8");
		const invalidMetadataDirectory = join(root, "metadata", "sha256", "aa", corruptDigest);
		await mkdir(invalidMetadataDirectory, { recursive: true });
		await writeFile(join(invalidMetadataDirectory, "broken.json"), "{not-json}\n", "utf8");

		const reopened = await ArtifactStore.open({ root, allowedRoots: [directory] });
		expect(reopened.recovery.invalidObjects).toEqual([join(corruptObjectDirectory, corruptDigest)]);
		expect(reopened.recovery.invalidMetadata).toEqual([join(invalidMetadataDirectory, "broken.json")]);
	});

	it("rejects lexical and symlink escapes from the configured host roots", async () => {
		const directory = await createTempDirectory();
		const allowed = join(directory, "allowed");
		const outside = join(directory, "outside");
		await mkdir(allowed);
		await mkdir(outside);

		await expect(ArtifactStore.open({ root: join(outside, "artifacts"), allowedRoots: [allowed] })).rejects.toThrow(
			"File path policy violation",
		);
		await symlink(outside, join(allowed, "escape"));
		await expect(
			ArtifactStore.open({ root: join(allowed, "escape", "artifacts"), allowedRoots: [allowed] }),
		).rejects.toThrow("File path policy violation");
		await expect(ArtifactStore.open({ root: join(allowed, "denied"), allowedRoots: [] })).rejects.toThrow(
			"File path policy violation",
		);
	});

	it("never leaves staging files after successful object and metadata writes", async () => {
		const directory = await createTempDirectory();
		const root = join(directory, "artifacts");
		const { store } = await ArtifactStore.open({ root });
		const descriptor = await store.put("content", { provenance: { producer: "test" } });
		const digest = descriptor.ref.slice(7);
		const objectDirectory = join(root, "objects", "sha256", digest.slice(0, 2));
		const metadataDirectory = join(root, "metadata", "sha256", digest.slice(0, 2), digest);

		expect((await readdir(objectDirectory)).some((name) => name.includes(".pi-stage-"))).toBe(false);
		expect((await readdir(metadataDirectory)).some((name) => name.includes(".pi-stage-"))).toBe(false);
		expect(await readFile(join(objectDirectory, digest), "utf8")).toBe("content");
	});
});
