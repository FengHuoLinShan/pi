import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

function textOutput(content: Awaited<ReturnType<ReturnType<typeof createReadTool>["execute"]>>["content"]): string {
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function continuationCommand(output: string): string {
	const match = /Continuation \(bash\): (.*)\]\n\n\[Revision:/.exec(output);
	if (!match?.[1]) throw new Error("Continuation command not found");
	return match[1];
}

describe("read oversized single-line files", () => {
	let testDirectory: string | undefined;

	afterEach(async () => {
		if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
		testDirectory = undefined;
	});

	it("returns a bounded Unicode-safe preview with deterministic continuation metadata", async () => {
		testDirectory = await mkdtemp(join(tmpdir(), "pi-read-single-line-"));
		const filePath = join(testDirectory, "large.jsonl");
		const source = `BEGIN:${"🙂".repeat(600_000)}:PRIVATE_TAIL`;
		const sourceBytes = Buffer.byteLength(source, "utf8");
		await writeFile(filePath, source, "utf8");
		const read = createReadTool(testDirectory);

		const result = await read.execute("large-single-line", { path: filePath });
		const output = textOutput(result.content);
		const truncation = result.details?.truncation;

		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(output.startsWith("BEGIN:")).toBe(true);
		expect(output.includes("PRIVATE_TAIL")).toBe(false);
		expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
		expect(output).toContain("single line truncated");
		expect(output).toContain("Continuation (bash):");
		expect(output).toContain(`skip=${truncation?.outputBytes}`);
		expect(output).toContain(`[Revision: ${result.details?.revision}]`);
		expect(truncation).toMatchObject({
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 1,
			totalBytes: sourceBytes,
			firstLineExceedsLimit: true,
			lastLinePartial: true,
		});
		expect(truncation?.outputBytes).toBeGreaterThan(0);
		expect(truncation?.outputBytes).toBeLessThan(DEFAULT_MAX_BYTES);
	});

	it("canonicalizes a reducible requested path before enforcing the complete output byte ceiling", async () => {
		testDirectory = await mkdtemp(join(tmpdir(), "pi-read-reducible-path-"));
		const filePath = join(testDirectory, "large.jsonl");
		await writeFile(filePath, `BEGIN:${"x".repeat(200_000)}:PRIVATE_TAIL`, "utf8");
		const read = createReadTool(testDirectory);
		const reduciblePath = `${"./".repeat(30_000)}large.jsonl`;

		const result = await read.execute("reducible-path", { path: reduciblePath });
		const output = textOutput(result.content);

		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(output).toContain(JSON.stringify(await realpath(filePath)));
		expect(output).not.toContain(reduciblePath);
		expect(output).not.toContain("PRIVATE_TAIL");
	});

	it.runIf(process.platform !== "win32")(
		"quotes spaces, metacharacters, brackets, and newlines without forging diagnostics",
		async () => {
			testDirectory = await mkdtemp(join(tmpdir(), "pi-read-special-path-"));
			const fileName = "odd ' $[];\nname.jsonl";
			const filePath = join(testDirectory, fileName);
			await writeFile(filePath, `BEGIN:${"🙂".repeat(100_000)}:PRIVATE_TAIL`, "utf8");
			const read = createReadTool(testDirectory);

			const result = await read.execute("special-path", { path: fileName });
			const output = textOutput(result.content);
			const command = continuationCommand(output);
			const continuation = execFileSync("bash", ["-c", command]);
			const decoded = continuation.toString("utf8");

			expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(output).toContain("\\nname.jsonl");
			expect(output).not.toContain("\nname.jsonl. Continuation");
			expect(command).toContain("FILE=$'");
			expect(decoded).not.toContain("�");
			expect(Buffer.from(decoded, "utf8")).toEqual(continuation);
			expect(output).not.toContain("PRIVATE_TAIL");
		},
	);

	it("uses a line-relative Unicode-safe continuation for an offset and leading-dash input", async () => {
		testDirectory = await mkdtemp(join(tmpdir(), "pi-read-offset-path-"));
		const fileName = "-leading.jsonl";
		const filePath = join(testDirectory, fileName);
		await writeFile(filePath, `first\nsecond\nBEGIN:${"🙂".repeat(100_000)}:PRIVATE_TAIL`, "utf8");
		const read = createReadTool(testDirectory);

		const result = await read.execute("offset-path", { path: fileName, offset: 3 });
		const output = textOutput(result.content);
		const command = continuationCommand(output);
		const continuation = execFileSync("bash", ["-c", command]);
		const decoded = continuation.toString("utf8");

		expect(command).toContain("sed -n '3p' < \"$FILE\"");
		expect(command).toContain(`skip=${result.details?.truncation?.outputBytes}`);
		expect(decoded.startsWith("🙂")).toBe(true);
		expect(decoded).not.toContain("�");
		expect(Buffer.from(decoded, "utf8")).toEqual(continuation);
		expect(output).not.toContain("PRIVATE_TAIL");
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});
});
