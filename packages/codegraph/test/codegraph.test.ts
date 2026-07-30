import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CodeGraphSnapshot,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import codeGraphExtension from "../src/extension.ts";
import { openTypeScriptCodeGraph, type TypeScriptCodeGraph } from "../src/service.ts";

const temporaryDirectories: string[] = [];

async function createFixture(): Promise<{ workspaceRoot: string; cacheDir: string }> {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-codegraph-workspace-"));
	const cacheDir = await mkdtemp(join(tmpdir(), "pi-codegraph-cache-"));
	temporaryDirectories.push(workspaceRoot, cacheDir);
	await writeFile(
		join(workspaceRoot, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2022",
				strict: true,
			},
			include: ["*.ts", "*.js"],
		}),
	);
	await writeFile(
		join(workspaceRoot, "base.ts"),
		[
			"export class Base {}",
			"export function helper(): string {",
			'  return "cache-must-not-contain-this-source";',
			"}",
		].join("\n"),
	);
	await writeFile(
		join(workspaceRoot, "consumer.ts"),
		[
			'import { Base, helper } from "./base.js";',
			"export class Child extends Base {",
			"  run(): string {",
			"    return helper();",
			"  }",
			"}",
		].join("\n"),
	);
	return { workspaceRoot, cacheDir };
}

