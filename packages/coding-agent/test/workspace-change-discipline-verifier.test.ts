import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHarness,
	COMPLETION_CONTRACT_VERSION,
	type CompletionContract,
	executeVerifiedRun,
	InMemorySessionStorage,
	Session,
	serializeCompletionReport,
	VERIFIED_RUN_SPEC_VERSION,
	type VerifiedRunVerificationContext,
	verifyCompletionContract,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	discardShadowRunOverlays,
	rankShadowRuns,
	runShadowCandidates,
	type ShadowRunVerificationContext,
} from "../src/core/shadow-runs.ts";
import {
	createWorkspaceChangeDisciplineVerifier,
	evaluateWorkspaceChangeDiscipline,
	WorkspaceOverlay,
	type WorkspacePatchSet,
	type WorkspacePatchSetEntry,
} from "../src/index.ts";

const tempRoots: string[] = [];
const baseSnapshotId = `sha256:${"0".repeat(64)}`;

function revision(content: Buffer | string): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function createEntry(path: string, content: string, mode = 0o644): WorkspacePatchSetEntry {
	const afterContent = Buffer.from(content);
	return {
		kind: "create",
		path,
		beforeRevision: "missing",
		afterRevision: revision(afterContent),
		afterByteLength: afterContent.length,
		afterMode: mode,
		afterContent,
	};
}

function updateEntry(
	path: string,
	before: string,
	after: string,
	beforeMode = 0o644,
	afterMode = beforeMode,
): WorkspacePatchSetEntry {
	const afterContent = Buffer.from(after);
	return {
		kind: "update",
		path,
		beforeRevision: revision(before),
		afterRevision: revision(afterContent),
		beforeByteLength: Buffer.byteLength(before),
		afterByteLength: afterContent.length,
		beforeMode,
		afterMode,
		afterContent,
	};
}

function modeEntry(path: string, content: string, beforeMode = 0o644, afterMode = 0o755): WorkspacePatchSetEntry {
	const afterContent = Buffer.from(content);
	const contentRevision = revision(afterContent);
	return {
		kind: "update",
		path,
		beforeRevision: contentRevision,
		afterRevision: contentRevision,
		beforeByteLength: afterContent.length,
		afterByteLength: afterContent.length,
		beforeMode,
		afterMode,
		afterContent,
	};
}

function deleteEntry(path: string, before: string, mode = 0o644): WorkspacePatchSetEntry {
	return {
		kind: "delete",
		path,
		beforeRevision: revision(before),
		afterRevision: "missing",
		beforeByteLength: Buffer.byteLength(before),
		beforeMode: mode,
	};
}

function patchSet(entries: readonly WorkspacePatchSetEntry[]): WorkspacePatchSet {
	return {
		version: 1,
		id: "patch-1",
		overlayId: "overlay-1",
		baseSnapshotId,
		createdAt: "2026-07-19T00:00:00.000Z",
		entries,
	};
}

