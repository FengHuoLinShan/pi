import type { CapabilityProfile } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	appendReplayEvalCorpus,
	createReplayEvalCorpus,
	runControlledModelRouting,
	verifyReplayEvalCorpus,
} from "../../src/evals/trace-eval-routing.ts";
import {
	type MinedReplayEvalFixture,
	mineReplayEval,
	verifyMinedReplayEvalFixture,
} from "../../src/evals/trace-mining.ts";
import { createTraceBundle, type TraceBundleSource } from "../../src/harness/observability/trace-bundle.ts";
import { RUNTIME_EVENT_VERSION, type RuntimeEventEnvelope } from "../../src/harness/runtime-events/types.ts";
import type { ModelRouteCandidate } from "../../src/routing/model-routing.ts";

function candidate(id: string): ModelRouteCandidate {
	const profile: CapabilityProfile = {
		version: 1,
		provider: "provider",
		model: id,
		api: "openai-completions",
		input: { modalities: ["text"] },
		reasoning: { supported: false, levels: ["off"] },
		limits: { contextWindow: 128_000, maxOutputTokens: 16_000 },
		tools: {
			support: "supported",
			schemaTarget: "json-schema",
			strictMode: "supported",
			deferredLoading: "none",
		},
	};
	return { id, profile };
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, nested]) => [key, canonicalValue(nested)]),
	);
}

async function fixtureDigest(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(canonicalValue(value))),
	);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture() {
	const canonicalEvents: RuntimeEventEnvelope[] = [
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-1",
			sequence: 1,
			timestamp: "2026-07-30T00:00:01.000Z",
			sessionId: "session-1",
			event: { type: "operation_started", operationId: "operation-1", kind: "turn" },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-2",
			sequence: 2,
			timestamp: "2026-07-30T00:00:02.000Z",
			sessionId: "session-1",
			event: { type: "turn_started", turnId: "turn-1", operationId: "operation-1", consumedQueueItemIds: [] },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-3",
			sequence: 3,
			timestamp: "2026-07-30T00:00:03.000Z",
			sessionId: "session-1",
			event: {
				type: "tool_call_started",
				toolCallId: "tool-1",
				turnId: "turn-1",
				toolName: "read",
				retrySafe: true,
			},
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "event-4",
			sequence: 4,
			timestamp: "2026-07-30T00:00:04.000Z",
			sessionId: "session-1",
			event: { type: "tool_call_finished", toolCallId: "tool-1" },
		},
	];
	const source: TraceBundleSource = {
		sessionId: "session-1",
		canonicalEvents,
		modelExchanges: [],
		toolExchanges: [
			{
				sequence: 3,
				toolCallId: "tool-1",
				toolName: "read",
				input: { path: "worker.ts" },
				result: { content: "captured result" },
				isError: true,
			},
		],
		metrics: {},
	};
	const bundle = await createTraceBundle(source, {
		createId: () => "bundle-1",
		now: () => new Date("2026-07-30T00:00:00.000Z"),
		contentCapture: { include: () => true },
	});
	return await mineReplayEval(bundle, {
		id: "tool-read-regression",
		allowCapturedContent: true,
		adapterKinds: ["tool"],
	});
}

async function modelFixture() {
	const canonicalEvents: RuntimeEventEnvelope[] = [
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "model-event-1",
			sequence: 1,
			timestamp: "2026-07-30T00:00:01.000Z",
			sessionId: "model-session",
			event: { type: "operation_started", operationId: "model-operation", kind: "turn" },
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "model-event-2",
			sequence: 2,
			timestamp: "2026-07-30T00:00:02.000Z",
			sessionId: "model-session",
			event: {
				type: "turn_started",
				turnId: "model-turn",
				operationId: "model-operation",
				consumedQueueItemIds: [],
			},
		},
		{
			version: RUNTIME_EVENT_VERSION,
			eventId: "model-event-3",
			sequence: 3,
			timestamp: "2026-07-30T00:00:03.000Z",
			sessionId: "model-session",
			event: {
				type: "provider_request_started",
				requestId: "model-request",
				turnId: "model-turn",
				provider: "source-provider",
				modelId: "source-model",
			},
		},
	];
	const bundle = await createTraceBundle(
		{
			sessionId: "model-session",
			canonicalEvents,
			modelExchanges: [
				{
					sequence: 3,
					requestId: "model-request",
					provider: "source-provider",
					modelId: "source-model",
					input: { prompt: "Return the captured output." },
					output: { text: "captured model output" },
				},
			],
			toolExchanges: [],
			metrics: {},
		},
		{
			createId: () => "model-bundle",
			now: () => new Date("2026-07-30T00:00:00.000Z"),
			contentCapture: { include: () => true },
		},
	);
	return await mineReplayEval(bundle, {
		id: "model-routing-regression",
		allowCapturedContent: true,
		adapterKinds: ["model"],
		criticalSequence: 3,
		force: true,
	});
}

