import type { CapabilityProfile } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type ModelRouteCandidate, routeModels } from "../../src/routing/model-routing.ts";

function candidate(
	id: string,
	overrides: {
		provider?: string;
		contextWindow?: number;
		modalities?: readonly ("text" | "image")[];
		reasoning?: boolean;
		toolSupport?: CapabilityProfile["tools"]["support"];
		strictMode?: CapabilityProfile["tools"]["strictMode"];
		priority?: number;
		preferenceScore?: number;
		availability?: ModelRouteCandidate["availability"];
	} = {},
): ModelRouteCandidate {
	return {
		id,
		priority: overrides.priority,
		preferenceScore: overrides.preferenceScore,
		availability: overrides.availability,
		profile: {
			version: 1,
			provider: overrides.provider ?? "provider",
			model: id,
			api: "openai-completions",
			input: { modalities: overrides.modalities ?? ["text"] },
			reasoning: {
				supported: overrides.reasoning ?? false,
				levels: overrides.reasoning ? ["off", "low", "high"] : ["off"],
			},
			limits: { contextWindow: overrides.contextWindow ?? 128_000, maxOutputTokens: 16_000 },
			tools: {
				support: overrides.toolSupport ?? "supported",
				schemaTarget: "json-schema",
				strictMode: overrides.strictMode ?? "supported",
				deferredLoading: "none",
			},
		},
	};
}

describe("model routing", () => {
	it("filters by capabilities and preserves structured rejection evidence", () => {
		const plan = routeModels({
			requestId: "request-1",
			candidates: [
				candidate("small", { contextWindow: 8_000 }),
				candidate("text-only", { reasoning: true }),
				candidate("capable", { modalities: ["text", "image"], reasoning: true }),
			],
			requirements: {
				modalities: ["image"],
				reasoningLevel: "high",
				minContextWindow: 64_000,
				tools: { required: true, strictMode: true },
			},
		});

		expect(plan.selected?.id).toBe("capable");
		expect(plan.evaluations.find((evaluation) => evaluation.candidate.id === "small")?.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "modality_missing", severity: "rejection" }),
				expect.objectContaining({ code: "reasoning_unsupported", severity: "rejection" }),
				expect.objectContaining({ code: "context_window_too_small", severity: "rejection" }),
			]),
		);
	});

	it("requires explicit permission for degraded and unknown capabilities", () => {
		const strict = routeModels({
			requestId: "strict",
			candidates: [candidate("unknown", { toolSupport: "unknown", availability: "degraded" })],
			requirements: { tools: { required: true } },
		});
		expect(strict.selected).toBeUndefined();

		const permissive = routeModels({
			requestId: "permissive",
			candidates: [candidate("unknown", { toolSupport: "unknown", availability: "degraded" })],
			requirements: { tools: { required: true }, allowDegraded: true, unknownCapabilities: "allow" },
		});
		expect(permissive.selected?.id).toBe("unknown");
		expect(permissive.evaluations[0]?.issues.every((issue) => issue.severity === "warning")).toBe(true);
	});

	it("uses only explicit priority and preference scores for deterministic ordering", () => {
		const plan = routeModels({
			requestId: "ranked",
			candidates: [
				candidate("b", { priority: 1, preferenceScore: 10 }),
				candidate("a", { priority: 1, preferenceScore: 10 }),
				candidate("preferred", { priority: 0, preferenceScore: -100 }),
			],
			maxCandidates: 2,
		});
		expect([plan.selected?.id, ...plan.fallbacks.map((value) => value.id)]).toEqual(["preferred", "a"]);
	});

	it("returns an inspectable empty plan when no candidate qualifies", () => {
		const plan = routeModels({
			requestId: "none",
			candidates: [candidate("offline", { availability: "unavailable" })],
		});
		expect(plan.selected).toBeUndefined();
		expect(plan.fallbacks).toEqual([]);
		expect(plan.evaluations[0]).toMatchObject({ eligible: false, issues: [{ code: "unavailable" }] });
	});

	it("fails closed on malformed nested profiles and runtime requirements", () => {
		const missingInput = candidate("missing-input");
		missingInput.profile = {
			...missingInput.profile,
			input: undefined,
		} as unknown as CapabilityProfile;
		expect(() => routeModels({ requestId: "bad-profile", candidates: [missingInput] })).toThrowError(
			expect.objectContaining({ code: "invalid_candidate" }),
		);

		expect(() =>
			routeModels({
				requestId: "truthy-degraded",
				candidates: [candidate("degraded", { availability: "degraded" })],
				requirements: { allowDegraded: "yes" } as unknown as Parameters<typeof routeModels>[0]["requirements"],
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));

		expect(() =>
			routeModels({
				requestId: "bad-tools",
				candidates: [candidate("tools")],
				requirements: { tools: "required" } as unknown as Parameters<typeof routeModels>[0]["requirements"],
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
	});
});
