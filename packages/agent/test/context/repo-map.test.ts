import { describe, expect, it } from "vitest";
import { buildRepoMap, type RepoMapFile } from "../../src/context/repo-map.ts";

const files: RepoMapFile[] = [
	{
		path: "src/worker.ts",
		language: "TypeScript",
		hash: "sha256:worker",
		summary: "Runs queued work",
		priority: 20,
		imports: ["./queue.ts", "./api.ts"],
		symbols: [
			{ name: "run", kind: "function", line: 20, exported: true, signature: "run(job: Job): Promise<void>" },
			{ name: "Worker", kind: "class", line: 5, exported: true },
		],
		evidenceIds: ["ev-worker"],
	},
	{
		path: "src/queue.ts",
		language: "TypeScript",
		summary: "Queue implementation with substantial internal detail ".repeat(20),
		priority: 5,
		symbols: [{ name: "Queue", kind: "class", line: 1, exported: true }],
	},
];

describe("repo map", () => {
	it("builds a stable map from caller-provided facts", () => {
		const forward = buildRepoMap({ root: "workspace", tokenBudget: 220, files });
		const reverse = buildRepoMap({ root: "workspace", tokenBudget: 220, files: [...files].reverse() });

		expect(reverse).toEqual(forward);
		expect(forward.text).toContain("repository: workspace");
		expect(forward.text).toContain("file: src/worker.ts");
		expect(forward.text.indexOf("./api.ts")).toBeLessThan(forward.text.indexOf("./queue.ts"));
		expect(forward.text.indexOf("class Worker @5")).toBeLessThan(forward.text.indexOf("function run @20"));
		expect(forward.files).toContainEqual(
			expect.objectContaining({ path: "src/worker.ts", evidenceIds: ["ev-worker"] }),
		);
		expect(JSON.parse(JSON.stringify(forward))).toEqual(forward);
	});

	it("admits higher-priority files first and reports budget omissions", () => {
		const result = buildRepoMap({ root: "workspace", tokenBudget: 90, files });

		expect(result.estimatedTokens).toBeLessThanOrEqual(90);
		expect(result.files.map((file) => file.path)).toContain("src/worker.ts");
		expect(result.omittedFiles).toContain("src/queue.ts");
	});

	it("rejects duplicate file paths instead of depending on input order", () => {
		expect(() => buildRepoMap({ tokenBudget: 100, files: [files[0], files[0]] })).toThrow(
			"Duplicate repository file path",
		);
	});
});
