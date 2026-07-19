import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { SessionRuntimeEventStore } from "../../src/harness/runtime-events/event-store.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";

let fauxCount = 0;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class BlockingEntryIdStorage extends InMemorySessionStorage {
	private blockEntryIds = false;
	private readonly entryIdGate = deferred();
	private readonly firstBlockedCall = deferred();
	private activeEntryIdCalls = 0;
	maxConcurrentEntryIdCalls = 0;

	block(): void {
		this.blockEntryIds = true;
	}

	async waitForBlockedCall(): Promise<void> {
		await this.firstBlockedCall.promise;
	}

	release(): void {
		this.entryIdGate.resolve();
	}

	override async createEntryId(): Promise<string> {
		if (!this.blockEntryIds) return await super.createEntryId();
		this.activeEntryIdCalls++;
		this.maxConcurrentEntryIdCalls = Math.max(this.maxConcurrentEntryIdCalls, this.activeEntryIdCalls);
		this.firstBlockedCall.resolve();
		await this.entryIdGate.promise;
		this.activeEntryIdCalls--;
		return await super.createEntryId();
	}
}

function createHarness(): { harness: AgentHarness; session: Session } {
	const models = createModels();
	const registration = fauxProvider({ provider: `lifecycle-faux-${++fauxCount}` });
	registration.setResponses([() => fauxAssistantMessage("ok")]);
	models.setProvider(registration.provider);
	const session = new Session(new InMemorySessionStorage());
	const harness = new AgentHarness({
		models,
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session,
		model: registration.getModel(),
	});
	return { harness, session };
}

