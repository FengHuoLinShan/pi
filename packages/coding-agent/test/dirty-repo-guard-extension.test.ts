import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import dirtyRepoGuard, { parsePorcelainV1Z } from "../examples/extensions/dirty-repo-guard.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/core/extensions/index.ts";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
type BeforeAgentStartHandler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined>;
type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
type SessionBeforeSwitchHandler = (
	event: SessionBeforeSwitchEvent,
	ctx: ExtensionContext,
) => Promise<SessionBeforeSwitchResult | undefined>;

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });

function setup(options: {
	status?: ExecResult;
	root?: ExecResult;
	hasUI?: boolean;
	confirm?: boolean;
	select?: string;
}) {
	const repositoryRoot = join(tmpdir(), "pi-dirty-guard-repo");
	const handlers: {
		sessionStart?: SessionStartHandler;
		beforeAgentStart?: BeforeAgentStartHandler;
		toolCall?: ToolCallHandler;
		sessionBeforeSwitch?: SessionBeforeSwitchHandler;
	} = {};
	const exec = vi.fn<ExtensionAPI["exec"]>().mockImplementation(async (_command, args) => {
		if (args[0] === "rev-parse") return options.root ?? ok(`${repositoryRoot}\n`);
		if (args[0] === "status") return options.status ?? ok();
		return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
	});
	const api = {
		on(event: string, handler: unknown) {
			if (event === "session_start") handlers.sessionStart = handler as SessionStartHandler;
			if (event === "before_agent_start") handlers.beforeAgentStart = handler as BeforeAgentStartHandler;
			if (event === "tool_call") handlers.toolCall = handler as ToolCallHandler;
			if (event === "session_before_switch") {
				handlers.sessionBeforeSwitch = handler as SessionBeforeSwitchHandler;
			}
		},
		exec,
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const confirm = vi.fn(async () => options.confirm ?? false);
	const select = vi.fn(async () => options.select);
	const ctx = {
		cwd: join(repositoryRoot, "packages", "app"),
		hasUI: options.hasUI ?? false,
		ui: { confirm, notify, select },
	} as unknown as ExtensionContext;

	dirtyRepoGuard(api);

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

	async function write(path: string): Promise<ToolCallEventResult | undefined> {
		return handlers.toolCall!(
			{
				type: "tool_call",
				toolCallId: "write-1",
				toolName: "write",
				input: { path, content: "new" },
			},
			ctx,
		);
	}

	return { confirm, ctx, edit, exec, handlers, notify, repositoryRoot, start, write };
}

describe("dirty-repo-guard example extension", () => {
	it("parses ordinary, untracked, renamed, and newline-containing paths", () => {
		const paths = parsePorcelainV1Z(
			[
				" M src/modified.ts",
				"?? src/new.ts",
				"R  src/renamed.ts",
				"src/original.ts",
				" M src/line\nbreak.ts",
				"",
			].join("\0"),
		);

		expect([...paths]).toEqual([
			"src/modified.ts",
			"src/new.ts",
			"src/renamed.ts",
			"src/original.ts",
			"src/line\nbreak.ts",
		]);
	});

	it("blocks non-interactive edits to paths that were dirty at session start", async () => {
		const fixture = setup({ status: ok(" M packages/app/src/user.ts\0") });
		await fixture.start();

		await expect(fixture.edit("src/user.ts")).resolves.toEqual({
			block: true,
			reason:
				'Blocked modification of pre-existing change "packages/app/src/user.ts" because approval UI is unavailable',
		});
		await expect(fixture.write("src/user.ts")).resolves.toEqual({
			block: true,
			reason:
				'Blocked modification of pre-existing change "packages/app/src/user.ts" because approval UI is unavailable',
		});
		await expect(fixture.edit("src/agent.ts")).resolves.toBeUndefined();
	});

	it("asks once and remembers approval for the rest of the session", async () => {
		const fixture = setup({
			status: ok(" M packages/app/src/user.ts\0"),
			hasUI: true,
			confirm: true,
		});
		await fixture.start();

		await expect(fixture.edit("src/user.ts")).resolves.toBeUndefined();
		await expect(fixture.edit("src/user.ts")).resolves.toBeUndefined();
		expect(fixture.confirm).toHaveBeenCalledTimes(1);
	});

	it("fails closed when a repository baseline cannot be captured", async () => {
		const fixture = setup({
			status: { stdout: "", stderr: "index is locked", code: 128, killed: false },
		});
		await fixture.start();

		await expect(fixture.edit("src/user.ts")).resolves.toEqual({
			block: true,
			reason: "Cannot safely modify files because the git baseline is unavailable: index is locked",
		});
	});

	it("does not guard file tools outside a git repository", async () => {
		const fixture = setup({
			root: { stdout: "", stderr: "not a git repository", code: 128, killed: false },
			status: { stdout: "", stderr: "not a git repository", code: 128, killed: false },
		});
		await fixture.start();

		await expect(fixture.edit("src/user.ts")).resolves.toBeUndefined();
		await expect(
			fixture.handlers.sessionBeforeSwitch!({ type: "session_before_switch", reason: "new" }, fixture.ctx),
		).resolves.toBeUndefined();
	});

	it("adds bash-bypass guidance when the baseline contains changes", async () => {
		const fixture = setup({ status: ok(" M packages/app/src/user.ts\0") });
		await fixture.start();

		const result = await fixture.handlers.beforeAgentStart!(
			{
				type: "before_agent_start",
				prompt: "implement",
				images: [],
				systemPrompt: "base",
				systemPromptOptions: {
					cwd: fixture.ctx.cwd,
				},
			},
			fixture.ctx,
		);

		expect(result?.systemPrompt).toContain("This session started with 1 pre-existing Git-changed path(s)");
		expect(result?.systemPrompt).toContain("Do not bypass the guard with bash");
	});

	it("continues to block dirty session switches without UI", async () => {
		const fixture = setup({ status: ok(" M packages/app/src/user.ts\0") });

		const result = await fixture.handlers.sessionBeforeSwitch!(
			{ type: "session_before_switch", reason: "new" },
			fixture.ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(fixture.exec).toHaveBeenCalledWith("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			cwd: fixture.ctx.cwd,
			timeout: 5_000,
		});
	});
});
