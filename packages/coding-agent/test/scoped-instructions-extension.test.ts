import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import scopedInstructions, { discoverScopedInstructionFiles } from "../examples/extensions/scoped-instructions.ts";
import {
	computeFileRevision,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionStartEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolResultEvent,
} from "../src/index.ts";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
type ToolResultHandler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void>;

function setup(cwd: string) {
	const handlers: {
		sessionStart?: SessionStartHandler;
		toolCall?: ToolCallHandler;
		toolResult?: ToolResultHandler;
	} = {};
	const api = {
		on(event: string, handler: unknown) {
			if (event === "session_start") handlers.sessionStart = handler as SessionStartHandler;
			if (event === "tool_call") handlers.toolCall = handler as ToolCallHandler;
			if (event === "tool_result") handlers.toolResult = handler as ToolResultHandler;
		},
	} as unknown as ExtensionAPI;
	const ctx = { cwd } as ExtensionContext;
	scopedInstructions(api);

	async function start(): Promise<void> {
		await handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
	}

	async function edit(path: string): Promise<ToolCallEventResult | undefined> {
		return handlers.toolCall!(
			{
				type: "tool_call",
				toolCallId: "edit-1",
				toolName: "edit",
				input: { path, edits: [{ oldText: "old", newText: "new" }] },
			},
			ctx,
		);
	}

	async function recordRead(
		path: string,
		options: {
			offset?: number;
			limit?: number;
			outputLines?: number;
			truncated?: boolean;
		} = {},
	): Promise<void> {
		const content = readFileSync(join(cwd, path));
		const input: Record<string, unknown> = { path };
		if (options.offset !== undefined) input.offset = options.offset;
		if (options.limit !== undefined) input.limit = options.limit;
		const truncated = options.truncated ?? false;
		await handlers.toolResult!(
			{
				type: "tool_result",
				toolCallId: "read-1",
				toolName: "read",
				input,
				content: [{ type: "text", text: "instructions" }],
				isError: false,
				details: {
					revision: computeFileRevision(content),
					...(truncated
						? {
								truncation: {
									content: "instructions",
									truncated: true,
									truncatedBy: "lines",
									totalLines: 4_000,
									totalBytes: content.length,
									outputLines: options.outputLines ?? 2_000,
									outputBytes: content.length,
									lastLinePartial: false,
									firstLineExceedsLimit: false,
									maxLines: 2_000,
									maxBytes: 50 * 1024,
								},
							}
						: {}),
				},
			},
			ctx,
		);
	}

	return { edit, handlers, recordRead, start };
}

describe("scoped-instructions example extension", () => {
	let workspace = "";

	afterEach(() => {
		if (workspace) rmSync(workspace, { recursive: true, force: true });
		workspace = "";
	});

	function createWorkspace(): string {
		workspace = mkdtempSync(join(tmpdir(), "pi-scoped-instructions-"));
		mkdirSync(join(workspace, "packages", "app", "src"), { recursive: true });
		writeFileSync(join(workspace, "AGENTS.md"), "root rules\n");
		writeFileSync(join(workspace, "packages", "AGENTS.md"), "package rules\n");
		writeFileSync(join(workspace, "packages", "app", "CLAUDE.md"), "app rules\n");
		writeFileSync(join(workspace, "packages", "app", "src", "index.ts"), "old\n");
		return workspace;
	}

	it("discovers applicable files from outermost to innermost scope", () => {
		const cwd = createWorkspace();

		expect(discoverScopedInstructionFiles(cwd, "packages/app/src/index.ts")).toEqual([
			join(cwd, "AGENTS.md"),
			join(cwd, "packages", "AGENTS.md"),
			join(cwd, "packages", "app", "CLAUDE.md"),
		]);
	});

	it("fails closed when an applicable instruction path cannot be read", () => {
		const cwd = createWorkspace();
		mkdirSync(join(cwd, "packages", "app", "AGENTS.md"));

		expect(() => discoverScopedInstructionFiles(cwd, "packages/app/src/index.ts")).toThrow();
	});

	it("treats cwd and ancestor instructions as loaded but blocks on nested instructions", async () => {
		const cwd = createWorkspace();
		const fixture = setup(cwd);
		await fixture.start();

		await expect(fixture.edit("packages/app/src/index.ts")).resolves.toEqual({
			block: true,
			reason:
				"Read applicable project instructions before modifying packages/app/src/index.ts: packages/AGENTS.md, packages/app/CLAUDE.md",
		});
	});

	it("unlocks only after every nested instruction file has been read completely", async () => {
		const cwd = createWorkspace();
		const fixture = setup(cwd);
		await fixture.start();

		await fixture.recordRead("packages/AGENTS.md");
		await expect(fixture.edit("packages/app/src/index.ts")).resolves.toEqual({
			block: true,
			reason:
				"Read applicable project instructions before modifying packages/app/src/index.ts: packages/app/CLAUDE.md",
		});

		await fixture.recordRead("packages/app/CLAUDE.md");
		await expect(fixture.edit("packages/app/src/index.ts")).resolves.toBeUndefined();
	});

	it("combines continued unbounded reads before accepting a large instruction file", async () => {
		const cwd = createWorkspace();
		const fixture = setup(cwd);
		await fixture.start();

		await fixture.recordRead("packages/AGENTS.md", { truncated: true, outputLines: 2_000 });
		await expect(fixture.edit("packages/app/src/index.ts")).resolves.toMatchObject({
			block: true,
		});

		await fixture.recordRead("packages/AGENTS.md", { offset: 2_001 });
		await fixture.recordRead("packages/app/CLAUDE.md");
		await expect(fixture.edit("packages/app/src/index.ts")).resolves.toBeUndefined();
	});

	it("invalidates a prior read when the instruction file changes", async () => {
		const cwd = createWorkspace();
		const fixture = setup(cwd);
		await fixture.start();
		await fixture.recordRead("packages/AGENTS.md");
		await fixture.recordRead("packages/app/CLAUDE.md");
		await expect(fixture.edit("packages/app/src/index.ts")).resolves.toBeUndefined();

		writeFileSync(join(cwd, "packages", "AGENTS.md"), "updated package rules\n");

		await expect(fixture.edit("packages/app/src/index.ts")).resolves.toEqual({
			block: true,
			reason: "Read applicable project instructions before modifying packages/app/src/index.ts: packages/AGENTS.md",
		});
	});
});
