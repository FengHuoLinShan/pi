import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createApprovalGrant,
	createApprovalRequest,
	createToolPolicyAdapter,
	evaluateToolPolicy,
	hashToolPolicyInvocation,
	InMemoryApprovalGrantStore,
	type ToolPolicy,
	type ToolPolicyInvocation,
	type ToolSpec,
	validateApprovalGrantForInvocation,
	validateApprovalGrantForRequest,
} from "../src/tool-policy.ts";
import type { BeforeToolCallContext } from "../src/types.ts";

const readSpec: ToolSpec = {
	name: "inspect",
	revision: "inspect@1",
	retrySafe: true,
	risk: { level: "low" },
	sideEffects: ["read_state"],
	resources: [{ kind: "workspace", access: ["read"], dynamic: true }],
	permissions: [{ id: "workspace.read", description: "Read workspace content" }],
	tags: ["local"],
};

const writeSpec: ToolSpec = {
	name: "mutate",
	revision: "mutate@3",
	retrySafe: false,
	risk: { level: "high", rationale: ["Changes durable state"] },
	sideEffects: ["write_state"],
	resources: [{ kind: "workspace", access: ["write"], dynamic: true }],
	permissions: [{ id: "workspace.write", description: "Modify workspace content" }],
	tags: ["local", "mutation"],
};

const policy: ToolPolicy = {
	revision: "policy@7",
	rules: [
		{
			id: "require-write-approval",
			priority: 20,
			effect: "require_approval",
			reason: "Durable writes require approval",
			match: { sideEffectsAny: ["write_state"] },
			approval: { expiresInMs: 1_000, scope: "call", oneShot: true },
		},
		{
			id: "allow-read",
			priority: 10,
			effect: "allow",
			reason: "Workspace reads are allowed",
			match: { permissionIdsAll: ["workspace.read"], resourceAccessAny: ["read"] },
		},
	],
	default: { effect: "deny", reason: "No policy rule allowed the tool" },
};

function invocation(toolName: string, toolCallId = "call-1"): ToolPolicyInvocation {
	return {
		toolCallId,
		toolName,
		arguments: { path: "src/index.ts" },
		resources: [{ kind: "workspace", access: toolName === "mutate" ? "write" : "read", locator: "src/index.ts" }],
	};
}

async function resolvedInvocation(toolName: string, toolCallId = "call-1"): Promise<ToolPolicyInvocation> {
	const unresolved = invocation(toolName, toolCallId);
	return { ...unresolved, resolvedCallHash: await hashToolPolicyInvocation(unresolved) };
}

function assistantMessage(toolName: string, toolCallId: string, path = "src/index.ts"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: { path } }],
		api: "openai-responses",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function beforeToolCallContext(toolName: string, toolCallId: string, path = "src/index.ts"): BeforeToolCallContext {
	const message = assistantMessage(toolName, toolCallId, path);
	const toolCall = message.content[0];
	if (toolCall.type !== "toolCall") throw new Error("Expected tool call");
	return {
		assistantMessage: message,
		toolCall,
		args: toolCall.arguments,
		context: { systemPrompt: "", messages: [] },
	};
}

describe("tool policy decisions", () => {
	it("matches structured declarations and applies deterministic priority", () => {
		const shuffled: ToolPolicy = {
			...policy,
			rules: [
				{
					id: "deny-all",
					priority: 1,
					effect: "deny",
					reason: "Low-priority fallback",
				},
				...policy.rules,
			],
		};

		expect(evaluateToolPolicy(shuffled, readSpec, invocation("inspect"))).toMatchObject({
			decision: "allow",
			ruleId: "allow-read",
		});
		expect(evaluateToolPolicy(shuffled, writeSpec, invocation("mutate"))).toMatchObject({
			decision: "require_approval",
			ruleId: "require-write-approval",
			toolSpecRevision: "mutate@3",
		});
	});

	it("uses rule id as a stable tie breaker instead of array order", () => {
		const tiedPolicy: ToolPolicy = {
			revision: "tie@1",
			rules: [
				{ id: "z-deny", effect: "deny", reason: "deny" },
				{ id: "a-allow", effect: "allow", reason: "allow" },
			],
			default: { effect: "deny", reason: "default" },
		};
		expect(evaluateToolPolicy(tiedPolicy, readSpec, invocation("inspect"))).toMatchObject({
			decision: "allow",
			ruleId: "a-allow",
		});
	});

	it("fails closed for missing specs unless the policy explicitly opts out", () => {
		expect(evaluateToolPolicy(policy, undefined, invocation("unregistered"))).toMatchObject({
			decision: "deny",
		});

		const permissive: ToolPolicy = {
			revision: "permissive@1",
			rules: [],
			default: { effect: "allow", reason: "Explicit fallback" },
			missingSpec: "use_default",
		};
		expect(evaluateToolPolicy(permissive, undefined, invocation("unregistered"))).toMatchObject({
			decision: "allow",
			reason: "Explicit fallback",
		});
	});

	it("rejects invalid approval policy definitions", () => {
		const invalid: ToolPolicy = {
			revision: "invalid@1",
			rules: [{ id: "bad", effect: "require_approval", reason: "missing settings" }],
			default: { effect: "deny", reason: "default" },
		};
		expect(() => evaluateToolPolicy(invalid, readSpec, invocation("inspect"))).toThrow("requires approval settings");
	});

	it("requires explicit retry safety metadata", () => {
		const missingRetrySafety = { ...readSpec, retrySafe: undefined } as unknown as ToolSpec;
		expect(() => createToolPolicyAdapter({ policy, specs: [missingRetrySafety] })).toThrow(
			"ToolSpec retrySafe must be boolean",
		);
	});
});