function contract(): CompletionContract {
	return {
		version: COMPLETION_CONTRACT_VERSION,
		id: "workspace-change",
		objective: "Keep workspace changes inside the declared boundary",
		conditions: [
			{
				id: "discipline",
				description: "Workspace change discipline passes",
				verifierIds: ["workspace-discipline"],
			},
		],
	};
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe("workspace change discipline verifier", () => {
	it("applies allow, deny, and operation gates with precise mode classification", () => {
		const result = evaluateWorkspaceChangeDiscipline(
			patchSet([
				createEntry("src/generated/output.ts", "generated"),
				updateEntry("src/index.ts", "old", "new", 0o644, 0o755),
				modeEntry("scripts/run.sh", "#!/bin/sh\n"),
				deleteEntry("docs/old.md", "old docs"),
			]),
			{
				allowedPaths: ["src/**", "scripts/**"],
				deniedPaths: ["src/generated/**"],
				allowedOperations: ["create", "update"],
			},
		);

		expect(result.status).toBe("fail");
		expect(result.kindCounts).toEqual({ create: 1, update: 2, delete: 1 });
		expect(result.operationCounts).toEqual({ create: 1, update: 1, delete: 1, mode: 2 });
		expect(result.violations).toEqual([
			{ code: "operation_denied", path: "docs/old.md", operation: "delete" },
			{ code: "operation_denied", path: "scripts/run.sh", operation: "mode" },
			{ code: "operation_denied", path: "src/index.ts", operation: "mode" },
			{ code: "path_denied", path: "src/generated/output.ts" },
			{ code: "path_not_allowed", path: "docs/old.md" },
		]);
	});

	it("treats content and mode changes independently", () => {
		const modeOnly = evaluateWorkspaceChangeDiscipline(patchSet([modeEntry("bin/run", "same")]), {
			allowedOperations: ["mode"],
			maxChangedBytes: 0,
		});
		const combined = evaluateWorkspaceChangeDiscipline(
			patchSet([updateEntry("bin/run", "old", "new", 0o644, 0o755)]),
			{ allowedOperations: ["mode"] },
		);
		const create = evaluateWorkspaceChangeDiscipline(patchSet([createEntry("bin/new", "new", 0o755)]), {
			allowedOperations: ["create"],
		});

		expect(modeOnly).toMatchObject({ status: "pass", changedBytes: 0 });
		expect(combined.violations).toEqual([{ code: "operation_denied", path: "bin/run", operation: "update" }]);
		expect(create.status).toBe("pass");
		expect(create.operationCounts.mode).toBe(0);
	});

	it("uses conservative content byte accounting at exact limits", () => {
		const entries = [
			createEntry("new.txt", "123"),
			updateEntry("same-size.txt", "abcd", "wxyz"),
			updateEntry("shrunk.txt", "12345", "x"),
			deleteEntry("deleted.txt", "123456"),
			modeEntry("mode-only.txt", "large-mode-only-content"),
		];
		const exact = evaluateWorkspaceChangeDiscipline(patchSet(entries), {
			maxFiles: 5,
			maxChangedBytes: 18,
			maxFileBytes: 6,
		});
		const exceeded = evaluateWorkspaceChangeDiscipline(patchSet(entries), {
			maxFiles: 4,
			maxChangedBytes: 17,
			maxFileBytes: 5,
		});

		expect(exact).toMatchObject({ status: "pass", fileCount: 5, changedBytes: 18 });
		expect(exceeded.violations).toEqual([
			{ code: "max_changed_bytes_exceeded", actual: 18, limit: 17 },
			{ code: "max_file_bytes_exceeded", path: "deleted.txt", actual: 6, limit: 5 },
			{ code: "max_files_exceeded", actual: 5, limit: 4 },
		]);
	});

	it("enforces an explicit minimum file count at the exact boundary", () => {
		const exact = evaluateWorkspaceChangeDiscipline(
			patchSet([createEntry("one.ts", "one"), createEntry("two.ts", "two")]),
			{ minFiles: 2 },
		);
		const below = evaluateWorkspaceChangeDiscipline(patchSet([createEntry("one.ts", "one")]), {
			minFiles: 2,
		});
		const zeroWithUpperBound = evaluateWorkspaceChangeDiscipline(patchSet([]), { minFiles: 0, maxFiles: 1 });
		const zeroMaximum = evaluateWorkspaceChangeDiscipline(patchSet([]), { minFiles: 0, maxFiles: 0 });
		const zeroMaximumExceeded = evaluateWorkspaceChangeDiscipline(patchSet([createEntry("one.ts", "one")]), {
			minFiles: 0,
			maxFiles: 0,
		});

		expect(exact).toMatchObject({ status: "pass", fileCount: 2 });
		expect(below.violations).toEqual([{ code: "min_files_not_met", actual: 1, limit: 2 }]);
		expect(zeroWithUpperBound).toMatchObject({ status: "pass", fileCount: 0 });
		expect(zeroMaximum).toMatchObject({ status: "pass", fileCount: 0 });
		expect(zeroMaximumExceeded.violations).toEqual([{ code: "max_files_exceeded", actual: 1, limit: 0 }]);
	});

	it("emits only aggregate minimum-file evidence", async () => {
		const privatePath = "private/minimum.ts";
		const verifier = createWorkspaceChangeDisciplineVerifier<{ patchSet: WorkspacePatchSet }>({
			id: "workspace-discipline",
			policy: { minFiles: 2 },
			getPatchSet: (context) => context.patchSet,
		});
		const report = await verifyCompletionContract(contract(), [verifier], {
			context: { patchSet: patchSet([createEntry(privatePath, "content")]) },
		});
		const evidence = report.conditions[0]?.verifiers[0]?.evidence?.[0];

		expect(evidence?.data).toMatchObject({
			violationCount: 1,
			violations: [{ code: "min_files_not_met", actual: 1, limit: 2 }],
		});
		expect(serializeCompletionReport(report)).not.toContain(privatePath);
	});

	it("is deterministic across PatchSet entry order and treats leading ! and # as literal glob text", () => {
		const entries = [
			createEntry(".github/workflows/check.yml", "check"),
			createEntry("!literal/file.txt", "bang"),
			createEntry("#literal/file.txt", "hash"),
		];
		const policy = { allowedPaths: [".github/**", "!literal/**", "#literal/**"], maxFiles: 3 } as const;
		const forward = evaluateWorkspaceChangeDiscipline(patchSet(entries), policy);
		const reverse = evaluateWorkspaceChangeDiscipline(patchSet([...entries].reverse()), policy);

		expect(forward.status).toBe("pass");
		expect(reverse).toEqual(forward);
	});

	it("omits violating paths and file content from completion evidence by default", async () => {
		const privatePath = "private/customer-secret.ts";
		const content = "private-customer-content";
		const privatePatchSetId = "private-patch-set-id";
		const privateBaseSnapshotId = revision("private-base-snapshot");
		const input = patchSet([createEntry(privatePath, content)]);
		input.id = privatePatchSetId;
		input.baseSnapshotId = privateBaseSnapshotId;
		const verifier = createWorkspaceChangeDisciplineVerifier<{ patchSet: WorkspacePatchSet }>({
			id: "workspace-discipline",
			policy: { deniedPaths: ["private/**"] },
			getPatchSet: (context) => context.patchSet,
		});
		const report = await verifyCompletionContract(contract(), [verifier], {
			context: { patchSet: input },
		});
		const serialized = serializeCompletionReport(report);

		expect(report.status).toBe("fail");
		expect(serialized).not.toContain(privatePath);
		expect(serialized).not.toContain(content);
		expect(serialized).not.toContain(revision(content));
		expect(serialized).not.toContain(revision(privatePath));
		expect(serialized).not.toContain(privatePatchSetId);
		expect(serialized).not.toContain(privateBaseSnapshotId);
		expect(report.conditions[0]?.verifiers[0]?.evidence).toHaveLength(1);
	});

	it("includes PatchSet identity in evidence only with explicit opt-in", async () => {
		const input = patchSet([]);
		const verifier = createWorkspaceChangeDisciplineVerifier<{ patchSet: WorkspacePatchSet }>({
			id: "workspace-discipline",
			policy: { maxFiles: 1 },
			getPatchSet: (context) => context.patchSet,
			evidenceIdentityMode: "include",
		});
		const report = await verifyCompletionContract(contract(), [verifier], { context: { patchSet: input } });
		const serialized = serializeCompletionReport(report);

		expect(serialized).toContain(`workspace-patch-set:${input.id}`);
		expect(serialized).toContain(input.baseSnapshotId);
	});

	it("supports explicit digest or plain path evidence", async () => {
		const privatePath = "private/violation.ts";
		const input = patchSet([createEntry(privatePath, "content")]);
		const createVerifier = (evidencePathMode: "digest" | "plain") =>
			createWorkspaceChangeDisciplineVerifier<{ patchSet: WorkspacePatchSet }>({
				id: "workspace-discipline",
				policy: { deniedPaths: ["private/**"] },
				getPatchSet: (context) => context.patchSet,
				evidencePathMode,
			});
		const digested = await verifyCompletionContract(contract(), [createVerifier("digest")], {
			context: { patchSet: input },
		});
		const plain = await verifyCompletionContract(contract(), [createVerifier("plain")], {
			context: { patchSet: input },
		});

		expect(serializeCompletionReport(digested)).not.toContain(privatePath);
		expect(serializeCompletionReport(digested)).toContain(revision(privatePath));
		expect(serializeCompletionReport(plain)).toContain(privatePath);
	});

	it("validates and snapshots policy options before verification", async () => {
		expect(() =>
			createWorkspaceChangeDisciplineVerifier({ id: "", policy: { maxFiles: 1 }, getPatchSet: () => patchSet([]) }),
		).toThrow("id must not be empty");
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([]), {})).toThrow("requires at least one effective gate");
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([]), { deniedPaths: [] })).toThrow(
			"requires at least one effective gate",
		);
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([]), { minFiles: 0 })).toThrow(
			"requires at least one effective gate",
		);
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([]), { minFiles: -1 })).toThrow(
			"non-negative safe integer",
		);
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([]), { minFiles: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
			"non-negative safe integer",
		);
		expect(() =>
			createWorkspaceChangeDisciplineVerifier({
				id: "workspace-discipline",
				policy: { minFiles: 2, maxFiles: 1 },
				getPatchSet: () => patchSet([]),
			}),
		).toThrow("minFiles must not exceed maxFiles");
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([]), { maxFiles: -1 })).toThrow(
			"non-negative safe integer",
		);
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([]), { deniedPaths: ["../secret"] })).toThrow(
			"portable workspace-relative glob",
		);
		expect(() =>
			createWorkspaceChangeDisciplineVerifier({
				id: "workspace-discipline",
				policy: { maxFiles: 1 },
				getPatchSet: () => patchSet([]),
				evidenceIdentityMode: "invalid" as "omit",
			}),
		).toThrow("Invalid workspace change evidence identity mode");

		const deniedPaths = ["private/**"];
		const verifier = createWorkspaceChangeDisciplineVerifier<{ patchSet: WorkspacePatchSet }>({
			id: "workspace-discipline",
			policy: { deniedPaths },
			getPatchSet: (context) => context.patchSet,
		});
		deniedPaths[0] = "other/**";
		const outcome = await verifier.verify(
			{
				contract: contract(),
				condition: contract().conditions[0]!,
				context: { patchSet: patchSet([createEntry("private/a", "a")]) },
			},
			new AbortController().signal,
		);

		expect(outcome).toMatchObject({ status: "fail" });
	});

	it("rejects sparse policy and PatchSet arrays instead of skipping gates or entries", () => {
		const sparseDeniedPaths = Array<string>(1);
		expect(() =>
			evaluateWorkspaceChangeDiscipline(patchSet([createEntry("private/secret.ts", "secret")]), {
				deniedPaths: sparseDeniedPaths,
			}),
		).toThrow("deniedPaths must not contain sparse entries");

		const sparseOperations = Array<"create">(1);
		expect(() =>
			evaluateWorkspaceChangeDiscipline(patchSet([createEntry("new.ts", "new")]), {
				allowedOperations: sparseOperations,
			}),
		).toThrow("allowedOperations must not contain sparse entries");

		const sparseEntries = Array<WorkspacePatchSetEntry>(1);
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet(sparseEntries), { maxFiles: 1 })).toThrow(
			"Workspace PatchSet entries must not contain sparse entries",
		);
	});

	it("rejects same-revision updates with inconsistent byte lengths", () => {
		const entry = modeEntry("large.bin", "large unchanged content");
		entry.beforeByteLength = 0;

		expect(() =>
			evaluateWorkspaceChangeDiscipline(patchSet([entry]), {
				allowedOperations: ["mode"],
				maxChangedBytes: 0,
				maxFileBytes: 0,
			}),
		).toThrow("same revision must have the same byte length");
	});

	it("validates PatchSet fields that are not used by policy evaluation", () => {
		const missingOverlayId = { ...patchSet([]), overlayId: "" };
		const missingTimestamp = { ...patchSet([]), createdAt: "" };
		const invalidPath = createEntry("valid.ts", "content");
		Reflect.set(invalidPath, "path", 42);
		const invalidPatch = createEntry("valid.ts", "content");
		Reflect.set(invalidPatch, "patch", 42);

		expect(() => evaluateWorkspaceChangeDiscipline(missingOverlayId, { maxFiles: 1 })).toThrow(
			"overlay id must not be empty",
		);
		expect(() => evaluateWorkspaceChangeDiscipline(missingTimestamp, { maxFiles: 1 })).toThrow(
			"creation timestamp must not be empty",
		);
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([invalidPath]), { maxFiles: 1 })).toThrow(
			"has an invalid path",
		);
		expect(() => evaluateWorkspaceChangeDiscipline(patchSet([invalidPatch]), { maxFiles: 1 })).toThrow(
			"patch must be a string",
		);
	});

	it("returns blocked before resolving a PatchSet when already aborted", async () => {
		const getPatchSet = () => {
			throw new Error("must not resolve");
		};
		const verifier = createWorkspaceChangeDisciplineVerifier({
			id: "workspace-discipline",
			policy: { maxFiles: 1 },
			getPatchSet,
		});
		const controller = new AbortController();
		controller.abort();

		await expect(
			verifier.verify(
				{ contract: contract(), condition: contract().conditions[0]!, context: undefined },
				controller.signal,
			),
		).resolves.toMatchObject({ status: "blocked" });
	});

	it("supports delayed asynchronous PatchSet resolution", async () => {
		let resolvePatchSet: ((value: WorkspacePatchSet) => void) | undefined;
		const getPatchSet = vi.fn(
			(_context: { patchSet: WorkspacePatchSet }, signal: AbortSignal) =>
				new Promise<WorkspacePatchSet>((resolve) => {
					expect(signal.aborted).toBe(false);
					resolvePatchSet = resolve;
				}),
		);
		const verifier = createWorkspaceChangeDisciplineVerifier({
			id: "workspace-discipline",
			policy: { minFiles: 1 },
			getPatchSet,
		});
		const input = patchSet([createEntry("src/async.ts", "async")]);
		const pending = verifier.verify(
			{ contract: contract(), condition: contract().conditions[0]!, context: { patchSet: input } },
			new AbortController().signal,
		);

		expect(getPatchSet).toHaveBeenCalledOnce();
		resolvePatchSet?.(input);
		await expect(pending).resolves.toMatchObject({ status: "pass" });
	});

	it("returns blocked without evaluation or evidence when aborted during PatchSet resolution", async () => {
		let rejectPatchSet: ((error: Error) => void) | undefined;
		const controller = new AbortController();
		const verifier = createWorkspaceChangeDisciplineVerifier({
			id: "workspace-discipline",
			policy: { maxFiles: 1 },
			getPatchSet: (_context: undefined, signal) =>
				new Promise<WorkspacePatchSet>((_resolve, reject) => {
					expect(signal).toBe(controller.signal);
					rejectPatchSet = reject;
				}),
		});
		const pending = verifier.verify(
			{ contract: contract(), condition: contract().conditions[0]!, context: undefined },
			controller.signal,
		);

		controller.abort();
		const outcome = await pending;
		rejectPatchSet?.(new Error("late PatchSet capture rejection"));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(outcome).toEqual({
			status: "blocked",
			summary: "Workspace change discipline verification was interrupted",
		});
		expect(outcome).not.toHaveProperty("evidence");
	});

	it("lets the completion runner isolate asynchronous resolver rejection as an error", async () => {
		const verifier = createWorkspaceChangeDisciplineVerifier({
			id: "workspace-discipline",
			policy: { maxFiles: 1 },
			getPatchSet: async () => {
				throw new Error("PatchSet capture failed");
			},
		});
		const report = await verifyCompletionContract(contract(), [verifier], { context: undefined });

		expect(report.status).toBe("error");
		expect(report.conditions[0]?.verifiers[0]).toMatchObject({
			status: "error",
			error: { name: "Error", message: "PatchSet capture failed" },
		});
	});

	it("keeps one-argument synchronous PatchSet resolvers compatible", async () => {
		const input = patchSet([]);
		const getPatchSet = vi.fn((context: { patchSet: WorkspacePatchSet }) => context.patchSet);
		const verifier = createWorkspaceChangeDisciplineVerifier({
			id: "workspace-discipline",
			policy: { maxFiles: 1 },
			getPatchSet,
		});
		const report = await verifyCompletionContract(contract(), [verifier], { context: { patchSet: input } });

		expect(report.status).toBe("pass");
		expect(getPatchSet).toHaveBeenCalledOnce();
	});

	it("captures the final Overlay PatchSet from a Verified Run context", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-workspace-discipline-verified-run-"));
		tempRoots.push(workspace);
		writeFileSync(join(workspace, "answer.txt"), "base");
		const { overlay } = await WorkspaceOverlay.open({ workspaceRoot: workspace });
		const models = createModels();
		const provider = fauxProvider({ provider: "workspace-discipline-verified-run" });
		provider.setResponses([
			() => {
				writeFileSync(join(overlay.getWorkingDirectory(), "answer.txt"), "verified change");
				return fauxAssistantMessage("implemented");
			},
		]);
		models.setProvider(provider.provider);
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: workspace }),
			session: new Session(new InMemorySessionStorage()),
			model: provider.getModel(),
		});
		const verifier = createWorkspaceChangeDisciplineVerifier<
			VerifiedRunVerificationContext<{ overlay: WorkspaceOverlay }>
		>({
			id: "workspace-discipline",
			policy: { minFiles: 1, maxFiles: 1 },
			getPatchSet: async ({ context, finalMessage }, signal) => {
				expect(finalMessage.content[0]).toMatchObject({ type: "text", text: "implemented" });
				expect(signal.aborted).toBe(false);
				return context.overlay.createPatchSet();
			},
		});

		try {
			const report = await executeVerifiedRun(
				harness,
				{
					version: VERIFIED_RUN_SPEC_VERSION,
					id: "verified-workspace-change",
					prompt: "Implement the workspace change",
					completionContract: contract(),
				},
				{ context: { overlay }, verifiers: [verifier] },
			);

			expect(report.status).toBe("passed");
			expect(report.completion?.conditions[0]?.verifiers[0]?.evidence?.[0]?.data).toMatchObject({
				fileCount: 1,
			});
			expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("base");
			expect(overlay.getState()).toBe("active");
		} finally {
			await overlay.discard();
		}
	});

	it("gates Shadow Run ranking without applying or discarding overlays", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-workspace-discipline-"));
		tempRoots.push(workspace);
		writeFileSync(join(workspace, "answer.txt"), "base");
		type Config = { path: string; quality: number };
		type Output = { quality: number };
		const verifier = createWorkspaceChangeDisciplineVerifier<ShadowRunVerificationContext<Config, Output>>({
			id: "workspace-discipline",
			policy: { deniedPaths: ["private/**"] },
			getPatchSet: (context) => context.patchSet,
		});
		const report = await runShadowCandidates<Config, Output>({
			workspaceRoot: workspace,
			candidates: [
				{ id: "allowed", config: { path: "answer.txt", quality: 1 } },
				{ id: "denied", config: { path: "private/secret.txt", quality: 2 } },
			],
			run: async ({ candidate, overlay }) => {
				const target = join(overlay.getWorkingDirectory(), candidate.config.path);
				if (candidate.id === "denied") {
					const privateDirectory = join(overlay.getWorkingDirectory(), "private");
					mkdirSync(privateDirectory);
				}
				writeFileSync(target, candidate.id);
				return { quality: candidate.config.quality };
			},
			completion: { contract: contract(), verifiers: [verifier] },
		});

		try {
			const ranking = await rankShadowRuns(report, (run) => ({
				score: run.output!.quality,
				summary: `quality ${run.output!.quality}`,
			}));
			expect(ranking.selectedCandidateId).toBe("allowed");
			expect(ranking.excluded).toEqual([{ candidateId: "denied", reason: "completion_not_passed" }]);
			expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("base");
			expect(report.runs.every((run) => run.overlay.getState() === "active")).toBe(true);
			expect(report.runs.every((run) => existsSync(run.overlay.getRoot()))).toBe(true);
			const deniedEvidence = serializeCompletionReport(report.runs[1]!.completion!);
			expect(deniedEvidence).not.toContain("private/secret.txt");
		} finally {
			await discardShadowRunOverlays(report);
		}
	});
});
