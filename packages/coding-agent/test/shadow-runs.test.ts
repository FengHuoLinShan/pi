import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPLETION_CONTRACT_VERSION, type CompletionVerifier } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	discardShadowRunOverlays,
	rankShadowRuns,
	runShadowCandidates,
	type ShadowRunVerificationContext,
} from "../src/core/shadow-runs.ts";
import { WorkspaceOverlay } from "../src/core/workspace-overlay.ts";

const tempRoots: string[] = [];

function createTempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-shadow-runs-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

interface CandidateConfig {
	content: string;
	quality: number;
}

describe("shadow runs", () => {
	it("runs candidates on comparable isolated snapshots without changing the base", async () => {
		const workspace = createTempDir();
		writeFileSync(join(workspace, "answer.txt"), "base");
		const report = await runShadowCandidates({
			workspaceRoot: workspace,
			candidates: [
				{ id: "a", config: { content: "candidate-a", quality: 1 } },
				{ id: "b", config: { content: "candidate-b", quality: 2 } },
			],
			run: async ({ candidate, overlay }) => {
				writeFileSync(join(overlay.getWorkingDirectory(), "answer.txt"), candidate.config.content);
				return { quality: candidate.config.quality };
			},
		});

		try {
			expect(report.status).toBe("completed");
			expect(report.execution).toBe("sequential");
			expect(new Set(report.runs.map((run) => run.overlay.getBaseSnapshotId()))).toEqual(
				new Set([report.baseSnapshotId]),
			);
			expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("base");
			expect(report.runs.map((run) => run.patchSet?.entries[0]?.afterContent?.toString())).toEqual([
				"candidate-a",
				"candidate-b",
			]);
		} finally {
			await discardShadowRunOverlays(report);
		}
	});

	it("verifies, ranks, and excludes candidates without applying a winner", async () => {
		const workspace = createTempDir();
		writeFileSync(join(workspace, "answer.txt"), "base");
		type Output = { quality: number };
		const verifier: CompletionVerifier<ShadowRunVerificationContext<CandidateConfig, Output>> = {
			id: "quality-gate",
			verify: ({ context }) => ({
				status: context.output.quality > 0 ? "pass" : "fail",
				summary: context.output.quality > 0 ? "Quality passed" : "Quality failed",
			}),
		};
		const report = await runShadowCandidates<CandidateConfig, Output>({
			workspaceRoot: workspace,
			candidates: [
				{ id: "low", config: { content: "low", quality: 1 } },
				{ id: "high", config: { content: "high", quality: 3 } },
				{ id: "invalid", config: { content: "invalid", quality: 0 } },
			],
			execution: "parallel",
			run: async ({ candidate, overlay }) => {
				writeFileSync(join(overlay.getWorkingDirectory(), "answer.txt"), candidate.config.content);
				return { quality: candidate.config.quality };
			},
			completion: {
				contract: {
					version: COMPLETION_CONTRACT_VERSION,
					id: "quality",
					objective: "Produce a valid candidate",
					conditions: [{ id: "gate", description: "Quality gate", verifierIds: ["quality-gate"] }],
				},
				verifiers: [verifier],
			},
		});

		try {
			const ranking = await rankShadowRuns(report, (run) => ({
				score: run.output!.quality,
				summary: `quality ${run.output!.quality}`,
			}));
			expect(report.execution).toBe("parallel");
			expect(ranking.selectedCandidateId).toBe("high");
			expect(ranking.ranked.map((candidate) => candidate.candidateId)).toEqual(["high", "low"]);
			expect(ranking.excluded).toEqual([{ candidateId: "invalid", reason: "completion_not_passed" }]);
			expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("base");
		} finally {
			await discardShadowRunOverlays(report);
		}
	});

	it("isolates candidate failures and retains their partial patch for inspection", async () => {
		const workspace = createTempDir();
		writeFileSync(join(workspace, "answer.txt"), "base");
		const report = await runShadowCandidates({
			workspaceRoot: workspace,
			candidates: [
				{ id: "fails", config: { content: "partial", quality: 0 } },
				{ id: "works", config: { content: "complete", quality: 1 } },
			],
			run: async ({ candidate, overlay }) => {
				writeFileSync(join(overlay.getWorkingDirectory(), "answer.txt"), candidate.config.content);
				if (candidate.id === "fails") throw new TypeError("candidate failed");
				return candidate.config.quality;
			},
		});

		try {
			expect(report.status).toBe("partial");
			expect(report.runs[0]).toMatchObject({
				status: "failed",
				error: { name: "TypeError", message: "candidate failed" },
			});
			expect(report.runs[0]?.patchSet?.entries[0]?.afterContent?.toString()).toBe("partial");
			expect(report.runs[1]?.status).toBe("completed");
		} finally {
			const roots = report.runs.map((run) => run.overlay.getRoot());
			await discardShadowRunOverlays(report);
			expect(roots.every((root) => !existsSync(root))).toBe(true);
		}
	});

	it("rejects duplicate candidates before creating overlays", async () => {
		const workspace = createTempDir();
		await expect(
			runShadowCandidates({
				workspaceRoot: workspace,
				candidates: [
					{ id: "same", config: 1 },
					{ id: "same", config: 2 },
				],
				run: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "invalid_options" });
	});

	it("rejects a caller-supplied candidate root that already contains a modified overlay", async () => {
		const workspace = createTempDir();
		writeFileSync(join(workspace, "answer.txt"), "base");
		const overlayRoot = join(createTempDir(), "candidate");
		const existing = await WorkspaceOverlay.open({ workspaceRoot: workspace, overlayRoot });
		writeFileSync(join(existing.overlay.getWorkingDirectory(), "answer.txt"), "staged");

		try {
			await expect(
				runShadowCandidates({
					workspaceRoot: workspace,
					candidates: [{ id: "reused", config: 1 }],
					overlay: { rootForCandidate: () => overlayRoot },
					run: async () => undefined,
				}),
			).rejects.toMatchObject({ code: "invalid_options" });
			expect(readFileSync(join(existing.overlay.getWorkingDirectory(), "answer.txt"), "utf8")).toBe("staged");
		} finally {
			await existing.overlay.discard();
		}
	});

	it("rejects overlapping caller-supplied candidate roots", async () => {
		const workspace = createTempDir();
		writeFileSync(join(workspace, "answer.txt"), "base");
		const holder = createTempDir();
		const firstRoot = join(holder, "candidate");
		const nestedRoot = join(firstRoot, "nested");

		await expect(
			runShadowCandidates({
				workspaceRoot: workspace,
				candidates: [
					{ id: "outer", config: 1 },
					{ id: "inner", config: 2 },
				],
				overlay: { rootForCandidate: (candidate) => (candidate.id === "outer" ? firstRoot : nestedRoot) },
				run: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "invalid_options" });
		expect(existsSync(firstRoot)).toBe(false);
	});

	it("waits for explicit parallel fail-fast runs before cleaning every overlay", async () => {
		const workspace = createTempDir();
		writeFileSync(join(workspace, "answer.txt"), "base");
		const roots = [join(createTempDir(), "a"), join(createTempDir(), "b")];
		await expect(
			runShadowCandidates({
				workspaceRoot: workspace,
				candidates: [
					{ id: "a", config: 1 },
					{ id: "b", config: 2 },
				],
				execution: "parallel",
				errorMode: "throw",
				overlay: { rootForCandidate: (candidate) => roots[candidate.id === "a" ? 0 : 1] },
				run: async ({ candidate, overlay }) => {
					writeFileSync(join(overlay.getWorkingDirectory(), "answer.txt"), String(candidate.config));
					if (candidate.id === "a") throw new Error("stop");
				},
			}),
		).rejects.toMatchObject({ code: "run_failed" });
		expect(roots.every((root) => !existsSync(root))).toBe(true);
	});

	it("aborts parallel peers before fail-fast cleanup", async () => {
		const workspace = createTempDir();
		writeFileSync(join(workspace, "answer.txt"), "base");
		const roots = [join(createTempDir(), "a"), join(createTempDir(), "b")];
		let markPeerStarted: (() => void) | undefined;
		const peerStarted = new Promise<void>((resolve) => {
			markPeerStarted = resolve;
		});
		let peerObservedAbort = false;

		await expect(
			runShadowCandidates({
				workspaceRoot: workspace,
				candidates: [
					{ id: "fails", config: 1 },
					{ id: "peer", config: 2 },
				],
				execution: "parallel",
				errorMode: "throw",
				overlay: { rootForCandidate: (candidate) => roots[candidate.id === "fails" ? 0 : 1] },
				run: async ({ candidate, signal }) => {
					if (candidate.id === "fails") {
						await peerStarted;
						throw new Error("fail fast");
					}
					markPeerStarted?.();
					await new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								peerObservedAbort = true;
								resolve();
							},
							{ once: true },
						);
					});
				},
			}),
		).rejects.toMatchObject({ code: "run_failed" });
		expect(peerObservedAbort).toBe(true);
		expect(roots.every((root) => !existsSync(root))).toBe(true);
	});
});