describe("trace eval controlled routing", () => {
	it("accepts class-based replay adapters and rejects unknown policy fields", async () => {
		const mined = await fixture();
		const corpus = await appendReplayEvalCorpus(createReplayEvalCorpus("class-adapter"), mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T00:00:00.000Z",
		});
		class Adapter {
			async invokeModel(): Promise<undefined> {
				return undefined;
			}

			async invokeTool(): Promise<{ result: unknown; isError: boolean }> {
				return { result: { content: "captured result" }, isError: true };
			}
		}
		const report = await runControlledModelRouting({
			requestId: "class-adapter",
			corpus,
			candidates: [{ candidate: candidate("candidate"), adapters: new Adapter() }],
		});
		expect(report.routePlan.selected?.id).toBe("candidate");

		await expect(
			runControlledModelRouting({
				requestId: "unknown-policy",
				corpus,
				candidates: [{ candidate: candidate("candidate"), adapters: new Adapter() }],
				policy: { minPassRtae: 1 } as unknown as Parameters<typeof runControlledModelRouting>[0]["policy"],
			}),
		).rejects.toMatchObject({ code: "invalid_policy" });

		await expect(
			runControlledModelRouting({
				requestId: "sparse-policy",
				corpus,
				candidates: [{ candidate: candidate("candidate"), adapters: new Adapter() }],
				policy: {
					fixtureIds: new Array<string>(1),
				},
			}),
		).rejects.toMatchObject({ code: "invalid_policy" });
	});

	it("promotes verified fixtures into an optimistic versioned corpus", async () => {
		const mined = await fixture();
		const initial = createReplayEvalCorpus("coding-agent-regressions");
		const corpus = await appendReplayEvalCorpus(initial, mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T00:00:00.000Z",
			tags: ["tool", "regression"],
		});

		expect(corpus).toMatchObject({
			id: "coding-agent-regressions",
			revision: 1,
			entries: [{ fixture: { id: "tool-read-regression" }, tags: ["regression", "tool"] }],
		});
		expect(await verifyReplayEvalCorpus(corpus)).toBe(true);
		expect(
			await appendReplayEvalCorpus(corpus, mined, {
				expectedRevision: 1,
				addedAt: "2026-07-30T01:00:00.000Z",
			}),
		).toEqual(corpus);
		await expect(
			appendReplayEvalCorpus(corpus, mined, {
				expectedRevision: 0,
				addedAt: "2026-07-30T01:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "revision_conflict" });

		const mutableInitial = createReplayEvalCorpus("append-frozen");
		const appending = appendReplayEvalCorpus(mutableInitial, mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T02:00:00.000Z",
		});
		(mutableInitial as unknown as { revision: number }).revision = 99;
		expect(await appending).toMatchObject({ revision: 1, entries: [{ fixture: { id: mined.id } }] });
	});

	it("rejects content-addressed fixtures whose candidate branch has no replay coverage", async () => {
		const mined = structuredClone(await fixture()) as MinedReplayEvalFixture;
		const mutable = mined as unknown as {
			candidateBranch: {
				manifest: MinedReplayEvalFixture["candidateBranch"]["manifest"];
				steps: MinedReplayEvalFixture["candidateBranch"]["steps"];
			};
			fixtureHash: string;
		};
		mutable.candidateBranch.steps = [];
		const { definitionHash: _definitionHash, ...manifest } = mutable.candidateBranch.manifest;
		(mutable.candidateBranch.manifest as unknown as { definitionHash: string }).definitionHash = await fixtureDigest({
			...mutable.candidateBranch,
			manifest,
		});
		const { fixtureHash: _fixtureHash, ...body } = mined;
		mutable.fixtureHash = await fixtureDigest(body);

		expect(await verifyMinedReplayEvalFixture(mined)).toBe(false);
	});

	it("routes only candidates that pass the frozen corpus quality gate", async () => {
		const mined = await fixture();
		const corpus = await appendReplayEvalCorpus(createReplayEvalCorpus("routing-corpus"), mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T00:00:00.000Z",
		});
		const report = await runControlledModelRouting({
			requestId: "route-1",
			corpus,
			candidates: [
				{
					candidate: candidate("passing-model"),
					adapters: {
						invokeModel: async () => undefined,
						invokeTool: async () => ({ result: { content: "captured result" }, isError: true }),
					},
				},
				{
					candidate: candidate("failing-model"),
					adapters: {
						invokeModel: async () => undefined,
						invokeTool: async () => ({ result: { content: "changed result" }, isError: false }),
					},
				},
			],
		});

		expect(report.routePlan.selected?.id).toBe("passing-model");
		expect(report.qualifications).toEqual([
			expect.objectContaining({ candidateId: "passing-model", status: "qualified", passRate: 1 }),
			expect.objectContaining({ candidateId: "failing-model", status: "failed", passRate: 0 }),
		]);
		expect(
			report.routePlan.evaluations.find((evaluation) => evaluation.candidate.id === "failing-model")?.issues,
		).toContainEqual(expect.objectContaining({ code: "qualification_failed", severity: "rejection" }));
		expect(JSON.stringify(report)).not.toContain("captured result");
		expect(report.id).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("binds model replay invocations to the route candidate profile", async () => {
		const mined = await modelFixture();
		const corpus = await appendReplayEvalCorpus(createReplayEvalCorpus("model-binding"), mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T00:00:00.000Z",
		});
		const invoked: Array<{ provider: string; modelId: string }> = [];
		const report = await runControlledModelRouting({
			requestId: "model-binding",
			corpus,
			candidates: [
				{
					candidate: candidate("candidate-model"),
					adapters: {
						invokeModel: async (step) => {
							invoked.push({ provider: step.provider, modelId: step.modelId });
							return { text: "captured model output" };
						},
						invokeTool: async () => ({ result: undefined, isError: false }),
					},
				},
			],
		});

		expect(invoked).toEqual([{ provider: "provider", modelId: "candidate-model" }]);
		expect(report.routePlan.selected?.id).toBe("candidate-model");
	});

	it("fails closed for missing fixtures and adapter execution errors", async () => {
		const mined = await fixture();
		const corpus = await appendReplayEvalCorpus(createReplayEvalCorpus("routing-errors"), mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T00:00:00.000Z",
		});
		await expect(
			runControlledModelRouting({
				requestId: "missing",
				corpus,
				candidates: [
					{
						candidate: candidate("candidate"),
						adapters: {
							invokeModel: async () => undefined,
							invokeTool: async () => {
								throw new Error("provider unavailable");
							},
						},
					},
				],
				policy: { fixtureIds: ["missing-fixture"] },
			}),
		).rejects.toMatchObject({ code: "invalid_policy" });

		const report = await runControlledModelRouting({
			requestId: "adapter-error",
			corpus,
			candidates: [
				{
					candidate: candidate("candidate"),
					adapters: {
						invokeModel: async () => undefined,
						invokeTool: async () => {
							throw new Error("provider unavailable");
						},
					},
				},
			],
		});
		expect(report.routePlan.selected).toBeUndefined();
		expect(report.qualifications[0]).toMatchObject({
			status: "failed",
			errors: 1,
			results: [{ status: "error", report: { candidate: { status: "error" } } }],
		});
	});

	it("never qualifies execution errors even when regression thresholds are permissive", async () => {
		const mined = await fixture();
		const corpus = await appendReplayEvalCorpus(createReplayEvalCorpus("routing-error-threshold"), mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T00:00:00.000Z",
		});
		const report = await runControlledModelRouting({
			requestId: "permissive-errors",
			corpus,
			candidates: [
				{
					candidate: candidate("candidate"),
					adapters: {
						invokeModel: async () => undefined,
						invokeTool: async () => {
							throw new Error("provider unavailable");
						},
					},
				},
			],
			policy: { minPassRate: 0, maxFailures: 1 },
		});

		expect(report.routePlan.selected).toBeUndefined();
		expect(report.qualifications[0]).toMatchObject({ status: "failed", passed: 0, failed: 1, errors: 1 });
	});

	it("freezes corpus and candidate metadata before asynchronous qualification", async () => {
		const mined = await fixture();
		const corpus = await appendReplayEvalCorpus(createReplayEvalCorpus("routing-frozen"), mined, {
			expectedRevision: 0,
			addedAt: "2026-07-30T00:00:00.000Z",
		});
		const routeCandidate = candidate("stable-candidate");
		let releaseAdapter: (() => void) | undefined;
		let notifyStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseAdapter = resolve;
		});
		const routing = runControlledModelRouting({
			requestId: "frozen-inputs",
			corpus,
			candidates: [
				{
					candidate: routeCandidate,
					adapters: {
						invokeModel: async () => undefined,
						invokeTool: async () => {
							notifyStarted?.();
							await release;
							return { result: { content: "captured result" }, isError: true };
						},
					},
				},
			],
		});
		(corpus as unknown as { revision: number }).revision = 99;
		(routeCandidate as { id: string }).id = "mutated-candidate";
		await started;
		releaseAdapter?.();

		const report = await routing;
		expect(report.corpusRevision).toBe(1);
		expect(report.qualifications[0]?.candidateId).toBe("stable-candidate");
		expect(report.routePlan.selected?.id).toBe("stable-candidate");
	});
});