describe("approval requests and grants", () => {
	it("round-trips through JSON with scope, expiry, and revisions intact", async () => {
		const toolInvocation = await resolvedInvocation("mutate");
		const decision = evaluateToolPolicy(policy, writeSpec, toolInvocation);
		const request = createApprovalRequest(decision, toolInvocation, { id: "request-1", now: 1_000 });
		const grant = createApprovalGrant(request, { id: "grant-1", issuedAt: 1_001, expiresAt: 1_500 });

		expect(JSON.parse(JSON.stringify({ request, grant }))).toEqual({ request, grant });
		expect(request).toMatchObject({
			revision: 1,
			policyRevision: "policy@7",
			toolSpecRevision: "mutate@3",
			scope: { kind: "call", toolName: "mutate", toolCallId: "call-1" },
			oneShot: true,
			expiresAt: 2_000,
		});
		expect(validateApprovalGrantForRequest(grant, request, 1_100)).toEqual({ valid: true });
		expect(validateApprovalGrantForInvocation(grant, decision, toolInvocation, 1_100, false)).toEqual({
			valid: true,
		});
	});

	it("rejects broadened, expired, stale, and consumed grants", async () => {
		const toolInvocation = await resolvedInvocation("mutate");
		const decision = evaluateToolPolicy(policy, writeSpec, toolInvocation);
		const request = createApprovalRequest(decision, toolInvocation, { id: "request-1", now: 1_000 });
		const grant = createApprovalGrant(request, { id: "grant-1", issuedAt: 1_001 });

		expect(
			validateApprovalGrantForRequest({ ...grant, scope: { kind: "tool", toolName: "mutate" } }, request, 1_100),
		).toMatchObject({ valid: false, reason: "Grant scope is broader than requested" });
		expect(validateApprovalGrantForInvocation(grant, decision, toolInvocation, 2_000, false)).toMatchObject({
			valid: false,
			reason: "Approval grant has expired",
		});
		expect(
			validateApprovalGrantForInvocation(
				grant,
				{ ...decision, policyRevision: "policy@8" },
				toolInvocation,
				1_100,
				false,
			),
		).toMatchObject({ valid: false, reason: "Grant policy revision is stale" });
		expect(validateApprovalGrantForInvocation(grant, decision, toolInvocation, 1_100, true)).toMatchObject({
			valid: false,
			reason: "One-shot approval grant was already consumed",
		});
	});

	it("persists grant and one-shot consumption state without authority widening", async () => {
		const toolInvocation = await resolvedInvocation("mutate");
		const decision = evaluateToolPolicy(policy, writeSpec, toolInvocation);
		const request = createApprovalRequest(decision, toolInvocation, { id: "request-1", now: 1_000 });
		const grant = createApprovalGrant(request, { id: "grant-1", issuedAt: 1_001 });
		const store = new InMemoryApprovalGrantStore();
		store.add(grant);
		store.consume(grant.id);

		const restored = new InMemoryApprovalGrantStore(JSON.parse(JSON.stringify(store.snapshot())));
		expect(restored.list()).toEqual([grant]);
		expect(restored.isConsumed(grant.id)).toBe(true);
	});
});

