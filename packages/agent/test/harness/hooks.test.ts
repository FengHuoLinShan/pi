import { describe, expect, it } from "vitest";
import { DefaultAgentHarnessHooks } from "../../src/harness/hooks.ts";
import type { ContextEvent, SettledEvent, ToolCallEvent, ToolResultEvent } from "../../src/harness/types.ts";

type TestEvent = ContextEvent | SettledEvent | ToolCallEvent | ToolResultEvent;

describe("DefaultAgentHarnessHooks", () => {
	it("separates observation from ordered context transformation", async () => {
		const hooks = new DefaultAgentHarnessHooks<TestEvent, { name: string }>({ context: { name: "ctx" } });
		const calls: string[] = [];
		const signal = new AbortController().signal;

		hooks.observe((event, context, receivedSignal) => {
			calls.push(`observe:${event.type}:${context.name}:${receivedSignal === signal}`);
		});
		hooks.on("context", (event) => {
			calls.push(`first:${event.messages.length}`);
			return { messages: [{ role: "user", content: "first", timestamp: 1 }] };
		});
		hooks.on("context", (event) => {
			calls.push(`second:${event.messages.length}`);
			return { messages: [...event.messages, { role: "user", content: "second", timestamp: 2 }] };
		});

		const result = await hooks.emit({ type: "context", messages: [] }, signal);

		expect(calls).toEqual(["observe:context:ctx:true", "first:0", "second:1"]);
		expect(result?.messages).toEqual([
			expect.objectContaining({ content: "first" }),
			expect.objectContaining({ content: "second" }),
		]);
	});

	it("short-circuits blocked tool calls and accumulates tool-result patches", async () => {
		const hooks = new DefaultAgentHarnessHooks<TestEvent, undefined>({ context: undefined });
		const toolCallHandlers: string[] = [];
		hooks.on("tool_call", () => {
			toolCallHandlers.push("first");
			return { block: true, reason: "policy" };
		});
		hooks.on("tool_call", () => {
			toolCallHandlers.push("second");
			return undefined;
		});
		hooks.on("tool_result", () => ({
			content: [{ type: "text", text: "patched" }],
			details: { first: true },
		}));
		hooks.on("tool_result", (event) => ({
			details: { previous: event.details },
			isError: true,
			terminate: true,
		}));

		const callResult = await hooks.emit({
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "write",
			input: {},
		});
		const result = await hooks.emit({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "write",
			input: {},
			content: [{ type: "text", text: "original" }],
			details: undefined,
			isError: false,
		});

		expect(callResult).toEqual({ block: true, reason: "policy" });
		expect(toolCallHandlers).toEqual(["first"]);
		expect(result).toEqual({
			content: [{ type: "text", text: "patched" }],
			details: { previous: { first: true } },
			isError: true,
			terminate: true,
		});
	});

	it("reports source-aware errors in continue mode and keeps later handlers running", async () => {
		const errors: Array<{ message: string; source?: string }> = [];
		const calls: string[] = [];
		const hooks = new DefaultAgentHarnessHooks<TestEvent, undefined, string>({
			context: undefined,
			errorMode: "continue",
			onError: ({ error, source }) => {
				errors.push({ message: error.message, source });
			},
		});
		hooks.createScope("broken-extension").on("settled", () => {
			throw new Error("broken hook");
		});
		hooks.createScope("working-extension").on("settled", () => {
			calls.push("working");
		});

		await expect(hooks.emit({ type: "settled", nextTurnCount: 0 })).resolves.toBeUndefined();

		expect(errors).toEqual([{ message: "broken hook", source: "broken-extension" }]);
		expect(calls).toEqual(["working"]);
	});

	it("runs retained cleanups in reverse order and disposes idempotently", async () => {
		const hooks = new DefaultAgentHarnessHooks<TestEvent, undefined>({ context: undefined });
		const cleanups: string[] = [];
		const unsubscribe = hooks.on("settled", () => undefined, {
			cleanup: () => {
				cleanups.push("unsubscribed");
			},
		});
		hooks.addCleanup(() => {
			cleanups.push("first");
		});
		hooks.addCleanup(async () => {
			cleanups.push("second");
		});
		unsubscribe();

		await hooks.dispose();
		await hooks.dispose();

		expect(cleanups).toEqual(["second", "first"]);
		expect(() => hooks.on("settled", () => undefined)).toThrow("disposed");
	});
});
