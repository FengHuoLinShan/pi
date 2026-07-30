import { afterEach, describe, expect, it, vi } from "vitest";
import { bindProcessAbort, TaskControllerRegistry } from "../examples/extensions/subagent/task-control.ts";

describe("subagent task control", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("cancels one parallel task without aborting its siblings", () => {
		const registry = new TaskControllerRegistry();
		const first = registry.start("call:0");
		const second = registry.start("call:1");
		expect(registry.cancel("call:0")).toBe(true);
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		registry.finish("call:0");
		registry.finish("call:1");
	});

	it("preserves cancellation when a queued task starts later", () => {
		const registry = new TaskControllerRegistry();
		const reserved = registry.start("call:4");
		expect(registry.cancel("call:4")).toBe(true);
		const started = registry.start("call:4");
		expect(started).toBe(reserved);
		expect(started.signal.aborted).toBe(true);
		registry.finish("call:4");
	});

	it("propagates parent cancellation to every active task", () => {
		const registry = new TaskControllerRegistry();
		const first = registry.start("call:0");
		const second = registry.start("call:1");
		registry.cancelAll();
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(true);
	});

	it("escalates SIGTERM to SIGKILL only while the process remains open", () => {
		vi.useFakeTimers();
		const signals: NodeJS.Signals[] = [];
		const process = {
			kill: (signal: NodeJS.Signals) => {
				signals.push(signal);
				return true;
			},
		};
		const task = new AbortController();
		const binding = bindProcessAbort(process, undefined, task.signal, 5000);
		task.abort();
		expect(binding.getSource()).toBe("task");
		expect(signals).toEqual(["SIGTERM"]);
		vi.advanceTimersByTime(5000);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("does not escalate after the child closes", () => {
		vi.useFakeTimers();
		const signals: NodeJS.Signals[] = [];
		const process = {
			kill: (signal: NodeJS.Signals) => {
				signals.push(signal);
				return true;
			},
		};
		const task = new AbortController();
		const binding = bindProcessAbort(process, undefined, task.signal, 5000);
		task.abort();
		binding.close();
		vi.advanceTimersByTime(5000);
		expect(signals).toEqual(["SIGTERM"]);
	});
});
