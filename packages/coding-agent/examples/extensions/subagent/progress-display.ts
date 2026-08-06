export type SubagentProgressMode = "single" | "parallel" | "chain";
export type SubagentProgressStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "skipped";

export interface SubagentProgressUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	readonly contextTokens: number;
	readonly turns: number;
}

export interface SubagentProgressTask {
	taskId: string;
	agent: string;
	taskSummary: string;
	status: SubagentProgressStatus;
	lastActivity?: string;
	cwd?: string;
	timeoutMs?: number;
	activityOutput?: string;
	lastActivityAt?: number;
	phase?: string;
	inactivityMs?: number;
	inactivityWarning?: string;
	usage: SubagentProgressUsage;
	provider?: string;
	model?: string;
	thinking?: string;
}

export interface SubagentProgressEvent {
	readonly toolCallId: string;
	readonly mode: SubagentProgressMode;
	readonly revision: number;
	readonly expectedTasks: number;
	readonly results: readonly SubagentProgressTask[];
}

interface ActiveCall {
	mode: SubagentProgressMode;
	expectedTasks: number;
	revision: number;
	tasks: Map<string, SubagentProgressTask>;
}

const MAX_VISIBLE_TASKS = 12;
const MAX_VISIBLE_CALLS = 6;
const MAX_AGENT_LENGTH = 40;
const MAX_ACTIVITY_LENGTH = 40;
const MAX_SUMMARY_LENGTH = 100;

function safeText(value: string, maximumLength: number): string {
	const sanitized = value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (sanitized.length <= maximumLength) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsage(task: SubagentProgressTask): string {
	const parts: string[] = [];
	if (task.usage.turns > 0) parts.push(`${task.usage.turns}t`);
	if (task.usage.input > 0) parts.push(`↑${formatTokens(task.usage.input)}`);
	if (task.usage.output > 0) parts.push(`↓${formatTokens(task.usage.output)}`);
	if (task.usage.cacheRead > 0) parts.push(`R${formatTokens(task.usage.cacheRead)}`);
	if (task.usage.cacheWrite > 0) parts.push(`W${formatTokens(task.usage.cacheWrite)}`);
	if (task.usage.cost > 0) parts.push(`$${task.usage.cost.toFixed(4)}`);
	if (task.usage.contextTokens > 0) parts.push(`ctx:${formatTokens(task.usage.contextTokens)}`);
	const runtime = task.model
		? `${task.provider ? `${task.provider}/` : ""}${task.model}${task.thinking ? `:${task.thinking}` : ""}`
		: task.provider;
	if (runtime) parts.push(safeText(runtime, 80));
	return parts.join(" ");
}

function taskIcon(status: SubagentProgressStatus): string {
	switch (status) {
		case "queued":
			return "○";
		case "running":
			return "⏳";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "◼";
		case "timed_out":
			return "⌛";
		case "skipped":
			return "－";
	}
}

function isPending(status: SubagentProgressStatus): boolean {
	return status === "queued" || status === "running";
}

function plural(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export class SubagentProgressDisplay {
	private readonly calls = new Map<string, ActiveCall>();

	begin(toolCallId: string, mode: SubagentProgressMode, expectedTasks: number): void {
		this.calls.set(toolCallId, {
			mode,
			expectedTasks,
			revision: 0,
			tasks: new Map(),
		});
	}

	update(event: SubagentProgressEvent): void {
		const call = this.calls.get(event.toolCallId);
		if (
			!call ||
			event.revision <= call.revision ||
			event.expectedTasks !== call.expectedTasks ||
			event.results.length !== event.expectedTasks
		)
			return;
		call.mode = event.mode;
		call.revision = event.revision;
		call.tasks = new Map(event.results.map((task) => [task.taskId, { ...task, usage: { ...task.usage } }]));
	}

	finish(toolCallId: string): void {
		this.calls.delete(toolCallId);
	}

	clear(): void {
		this.calls.clear();
	}

	getStatusText(): string | undefined {
		if (this.calls.size === 0) return undefined;
		const tasks = [...this.calls.values()].flatMap((call) => [...call.tasks.values()]);
		const running = tasks.filter((task) => task.status === "running").length;
		const queued = tasks.filter((task) => task.status === "queued").length;
		const starting = [...this.calls.values()].filter((call) => call.tasks.size === 0).length;
		const parts = [`subagents ${this.calls.size} call${this.calls.size === 1 ? "" : "s"}`];
		if (running > 0) parts.push(`${running} running`);
		if (queued > 0) parts.push(`${queued} queued`);
		if (starting > 0) parts.push(`${starting} starting`);
		return parts.join(" · ");
	}

	getLines(): string[] | undefined {
		if (this.calls.size === 0) return undefined;
		const calls = [...this.calls.values()];
		const allTasks = calls.flatMap((call) => [...call.tasks.values()]);
		const running = allTasks.filter((task) => task.status === "running").length;
		const queued = allTasks.filter((task) => task.status === "queued").length;
		const terminal = allTasks.length - running - queued;
		const headerParts = [`Subagents · ${plural(calls.length, "call")}`];
		if (running > 0) headerParts.push(`${running} running`);
		if (queued > 0) headerParts.push(`${queued} queued`);
		if (terminal > 0) headerParts.push(`${terminal} done`);
		if (allTasks.length === 0) headerParts.push("starting");

		const lines = [headerParts.join(" · ")];
		let visibleTasks = 0;
		const visibleCalls = calls.slice(0, MAX_VISIBLE_CALLS);
		for (let callIndex = 0; callIndex < visibleCalls.length; callIndex++) {
			const call = calls[callIndex]!;
			const tasks = [...call.tasks.values()].sort((left, right) => {
				const leftRank = left.status === "running" ? 0 : left.status === "queued" ? 1 : 2;
				const rightRank = right.status === "running" ? 0 : right.status === "queued" ? 1 : 2;
				return leftRank - rightRank;
			});
			const pending = tasks.filter((task) => isPending(task.status)).length;
			const completed = tasks.length - pending;
			lines.push(
				`#${callIndex + 1} ${call.mode} · ${completed}/${call.expectedTasks} done${pending > 0 ? ` · ${pending} active` : ""}`,
			);
			for (const task of tasks) {
				if (visibleTasks >= MAX_VISIBLE_TASKS) continue;
				visibleTasks++;
				const activity = task.lastActivity ? ` · ${safeText(task.lastActivity, MAX_ACTIVITY_LENGTH)}` : "";
				const usage = formatUsage(task);
				lines.push(
					`  ${taskIcon(task.status)} ${safeText(task.agent, MAX_AGENT_LENGTH)} · ${task.status}${activity} · ${safeText(task.taskSummary, MAX_SUMMARY_LENGTH)}${usage ? ` · ${usage}` : ""}`,
				);
			}
			if (tasks.length === 0) lines.push("  ○ starting...");
		}
		const hiddenCalls = calls.length - visibleCalls.length;
		const hiddenTasks = allTasks.length - visibleTasks;
		if (hiddenCalls > 0) {
			lines.push(
				`  … ${plural(hiddenCalls, "more call")}${hiddenTasks > 0 ? ` · ${plural(hiddenTasks, "more task")}` : ""}`,
			);
		} else if (hiddenTasks > 0) {
			lines.push(`  … ${plural(hiddenTasks, "more task")}`);
		}
		return lines;
	}
}
