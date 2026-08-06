import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewablePatchStack } from "../src/core/reviewable-patch-stack.ts";
import { WorkspaceOverlay } from "../src/core/workspace-overlay.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-patch-stack-workspace-"));
	const overlayRoot = await mkdtemp(join(tmpdir(), "pi-patch-stack-overlay-"));
	temporaryDirectories.push(workspaceRoot, overlayRoot);
	await writeFile(join(workspaceRoot, "tracked.txt"), "base\n");
	const { overlay } = await WorkspaceOverlay.open({ workspaceRoot, overlayRoot });
	let id = 0;
	let tick = 0;
	const stack = new ReviewablePatchStack({
		id: "stack-1",
		overlayId: overlay.getId(),
		baseSnapshotId: overlay.getBaseSnapshotId(),
		createId: () => `layer-${++id}`,
		now: () => new Date(Date.parse("2026-07-30T00:00:00.000Z") + tick++ * 1_000).toISOString(),
	});
	return { overlay, stack, workspaceRoot };
}

describe("reviewable patch stack", () => {
	it("captures cumulative checkpoints, requires review, and delegates atomic apply to the overlay", async () => {
		const { overlay, stack, workspaceRoot } = await fixture();
		await writeFile(join(overlay.getWorkingDirectory(), "tracked.txt"), "first\n");
		const first = stack.capture(await overlay.createPatchSet(), { title: "Implementation" });
		expect(first).toMatchObject({ id: "layer-1", status: "pending" });

		await writeFile(join(overlay.getWorkingDirectory(), "tracked.txt"), "second\n");
		const second = stack.capture(await overlay.createPatchSet(), {
			title: "Verification repair",
			summary: "Adjusted the implementation after a failed check",
		});
		expect(second).toMatchObject({ id: "layer-2", status: "pending" });
		expect(stack.capture(await overlay.createPatchSet(), { title: "Duplicate" })).toBeUndefined();
		expect(() => stack.getApprovedPatchSet()).toThrow("has not been approved");

		stack.review("layer-1", "approved", stack.snapshot().revision, "Reviewed first checkpoint");
		stack.review("layer-2", "approved", stack.snapshot().revision);
		const result = await stack.apply(overlay, stack.snapshot().revision);

		expect(result.appliedPaths).toEqual(["tracked.txt"]);
		expect(await readFile(join(workspaceRoot, "tracked.txt"), "utf8")).toBe("second\n");
		expect(stack.snapshot()).toMatchObject({
			state: "applied",
			apply: { patchSetId: expect.any(String), appliedPaths: ["tracked.txt"] },
		});
	});

	it("fails closed on revision conflicts and rejected layers", async () => {
		const { overlay, stack } = await fixture();
		await writeFile(join(overlay.getWorkingDirectory(), "tracked.txt"), "change\n");
		stack.capture(await overlay.createPatchSet(), { title: "Unsafe change" });

		expect(() => stack.review("layer-1", "approved", 0)).toThrow("revision conflict");
		stack.review("layer-1", "rejected", stack.snapshot().revision, "Requires redesign");
		expect(() => stack.getApprovedPatchSet()).toThrow("was rejected");
	});

	it("locks review state while an approved PatchSet is being applied", async () => {
		const { overlay, stack } = await fixture();
		await writeFile(join(overlay.getWorkingDirectory(), "tracked.txt"), "change\n");
		stack.capture(await overlay.createPatchSet(), { title: "Approved change" });
		stack.approveAll(stack.snapshot().revision);

		let releaseApply: (() => void) | undefined;
		const applyReleased = new Promise<void>((resolve) => {
			releaseApply = resolve;
		});
		const originalApply = overlay.applyPatchSet.bind(overlay);
		vi.spyOn(overlay, "applyPatchSet").mockImplementation(async (patchSet, options) => {
			await applyReleased;
			return originalApply(patchSet, options);
		});

		const applying = stack.apply(overlay, stack.snapshot().revision);
		expect(() =>
			stack.capture(stack.getApprovedPatchSet(), {
				title: "Concurrent checkpoint",
			}),
		).toThrow("being applied");
		expect(() => stack.approveAll(stack.snapshot().revision)).toThrow("being applied");

		releaseApply?.();
		await expect(applying).resolves.toMatchObject({ state: "applied" });
	});

	it("rejects duplicate generated layer identifiers", async () => {
		const { overlay } = await fixture();
		const stack = new ReviewablePatchStack({
			id: "stack-duplicate-id",
			overlayId: overlay.getId(),
			baseSnapshotId: overlay.getBaseSnapshotId(),
			createId: () => "same-layer",
		});
		await writeFile(join(overlay.getWorkingDirectory(), "tracked.txt"), "first\n");
		stack.capture(await overlay.createPatchSet(), { title: "First" });
		await writeFile(join(overlay.getWorkingDirectory(), "tracked.txt"), "second\n");
		const second = await overlay.createPatchSet();

		expect(() => stack.capture(second, { title: "Second" })).toThrow("Patch layer id already exists");
	});
});