describe("tool policy adapter", () => {
	it("exposes defensive ToolSpec reads including retry safety", () => {
		let resolutions = 0;
		const adapter = createToolPolicyAdapter({
			policy,
			specs: () => {
				resolutions++;
				return readSpec;
			},
			now: () => 1_000,
		});
		const first = adapter.getSpec("inspect");
		const second = adapter.getSpec("inspect");
		expect(first).toEqual(readSpec);
		expect(first?.retrySafe).toBe(true);
		expect(first).not.toBe(second);
		expect(resolutions).toBe(1);
	});

	it("adapts approval to beforeToolCall without embedding UI", async () => {
		let currentTime = 1_000;
		const requests: string[] = [];
		const adapter = createToolPolicyAdapter({
			policy,
			specs: [readSpec, writeSpec],
			now: () => currentTime,
			resolveInvocation: () => ({ resources: [{ kind: "workspace", access: "write", locator: "src/index.ts" }] }),
			requestApproval: async (request) => {
				requests.push(request.id);
				currentTime++;
				return createApprovalGrant(request, { id: "grant-1", issuedAt: currentTime });
			},
		});

		expect(await adapter.beforeToolCall(beforeToolCallContext("mutate", "call-1"))).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatch(/^call-1:policy@7:require-write-approval:sha256:[0-9a-f]{64}$/);
		expect(adapter.grantStore.isConsumed("grant-1")).toBe(true);

		const second = await adapter.authorize(beforeToolCallContext("mutate", "call-1"));
		expect(second).toMatchObject({ allowed: false, reason: "One-shot approval grant was already consumed" });
	});

	it("reuses an unexpired tool-scoped grant only for the exact resolved action", async () => {
		const toolScopePolicy: ToolPolicy = {
			...policy,
			rules: [
				{
					...policy.rules[0],
					approval: { expiresInMs: 1_000, scope: "tool", oneShot: false },
				},
			],
		};
		let requestCount = 0;
		let currentTime = 1_000;
		const adapter = createToolPolicyAdapter({
			policy: toolScopePolicy,
			specs: [writeSpec],
			now: () => currentTime,
			requestApproval: async (request) => {
				requestCount++;
				currentTime++;
				return createApprovalGrant(request, { id: `tool-grant-${requestCount}`, issuedAt: currentTime });
			},
		});

		expect((await adapter.authorize(beforeToolCallContext("mutate", "call-1"))).allowed).toBe(true);
		expect((await adapter.authorize(beforeToolCallContext("mutate", "call-2"))).allowed).toBe(true);
		expect(requestCount).toBe(1);
		expect((await adapter.authorize(beforeToolCallContext("mutate", "call-3", "src/other.ts"))).allowed).toBe(true);
		expect(requestCount).toBe(2);

		const revisedAdapter = createToolPolicyAdapter({
			policy: toolScopePolicy,
			specs: [{ ...writeSpec, revision: "mutate@4" }],
			grantStore: adapter.grantStore,
			now: () => currentTime,
		});
		expect(await revisedAdapter.beforeToolCall(beforeToolCallContext("mutate", "call-4"))).toMatchObject({
			block: true,
			reason: "Durable writes require approval",
		});
	});

	it("hashes canonical arguments and sorted resources without retaining payloads", async () => {
		const first: ToolPolicyInvocation = {
			toolCallId: "first",
			toolName: "mutate",
			arguments: { nested: { b: 2, a: 1 }, path: "secret.txt" },
			resources: [
				{ kind: "workspace", access: "write", locator: "b" },
				{ kind: "workspace", access: "read", locator: "a" },
			],
		};
		const reordered: ToolPolicyInvocation = {
			toolCallId: "second",
			toolName: "mutate",
			arguments: { path: "secret.txt", nested: { a: 1, b: 2 } },
			resources: [...(first.resources ?? [])].reverse(),
		};
		const digest = await hashToolPolicyInvocation(first);
		expect(await hashToolPolicyInvocation(reordered)).toBe(digest);
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(digest).not.toContain("secret.txt");
	});

	it("blocks missing declarations and declined approvals", async () => {
		const missing = createToolPolicyAdapter({ policy, specs: [], now: () => 1_000 });
		expect(await missing.beforeToolCall(beforeToolCallContext("unknown", "call-x"))).toMatchObject({
			block: true,
			reason: "No ToolSpec is registered for tool unknown",
		});

		const declined = createToolPolicyAdapter({
			policy,
			specs: [writeSpec],
			now: () => 1_000,
			requestApproval: async () => undefined,
		});
		expect(await declined.beforeToolCall(beforeToolCallContext("mutate", "call-1"))).toMatchObject({
			block: true,
			reason: "Approval was not granted",
		});
	});

	it("accepts harness-shaped invocation data without a loop context", async () => {
		const adapter = createToolPolicyAdapter({ policy, specs: [readSpec], now: () => 1_000 });
		expect(await adapter.authorizeInvocation(invocation("inspect", "harness-call"))).toMatchObject({
			allowed: true,
			decision: { ruleId: "allow-read" },
		});
	});
});
