import { type CapabilityProfile, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type ModelRouteCandidate, routeModels } from "../../src/routing/model-routing.ts";
import {
	classifyAssistantFailure,
	executeStructuredRecoveryAction,
	planStructuredRecovery,
} from "../../src/routing/structured-recovery.ts";

function route(id: string, provider: string, contextWindow: number): ModelRouteCandidate {
	const profile: CapabilityProfile = {
		version: 1,
		provider,
		model: id,
		api: "openai-completions",
		input: { modalities: ["text"] },
		reasoning: { supported: false, levels: ["off"] },
		limits: { contextWindow, maxOutputTokens: 8_000 },
		tools: {
			support: "supported",
			schemaTarget: "json-schema",
			strictMode: "supported",
			deferredLoading: "none",
		},
	};
	return { id, profile };
}

const routePlan = routeModels({
	requestId: "routes",
	candidates: [route("primary", "provider-a", 32_000), route("large", "provider-b", 128_000)],
});

describe("structured recovery", () => {
	it("classifies existing pi-ai terminal messages without executing recovery", () => {
		expect(
			classifyAssistantFailure(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
				{ attempt: 1 },
			),
		).toMatchObject({ kind: "context_overflow", source: "model" });
		expect(
			classifyAssistantFailure(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
				{ attempt: 2 },
			),
		).toMatchObject({ kind: "transient_provider", attempt: 2 });
		expect(
			classifyAssistantFailure(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "cancelled" }), {
				attempt: 1,
			}),
		).toMatchObject({ kind: "aborted", source: "runtime" });
	});

	it("offers bounded retry, fallback, and stop alternatives in a stable order", () => {
		const plan = planStructuredRecovery({
			failure: {
				kind: "rate_limited",
				source: "model",
				summary: "rate limited",
				attempt: 1,
				retryAfterMs: 500,
			},
			routePlan,
			currentRouteId: "primary",
			maxRequestAttempts: 2,
			maxRetryDelayMs: 1_000,
		});
		expect(plan.recommendedActionId).toBe("retry-request");
		expect(plan.terminal).toBe(false);
		expect(plan.actions.map((action) => action.id)).toEqual(["retry-request", "switch-model:large", "stop"]);
	});

	it("prefers compaction and only larger-context fallbacks for overflow", () => {
		const plan = planStructuredRecovery({
			failure: { kind: "context_overflow", source: "model", summary: "too long", attempt: 1 },
			routePlan,
			currentRouteId: "primary",
			compaction: { available: true, attempts: 0, maxAttempts: 1 },
		});
		expect(plan.actions.map((action) => action.id)).toEqual(["compact-context", "switch-model:large", "stop"]);
	});

	it("does not retry unsafe tools and exposes approval as an explicit action", () => {
		const unsafe = planStructuredRecovery({
			failure: {
				kind: "tool_failed",
				source: "tool",
				summary: "deploy failed",
				attempt: 1,
				tool: { name: "deploy", retrySafe: false },
			},
			maxToolAttempts: 2,
		});
		expect(unsafe.actions.map((action) => action.id)).toEqual(["stop"]);
		expect(unsafe.terminal).toBe(true);

		const policy = planStructuredRecovery({
			failure: {
				kind: "policy_denied",
				source: "policy",
				summary: "approval required",
				attempt: 1,
				approvalAvailable: true,
			},
			approvalAvailable: true,
		});
		expect(policy.actions.map((action) => action.id)).toEqual(["request-approval", "stop"]);
	});

	it("executes exactly one selected handler", async () => {
		const plan = planStructuredRecovery({
			failure: { kind: "transient_provider", source: "model", summary: "temporary", attempt: 1 },
			routePlan,
			currentRouteId: "primary",
			maxRequestAttempts: 2,
		});
		const retryRequest = vi.fn(async () => "retried");
		const switchModel = vi.fn(async () => "switched");
		await expect(executeStructuredRecoveryAction(plan, "retry-request", { retryRequest, switchModel })).resolves.toBe(
			"retried",
		);
		expect(retryRequest).toHaveBeenCalledOnce();
		expect(switchModel).not.toHaveBeenCalled();
		await expect(executeStructuredRecoveryAction(plan, "switch-model:large", {})).rejects.toMatchObject({
			code: "handler_missing",
		});
	});

	it("infers the selected route and rejects unknown or duplicate current routes", () => {
		const inferred = planStructuredRecovery({
			failure: { kind: "transient_provider", source: "model", summary: "temporary", attempt: 1 },
			routePlan,
			maxRequestAttempts: 2,
		});
		expect(inferred.currentRouteId).toBe("primary");
		expect(inferred.actions.map((action) => action.id)).toEqual(["retry-request", "switch-model:large", "stop"]);

		expect(() =>
			planStructuredRecovery({
				failure: { kind: "transient_provider", source: "model", summary: "temporary", attempt: 1 },
				routePlan,
				currentRouteId: "typo",
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_options" }));

		expect(() =>
			planStructuredRecovery({
				failure: { kind: "transient_provider", source: "model", summary: "temporary", attempt: 1 },
				routePlan: { ...routePlan, fallbacks: [routePlan.selected!] },
			}),
		).toThrow("Duplicate recovery route id");
	});

	it("rejects malformed plans and nested options with structured errors", async () => {
		expect(() =>
			planStructuredRecovery(null as unknown as Parameters<typeof planStructuredRecovery>[0]),
		).toThrowError(expect.objectContaining({ code: "invalid_options" }));
		expect(() =>
			planStructuredRecovery({
				failure: { kind: "context_overflow", source: "model", summary: "overflow", attempt: 1 },
				compaction: { available: "yes", attempts: 0, maxAttempts: 1 } as unknown as NonNullable<
					Parameters<typeof planStructuredRecovery>[0]["compaction"]
				>,
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_options" }));

		const malformed = {
			version: 1,
			failure: { kind: "unknown", source: "runtime", summary: "bad", attempt: 1 },
			recommendedActionId: "bad",
			actions: [{ id: "bad", kind: "retry_forever", summary: "bad" }],
			terminal: false,
		} as unknown as Parameters<typeof executeStructuredRecoveryAction>[0];
		await expect(executeStructuredRecoveryAction(malformed, "bad", {})).rejects.toMatchObject({
			code: "invalid_options",
		});
	});

	it("aborts an in-flight handler without hiding ordinary handler failures", async () => {
		const plan = planStructuredRecovery({
			failure: { kind: "transient_provider", source: "model", summary: "temporary", attempt: 1 },
			routePlan,
			maxRequestAttempts: 2,
		});
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = executeStructuredRecoveryAction(
			plan,
			"retry-request",
			{
				retryRequest: async () => {
					markStarted?.();
					return await new Promise(() => undefined);
				},
			},
			{ signal: controller.signal },
		);
		await started;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });

		const failure = new TypeError("handler failed");
		await expect(
			executeStructuredRecoveryAction(plan, "retry-request", {
				retryRequest: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
	});
});
