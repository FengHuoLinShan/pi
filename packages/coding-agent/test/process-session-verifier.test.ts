import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHarness,
	COMPLETION_CONTRACT_VERSION,
	executeVerifiedRun,
	InMemorySessionStorage,
	Session,
	VERIFIED_RUN_SPEC_VERSION,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ArtifactRef, ArtifactStore } from "../src/core/artifact-store.ts";
import { ProcessSessionManager } from "../src/core/process-session.ts";
import { createProcessSessionCompletionVerifier } from "../src/core/process-session-verifier.ts";

const tempDirectories: string[] = [];
let providerId = 0;

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-process-verifier-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createHarness(): AgentHarness {
	const models = createModels();
	const provider = fauxProvider({ provider: `process-verifier-${++providerId}` });
	provider.setResponses([() => fauxAssistantMessage("implementation complete")]);
	models.setProvider(provider.provider);
	return new AgentHarness({
		models,
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: new Session(new InMemorySessionStorage()),
		model: provider.getModel(),
	});
}

async function createStores(directory: string): Promise<{
	artifactStore: ArtifactStore;
	processManager: ProcessSessionManager;
}> {
	const artifactStore = (await ArtifactStore.open({ root: join(directory, "artifacts"), allowedRoots: [directory] }))
		.store;
	const processManager = (
		await ProcessSessionManager.open({
			root: join(directory, "processes"),
			allowedRoots: [directory],
			artifactStore,
			defaultCwd: directory,
		})
	).manager;
	return { artifactStore, processManager };
}

function verifiedRunSpec() {
	return {
		version: VERIFIED_RUN_SPEC_VERSION,
		id: "process-backed-verification",
		prompt: "Implement the requested change",
		completionContract: {
			version: COMPLETION_CONTRACT_VERSION,
			id: "verified",
			objective: "Focused command succeeds",
			conditions: [{ id: "focused-test", description: "Focused test passes", verifierIds: ["focused-test"] }],
		},
	};
}

describe("process-session completion verifier", () => {
	it("connects Verified Run to artifact-backed process evidence without embedding output", async () => {
		const directory = await createTempDirectory();
		const { artifactStore, processManager } = await createStores(directory);
		const environmentSecret = "private-verifier-environment-value";
		const verifier = createProcessSessionCompletionVerifier({
			id: "focused-test",
			manager: processManager,
			command: process.execPath,
			args: ["-e", "process.stdout.write('focused-test-output')"],
			env: { ...process.env, PROCESS_VERIFIER_SECRET: environmentSecret },
		});

		const report = await executeVerifiedRun(createHarness(), verifiedRunSpec(), {
			context: undefined,
			verifiers: [verifier],
		});

		expect(report.status).toBe("passed");
		const evidence = report.completion?.conditions[0]?.verifiers[0]?.evidence ?? [];
		expect(evidence.find((item) => item.kind === "process")).toMatchObject({
			kind: "process",
			data: { state: "exited", exitCode: 0 },
		});
		const artifactEvidence = evidence.find((item) => item.kind === "artifact");
		expect(artifactEvidence?.reference).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect((await artifactStore.read(artifactEvidence?.reference as ArtifactRef)).toString()).toBe(
			"focused-test-output",
		);
		expect(JSON.stringify(report)).not.toContain("focused-test-output");
		expect(JSON.stringify(report)).not.toContain(environmentSecret);
		const processRecord = processManager.list()[0];
		expect(processRecord).toBeDefined();
		expect(JSON.stringify(processRecord)).not.toContain(environmentSecret);
		expect(JSON.stringify(processManager.getEvents(processRecord!.id))).not.toContain(environmentSecret);
	});

	it("returns failed with opaque stderr evidence for an unexpected exit code", async () => {
		const directory = await createTempDirectory();
		const { processManager } = await createStores(directory);
		const verifier = createProcessSessionCompletionVerifier({
			id: "focused-test",
			manager: processManager,
			command: process.execPath,
			args: ["-e", "process.stderr.write('private failure detail'); process.exit(2)"],
		});

		const report = await executeVerifiedRun(createHarness(), verifiedRunSpec(), {
			context: undefined,
			verifiers: [verifier],
		});

		expect(report.status).toBe("failed");
		expect(report.completion?.status).toBe("fail");
		expect(report.completion?.conditions[0]?.verifiers[0]).toMatchObject({
			status: "fail",
			summary: "Process exited with unexpected code 2",
		});
		expect(JSON.stringify(report)).not.toContain("private failure detail");
	});

	it("terminates the foreground process when verification is aborted", async () => {
		const directory = await createTempDirectory();
		const { processManager } = await createStores(directory);
		const verifier = createProcessSessionCompletionVerifier({
			id: "focused-test",
			manager: processManager,
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
		});
		const controller = new AbortController();
		const unsubscribe = processManager.subscribe((_record, event) => {
			if (event.type === "process_started") controller.abort();
		});
		const contract = verifiedRunSpec().completionContract;

		try {
			const outcome = await verifier.verify(
				{ contract, condition: contract.conditions[0]!, context: undefined },
				controller.signal,
			);

			expect(outcome).toMatchObject({ status: "blocked", summary: "Process verification was interrupted" });
			await processManager.flush();
			expect(processManager.list()).toEqual([
				expect.objectContaining({ state: "terminated", exit: expect.objectContaining({ exitCode: null }) }),
			]);
		} finally {
			unsubscribe();
		}
	});
});
