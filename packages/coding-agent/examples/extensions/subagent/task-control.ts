export type AbortSource = "parent" | "task" | "timeout";

interface KillableProcess {
	kill(signal: NodeJS.Signals): boolean;
}

export interface ProcessAbortBinding {
	getSource(): AbortSource | undefined;
	close(): void;
}

export function classifyProcessCompletion(
	exitCode: number,
	source: AbortSource | undefined,
): "completed" | "failed" | "cancelled" | "timed_out" {
	if (source === "timeout") return "timed_out";
	if (source) return "cancelled";
	return exitCode === 0 ? "completed" : "failed";
}

export function bindProcessAbort(
	process: KillableProcess,
	parentSignal: AbortSignal | undefined,
	taskSignal: AbortSignal | undefined,
	escalationMs = 5000,
	timeoutMs?: number,
): ProcessAbortBinding {
	let source: AbortSource | undefined;
	let closed = false;
	let escalationTimer: ReturnType<typeof setTimeout> | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const abortParent = () => abort("parent");
	const abortTask = () => abort("task");

	const cleanupListenersAndDeadline = () => {
		parentSignal?.removeEventListener("abort", abortParent);
		taskSignal?.removeEventListener("abort", abortTask);
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}
	};
	const abort = (nextSource: AbortSource) => {
		if (source || closed || !process.kill("SIGTERM")) return;
		source = nextSource;
		cleanupListenersAndDeadline();
		escalationTimer = setTimeout(() => {
			process.kill("SIGKILL");
			escalationTimer = undefined;
		}, escalationMs);
	};

	if (parentSignal?.aborted) abortParent();
	else parentSignal?.addEventListener("abort", abortParent, { once: true });
	if (taskSignal?.aborted) abortTask();
	else taskSignal?.addEventListener("abort", abortTask, { once: true });
	if (!source && timeoutMs !== undefined) timeoutTimer = setTimeout(() => abort("timeout"), timeoutMs);

	return {
		getSource: () => source,
		close: () => {
			closed = true;
			cleanupListenersAndDeadline();
			if (!source && escalationTimer) {
				clearTimeout(escalationTimer);
				escalationTimer = undefined;
			}
		},
	};
}

export class TaskControllerRegistry {
	private readonly controllers = new Map<string, AbortController>();

	start(taskId: string): AbortController {
		const existing = this.controllers.get(taskId);
		if (existing) return existing;
		const controller = new AbortController();
		this.controllers.set(taskId, controller);
		return controller;
	}

	cancel(taskId: string): boolean {
		const controller = this.controllers.get(taskId);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	finish(taskId: string): void {
		this.controllers.delete(taskId);
	}

	cancelAll(): void {
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
	}
}
