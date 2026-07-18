import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { SessionRuntimeEventStore } from "../../src/harness/runtime-events/event-store.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import {
	type ApprovalRequest,
	createApprovalGrant,
	createToolPolicyAdapter,
	type ToolPolicy,
	type ToolSpec,
} from "../../src/tool-policy.ts";
import { calculateTool } from "../utils/calculate.ts";

const calculateSpec: ToolSpec = {
	name: "calculate",
	revision: "calculate@1",
	retrySafe: true,
	risk: { level: "low" },
	sideEffects: ["none"],
	resources: [],
	permissions: [],
};

function createPolicy(effect: "allow" | "deny"): ToolPolicy {
	return {
		revision: `policy-${effect}@1`,
		rules: [],
		default: { effect, reason: effect === "deny" ? "Denied by policy" : "Allowed by policy" },
	};
}

describe("AgentHarness tool policy integration", () => {
	it("keeps policy denial fail-closed after hooks attempt to allow", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "harness-policy-deny" });
		faux.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "denied-call" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		models.setProvider(faux.provider);
		let executions = 0;
		const guardedTool: typeof calculateTool = {
			...calculateTool,
			async execute(toolCallId, params, signal, onUpdate) {
				executions++;
				return calculateTool.execute(toolCallId, params, signal, onUpdate);
			},
		};
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: faux.getModel(),
			tools: [guardedTool],
			toolPolicy: createToolPolicyAdapter({ policy: createPolicy("deny"), specs: [calculateSpec] }),
		});
		harness.on("tool_call", () => ({ block: false }));

		await harness.prompt("calculate");

		const toolResult = (await session.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(executions).toBe(0);
		expect(toolResult).toMatchObject({
			type: "message",
			message: {
				isError: true,
				content: [{ type: "text", text: "Denied by policy" }],
			},
		});
	});

	it("supplies the harness session scope to approval and executes a granted call", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "harness-policy-approval" });
		faux.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "3 + 4" }, { id: "approved-call" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		models.setProvider(faux.provider);
		let executions = 0;
		let currentTime = 1_000;
		let approvalRequest: ApprovalRequest | undefined;
		const guardedTool: typeof calculateTool = {
			...calculateTool,
			async execute(toolCallId, params, signal, onUpdate) {
				executions++;
				return calculateTool.execute(toolCallId, params, signal, onUpdate);
			},
		};
		const approvalPolicy: ToolPolicy = {
			revision: "approval-policy@1",
			rules: [],
			default: {
				effect: "require_approval",
				reason: "Operator approval required",
				approval: { expiresInMs: 1_000, scope: "session", oneShot: true },
			},
		};
		const session = new Session(new InMemorySessionStorage());
		const sessionId = (await session.getMetadata()).id;
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: faux.getModel(),
			tools: [guardedTool],
			toolPolicy: createToolPolicyAdapter({
				policy: approvalPolicy,
				specs: [calculateSpec],
				now: () => currentTime,
				requestApproval: async (request) => {
					approvalRequest = request;
					currentTime++;
					return createApprovalGrant(request, { id: "approval-grant", issuedAt: currentTime });
				},
			}),
		});

		await harness.prompt("calculate");

		expect(executions).toBe(1);
		expect(approvalRequest?.scope).toEqual({ kind: "session", toolName: "calculate", sessionId });
	});

	it("journals retrySafe from ToolSpec and defaults missing declarations to false", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "harness-policy-retry-safe" });
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("calculate", { expression: "1 + 1" }, { id: "safe-call" }),
						fauxToolCall("unregistered", { expression: "2 + 2" }, { id: "default-call" }),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("done"),
		]);
		models.setProvider(faux.provider);
		const unregisteredTool: typeof calculateTool = { ...calculateTool, name: "unregistered" };
		const session = new Session(new InMemorySessionStorage());
		const runtimeEvents = await SessionRuntimeEventStore.open(session);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			runtimeEvents,
			model: faux.getModel(),
			tools: [calculateTool, unregisteredTool],
			toolPolicy: createToolPolicyAdapter({
				policy: { ...createPolicy("allow"), missingSpec: "use_default" },
				specs: [calculateSpec],
			}),
		});

		await harness.prompt("calculate twice");

		expect(runtimeEvents.getState().toolCalls["safe-call"]?.retrySafe).toBe(true);
		expect(runtimeEvents.getState().toolCalls["default-call"]?.retrySafe).toBe(false);
	});
});
