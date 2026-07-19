import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CodingAgentHarnessRuntime } from "../src/core/coding-agent-harness-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

let fauxCount = 0;

async function createRuntime() {
	const models = createModels();
	const faux = fauxProvider({ provider: `coding-harness-runtime-${++fauxCount}` });
	models.setProvider(faux.provider);
	const sessionManager = SessionManager.inMemory(process.cwd());
	const runtime = new CodingAgentHarnessRuntime({
		models,
		sessionManager,
		cwd: process.cwd(),
		initialState: {
			systemPrompt: "test",
			model: faux.getModel(),
			thinkingLevel: "off",
			tools: [],
		},
		streamFn: (model, context, options) => models.streamSimple(model, context, options),
	});
	await runtime.initialize();
	return { faux, runtime, sessionManager };
}

function userText(messages: Message[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	});
}

describe("CodingAgentHarnessRuntime", () => {
	it("uses projected state messages as the next prompt context", async () => {
		const { faux, runtime } = await createRuntime();
		let requestText: string[] = [];
		faux.setResponses([
			(context) => {
				requestText = userText(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		runtime.state.messages = [{ role: "user", content: [{ type: "text", text: "projected" }], timestamp: 1 }];

		await runtime.prompt("current");

		expect(requestText).toEqual(["projected", "current"]);
	});

	it("preserves prepareNextTurn context and newMessages across tool turns", async () => {
		const { faux, runtime } = await createRuntime();
		let secondRequestText: string[] = [];
		faux.setResponses([
			() => fauxAssistantMessage(fauxToolCall("missing", {}, { id: "call-1" }), { stopReason: "toolUse" }),
			(context) => {
				secondRequestText = userText(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		let prepareCalls = 0;
		let newMessageRoles: string[] = [];
		runtime.prepareNextTurnWithContext = (turn) => {
			prepareCalls++;
			if (prepareCalls !== 1) return undefined;
			newMessageRoles = turn.newMessages.map((message) => message.role);
			return {
				context: {
					...turn.context,
					messages: [{ role: "user", content: [{ type: "text", text: "replacement" }], timestamp: 2 }],
				},
			};
		};

		await runtime.prompt("original");

		expect(newMessageRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(secondRequestText).toEqual(["replacement"]);
	});

	it("dispatches message_end only after the message is persisted", async () => {
		const { faux, runtime, sessionManager } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("committed")]);
		let persistedWhenObserved = false;
		runtime.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			persistedWhenObserved = sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && entry.message === event.message);
		});

		await runtime.prompt("go");

		expect(persistedWhenObserved).toBe(true);
	});

	it("aborts the active run before queued control cleanup completes", async () => {
		const { faux, runtime } = await createRuntime();
		let providerSignal: AbortSignal | undefined;
		let releaseProvider = () => {};
		const providerBlocked = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		let providerStarted = () => {};
		const providerReady = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		faux.setResponses([
			async (_context, options) => {
				providerSignal = options?.signal;
				providerStarted();
				await providerBlocked;
				return fauxAssistantMessage("late");
			},
		]);
		const prompt = runtime.prompt("wait");
		await providerReady;

		runtime.abort();

		expect(providerSignal?.aborted).toBe(true);
		releaseProvider();
		await prompt;
		await runtime.waitForIdle();
	});
});
