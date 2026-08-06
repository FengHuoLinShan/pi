import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bindProcessAbort,
	classifyProcessCompletion,
	TaskControllerRegistry,
} from "../examples/extensions/subagent/task-control.ts";

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

	it("times out a hung process with SIGTERM then SIGKILL", () => {
		vi.useFakeTimers();
		const signals: NodeJS.Signals[] = [];
		const process = {
			kill: (signal: NodeJS.Signals) => {
				signals.push(signal);
				return true;
			},
		};
		const binding = bindProcessAbort(process, undefined, undefined, 5, 10);
		vi.advanceTimersByTime(10);
		expect(binding.getSource()).toBe("timeout");
		expect(signals).toEqual(["SIGTERM"]);
		vi.advanceTimersByTime(5);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("keeps user cancellation distinct when it wins the timeout race", () => {
		vi.useFakeTimers();
		const signals: NodeJS.Signals[] = [];
		const process = {
			kill: (signal: NodeJS.Signals) => {
				signals.push(signal);
				return true;
			},
		};
		const task = new AbortController();
		const binding = bindProcessAbort(process, undefined, task.signal, 5, 10);
		task.abort();
		vi.advanceTimersByTime(10);
		expect(binding.getSource()).toBe("task");
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("does not classify cancellation when initial termination fails", () => {
		vi.useFakeTimers();
		const signals: NodeJS.Signals[] = [];
		const task = new AbortController();
		const binding = bindProcessAbort(
			{
				kill: (signal: NodeJS.Signals) => {
					signals.push(signal);
					return false;
				},
			},
			undefined,
			task.signal,
			5,
			10,
		);
		task.abort();
		expect(binding.getSource()).toBeUndefined();
		expect(classifyProcessCompletion(0, binding.getSource())).toBe("completed");
		expect(signals).toEqual(["SIGTERM"]);
		binding.close();
		vi.runAllTimers();
		expect(signals).toEqual(["SIGTERM"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves process-tree escalation after direct-child wait completes", () => {
		vi.useFakeTimers();
		const signals: NodeJS.Signals[] = [];
		const process = {
			kill: (signal: NodeJS.Signals) => {
				signals.push(signal);
				return true;
			},
		};
		const task = new AbortController();
		const binding = bindProcessAbort(process, undefined, task.signal, 5000, 10_000);
		task.abort();
		binding.close();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(5000);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears deadline and escalation timers after normal completion", () => {
		vi.useFakeTimers();
		const signals: NodeJS.Signals[] = [];
		const binding = bindProcessAbort(
			{
				kill: (signal: NodeJS.Signals) => {
					signals.push(signal);
					return true;
				},
			},
			undefined,
			undefined,
			5000,
			10_000,
		);
		binding.close();
		expect(vi.getTimerCount()).toBe(0);
		vi.runAllTimers();
		expect(signals).toEqual([]);
	});
});
