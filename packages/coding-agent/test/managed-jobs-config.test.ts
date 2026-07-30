import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadManagedJobsConfig,
	MANAGED_JOBS_CONFIG_PATH,
	parseManagedJobsConfig,
} from "../src/extensions/managed-jobs/config.ts";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "pi-managed-jobs-config-"));
	temporaryDirectories.push(workspace);
	await mkdir(join(workspace, ".pi"));
	return workspace;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function validConfig(): unknown {
	return {
		version: 1,
		recipes: [
			{
				id: "dev-server",
				command: "npm",
				args: ["run", "dev"],
				readiness: { contains: "ready", stream: "stdout", timeoutSeconds: 10 },
			},
		],
	};
}

describe("managed jobs config", () => {
	it("parses fixed command recipes and applies bounded readiness defaults", () => {
		expect(parseManagedJobsConfig(validConfig())).toEqual(validConfig());
		expect(
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "worker", command: "node", readiness: { contains: "started" } }],
			}),
		).toEqual({
			version: 1,
			recipes: [
				{
					id: "worker",
					command: "node",
					args: [],
					readiness: { contains: "started", stream: "all", timeoutSeconds: 30 },
				},
			],
		});
	});

	it("rejects unknown fields at every config level", () => {
		expect(() => parseManagedJobsConfig({ ...(validConfig() as object), extra: true })).toThrow(
			"unknown managed jobs config field: extra",
		);
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "dev", command: "npm", extra: true }],
			}),
		).toThrow("unknown recipes[0] field: extra");
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "dev", command: "npm", readiness: { contains: "ready", extra: true } }],
			}),
		).toThrow("unknown recipes[0].readiness field: extra");
	});

	it("rejects duplicate or non-portable recipe ids", () => {
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [
					{ id: "dev", command: "npm" },
					{ id: "dev", command: "node" },
				],
			}),
		).toThrow("recipe ids must be unique");
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "../dev", command: "npm" }],
			}),
		).toThrow("portable identifier");
	});

	it("rejects sparse arrays, NUL bytes, and unbounded readiness", () => {
		const sparseRecipes = new Array(1);
		expect(() => parseManagedJobsConfig({ version: 1, recipes: sparseRecipes })).toThrow(
			"recipes must not contain sparse entries",
		);
		const sparseArguments = new Array(1);
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "dev", command: "npm", args: sparseArguments }],
			}),
		).toThrow("recipes[0].args must not contain sparse entries");
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "dev", command: "npm", args: ["bad\0arg"] }],
			}),
		).toThrow("must not contain NUL bytes");
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "dev", command: "npm", args: ["x".repeat(8_193)] }],
			}),
		).toThrow("exceeds 8192 bytes");
		expect(() =>
			parseManagedJobsConfig({
				version: 1,
				recipes: [{ id: "dev", command: "npm", readiness: { contains: "ready", timeoutSeconds: 31 } }],
			}),
		).toThrow("timeoutSeconds must be a safe integer between 1 and 30");
	});

	it("loads a bounded regular project config with a stable source revision", async () => {
		const workspace = await createWorkspace();
		const source = `${JSON.stringify(validConfig())}\n`;
		await writeFile(join(workspace, MANAGED_JOBS_CONFIG_PATH), source, "utf8");

		const loaded = await loadManagedJobsConfig(workspace);

		expect(loaded.config).toEqual(validConfig());
		expect(loaded.revision).toBe(createHash("sha256").update(source).digest("hex"));
	});

	it("rejects symbolic links and oversized project configs", async () => {
		const workspace = await createWorkspace();
		const outside = join(workspace, "outside.json");
		const configPath = join(workspace, MANAGED_JOBS_CONFIG_PATH);
		await writeFile(outside, JSON.stringify(validConfig()), "utf8");
		await symlink(outside, configPath);

		await expect(loadManagedJobsConfig(workspace)).rejects.toThrow("must be a regular non-symbolic-link file");

		await rm(configPath);
		await writeFile(configPath, " ".repeat(256 * 1024 + 1), "utf8");
		await expect(loadManagedJobsConfig(workspace)).rejects.toThrow("exceeds 262144 bytes");
	});

	it("rejects a regular config replaced after path validation", async () => {
		const workspace = await createWorkspace();
		const configPath = join(workspace, MANAGED_JOBS_CONFIG_PATH);
		const originalPath = join(workspace, ".pi", "managed-jobs.original.json");
		await writeFile(configPath, JSON.stringify(validConfig()), "utf8");

		await expect(
			loadManagedJobsConfig(workspace, {
				openFile: async (path, flags) => {
					await rename(configPath, originalPath);
					await writeFile(
						configPath,
						JSON.stringify({ version: 1, recipes: [{ id: "replacement", command: "node" }] }),
						"utf8",
					);
					return open(path, flags);
				},
			}),
		).rejects.toThrow("changed while being loaded; retry");
	});
});
