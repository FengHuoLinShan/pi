import { describe, expect, it } from "vitest";
import { parseManagedJobsConfig } from "../src/extensions/managed-jobs/config.ts";

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
});
