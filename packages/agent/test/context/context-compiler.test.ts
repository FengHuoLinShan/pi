import { describe, expect, it } from "vitest";
import {
	type ContextCompilerError,
	compileContext,
	estimateContextTextTokens,
} from "../../src/context/context-compiler.ts";

describe("context compiler", () => {
	it("is deterministic across input order and keeps output ordering separate from admission priority", () => {
		const fragments = [
			{ id: "later", kind: "evidence", content: "high priority", priority: 20, order: 2 },
			{ id: "first", kind: "instruction", content: "required", priority: 0, order: 0, required: true },
			{ id: "middle", kind: "repo_map", content: "medium priority", priority: 10, order: 1 },
		] as const;
		const forward = compileContext({ tokenBudget: 200, reserveTokens: 10, fragments });
		const reverse = compileContext({ tokenBudget: 200, reserveTokens: 10, fragments: [...fragments].reverse() });

		expect(reverse).toEqual(forward);
		expect(forward.fragments.map((fragment) => fragment.id)).toEqual(["first", "middle", "later"]);
		expect(forward.estimatedTokens).toBeLessThanOrEqual(190);
		expect(JSON.parse(JSON.stringify(forward))).toEqual(forward);
	});

	it("applies a conservative multilingual estimate and truncates within the available budget", () => {
		expect(estimateContextTextTokens("abcdefgh")).toBe(2);
		expect(estimateContextTextTokens("上下文")).toBe(3);

		const result = compileContext({
			tokenBudget: 42,
			reserveTokens: 7,
			fragments: [
				{
					id: "large",
					kind: "repo_map",
					content: "important-context-".repeat(30),
					priority: 10,
					truncation: "middle",
				},
				{ id: "small", kind: "note", content: "lower priority", priority: 0 },
			],
		});

		expect(result.estimatedTokens).toBeLessThanOrEqual(35);
		expect(result.fragments[0]).toMatchObject({ id: "large", truncated: true });
		expect(result.fragments[0].content).toContain("[... truncated ...]");
		expect(result.omitted).toEqual([expect.objectContaining({ id: "small", reason: "budget", required: false })]);
	});

	it("fails explicitly instead of silently dropping a required fragment", () => {
		expect(() =>
			compileContext({
				tokenBudget: 5,
				fragments: [
					{
						id: "policy",
						kind: "instruction",
						content: "This policy must remain intact.",
						priority: 0,
						required: true,
					},
				],
			}),
		).toThrowError(
			expect.objectContaining<Partial<ContextCompilerError>>({
				code: "required_fragment_overflow",
				fragmentId: "policy",
			}),
		);
	});

	it("rejects duplicate ids and invalid per-fragment budgets", () => {
		expect(() =>
			compileContext({
				tokenBudget: 50,
				fragments: [
					{ id: "same", kind: "note", content: "one", priority: 0 },
					{ id: "same", kind: "note", content: "two", priority: 1 },
				],
			}),
		).toThrow("Duplicate context fragment id");

		expect(() =>
			compileContext({
				tokenBudget: 50,
				fragments: [
					{
						id: "bad-budget",
						kind: "note",
						content: "text",
						priority: 0,
						minTokens: 10,
						maxTokens: 5,
					},
				],
			}),
		).toThrow("maximum tokens may not be less than its minimum");
	});
});
