export type AbortSource = "parent" | "task";

interface KillableProcess {
	kill(signal: NodeJS.Signals): boolean;
}

export interface ProcessAbortBinding {
	getSource(): AbortSource | undefined;
	close(): void;
}

export function bindProcessAbort(
	process: KillableProcess,
	parentSignal: AbortSignal | undefined,
	taskSignal: AbortSignal | undefined,
	escalationMs = 5000,
): ProcessAbortBinding {
	let source: AbortSource | undefined;
	let closed = false;
	let escalationTimer: ReturnType<typeof setTimeout> | undefined;
	const abortParent = () => abort("parent");
	const abortTask = () => abort("task");

	const cleanup = () => {
		parentSignal?.removeEventListener("abort", abortParent);
		taskSignal?.removeEventListener("abort", abortTask);
		if (escalationTimer) clearTimeout(escalationTimer);
	};
	const abort = (nextSource: AbortSource) => {
		if (source || closed) return;
		source = nextSource;
		process.kill("SIGTERM");
		escalationTimer = setTimeout(() => {
			if (!closed) process.kill("SIGKILL");
		}, escalationMs);
	};

	if (parentSignal?.aborted) abortParent();
	else parentSignal?.addEventListener("abort", abortParent, { once: true });
	if (taskSignal?.aborted) abortTask();
	else taskSignal?.addEventListener("abort", abortTask, { once: true });

	return {
		getSource: () => source,
		close: () => {
			closed = true;
			cleanup();
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
