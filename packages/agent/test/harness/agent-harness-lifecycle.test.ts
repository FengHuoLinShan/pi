import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";

let fauxCount = 0;

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
});