describe("AgentHarness lifecycle", () => {
	it("keeps the turn phase through agent_end and settled callbacks", async () => {
		const { harness } = createHarness();
		const phases: string[] = [];
		harness.subscribe(async (event) => {
			if (event.type !== "agent_end" && event.type !== "settled") return;
			phases.push(`${event.type}:${harness.getPhase()}`);
			await expect(harness.prompt("nested")).rejects.toMatchObject({ code: "busy" });
		});

		expect(harness.isIdle()).toBe(true);
		await harness.prompt("hello");

		expect(phases).toEqual(["agent_end:turn", "settled:turn"]);
		expect(harness.getPhase()).toBe("idle");
		expect(harness.isIdle()).toBe(true);
	});

	it("flushes session writes requested by settled callbacks", async () => {
		const { harness, session } = createHarness();
		const settledMessage = {
			role: "custom",
			customType: "settled-test",
			content: "written during settled",
			display: true,
			timestamp: Date.now(),
		} as AgentMessage;
		let pendingCount = 0;
		harness.on("settled", async () => {
			await harness.appendMessage(settledMessage);
			pendingCount = harness.getPendingWrites().length;
		});

		await harness.prompt("hello");

		expect(pendingCount).toBe(1);
		expect(harness.getPendingWrites()).toHaveLength(0);
		const messages = (await session.getEntries()).flatMap((entry) =>
			entry.type === "message" ? [entry.message] : [],
		);
		expect(messages).toEqual([
			expect.objectContaining({ role: "user" }),
			expect.objectContaining({ role: "assistant" }),
			settledMessage,
		]);
	});

	it("rejects late steering and follow-up input once terminal settlement starts", async () => {
		const { harness } = createHarness();
		const errorCodes: string[] = [];
		harness.on("settled", async () => {
			for (const operation of [harness.steer("late steer"), harness.followUp("late follow-up")]) {
				try {
					await operation;
				} catch (error) {
					if (error && typeof error === "object" && "code" in error) errorCodes.push(String(error.code));
				}
			}
		});

		await harness.prompt("hello");

		expect(errorCodes).toEqual(["invalid_state", "invalid_state"]);
	});

	it("allows abort from terminal callbacks without self-waiting", async () => {
		const { harness } = createHarness();
		let abortCompleted = false;
		harness.on("settled", async () => {
			await harness.abort();
			abortCompleted = true;
		});

		await harness.prompt("hello");

		expect(abortCompleted).toBe(true);
		expect(harness.isIdle()).toBe(true);
	});

	it("does not synthesize a second assistant response after terminal hook failure", async () => {
		const { harness, session } = createHarness();
		harness.on("settled", () => {
			throw new Error("settled exploded");
		});

		await expect(harness.prompt("hello")).rejects.toThrow("settled exploded");

		const assistantMessages = (await session.getEntries()).flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
		);
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0]).toMatchObject({ stopReason: "stop" });
		expect(harness.isIdle()).toBe(true);
	});

	it("notifies observers for result-producing hook events", async () => {
		const { harness } = createHarness();
		const observed: string[] = [];
		harness.subscribe((event) => {
			if (
				event.type === "before_agent_start" ||
				event.type === "context" ||
				event.type === "before_provider_request"
			) {
				observed.push(event.type);
			}
		});

		await harness.prompt("hello");

		expect(observed).toEqual(["before_agent_start", "context", "before_provider_request"]);
	});

	it("establishes the abort barrier before asynchronous turn setup", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `lifecycle-startup-abort-${++fauxCount}` });
		registration.setResponses([
			(_context, options) =>
				options?.signal?.aborted
					? fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "startup aborted" })
					: fauxAssistantMessage("unexpected"),
		]);
		models.setProvider(registration.provider);
		const setupStarted = deferred();
		const releaseSetup = deferred();
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			systemPrompt: async () => {
				setupStarted.resolve();
				await releaseSetup.promise;
				return "system";
			},
		});

		const prompt = harness.prompt("hello");
		await setupStarted.promise;
		let abortResolved = false;
		const abort = harness.abort().then(() => {
			abortResolved = true;
		});
		await Promise.resolve();
		expect(harness.signal?.aborted).toBe(true);
		expect(abortResolved).toBe(false);
		releaseSetup.resolve();

		await expect(prompt).resolves.toMatchObject({ stopReason: "aborted" });
		await abort;
		expect(harness.isIdle()).toBe(true);
	});

	it("waits only for the run captured when abort starts", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `lifecycle-abort-run-${++fauxCount}` });
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const secondStarted = deferred();
		const releaseSecond = deferred();
		registration.setResponses([
			async (_context, options) => {
				firstStarted.resolve();
				await releaseFirst.promise;
				return options?.signal?.aborted
					? fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "first aborted" })
					: fauxAssistantMessage("unexpected first result");
			},
			async () => {
				secondStarted.resolve();
				await releaseSecond.promise;
				return fauxAssistantMessage("second complete");
			},
		]);
		models.setProvider(registration.provider);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const abortQueueUpdateStarted = deferred();
		const releaseAbortQueueUpdate = deferred();
		let blockNextQueueUpdate = true;
		harness.on("queue_update", async () => {
			if (!blockNextQueueUpdate) return;
			blockNextQueueUpdate = false;
			abortQueueUpdateStarted.resolve();
			await releaseAbortQueueUpdate.promise;
		});

		const firstPrompt = harness.prompt("first");
		await firstStarted.promise;
		let abortResolved = false;
		const abort = harness.abort().then(() => {
			abortResolved = true;
		});
		await abortQueueUpdateStarted.promise;
		releaseFirst.resolve();
		await firstPrompt;

		const secondPrompt = harness.prompt("second");
		await secondStarted.promise;
		releaseAbortQueueUpdate.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(abortResolved).toBe(true);
		expect(harness.isIdle()).toBe(false);
		releaseSecond.resolve();
		await Promise.all([abort, secondPrompt]);
	});

	it("serializes concurrent durable session writes requested by settled callbacks", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `lifecycle-settled-writes-${++fauxCount}` });
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		models.setProvider(registration.provider);
		const storage = new BlockingEntryIdStorage();
		const session = new Session(storage);
		const runtimeEvents = await SessionRuntimeEventStore.open(session);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			runtimeEvents,
			model: registration.getModel(),
		});
		const messages = [
			{ role: "custom", customType: "settled", content: "first", display: true, timestamp: 1 },
			{ role: "custom", customType: "settled", content: "second", display: true, timestamp: 2 },
		] as AgentMessage[];
		harness.on("settled", async () => {
			storage.block();
			await Promise.all(messages.map(async (message) => await harness.appendMessage(message)));
		});

		const prompt = harness.prompt("hello");
		await storage.waitForBlockedCall();
		await Promise.resolve();
		expect(storage.maxConcurrentEntryIdCalls).toBe(1);
		storage.release();
		await prompt;

		const customMessages = (await session.getEntries()).flatMap((entry) =>
			entry.type === "message" && entry.message.role === "custom" ? [entry.message.content] : [],
		);
		expect(customMessages).toEqual(["first", "second"]);
		expect(harness.getPendingWrites()).toHaveLength(0);
	});

	it("does not emit settled before validating that the run produced an assistant result", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `lifecycle-no-result-${++fauxCount}` });
		models.setProvider(registration.provider);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			runBudget: { maxSteps: 0 },
		});
		const terminalEvents: string[] = [];
		harness.subscribe((event) => {
			if (event.type === "agent_end" || event.type === "settled") terminalEvents.push(event.type);
		});

		await expect(harness.prompt("hello")).rejects.toMatchObject({ code: "invalid_state" });

		expect(terminalEvents).toEqual(["agent_end"]);
		expect(harness.isIdle()).toBe(true);
	});
});
