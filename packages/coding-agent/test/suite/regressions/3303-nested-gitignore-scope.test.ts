import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFindTool } from "../../../src/core/tools/find.ts";
import { getToolPath } from "../../../src/utils/tools-manager.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("issue #3303: find preserves hierarchical .gitignore scope", () => {
	const originalOffline = process.env.PI_OFFLINE;
	let fixtureRoot: string | undefined;
	let harness: Harness | undefined;

	beforeAll(() => {
		process.env.PI_OFFLINE = "1";
		const fdPath = getToolPath("fd");
		if (!fdPath) {
			throw new Error("This offline regression requires fd to be preinstalled");
		}
		const version = spawnSync(fdPath, ["--version"], { encoding: "utf8" });
		if (version.error || version.status !== 0) {
			throw new Error(`Unable to execute the preinstalled fd binary: ${version.error?.message ?? version.stderr}`);
		}
		expect(version.stdout.trim()).toMatch(/\d+(?:\.\d+)+/);
	});

	afterAll(() => {
		if (originalOffline === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = originalOffline;
		}
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	it("keeps root, sibling, and deeply nested ignore rules in their own scopes", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "pi-3303-scope-"));
		mkdirSync(join(fixtureRoot, "team-a", "nested"), { recursive: true });
		mkdirSync(join(fixtureRoot, "team-b"), { recursive: true });

		writeFileSync(join(fixtureRoot, ".gitignore"), "/root-only.txt\nroot-wide.txt\n");
		writeFileSync(join(fixtureRoot, "team-a", ".gitignore"), "local-only.txt\n");
		writeFileSync(join(fixtureRoot, "team-a", "nested", ".gitignore"), "deep-only.txt\n");

		for (const relativePath of [
			"kept.txt",
			"root-only.txt",
			"root-wide.txt",
			"team-a/kept.txt",
			"team-a/local-only.txt",
			"team-a/deep-only.txt",
			"team-a/root-wide.txt",
			"team-a/nested/kept.txt",
			"team-a/nested/local-only.txt",
			"team-a/nested/deep-only.txt",
			"team-a/nested/root-only.txt",
			"team-a/nested/root-wide.txt",
			"team-b/kept.txt",
			"team-b/local-only.txt",
			"team-b/deep-only.txt",
			"team-b/root-only.txt",
			"team-b/root-wide.txt",
		]) {
			writeFileSync(join(fixtureRoot, relativePath), "fixture\n");
		}

		harness = await createHarness({ tools: [createFindTool(fixtureRoot)] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("find", { pattern: "**/*.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("List the text fixtures with find.");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		const files = getMessageText(toolResult)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("["))
			.sort();

		expect(files).toEqual([
			"kept.txt",
			"team-a/deep-only.txt",
			"team-a/kept.txt",
			"team-a/nested/kept.txt",
			"team-a/nested/root-only.txt",
			"team-b/deep-only.txt",
			"team-b/kept.txt",
			"team-b/local-only.txt",
			"team-b/root-only.txt",
		]);
	});
});
