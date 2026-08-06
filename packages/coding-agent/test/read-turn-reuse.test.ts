import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

function userEntry(id: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: id, timestamp: Date.now() },
	};
}

function createContext(entries: SessionEntry[]): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => entries,
		},
		model: undefined,
	} as unknown as ExtensionContext;
}

function numberedFile(prefix = "VALUE"): string {
	return Array.from({ length: 100 }, (_, index) => `${prefix}_${String(index + 1).padStart(4, "0")}`).join("\n");
}

describe("read current-turn range reuse", () => {
	let testDirectory: string | undefined;

	afterEach(async () => {
		if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
		testDirectory = undefined;
	});

	it("omits covered prefixes and complete ranges until the file revision or user turn changes", async () => {
		testDirectory = await mkdtemp(join(tmpdir(), "pi-read-reuse-"));
		const filePath = join(testDirectory, "numbered.txt");
		await writeFile(filePath, numberedFile(), "utf8");
		const entries = [userEntry("user-1")];
		const context = createContext(entries);
		const read = createReadToolDefinition(testDirectory);

		const first = await read.execute(
			"read-1",
			{ path: filePath, offset: 1, limit: 60 },
			undefined,
			undefined,
			context,
		);
		expect(first.details?.reuse).toBeUndefined();

		const overlap = await read.execute(
			"read-2",
			{ path: filePath, offset: 40, limit: 41 },
			undefined,
			undefined,
			context,
		);
		const overlapText = overlap.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(overlap.details?.reuse).toEqual({
			omittedStartLine: 40,
			omittedEndLine: 60,
			fullyCovered: false,
		});
		expect(overlapText).toContain("Read reuse: unchanged lines 40-60");
		expect(overlapText).toContain("Do not retry that prefix");
		expect(overlapText).not.toContain("VALUE_0040");
		expect(overlapText).not.toContain("VALUE_0060");
		expect(overlapText).toContain("VALUE_0061");
		expect(overlapText).toContain("VALUE_0080");

		const covered = await read.execute(
			"read-3",
			{ path: filePath, offset: 45, limit: 5 },
			undefined,
			undefined,
			context,
		);
		const coveredText = covered.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(covered.details?.reuse).toEqual({
			omittedStartLine: 45,
			omittedEndLine: 49,
			fullyCovered: true,
		});
		expect(coveredText).toContain("do not retry this range");
		expect(coveredText).not.toContain("VALUE_0045");

		const markerRetry = await read.execute(
			"read-marker-retry",
			{ path: filePath, offset: 46, limit: 1 },
			undefined,
			undefined,
			context,
		);
		const markerRetryText = markerRetry.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(markerRetry.details?.reuse).toBeUndefined();
		expect(markerRetryText).toContain("Read reuse fallback");
		expect(markerRetryText).toContain("VALUE_0046");

		const afterFallback = await read.execute(
			"read-after-fallback",
			{ path: filePath, offset: 46, limit: 1 },
			undefined,
			undefined,
			context,
		);
		const afterFallbackText = afterFallback.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(afterFallback.details?.reuse).toEqual({
			omittedStartLine: 46,
			omittedEndLine: 46,
			fullyCovered: true,
		});
		expect(afterFallbackText).toContain("will not be repeated again in this turn");
		expect(afterFallbackText).not.toContain("VALUE_0046");

		const repeatedAfterFallback = await read.execute(
			"read-repeated-after-fallback",
			{ path: filePath, offset: 46, limit: 1 },
			undefined,
			undefined,
			context,
		);
		const repeatedAfterFallbackText = repeatedAfterFallback.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(repeatedAfterFallback.details?.reuse?.fullyCovered).toBe(true);
		expect(repeatedAfterFallbackText).not.toContain("Read reuse fallback");
		expect(repeatedAfterFallbackText).not.toContain("VALUE_0046");

		await writeFile(filePath, numberedFile("MUTATED"), "utf8");
		const afterMutation = await read.execute(
			"read-4",
			{ path: filePath, offset: 45, limit: 5 },
			undefined,
			undefined,
			context,
		);
		const mutationText = afterMutation.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(afterMutation.details?.reuse).toBeUndefined();
		expect(mutationText).toContain("MUTATED_0045");

		entries.push(userEntry("user-2", "user-1"));
		const nextTurn = await read.execute(
			"read-5",
			{ path: filePath, offset: 45, limit: 5 },
			undefined,
			undefined,
			context,
		);
		const nextTurnText = nextTurn.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(nextTurn.details?.reuse).toBeUndefined();
		expect(nextTurnText).toContain("MUTATED_0045");
	});

	it("starts a fresh reuse scope after compaction", async () => {
		testDirectory = await mkdtemp(join(tmpdir(), "pi-read-reuse-compaction-"));
		const filePath = join(testDirectory, "numbered.txt");
		await writeFile(filePath, numberedFile(), "utf8");
		const entries = [userEntry("user-1")];
		const context = createContext(entries);
		const read = createReadToolDefinition(testDirectory);

		await read.execute("read-1", { path: filePath, offset: 1, limit: 10 }, undefined, undefined, context);
		entries.push({
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: "checkpoint",
			firstKeptEntryId: "user-1",
			tokensBefore: 1000,
		});
		const afterCompaction = await read.execute(
			"read-2",
			{ path: filePath, offset: 1, limit: 10 },
			undefined,
			undefined,
			context,
		);
		const output = afterCompaction.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

		expect(afterCompaction.details?.reuse).toBeUndefined();
		expect(output).toContain("VALUE_0001");
	});

	it("retains covered ranges across unrelated file revisions and invalidates changed ranges", async () => {
		testDirectory = await mkdtemp(join(tmpdir(), "pi-read-reuse-revision-"));
		const filePath = join(testDirectory, "numbered.txt");
		const originalLines = numberedFile().split("\n");
		await writeFile(filePath, originalLines.join("\n"), "utf8");
		const context = createContext([userEntry("user-1")]);
		const read = createReadToolDefinition(testDirectory);

		const first = await read.execute(
			"read-1",
			{ path: filePath, offset: 1, limit: 100 },
			undefined,
			undefined,
			context,
		);
		const unrelatedMutation = [...originalLines];
		unrelatedMutation[89] = "CHANGED_0090";
		await writeFile(filePath, unrelatedMutation.join("\n"), "utf8");

		const retained = await read.execute(
			"read-2",
			{ path: filePath, offset: 45, limit: 5 },
			undefined,
			undefined,
			context,
		);
		const retainedText = retained.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(retained.details?.revision).not.toBe(first.details?.revision);
		expect(retained.details?.reuse?.fullyCovered).toBe(true);
		expect(retainedText).not.toContain("VALUE_0045");

		const coveredMutation = [...unrelatedMutation];
		coveredMutation[46] = "CHANGED_0047";
		await writeFile(filePath, coveredMutation.join("\n"), "utf8");
		const invalidated = await read.execute(
			"read-3",
			{ path: filePath, offset: 45, limit: 5 },
			undefined,
			undefined,
			context,
		);
		const invalidatedText = invalidated.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(invalidated.details?.reuse).toBeUndefined();
		expect(invalidatedText).toContain("CHANGED_0047");
	});
});
