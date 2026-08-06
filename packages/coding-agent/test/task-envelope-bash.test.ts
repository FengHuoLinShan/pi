import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	type BashOperations,
	type BashToolInput,
	createBashTool,
	createBashToolDefinition,
} from "../src/core/tools/bash.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function text(result: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

type BashDefinition = ReturnType<typeof createBashToolDefinition>;
type BashResult = Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>;
type BashRenderContext = Parameters<NonNullable<BashDefinition["renderCall"]>>[2];

function renderContext(args: BashToolInput): BashRenderContext {
	return {
		args,
		toolCallId: "render-test",
		invalidate: () => {},
		lastComponent: undefined,
		state: { startedAt: undefined, endedAt: undefined, interval: undefined },
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
	};
}

function renderCall(definition: BashDefinition, args: BashToolInput): string {
	if (!definition.renderCall) throw new Error("bash renderCall is missing");
	return definition.renderCall(args, theme, renderContext(args)).render(160).join("\n");
}

function renderResult(definition: BashDefinition, result: BashResult, args: BashToolInput): string {
	if (!definition.renderResult) throw new Error("bash renderResult is missing");
	return definition
		.renderResult(result, { expanded: true, isPartial: false }, theme, renderContext(args))
		.render(160)
		.join("\n");
}

beforeAll(() => initTheme(undefined, false));

describe("task envelope bash command policy", () => {
	it("passes effective milliseconds to operations and caps at the envelope maximum", async () => {
		let timeoutSeconds: number | undefined;
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				timeoutSeconds = options?.timeout;
				return { exitCode: 0 };
			},
		};
		const options = {
			operations,
			commandPolicy: { defaultTimeoutMs: 2_000, maxTimeoutMs: 3_000 },
		};
		const bash = createBashTool(process.cwd(), options);
		const definition = createBashToolDefinition(process.cwd(), options);
		const args = { command: "work", timeoutMs: 9_000 };

		const result = await bash.execute("call", args);
		expect(timeoutSeconds).toBe(3);
		expect(result.details).toMatchObject({ requestedTimeoutMs: 9_000, effectiveTimeoutMs: 3_000 });
		expect(renderCall(definition, args)).toContain("requested timeoutMs 9000 ms");
		expect(renderResult(definition, result, args)).toContain(
			"Requested timeoutMs: 9000 ms; Effective timeoutMs: 3000 ms",
		);
	});

	it("uses the millisecond default without changing no-envelope details", async () => {
		const timeouts: Array<number | undefined> = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				timeouts.push(options?.timeout);
				return { exitCode: 0 };
			},
		};

		const boundedOptions = {
			operations,
			commandPolicy: { defaultTimeoutMs: 1_250, expectedHangMaxTimeoutMs: 100 },
		};
		const bounded = createBashTool(process.cwd(), boundedOptions);
		const boundedDefinition = createBashToolDefinition(process.cwd(), boundedOptions);
		const legacy = createBashTool(process.cwd(), { operations });
		const boundedResult = await bounded.execute("bounded", { command: "work" });
		const unclampedResult = await bounded.execute("unclamped", { command: "work", timeoutMs: 1_000 });
		const legacyResult = await legacy.execute("legacy", { command: "work" });

		expect(timeouts).toEqual([1.25, 1, undefined]);
		expect(boundedResult.details).toMatchObject({ effectiveTimeoutMs: 1_250 });
		expect(unclampedResult.details).toMatchObject({ requestedTimeoutMs: 1_000, effectiveTimeoutMs: 1_000 });
		expect(legacyResult.details).toBeUndefined();
		expect(renderResult(boundedDefinition, boundedResult, { command: "work" })).toContain(
			"Effective timeoutMs: 1250 ms",
		);
		expect(renderResult(boundedDefinition, boundedResult, { command: "work" })).not.toContain("Requested timeoutMs");
		expect(renderResult(boundedDefinition, unclampedResult, { command: "work", timeoutMs: 1_000 })).toContain(
			"Requested timeoutMs: 1000 ms; Effective timeoutMs: 1000 ms",
		);
	});

	it("requires a cap for authorization and treats only timeout as expected completion", async () => {
		const observedTimeouts: Array<number | undefined> = [];
		const timeoutOperations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				observedTimeouts.push(options?.timeout);
				throw new Error(`timeout:${options?.timeout}`);
			},
		};
		const unauthorized = createBashTool(process.cwd(), {
			operations: timeoutOperations,
			commandPolicy: { maxTimeoutMs: 500 },
		});
		await expect(
			unauthorized.execute("unauthorized", { command: "server", timeoutMs: 1_000, expectedHang: true }),
		).rejects.toThrow("not authorized");

		const authorizedOptions = {
			operations: timeoutOperations,
			commandPolicy: { maxTimeoutMs: 800, expectedHangMaxTimeoutMs: 500 },
		};
		const authorized = createBashTool(process.cwd(), authorizedOptions);
		const authorizedDefinition = createBashToolDefinition(process.cwd(), authorizedOptions);
		const requestedResult = await authorized.execute("requested", {
			command: "server",
			timeoutMs: 1_000,
			expectedHang: true,
		});
		const capOnlyResult = await authorized.execute("cap-only", { command: "server", expectedHang: true });
		expect(observedTimeouts).toEqual([0.5, 0.5]);
		expect(text(requestedResult)).toContain("expected timeout");
		expect(requestedResult.details).toMatchObject({
			requestedTimeoutMs: 1_000,
			effectiveTimeoutMs: 500,
			expectedHang: true,
			completionReason: "expected-timeout",
		});
		expect(capOnlyResult.details).toMatchObject({
			effectiveTimeoutMs: 500,
			expectedHang: true,
			completionReason: "expected-timeout",
		});
		expect(
			renderResult(authorizedDefinition, requestedResult, {
				command: "server",
				timeoutMs: 1_000,
				expectedHang: true,
			}),
		).toContain("Requested timeoutMs: 1000 ms; Effective timeoutMs: 500 ms");
	});

	it("validates public command policies synchronously", () => {
		for (const commandPolicy of [
			{ defaultTimeoutMs: -1 },
			{ maxTimeoutMs: -1 },
			{ expectedHangMaxTimeoutMs: -1 },
			{ defaultTimeoutMs: 1.5 },
			{ maxTimeoutMs: 1.5 },
			{ expectedHangMaxTimeoutMs: 1.5 },
			{ expectedHangMaxTimeoutMs: 30_001 },
			{ defaultTimeoutMs: 1_001, maxTimeoutMs: 1_000 },
			{ expectedHangMaxTimeoutMs: 1_001, maxTimeoutMs: 1_000 },
		]) {
			expect(() => createBashTool(process.cwd(), { commandPolicy })).toThrow("Invalid commandPolicy");
		}
	});

	it("prioritizes an aborted signal over a backend timeout", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				expect(options.signal?.aborted).toBe(true);
				throw new Error("timeout:0.5");
			},
		};
		const bash = createBashTool(process.cwd(), {
			operations,
			commandPolicy: { defaultTimeoutMs: 500, expectedHangMaxTimeoutMs: 500 },
		});
		const controller = new AbortController();
		controller.abort();
		const update = vi.fn();

		await expect(
			bash.execute("cancel", { command: "server", expectedHang: true }, controller.signal, update),
		).rejects.toThrow("Command aborted");
	});
});
