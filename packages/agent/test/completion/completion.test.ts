import { describe, expect, it, vi } from "vitest";
import {
	COMPLETION_CONTRACT_VERSION,
	type CompletionContract,
	type CompletionJsonValue,
	type CompletionVerifier,
	composeCompletionVerifiers,
	serializeCompletionReport,
	verifyCompletionContract,
} from "../../src/completion/index.ts";

interface TestContext {
	workspace: string;
}

function contract(conditions: CompletionContract["conditions"]): CompletionContract {
	return {
		version: COMPLETION_CONTRACT_VERSION,
		id: "ship-change",
		objective: "Ship a verified change",
		conditions,
		metadata: { z: 2, a: 1 },
	};
}

function verifier(id: string, verify: CompletionVerifier<TestContext>["verify"]): CompletionVerifier<TestContext> {
	return { id, verify };
}

describe("completion contracts", () => {
	it("composes verifiers and deterministically aggregates required and optional conditions", async () => {
		const unit = verifier("unit", ({ context, condition }, signal) => {
			expect(context.workspace).toBe("/workspace");
			expect(condition.id).toBe("tests");
			expect(signal.aborted).toBe(false);
			return {
				status: "pass",
				summary: "Unit tests passed",
				evidence: [
					{ id: "test-z", kind: "test", summary: "Second suite passed", data: { z: 2, a: 1 } },
					{ id: "test-a", kind: "test", summary: "First suite passed" },
				],
			};
		});
		const lint = verifier("lint", () => ({ status: "pass", summary: "Static checks passed" }));
		const docs = verifier("docs", () => ({ status: "fail", summary: "Documentation is missing" }));
		const waiver = verifier("waiver", () => ({ status: "blocked", summary: "No reviewer waiver" }));
		const verifiers = composeCompletionVerifiers([lint, unit], [waiver, docs]);
		expect(verifiers.map((item) => item.id)).toEqual(["docs", "lint", "unit", "waiver"]);

		const completionContract = contract([
			{
				id: "tests",
				description: "All code gates pass",
				verifierIds: ["unit", "lint"],
				mode: "all",
			},
			{
				id: "documentation",
				description: "Documentation exists or is waived",
				verifierIds: ["docs", "waiver"],
				mode: "any",
				required: false,
			},
		]);
		const first = await verifyCompletionContract(completionContract, verifiers, {
			context: { workspace: "/workspace" },
		});
		const second = await verifyCompletionContract(completionContract, [...verifiers].reverse(), {
			context: { workspace: "/workspace" },
		});

		expect(first.status).toBe("pass");
		expect(first.summary).toEqual({
			required: { total: 1, pass: 1, fail: 0, blocked: 0, error: 0 },
			optional: { total: 1, pass: 0, fail: 0, blocked: 1, error: 0 },
		});
		expect(first.conditions.map((condition) => [condition.conditionId, condition.status])).toEqual([
			["tests", "pass"],
			["documentation", "blocked"],
		]);
		expect(first.conditions[0]?.verifiers.map((result) => result.verifierId)).toEqual(["unit", "lint"]);
		expect(first.conditions[0]?.verifiers[0]?.evidence?.map((evidence) => evidence.id)).toEqual(["test-a", "test-z"]);
		expect(serializeCompletionReport(first)).toBe(serializeCompletionReport(second));
		expect(JSON.parse(serializeCompletionReport(first))).toEqual(first);
	});

	it("applies all and any status precedence without short-circuiting evidence collection", async () => {
		const calls: string[] = [];
		const verifiers = [
			verifier("pass", () => {
				calls.push("pass");
				return { status: "pass", summary: "passed" };
			}),
			verifier("fail", () => {
				calls.push("fail");
				return { status: "fail", summary: "failed" };
			}),
			verifier("blocked", () => {
				calls.push("blocked");
				return { status: "blocked", summary: "blocked" };
			}),
		];
		const report = await verifyCompletionContract(
			contract([
				{ id: "all", description: "all", verifierIds: ["pass", "fail", "blocked"], mode: "all" },
				{ id: "any", description: "any", verifierIds: ["fail", "pass", "blocked"], mode: "any" },
			]),
			verifiers,
			{ context: { workspace: "/workspace" } },
		);

		expect(calls).toEqual(["pass", "fail", "blocked", "fail", "pass", "blocked"]);
		expect(report.conditions.map((condition) => condition.status)).toEqual(["fail", "pass"]);
		expect(report.status).toBe("fail");
	});

	it("isolates verifier exceptions and invalid results while continuing later verifiers", async () => {
		const healthy = vi.fn(() => ({ status: "pass" as const, summary: "Healthy verifier ran" }));
		const report = await verifyCompletionContract(
			contract([
				{
					id: "quality",
					description: "Quality is verified",
					verifierIds: ["throws", "invalid", "missing", "healthy"],
				},
			]),
			[
				verifier("throws", () => {
					throw new TypeError("provider unavailable");
				}),
				verifier("invalid", () => ({ status: "pass", summary: "", evidence: [] })),
				verifier("healthy", healthy),
			],
			{ context: { workspace: "/workspace" } },
		);

		expect(healthy).toHaveBeenCalledOnce();
		expect(report.status).toBe("error");
		expect(report.conditions[0]?.verifiers).toMatchObject([
			{ verifierId: "throws", status: "error", error: { name: "TypeError", message: "provider unavailable" } },
			{ verifierId: "invalid", status: "error", error: { name: "CompletionContractError" } },
			{ verifierId: "missing", status: "error", error: { name: "MissingCompletionVerifier" } },
			{ verifierId: "healthy", status: "pass" },
		]);
		expect(serializeCompletionReport(report)).not.toContain("stack");
	});

	it("supports an explicit fail-fast verifier exception policy", async () => {
		const failure = new Error("stop verification");
		await expect(
			verifyCompletionContract(
				contract([{ id: "gate", description: "Gate", verifierIds: ["throws"] }]),
				[
					verifier("throws", () => {
						throw failure;
					}),
				],
				{ context: { workspace: "/workspace" }, errorMode: "throw" },
			),
		).rejects.toBe(failure);
	});

	it("returns a blocked report promptly when the abort signal fires", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const never = verifier("never", (_input, signal) => {
			receivedSignal = signal;
			return new Promise(() => undefined);
		});
		const after = vi.fn(() => ({ status: "pass" as const, summary: "should not run" }));
		const pending = verifyCompletionContract(
			contract([{ id: "external", description: "External gate", verifierIds: ["never", "after"] }]),
			[never, verifier("after", after)],
			{ context: { workspace: "/workspace" }, signal: controller.signal },
		);
		controller.abort();

		const report = await pending;
		expect(receivedSignal).toBe(controller.signal);
		expect(after).not.toHaveBeenCalled();
		expect(report.status).toBe("blocked");
		expect(report.conditions[0]?.verifiers).toMatchObject([
			{ verifierId: "never", status: "blocked", summary: "Verification aborted" },
			{ verifierId: "after", status: "blocked", summary: "Verification aborted" },
		]);
	});

	it("rejects ambiguous contracts, verifier registries, and non-JSON evidence", async () => {
		expect(() =>
			composeCompletionVerifiers(
				[verifier("same", () => ({ status: "pass", summary: "one" }))],
				[verifier("same", () => ({ status: "pass", summary: "two" }))],
			),
		).toThrow("Duplicate completion verifier id: same");

		await expect(
			verifyCompletionContract(
				contract([
					{ id: "duplicate", description: "first", verifierIds: ["check"] },
					{ id: "duplicate", description: "second", verifierIds: ["check"] },
				]),
				[],
				{ context: { workspace: "/workspace" } },
			),
		).rejects.toThrow("Duplicate completion condition id: duplicate");

		const circular: { self?: unknown } = {};
		circular.self = circular;
		const report = await verifyCompletionContract(
			contract([{ id: "json", description: "JSON evidence", verifierIds: ["check"] }]),
			[
				verifier("check", () => ({
					status: "pass",
					summary: "Evidence produced",
					evidence: [
						{ id: "circular", kind: "artifact", summary: "Circular", data: circular as CompletionJsonValue },
					],
				})),
			],
			{ context: { workspace: "/workspace" } },
		);
		expect(report.conditions[0]?.verifiers[0]).toMatchObject({
			status: "error",
			error: { name: "CompletionContractError", message: "Evidence circular data.self must not be circular" },
		});
	});

	it("preserves prototype-like JSON keys without prototype mutation", async () => {
		const metadata = Object.create(null) as { [key: string]: CompletionJsonValue };
		metadata.__proto__ = { retained: true };
		const evidenceData = Object.create(null) as { [key: string]: CompletionJsonValue };
		evidenceData.__proto__ = "evidence-value";
		const completionContract = contract([{ id: "safe-json", description: "Safe JSON", verifierIds: ["json"] }]);
		completionContract.metadata = metadata;
		const report = await verifyCompletionContract(
			completionContract,
			[
				verifier("json", () => ({
					status: "pass",
					summary: "JSON retained",
					evidence: [{ id: "json", kind: "artifact", summary: "JSON", data: evidenceData }],
				})),
			],
			{ context: { workspace: "/workspace" } },
		);
		const serialized = serializeCompletionReport(report);
		const parsed = JSON.parse(serialized) as {
			contract: { metadata: { __proto__: { retained: boolean } } };
			conditions: { verifiers: { evidence: { data: { __proto__: string } }[] }[] }[];
		};

		expect(parsed.contract.metadata.__proto__).toEqual({ retained: true });
		expect(parsed.conditions[0]?.verifiers[0]?.evidence[0]?.data.__proto__).toBe("evidence-value");
		expect(Object.getPrototypeOf(report.contract.metadata)).toBeNull();
	});

	it("rejects lossy JSON values and safely isolates unstringifiable exceptions", async () => {
		const unstringifiable = Object.create(null);
		const report = await verifyCompletionContract(
			contract([
				{ id: "throw", description: "Throw", verifierIds: ["throw"] },
				{ id: "undefined", description: "Undefined", verifierIds: ["undefined"] },
			]),
			[
				verifier("throw", () => {
					throw unstringifiable;
				}),
				verifier("undefined", () => ({
					status: "pass",
					summary: "invalid data",
					evidence: [
						{
							id: "undefined",
							kind: "artifact",
							summary: "invalid",
							data: { lost: undefined } as unknown as CompletionJsonValue,
						},
					],
				})),
			],
			{ context: { workspace: "/workspace" } },
		);

		expect(report.conditions[0]?.verifiers[0]).toMatchObject({
			status: "error",
			error: { name: "Error", message: "Unknown verifier error" },
		});
		expect(report.conditions[1]?.verifiers[0]).toMatchObject({
			status: "error",
			error: { message: "Evidence undefined data.lost must be JSON serializable" },
		});
	});
});
