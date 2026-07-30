import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openTypeScriptCodeGraph } from "../src/service.ts";

it.runIf(process.env.RUN_PI_CODEGRAPH_BENCHMARK === "1")(
	"meets the Pi repository indexing and cached-query budgets",
	async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "pi-codegraph-benchmark-"));
		try {
			const graph = await openTypeScriptCodeGraph({
				workspaceRoot: resolve(import.meta.dirname, "../../.."),
				cacheDir,
			});
			const initial = await graph.sync();
			const explicitWarmSync = await graph.sync();
			const queryStartedAt = performance.now();
			const status = graph.status();
			if (status.dirty || (status.state !== "ready" && status.state !== "degraded")) await graph.sync();
			const matches = graph.search("AgentSession");
			const cachedQueryMs = performance.now() - queryStartedAt;

			console.log(
				JSON.stringify({
					files: initial.status.fileCount,
					nodes: initial.status.nodeCount,
					edges: initial.status.edgeCount,
					initialMs: Math.round(initial.durationMs),
					explicitWarmSyncMs: Math.round(explicitWarmSync.durationMs),
					cachedQueryMs: Math.round(cachedQueryMs),
				}),
			);

			expect(matches[0]?.node.name).toBe("AgentSession");
			expect(initial.durationMs).toBeLessThan(30_000);
			expect(explicitWarmSync.durationMs).toBeLessThan(10_000);
			expect(cachedQueryMs).toBeLessThan(1_000);
			await graph.dispose();
		} finally {
			await rm(cacheDir, { recursive: true, force: true });
		}
	},
	45_000,
);
