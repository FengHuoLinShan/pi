import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionBindings } from "../src/core/agent-session.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ToolName } from "../src/core/tools/index.ts";

describe("lazy capabilities", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lazy-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createLazyPackage(source: string, id = "browser-tools"): string {
		const packageDir = join(tempDir, "lazy-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "test-lazy-package",
				pi: {
					lazyExtensions: [
						{
							id,
							path: "./extension.ts",
							description: "Browser automation tools",
							keywords: ["playwright", "web"],
						},
					],
				},
			}),
		);
		writeFileSync(join(packageDir, "extension.ts"), source);
		return packageDir;
	}

	function createSkill(name = "review-code"): string {
		const skillDir = join(tempDir, "skills", name);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Review code carefully\n---\n\n# Review\n\nRead every changed file.\n`,
		);
		return skillDir;
	}

	async function createSession(
		settingsManager: SettingsManager,
		options: {
			bindings?: ExtensionBindings;
			tools?: ToolName[];
			extensionsOverride?: DefaultResourceLoaderOptions["extensionsOverride"];
		} = {},
	) {
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionsOverride: options.extensionsOverride,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			tools: options.tools,
		});
		await session.bindExtensions(options.bindings ?? {});
		return { resourceLoader, session };
	}

	it("keeps skill bodies and extension modules out of startup, then activates once", async () => {
		let extensionsChanged = 0;
		const markerPath = join(tempDir, "activation.log");
		const skillDir = createSkill();
		const packageDir = createLazyPackage(`
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(markerPath)}, "import\\n");
export default function (pi) {
  appendFileSync(${JSON.stringify(markerPath)}, "factory\\n");
  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser snapshot",
    description: "Capture a browser snapshot",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "snapshot" }], details: {} }),
  });
  pi.on("session_start", (event) => appendFileSync(${JSON.stringify(markerPath)}, event.reason + "\\n"));
  return { dispose: () => appendFileSync(${JSON.stringify(markerPath)}, "dispose\\n") };
}
`);
		const settingsManager = SettingsManager.inMemory({
			packages: [packageDir],
			skills: [skillDir],
			skillLoading: "on-demand",
		});
		const { resourceLoader, session } = await createSession(settingsManager, {
			bindings: {
				onExtensionsChanged: () => {
					extensionsChanged++;
				},
			},
		});

		expect(existsSync(markerPath)).toBe(false);
		expect(resourceLoader.getLazyExtensions()).toMatchObject([{ id: "browser-tools", status: "dormant" }]);
		expect(session.getActiveToolNames()).toContain("capability");
		expect(session.systemPrompt).not.toContain("review-code");
		expect(session.systemPrompt).toContain("Specialized skills are available on demand");
		expect(session.searchCapabilities("all", "playwright")).toMatchObject([
			{ id: "browser-tools", kind: "extension", status: "dormant" },
		]);
		expect(await session.loadCapability("review-code")).toMatchObject({
			id: "review-code",
			kind: "skill",
			content: expect.stringContaining("Read every changed file."),
		});

		const [first, second] = await Promise.all([
			session.activateExtension("browser-tools"),
			session.activateExtension("browser-tools"),
		]);
		expect(first.info.status).toBe("active");
		expect(second.info.status).toBe("active");
		expect(session.getActiveToolNames()).toContain("browser_snapshot");
		expect(extensionsChanged).toBe(1);
		expect(readFileSync(markerPath, "utf-8").trim().split("\n")).toEqual(["import", "factory", "activation"]);
		await session.reload();
		expect(readFileSync(markerPath, "utf-8").trim().split("\n").at(-1)).toBe("dispose");
		expect(resourceLoader.getLazyExtensions()).toMatchObject([{ id: "browser-tools", status: "dormant" }]);
		session.dispose();
	});

	it("keeps failed registrations atomic and retries only when requested", async () => {
		const attemptsPath = join(tempDir, "attempts.log");
		const gatePath = join(tempDir, "allow-activation");
		const packageDir = createLazyPackage(
			`
import { appendFileSync, existsSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(attemptsPath)}, "attempt\\n");
  pi.registerTool({
    name: "gated_tool",
    label: "Gated",
    description: "Only appears after a successful activation",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  });
  if (!existsSync(${JSON.stringify(gatePath)})) throw new Error("gate closed");
}
`,
			"gated-extension",
		);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const { session } = await createSession(settingsManager);

		const failed = await session.activateExtension("gated-extension");
		expect(failed.info).toMatchObject({ status: "failed", error: expect.stringContaining("gate closed") });
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("gated_tool");

		const unchanged = await session.activateExtension("gated-extension");
		expect(unchanged.info.status).toBe("failed");
		expect(readFileSync(attemptsPath, "utf-8").trim().split("\n")).toHaveLength(1);

		writeFileSync(gatePath, "ok");
		const recovered = await session.activateExtension("gated-extension", { retry: true });
		expect(recovered.info.status).toBe("active");
		expect(session.getActiveToolNames()).toContain("gated_tool");
		expect(readFileSync(attemptsPath, "utf-8").trim().split("\n")).toHaveLength(2);
		session.dispose();
	});

	it("invalidates an in-flight activation when the resource loader reloads", async () => {
		const markerPath = join(tempDir, "reload-race.log");
		const packageDir = createLazyPackage(`
import { appendFileSync } from "node:fs";
export default async function () {
  appendFileSync(${JSON.stringify(markerPath)}, "factory\\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { dispose: () => appendFileSync(${JSON.stringify(markerPath)}, "dispose\\n") };
}
`);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const activation = resourceLoader.activateExtension("browser-tools");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await resourceLoader.reload();
		const result = await activation;

		expect(result.info).toMatchObject({
			status: "failed",
			error: expect.stringContaining("invalidated by a resource reload"),
		});
		expect(readFileSync(markerPath, "utf-8").trim().split("\n")).toEqual(["factory", "dispose"]);
		expect(resourceLoader.getLazyExtensions()).toMatchObject([{ id: "browser-tools", status: "dormant" }]);
	});

	it("drains an in-flight activation before session reload teardown", async () => {
		const markerPath = join(tempDir, "session-reload-race.log");
		const packageDir = createLazyPackage(`
import { appendFileSync } from "node:fs";
export default async function () {
  appendFileSync(${JSON.stringify(markerPath)}, "factory\\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { dispose: () => appendFileSync(${JSON.stringify(markerPath)}, "dispose\\n") };
}
`);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const { resourceLoader, session } = await createSession(settingsManager);

		const activation = session.activateExtension("browser-tools");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const reload = session.reload();
		expect((await activation).info.status).toBe("active");
		await reload;

		expect(readFileSync(markerPath, "utf-8").trim().split("\n")).toEqual(["factory", "dispose"]);
		expect(resourceLoader.getLazyExtensions()).toMatchObject([{ id: "browser-tools", status: "dormant" }]);
		session.dispose();
	});

	it("applies extensionsOverride to lazy activation", async () => {
		const markerPath = join(tempDir, "override.log");
		const packageDir = createLazyPackage(`
import { appendFileSync } from "node:fs";
export default function () {
  return { dispose: () => appendFileSync(${JSON.stringify(markerPath)}, "dispose\\n") };
}
`);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const { session } = await createSession(settingsManager, {
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter((extension) => !extension.path.endsWith("extension.ts")),
			}),
		});

		const result = await session.activateExtension("browser-tools");
		expect(result.info).toMatchObject({
			status: "failed",
			error: expect.stringContaining("rejected by the configured extensions override"),
		});
		expect(readFileSync(markerPath, "utf-8")).toBe("dispose\n");
		session.dispose();
	});

	it("starts lazy extension cleanup from direct session.dispose", async () => {
		const markerPath = join(tempDir, "direct-dispose.log");
		const packageDir = createLazyPackage(`
import { appendFileSync } from "node:fs";
export default function () {
  return { dispose: () => appendFileSync(${JSON.stringify(markerPath)}, "dispose\\n") };
}
`);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const { session } = await createSession(settingsManager);
		await session.activateExtension("browser-tools");

		session.dispose();
		expect(readFileSync(markerPath, "utf-8")).toBe("dispose\n");
	});

	it("keeps restricted registrations blocked after lazy activation", async () => {
		const markerPath = join(tempDir, "restricted.log");
		const packageDir = createLazyPackage(`
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    for (const action of [
      () => pi.unregisterProvider("anthropic"),
      () => pi.registerFlag("late-flag", { type: "boolean" }),
      () => pi.on("project_trust", async () => ({ trusted: true })),
    ]) {
      try { action(); } catch (error) { appendFileSync(${JSON.stringify(markerPath)}, error.message + "\\n"); }
    }
  });
}
`);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const { session } = await createSession(settingsManager);

		const result = await session.activateExtension("browser-tools");
		expect(result.info.status).toBe("active");
		expect(readFileSync(markerPath, "utf-8")).toContain("cannot unregister providers");
		expect(readFileSync(markerPath, "utf-8")).toContain("cannot register CLI flags");
		expect(readFileSync(markerPath, "utf-8")).toContain("cannot register project_trust handlers");
		session.dispose();
	});

	it("uses kind to disambiguate a skill and extension with the same id", async () => {
		const id = "shared-capability";
		const packageDir = createLazyPackage("export default function () {}", id);
		const skillDir = createSkill(id);
		const settingsManager = SettingsManager.inMemory({
			packages: [packageDir],
			skills: [skillDir],
			skillLoading: "on-demand",
		});
		const { session } = await createSession(settingsManager);

		expect(await session.loadCapability(id)).toMatchObject({ error: expect.stringContaining("ambiguous") });
		expect(await session.loadCapability(id, false, "skill")).toMatchObject({
			kind: "skill",
			content: expect.stringContaining("Read every changed file."),
		});
		expect(await session.loadCapability(id, false, "extension")).toMatchObject({
			kind: "extension",
			status: "active",
		});
		session.dispose();
	});

	it("does not auto-enable capability for an explicit tools allowlist", async () => {
		const packageDir = createLazyPackage("export default function () {}");
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const { session } = await createSession(settingsManager, { tools: ["read"] });

		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("capability");
		session.dispose();
	});

	it("safely ignores malformed lazy extension manifest entries", async () => {
		const packageDir = join(tempDir, "malformed-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "malformed", pi: { lazyExtensions: [null, 42, "bad"] } }),
		);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });

		await expect(resourceLoader.reload()).resolves.toBeUndefined();
		expect(resourceLoader.getLazyExtensions()).toEqual([]);
	});
});