async function readCachedSnapshot(graph: TypeScriptCodeGraph): Promise<CodeGraphSnapshot> {
	const payload = JSON.parse(await readFile(graph.status().cachePath, "utf8")) as { graph: CodeGraphSnapshot };
	return payload.graph;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TypeScriptCodeGraph", () => {
	it("loads the package through Pi's lazy capability manifest from a source checkout", async () => {
		const fixture = await createFixture();
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const settingsManager = SettingsManager.inMemory({ packages: [packageRoot] });
		const resourceLoader = new DefaultResourceLoader({
			cwd: fixture.workspaceRoot,
			agentDir: fixture.cacheDir,
			settingsManager,
		});

		await resourceLoader.reload();
		expect(resourceLoader.getLazyExtensions()).toMatchObject([{ id: "codegraph", status: "dormant" }]);
		const activation = await resourceLoader.activateExtension("codegraph");
		expect(activation.info.error).toBeUndefined();
		expect(activation.info).toMatchObject({ status: "active" });
		expect(activation.extension?.tools.has("code_graph")).toBe(true);
		await resourceLoader.reload();
		expect(resourceLoader.getLazyExtensions()).toMatchObject([{ id: "codegraph", status: "dormant" }]);
	});

	it("indexes TS/JS declarations, imports, calls, inheritance, and source evidence", async () => {
		const fixture = await createFixture();
		const graph = await openTypeScriptCodeGraph(fixture);
		const sync = await graph.sync();

		expect(sync.updated).toBe(true);
		expect(sync.status.state).toBe("ready");
		expect(sync.status.fileCount).toBe(2);
		const child = graph.search("Child")[0];
		const base = graph.search("Base")[0];
		const run = graph.search("run")[0];
		const helper = graph.search("helper")[0];
		expect(child.location).toMatch(/^consumer\.ts:2:/);
		expect(base.location).toMatch(/^base\.ts:1:/);

		const childDependencies = graph.dependencies(child.node.id, { maxDepth: 1 });
		expect(childDependencies.paths.some((path) => path.edges[0]?.kind === "extends")).toBe(true);
		expect(childDependencies.paths.every((path) => path.edges[0]?.range?.start.line !== undefined)).toBe(true);

		const runDependencies = graph.dependencies(run.node.id, { maxDepth: 1 });
		expect(
			runDependencies.paths.some((path) => path.edges[0]?.kind === "calls" && path.nodes[1]?.id === helper.node.id),
		).toBe(true);

		const baseDependents = graph.dependents(base.node.id, { maxDepth: 1 });
		expect(baseDependents.paths.some((path) => path.nodes[1]?.id === child.node.id)).toBe(true);
		expect(graph.nodeIdsForFile("consumer.ts")).toContain(child.node.id);
		await graph.dispose();
	});

	it("restores a source-free cache and validates revisions before reusing it", async () => {
		const fixture = await createFixture();
		let graph: TypeScriptCodeGraph = await openTypeScriptCodeGraph(fixture);
		const first = await graph.sync();
		expect(first.updated).toBe(true);
		const cacheText = await readFile(graph.status().cachePath, "utf8");
		expect(cacheText).not.toContain("cache-must-not-contain-this-source");
		expect(cacheText).not.toContain(fixture.workspaceRoot);
		await graph.dispose();

		graph = await openTypeScriptCodeGraph(fixture);
		expect(graph.status().cacheRestored).toBe(true);
		expect(graph.status().state).toBe("stale");
		expect(() => graph.search("Base")).toThrowError(/must be synchronized/);
		const warm = await graph.sync();
		expect(warm.updated).toBe(false);

		await writeFile(
			join(fixture.workspaceRoot, "consumer.ts"),
			'import { helper } from "./base.js";\nexport const changed = () => helper();\n',
		);
		graph.markDirty(["consumer.ts"]);
		const changed = await graph.sync();
		expect(changed.updated).toBe(true);
		expect(graph.search("changed")[0]?.node.name).toBe("changed");
		expect(graph.search("Child")).toEqual([]);
		await graph.dispose();
	});

	it("keeps named symbol ids stable and deduplicates overloads and equal member names", async () => {
		const fixture = await createFixture();
		const scopesPath = join(fixture.workspaceRoot, "scopes.ts");
		const source = [
			"export function overloaded(value: string): string;",
			"export function overloaded(value: number): number;",
			"export function overloaded(value: string | number): string | number { return value; }",
			"export class First { run(): void {} }",
			"export class Second { run(): void {} }",
			"export class Dual { static run(): void {} run(): void {} }",
			"export default function (): void {}",
		].join("\n");
		await writeFile(scopesPath, source);
		const graph = await openTypeScriptCodeGraph(fixture);
		const first = await graph.sync();

		const overloads = graph.search("overloaded").filter((match) => match.node.filePath === "scopes.ts");
		const runs = graph.search("run").filter((match) => match.node.filePath === "scopes.ts");
		expect(overloads).toHaveLength(1);
		expect(runs).toHaveLength(4);
		expect(new Set(runs.map((match) => match.node.id)).size).toBe(4);
		expect(runs.map((match) => match.node.id).sort()).toEqual(
			expect.arrayContaining([expect.stringContaining("class:First"), expect.stringContaining("class:Second")]),
		);
		expect(overloads[0].node.id).toContain("symbol:scopes.ts:function:");
		expect(overloads[0].node.id).not.toContain("@FunctionDeclaration");
		const anonymous = (await readCachedSnapshot(graph)).nodes.find(
			(node) => node.filePath === "scopes.ts" && node.name === "<anonymous function>",
		);
		expect(anonymous?.id).toContain("@FunctionDeclaration:");
		await writeFile(scopesPath, `${source}\nif (true) { function nested(): void { overloaded("x"); } }`);
		graph.markDirty(["scopes.ts"]);
		await graph.sync();
		const nestedId = graph.search("nested")[0].node.id;
		const nestedEdgeIds = (await readCachedSnapshot(graph)).edges
			.filter((edge) => edge.filePath === "scopes.ts" && edge.from === nestedId)
			.map((edge) => edge.id);

		await writeFile(
			scopesPath,
			`// inserted before every declaration\n${source}\nif (true) { function nested(): void { overloaded("x"); } }`,
		);
		graph.markDirty(["scopes.ts"]);
		const second = await graph.sync();
		const stableOverload = graph.search("overloaded").find((match) => match.node.filePath === "scopes.ts");
		expect(second.status.generation).toBe(first.status.generation + 2);
		expect(stableOverload?.node.id).toBe(overloads[0].node.id);
		expect(graph.search("nested")[0].node.id).toBe(nestedId);
		expect(
			(await readCachedSnapshot(graph)).edges
				.filter((edge) => edge.filePath === "scopes.ts" && edge.from === nestedId)
				.map((edge) => edge.id),
		).toEqual(nestedEdgeIds);
		await graph.dispose();
	});

	it("re-extracts unresolved importers when a matching source file is added", async () => {
		const fixture = await createFixture();
		await writeFile(
			join(fixture.workspaceRoot, "late-consumer.ts"),
			'import { created } from "./created.js";\nexport const useCreated = () => created();\n',
		);
		const graph = await openTypeScriptCodeGraph(fixture);
		await graph.sync();
		const useCreatedId = graph.search("useCreated")[0].node.id;
		expect(
			graph.dependencies(useCreatedId, { maxDepth: 1 }).paths.some((path) => path.nodes[1]?.id.includes("created")),
		).toBe(false);

		await writeFile(join(fixture.workspaceRoot, "created.ts"), "export function created(): number { return 1; }\n");
		graph.markDirty(["created.ts"]);
		await graph.sync();
		const createdId = graph.search("created")[0].node.id;
		expect(
			graph.dependencies(useCreatedId, { maxDepth: 1 }).paths.some((path) => path.nodes[1]?.id === createdId),
		).toBe(true);
		await graph.dispose();
	});

	it("reuses a clean extension index without rescanning the workspace", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspaceRoot, "other.ts"), "export class Other { run(): void {} }\n");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = fixture.cacheDir;
		let tool: ToolDefinition | undefined;
		codeGraphExtension({
			registerTool(definition: ToolDefinition) {
				tool = definition;
			},
			on() {},
		} as unknown as ExtensionAPI);
		if (!tool) throw new Error("Code graph extension did not register its tool");
		const registeredTool = tool;
		const context = { cwd: fixture.workspaceRoot } as ExtensionContext;
		const execute = (params: { action: string; query?: string }) =>
			registeredTool.execute("test", params as never, undefined, undefined, context);

		try {
			await expect(execute({ action: "search", query: "Child" })).resolves.toBeDefined();
			await expect(execute({ action: "dependencies", query: "run" })).rejects.toThrow(/ambiguous/);
			await writeFile(join(fixture.workspaceRoot, "tsconfig.json"), "{ invalid after the index is ready");
			await expect(execute({ action: "search", query: "Child" })).resolves.toBeDefined();
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("updates only changed and transitively affected files", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspaceRoot, "unrelated.ts"), "export const unrelated = 1;\n");
		const graph = await openTypeScriptCodeGraph(fixture);
		const first = await graph.sync();
		const before = await readCachedSnapshot(graph);
		const helperId = graph.search("helper")[0].node.id;
		const childId = graph.search("Child")[0].node.id;
		const unrelatedId = graph.search("unrelated")[0].node.id;

		const basePath = join(fixture.workspaceRoot, "base.ts");
		await writeFile(basePath, `// upstream insertion\n${await readFile(basePath, "utf8")}`);
		graph.markDirty(["base.ts"]);
		const changed = await graph.sync();
		const after = await readCachedSnapshot(graph);

		expect(changed.status.generation).toBe(first.status.generation + 2);
		expect(graph.search("helper")[0].node.id).toBe(helperId);
		expect(graph.search("Child")[0].node.id).toBe(childId);
		expect(graph.search("unrelated")[0].node.id).toBe(unrelatedId);
		expect(graph.getNode(unrelatedId)?.filePath).toBe("unrelated.ts");
		expect(after.files.find((file) => file.path === "unrelated.ts")?.revision).toBe(
			before.files.find((file) => file.path === "unrelated.ts")?.revision,
		);
		expect(after.files.find((file) => file.path === "consumer.ts")?.revision).toBe(
			before.files.find((file) => file.path === "consumer.ts")?.revision,
		);
		await graph.dispose();
	});

	it("removes deleted files and refreshes their dependents without touching unrelated files", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspaceRoot, "unrelated.ts"), "export const unrelated = 1;\n");
		const graph = await openTypeScriptCodeGraph(fixture);
		const first = await graph.sync();
		const unrelatedId = graph.search("unrelated")[0].node.id;

		await unlink(join(fixture.workspaceRoot, "base.ts"));
		graph.markDirty(["base.ts"]);
		const removed = await graph.sync();
		const snapshot = await readCachedSnapshot(graph);

		expect(removed.status.generation).toBe(first.status.generation + 2);
		expect(removed.status.fileCount).toBe(2);
		expect(snapshot.files.some((file) => file.path === "base.ts")).toBe(false);
		expect(snapshot.nodes.some((node) => node.filePath === "base.ts")).toBe(false);
		expect(snapshot.edges.some((edge) => edge.filePath === "base.ts")).toBe(false);
		expect(graph.search("Base")).toEqual([]);
		expect(graph.search("Child")[0]?.node.filePath).toBe("consumer.ts");
		expect(graph.getNode(unrelatedId)?.filePath).toBe("unrelated.ts");
		await graph.dispose();
	});

	it("reports syntax errors as a queryable degraded index", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspaceRoot, "broken.ts"), "export function broken( {\n");
		const graph = await openTypeScriptCodeGraph(fixture);
		const sync = await graph.sync();

		expect(sync.status.state).toBe("degraded");
		expect(sync.status.diagnostics.length).toBeGreaterThan(0);
		expect(graph.search("Base")[0]?.node.name).toBe("Base");
		await graph.dispose();
	});

	it("keeps failed cache commits out of the active graph and retries them", async () => {
		const fixture = await createFixture();
		const blockedCachePath = join(fixture.workspaceRoot, "blocked-cache");
		await writeFile(blockedCachePath, "not a directory");
		const graph = await openTypeScriptCodeGraph({ workspaceRoot: fixture.workspaceRoot, cacheDir: blockedCachePath });

		await expect(graph.sync()).rejects.toThrow();
		expect(graph.status()).toMatchObject({ state: "failed", fileCount: 0, nodeCount: 0, dirty: true });

		await unlink(blockedCachePath);
		await mkdir(blockedCachePath);
		const retried = await graph.sync();
		expect(retried).toMatchObject({ updated: true, status: { state: "ready", fileCount: 2, dirty: false } });
		expect(graph.search("Base")[0]?.node.name).toBe("Base");
		await graph.dispose();
	});

	it("serializes forced synchronization and rejects new work during disposal", async () => {
		const fixture = await createFixture();
		const graph = await openTypeScriptCodeGraph(fixture);
		const initial = await graph.sync();
		const firstForce = graph.sync({ force: true });
		const secondForce = graph.sync({ force: true });
		const [first, second] = await Promise.all([firstForce, secondForce]);

		expect(first.status.generation).toBe(initial.status.generation + initial.status.fileCount);
		expect(second.status.generation).toBe(first.status.generation + initial.status.fileCount);

		const finalSync = graph.sync({ force: true });
		const disposing = graph.dispose();
		await expect(graph.sync()).rejects.toThrow(/disposed/);
		await Promise.all([finalSync, disposing]);
		expect(graph.status().state).toBe("disposed");
	});

	it("rejects TypeScript configuration paths outside the workspace", async () => {
		const fixture = await createFixture();
		const outsideConfigPath = join(fixture.cacheDir, "outside-tsconfig.json");
		await writeFile(outsideConfigPath, JSON.stringify({ include: ["*.ts"] }));
		const graph = await openTypeScriptCodeGraph({
			...fixture,
			tsconfigPath: relative(fixture.workspaceRoot, outsideConfigPath),
		});

		await expect(graph.sync()).rejects.toThrow(/must be inside the workspace/);
		await graph.dispose();
	});

	it("bounds search and rejects file paths outside the workspace", async () => {
		const fixture = await createFixture();
		const graph = await openTypeScriptCodeGraph(fixture);
		await graph.sync();

		expect(graph.search("class", { kinds: ["class"], limit: 1 })).toHaveLength(1);
		expect(() => graph.search("", { limit: 1 })).toThrowError(/non-empty/);
		expect(() => graph.search("Base", { limit: 101 })).toThrowError(/1 to 100/);
		expect(() => graph.nodeIdsForFile("../outside.ts")).toThrowError(/inside the workspace/);
		await graph.dispose();
	});
});
