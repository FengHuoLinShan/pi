import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import verificationLoop from "../examples/extensions/verification-loop.ts";
import type {
	AgentEndEvent,
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolResultEvent,
} from "../src/index.ts";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
type ToolResultHandler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void>;
type AgentEndHandler = (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;

const success: ExecResult = { stdout: "ok\n", stderr: "", code: 0, killed: false };
const failure: ExecResult = { stdout: "", stderr: "type error\n", code: 1, killed: false };

function setup(
	cwd: string,
	options: {
		enabled?: boolean;
		trusted?: boolean;
		results?: ExecResult[];
	},
) {
	const handlers: {
		sessionStart?: SessionStartHandler;
		toolResult?: ToolResultHandler;
		agentEnd?: AgentEndHandler;
	} = {};
	const results = [...(options.results ?? [success])];
	const exec = vi.fn<ExtensionAPI["exec"]>().mockImplementation(async () => results.shift() ?? success);
	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>();
	const api = {
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => options.enabled ?? true),
		on(event: string, handler: unknown) {
			if (event === "session_start") handlers.sessionStart = handler as SessionStartHandler;
			if (event === "tool_result") handlers.toolResult = handler as ToolResultHandler;
			if (event === "agent_end") handlers.agentEnd = handler as AgentEndHandler;
		},
		exec,
		sendUserMessage,
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const ctx = {
		cwd,
		isProjectTrusted: () => options.trusted ?? true,
		ui: { notify },
	} as unknown as ExtensionContext;
	verificationLoop(api);

	async function start(): Promise<void> {
		await handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
	}

	async function mutate(isError = false): Promise<void> {
		await handlers.toolResult!(
			{
				type: "tool_result",
				toolCallId: "edit-1",
				toolName: "edit",
				input: { path: "src/index.ts", edits: [{ oldText: "old", newText: "new" }] },
				content: [{ type: "text", text: isError ? "failed" : "edited" }],
				isError,
				details: undefined,
			},
			ctx,
		);
	}

	async function bash(isError = false): Promise<void> {
		await handlers.toolResult!(
			{
				type: "tool_result",
				toolCallId: "bash-1",
				toolName: "bash",
				input: { command: "touch generated.txt" },
				content: [{ type: "text", text: isError ? "failed" : "completed" }],
				isError,
				details: undefined,
			},
			ctx,
		);
	}

	async function finish(): Promise<void> {
		await handlers.agentEnd!({ type: "agent_end", messages: [] }, ctx);
	}

	return { bash, exec, finish, mutate, notify, sendUserMessage, start };
}

describe("verification-loop example extension", () => {
	let workspace = "";

	afterEach(() => {
		if (workspace) rmSync(workspace, { recursive: true, force: true });
		workspace = "";
	});

	function createWorkspace(config: Record<string, unknown>): string {
		workspace = mkdtempSync(join(tmpdir(), "pi-verification-loop-"));
		mkdirSync(join(workspace, ".pi"), { recursive: true });
		writeFileSync(join(workspace, ".pi", "verify.json"), JSON.stringify(config));
		return workspace;
	}

	it("runs the configured command after a successful built-in mutation", async () => {
		const cwd = createWorkspace({
			command: "npm",
			args: ["run", "check"],
			timeoutMs: 30_000,
			maxAttempts: 3,
		});
		const fixture = setup(cwd, {});
		await fixture.start();
		await fixture.mutate();
		await fixture.finish();

		expect(fixture.exec).toHaveBeenCalledWith("npm", ["run", "check"], {
			cwd,
			timeout: 30_000,
		});
		expect(fixture.notify).toHaveBeenCalledWith('verification-loop: passed npm "run" "check"', "info");
		expect(fixture.sendUserMessage).not.toHaveBeenCalled();
	});

	it("sends bounded failure output and retries after the repair turn", async () => {
		const cwd = createWorkspace({ command: "npm", args: ["run", "check"] });
		const fixture = setup(cwd, { results: [failure, success] });
		await fixture.start();
		await fixture.mutate();
		await fixture.finish();

		expect(fixture.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining('Verification attempt 1/3 failed for npm "run" "check"'),
			{ deliverAs: "followUp" },
		);
		expect(fixture.sendUserMessage.mock.calls[0]![0]).toContain("stderr:\ntype error");

		await fixture.mutate();
		await fixture.finish();
		expect(fixture.exec).toHaveBeenCalledTimes(2);
		expect(fixture.notify).toHaveBeenCalledWith('verification-loop: passed npm "run" "check"', "info");
	});

	it("stops at maxAttempts and does not verify again until a new mutation", async () => {
		const cwd = createWorkspace({ command: "npm", maxAttempts: 2 });
		const fixture = setup(cwd, { results: [failure, failure, success] });
		await fixture.start();
		await fixture.mutate();
		await fixture.finish();
		await fixture.mutate();
		await fixture.finish();
		await fixture.finish();

		expect(fixture.exec).toHaveBeenCalledTimes(2);
		expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fixture.notify).toHaveBeenCalledWith(
			"verification-loop: Verification attempt 2/2 failed for npm (exit 1).",
			"error",
		);

		await fixture.mutate();
		await fixture.finish();
		expect(fixture.exec).toHaveBeenCalledTimes(3);
	});

	it("does not run untrusted or invalid project configuration", async () => {
		const untrustedCwd = createWorkspace({ command: "npm" });
		const untrusted = setup(untrustedCwd, { trusted: false });
		await untrusted.start();
		await untrusted.mutate();
		await untrusted.finish();
		expect(untrusted.exec).not.toHaveBeenCalled();

		rmSync(workspace, { recursive: true, force: true });
		workspace = "";
		const invalidCwd = createWorkspace({ command: "npm", timeout: 10 });
		const invalid = setup(invalidCwd, {});
		await invalid.start();
		await invalid.mutate();
		await invalid.finish();
		expect(invalid.exec).not.toHaveBeenCalled();
		expect(invalid.notify).toHaveBeenCalledWith(
			"verification-loop: invalid .pi/verify.json: unknown verification config field: timeout",
			"error",
		);
	});

	it("requires explicit CLI opt-in", async () => {
		const cwd = createWorkspace({ command: "npm" });
		const fixture = setup(cwd, { enabled: false });
		await fixture.start();
		await fixture.mutate();
		await fixture.finish();

		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it("does not arm verification after a failed mutation", async () => {
		const cwd = createWorkspace({ command: "npm" });
		const fixture = setup(cwd, {});
		await fixture.start();
		await fixture.mutate(true);
		await fixture.finish();

		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it("conservatively verifies after a successful built-in bash call", async () => {
		const cwd = createWorkspace({ command: "npm", args: ["run", "check"] });
		const fixture = setup(cwd, {});
		await fixture.start();
		await fixture.bash();
		await fixture.finish();

		expect(fixture.exec).toHaveBeenCalledWith("npm", ["run", "check"], {
			cwd,
			timeout: 120_000,
		});
	});
});
