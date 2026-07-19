import { describe, expect, it, vi } from "vitest";
import {
	CodeGraphError,
	type CodeGraphExtraction,
	computeCodeGraphFileRevision,
	IncrementalCodeGraph,
} from "../src/core/code-graph.ts";

const revision = (value: string) => computeCodeGraphFileRevision(value);

function extraction(
	nodes: Array<{ id: string; name?: string; kind?: string }>,
	edges: Array<{ id: string; from: string; to: string; kind?: string }> = [],
): CodeGraphExtraction {
	return {
		nodes: nodes.map((node) => ({
			id: node.id,
			kind: node.kind ?? "symbol",
			name: node.name ?? node.id,
		})),
		edges: edges.map((edge) => ({
			id: edge.id,
			kind: edge.kind ?? "depends_on",
			from: edge.from,
			to: edge.to,
		})),
	};
}

describe("IncrementalCodeGraph", () => {
	it("atomically replaces one file at an expected revision", () => {
		const graph = new IncrementalCodeGraph();
		const firstRevision = revision("first");
		const secondRevision = revision("second");

		graph.upsertFile({
			path: "src/a.ts",
			previousRevision: null,
			revision: firstRevision,
			extraction: extraction([{ id: "a" }, { id: "old" }], [{ id: "a-old", from: "a", to: "old" }]),
		});
		const result = graph.upsertFile({
			path: "src/a.ts",
			previousRevision: firstRevision,
			revision: secondRevision,
			extraction: extraction([{ id: "a", name: "renamed" }]),
		});

		expect(result).toEqual({
			generation: 2,
			path: "src/a.ts",
			revision: secondRevision,
			nodeIds: ["a"],
			edgeIds: [],
		});
		expect(graph.getNode("a")?.name).toBe("renamed");
		expect(graph.getNode("old")).toBeUndefined();
		expect(graph.getEdge("a-old")).toBeUndefined();
	});

	it("rejects stale and invalid updates without mutating the graph", () => {
		const graph = new IncrementalCodeGraph();
		const currentRevision = revision("current");
		graph.upsertFile({
			path: "src/a.ts",
			previousRevision: null,
			revision: currentRevision,
			extraction: extraction([{ id: "a" }]),
		});
		const before = graph.toJSON();

		expect(() =>
			graph.upsertFile({
				path: "src/a.ts",
				previousRevision: revision("stale"),
				revision: revision("next"),
				extraction: extraction([{ id: "replacement" }]),
			}),
		).toThrowError(expect.objectContaining({ code: "stale_update" }));
		expect(() =>
			graph.upsertFile({
				path: "src/a.ts",
				previousRevision: currentRevision,
				revision: revision("next"),
				extraction: extraction(
					[{ id: "replacement" }],
					[{ id: "invalid", from: "missing-source", to: "replacement" }],
				),
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_update" }));
		expect(graph.toJSON()).toBe(before);
	});

	it("produces deterministic snapshots and restores them from JSON", () => {
		const left = new IncrementalCodeGraph();
		const right = new IncrementalCodeGraph();
		const files = [
			{
				path: "src/z.ts",
				revision: revision("z"),
				extraction: extraction([{ id: "z" }], [{ id: "z-a", from: "z", to: "a" }]),
			},
			{ path: "src/a.ts", revision: revision("a"), extraction: extraction([{ id: "a" }]) },
		];
		for (const file of files) left.upsertFile({ ...file, previousRevision: null });
		for (const file of [...files].reverse()) right.upsertFile({ ...file, previousRevision: null });

		expect(left.toJSON()).toBe(right.toJSON());
		const restored = IncrementalCodeGraph.fromJSON(left.toJSON());
		expect(restored.snapshot()).toEqual(left.snapshot());
		expect(restored.findForwardDependencies("z").paths).toEqual([{ nodeIds: ["z", "a"], edgeIds: ["z-a"] }]);
	});

	it("queries deterministic forward, reverse, and transitive impact paths", () => {
		const graph = new IncrementalCodeGraph();
		graph.upsertFile({
			path: "src/graph.ts",
			previousRevision: null,
			revision: revision("graph"),
			extraction: extraction(
				[{ id: "a" }, { id: "b" }, { id: "c" }, { id: "test" }],
				[
					{ id: "a-b", from: "a", to: "b" },
					{ id: "b-c", from: "b", to: "c" },
					{ id: "c-a", from: "c", to: "a" },
					{ id: "test-a", from: "test", to: "a", kind: "tests" },
				],
			),
		});

		expect(graph.findForwardDependencies("a", { maxDepth: 2 }).paths).toEqual([
			{ nodeIds: ["a", "b"], edgeIds: ["a-b"] },
			{ nodeIds: ["a", "b", "c"], edgeIds: ["a-b", "b-c"] },
		]);
		expect(graph.findReverseDependencies("a", { maxDepth: 1 }).paths).toEqual([
			{ nodeIds: ["a", "c"], edgeIds: ["c-a"] },
			{ nodeIds: ["a", "test"], edgeIds: ["test-a"] },
		]);
		expect(graph.findImpactPaths(["a"], { maxDepth: 3, edgeKinds: ["depends_on"] }).paths).toEqual([
			{ nodeIds: ["a", "c"], edgeIds: ["c-a"] },
			{ nodeIds: ["a", "c", "b"], edgeIds: ["c-a", "b-c"] },
		]);
	});

	it("allows unresolved targets and preserves their reverse impact evidence after removal", () => {
		const graph = new IncrementalCodeGraph();
		const dependencyRevision = revision("dependency");
		graph.upsertFile({
			path: "src/dependency.ts",
			previousRevision: null,
			revision: dependencyRevision,
			extraction: extraction([{ id: "dependency" }]),
		});
		graph.upsertFile({
			path: "src/consumer.ts",
			previousRevision: null,
			revision: revision("consumer"),
			extraction: extraction(
				[{ id: "consumer" }],
				[{ id: "consumer-dependency", from: "consumer", to: "dependency" }],
			),
		});

		graph.removeFile({ path: "src/dependency.ts", previousRevision: dependencyRevision });
		expect(graph.getNode("dependency")).toBeUndefined();
		expect(graph.findImpactPaths(["dependency"]).paths).toEqual([
			{ nodeIds: ["dependency", "consumer"], edgeIds: ["consumer-dependency"] },
		]);
	});

	it("delegates parsing to an explicit extractor", async () => {
		const graph = new IncrementalCodeGraph();
		const fileRevision = revision("source");
		const extractor = {
			extract: vi.fn((input: { symbol: string }, file: { path: string; revision: string }) => {
				expect(file).toEqual({ path: "src/a.ts", revision: fileRevision });
				return extraction([{ id: input.symbol }]);
			}),
		};

		await graph.extractAndUpsert(
			{ path: "src/a.ts", previousRevision: null, revision: fileRevision },
			{ symbol: "a" },
			extractor,
		);
		expect(extractor.extract).toHaveBeenCalledOnce();
		expect(graph.getNode("a")).toBeDefined();
	});

	it("rejects malformed extractor and query inputs at the runtime boundary", async () => {
		const graph = new IncrementalCodeGraph();
		const file = { path: "src/a.ts", previousRevision: null, revision: revision("a") };

		await expect(
			graph.extractAndUpsert(file, undefined, null as unknown as { extract: () => CodeGraphExtraction }),
		).rejects.toMatchObject({ code: "invalid_update" });
		expect(() => graph.findImpactPaths(null as unknown as readonly string[])).toThrowError(
			expect.objectContaining({ code: "invalid_query" }),
		);
		expect(() => graph.findForwardDependencies("a", { edgeKinds: "depends_on" as unknown as string[] })).toThrowError(
			expect.objectContaining({ code: "invalid_query" }),
		);
	});

	it("rejects an extractor result that became stale while parsing", async () => {
		const graph = new IncrementalCodeGraph();
		const extractedRevision = revision("extracted");
		let finishExtraction: ((value: CodeGraphExtraction) => void) | undefined;
		const pendingExtraction = graph.extractAndUpsert(
			{ path: "src/a.ts", previousRevision: null, revision: extractedRevision },
			undefined,
			{
				extract: () =>
					new Promise<CodeGraphExtraction>((resolve) => {
						finishExtraction = resolve;
					}),
			},
		);
		const interveningRevision = revision("intervening");
		graph.upsertFile({
			path: "src/a.ts",
			previousRevision: null,
			revision: interveningRevision,
			extraction: extraction([{ id: "intervening" }]),
		});
		finishExtraction?.(extraction([{ id: "stale" }]));

		await expect(pendingExtraction).rejects.toMatchObject({ code: "stale_update" });
		expect(graph.getFileRevision("src/a.ts")).toBe(interveningRevision);
		expect(graph.getNode("stale")).toBeUndefined();
	});

	it("rejects malformed restored state", () => {
		expect(() => IncrementalCodeGraph.fromJSON("{not-json}")).toThrowError(
			expect.objectContaining({ code: "invalid_snapshot" }),
		);
		expect(() =>
			IncrementalCodeGraph.restore({
				version: 1,
				generation: 0,
				files: [{ path: "src/a.ts", revision: revision("a") }],
				nodes: [{ id: "a", kind: "symbol", name: "a", filePath: "src/a.ts" }],
				edges: [{ id: "bad", kind: "depends_on", from: "missing", to: "a", filePath: "src/a.ts" }],
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_snapshot" }));
		expect(() =>
			IncrementalCodeGraph.restore({
				version: 1,
				generation: 0,
				files: [{ path: "src/..", revision: revision("a") }],
				nodes: [],
				edges: [],
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_snapshot" }));
	});

	it("returns defensive copies and reports query truncation", () => {
		const graph = new IncrementalCodeGraph();
		graph.upsertFile({
			path: "src/a.ts",
			previousRevision: null,
			revision: revision("a"),
			extraction: {
				nodes: [
					{ id: "a", kind: "symbol", name: "a", attributes: { visibility: "public" } },
					{ id: "b", kind: "symbol", name: "b" },
					{ id: "c", kind: "symbol", name: "c" },
				],
				edges: [
					{ id: "a-b", kind: "depends_on", from: "a", to: "b" },
					{ id: "a-c", kind: "depends_on", from: "a", to: "c" },
				],
			},
		});

		const snapshot = graph.snapshot();
		snapshot.nodes[0].name = "mutated";
		expect(graph.getNode("a")?.name).toBe("a");
		expect(graph.findForwardDependencies("a", { maxPaths: 1 })).toEqual({
			paths: [{ nodeIds: ["a", "b"], edgeIds: ["a-b"] }],
			truncated: true,
		});
		expect(() => graph.findForwardDependencies("a", { maxDepth: 0 })).toThrowError(CodeGraphError);
		expect(() => graph.findForwardDependencies("a", { maxDepth: 65 })).toThrowError(/must not exceed 64/);
		expect(() => graph.findForwardDependencies("a", { maxPaths: 10_001 })).toThrowError(/must not exceed 10000/);
	});

	it("normalizes portable file paths and fails atomically when generation is exhausted", () => {
		const exhausted = IncrementalCodeGraph.restore({
			version: 1,
			generation: Number.MAX_SAFE_INTEGER,
			files: [],
			nodes: [],
			edges: [],
		});
		expect(() =>
			exhausted.upsertFile({
				path: "src/./nested/../a.ts",
				previousRevision: null,
				revision: revision("a"),
				extraction: extraction([{ id: "a" }]),
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_update" }));
		expect(exhausted.snapshot()).toEqual({
			version: 1,
			generation: Number.MAX_SAFE_INTEGER,
			files: [],
			nodes: [],
			edges: [],
		});

		const graph = new IncrementalCodeGraph();
		graph.upsertFile({
			path: "src/./nested/../a.ts",
			previousRevision: null,
			revision: revision("a"),
			extraction: extraction([{ id: "a" }]),
		});
		expect(graph.getFileRevision("src/a.ts")).toBe(revision("a"));
	});

	it("preserves prototype-named attributes as inert snapshot data", () => {
		const graph = new IncrementalCodeGraph();
		const attributes = JSON.parse('{"__proto__":"data","constructor":"also-data"}') as Record<string, string>;
		graph.upsertFile({
			path: "src/a.ts",
			previousRevision: null,
			revision: revision("a"),
			extraction: {
				nodes: [{ id: "a", kind: "symbol", name: "a", attributes }],
				edges: [],
			},
		});

		const restored = IncrementalCodeGraph.fromJSON(graph.toJSON());
		const restoredAttributes = restored.getNode("a")?.attributes;
		expect(Object.hasOwn(restoredAttributes ?? {}, "__proto__")).toBe(true);
		expect(restoredAttributes?.__proto__).toBe("data");
		expect(restoredAttributes?.constructor).toBe("also-data");
		expect(Object.getPrototypeOf({})).toBe(Object.prototype);
	});
});
