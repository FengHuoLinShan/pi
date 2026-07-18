import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { deriveCapabilityProfile } from "../src/capabilities.ts";
import { createModels, createProvider } from "../src/models.ts";
import { compileToolSchemas } from "../src/tool-schema.ts";
import type { Api, Context, Model, Tool } from "../src/types.ts";
import { splitDeferredTools } from "../src/utils/deferred-tools.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function model<TApi extends Api>(input: Partial<Model<TApi>> & Pick<Model<TApi>, "api" | "provider">): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...input,
	};
}

function tool(name: string, parameters: Record<string, unknown>): Tool {
	return {
		name,
		description: `${name} description`,
		parameters: parameters as Tool["parameters"],
	};
}

describe("CapabilityProfile", () => {
	it("derives distinct model and adapter capabilities without changing Model", () => {
		const deepseek = deriveCapabilityProfile(
			model({
				id: "deepseek-v4-flash",
				api: "openai-completions",
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com",
				reasoning: true,
			}),
		);
		const anthropic = deriveCapabilityProfile(
			model({
				id: "claude-opus-4-6",
				api: "anthropic-messages",
				provider: "anthropic",
				input: ["text", "image"],
			}),
		);
		const kimi = deriveCapabilityProfile(
			model({
				api: "openai-completions",
				provider: "moonshotai",
				compat: { deferredToolsMode: "kimi" },
			}),
		);

		expect(deepseek).toMatchObject({
			version: 1,
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoning: { supported: true, levels: ["off", "minimal", "low", "medium", "high"] },
			tools: { support: "supported", schemaTarget: "json-schema", strictMode: "supported" },
		});
		expect(anthropic).toMatchObject({
			input: { modalities: ["text", "image"] },
			tools: {
				schemaTarget: "anthropic-input-schema",
				strictMode: "unsupported",
				deferredLoading: "native",
			},
		});
		expect(kimi.tools).toMatchObject({ strictMode: "unsupported", deferredLoading: "transcript" });
	});

	it("lets a provider refine derived capabilities through Models", () => {
		const customModel = model({ api: "custom-api", provider: "custom" });
		const streams = {
			stream: () => new AssistantMessageEventStream(),
			streamSimple: () => new AssistantMessageEventStream(),
		};
		const provider = createProvider({
			id: "custom",
			auth: { apiKey: { name: "None", resolve: async () => ({ auth: {} }) } },
			models: [customModel],
			api: streams,
			capabilities: {
				tools: { support: "supported", schemaTarget: "openapi-3.0", strictMode: "unsupported" },
			},
		});
		const models = createModels();
		models.setProvider(provider);

		expect(models.getCapabilities(customModel).tools).toEqual({
			support: "supported",
			schemaTarget: "openapi-3.0",
			strictMode: "unsupported",
			deferredLoading: "none",
		});
	});
});

describe("tool schema compiler", () => {
	it("produces stable canonical hashes independent of object key order", () => {
		const first = tool("inspect", {
			type: "object",
			properties: { path: { type: "string", description: "Path" }, depth: { type: "integer" } },
			required: ["path"],
		});
		const reordered = tool("inspect", {
			required: ["path"],
			properties: { depth: { type: "integer" }, path: { description: "Path", type: "string" } },
			type: "object",
		});

		const left = compileToolSchemas([first]);
		const right = compileToolSchemas([reordered]);

		expect(left.tools[0].canonical.hash).toBe(right.tools[0].canonical.hash);
		expect(left.toolsetHash).toBe(right.toolsetHash);
		expect(left.tools[0].canonical).toMatchInlineSnapshot(`
			{
			  "hash": "pi-schema-v1-92n4au17v4j3n",
			  "schema": {
			    "properties": {
			      "depth": {
			        "type": "integer",
			      },
			      "path": {
			        "description": "Path",
			        "type": "string",
			      },
			    },
			    "required": [
			      "path",
			    ],
			    "type": "object",
			  },
			}
		`);
	});

	it("reports deterministic loss when compiling the OpenAPI provider view", () => {
		const result = compileToolSchemas(
			[
				tool("legacy", {
					$schema: "https://json-schema.org/draft/2020-12/schema",
					$defs: { path: { type: "string" } },
					type: "object",
					properties: { path: { $ref: "#/$defs/path" } },
				}),
			],
			{ target: "openapi-3.0" },
		);

		expect(result.tools[0].provider.schema).toEqual({
			properties: { path: { $ref: "#/$defs/path" } },
			type: "object",
		});
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "schema-keyword-dropped", path: "/$defs", toolName: "legacy" }),
			expect.objectContaining({ code: "schema-keyword-dropped", path: "/$schema", toolName: "legacy" }),
		]);
	});

	it("matches the Anthropic root projection and reports dropped constraints", () => {
		const profile = deriveCapabilityProfile(
			model({ id: "claude-opus-4-6", api: "anthropic-messages", provider: "anthropic" }),
		);
		const result = compileToolSchemas(
			[
				tool("write", {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				}),
			],
			{ profile },
		);

		expect(result.profile).toBe(profile);
		expect(result.target).toBe("anthropic-input-schema");
		expect(result.tools[0].provider.schema).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "schema-keyword-dropped", path: "/additionalProperties" }),
		]);
	});

	it("exposes deferred visibility and stable schema identities", () => {
		const base = { name: "base", description: "base", parameters: Type.Object({ value: Type.String() }) };
		const late = { name: "late", description: "late", parameters: Type.Object({ path: Type.String() }) };
		const context: Context = {
			tools: [base, late],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "base",
					content: [{ type: "text", text: "ok" }],
					addedToolNames: ["late"],
					isError: false,
					timestamp: 1,
				},
			],
		};

		const placement = splitDeferredTools(context, true);
		const inspection = placement.inspect();
		expect(placement.immediate.map((entry) => entry.name)).toEqual(["base"]);
		expect([...placement.deferred.keys()]).toEqual(["late"]);
		expect(inspection.visibility).toEqual([
			expect.objectContaining({ name: "base", normalizedName: "base", visibility: "immediate" }),
			expect.objectContaining({ name: "late", normalizedName: "late", visibility: "deferred" }),
		]);
		expect(inspection.visibility[1].schemaHash).toBe(compileToolSchemas([late]).tools[0].canonical.hash);
	});

	it("uses the compiler view in the DeepSeek/OpenAI-compatible payload", async () => {
		const deepseek = model({
			id: "deepseek-v4-flash",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "http://127.0.0.1:9/v1",
		});
		let payload: { tools?: Array<{ function: { parameters: Record<string, unknown> } }> } | undefined;
		const stream = streamOpenAICompletions(
			deepseek,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: [tool("inspect", { required: ["path"], type: "object", properties: { path: { type: "string" } } })],
			},
			{
				apiKey: "test-key",
				onPayload: (value) => {
					payload = value as typeof payload;
					throw new Error("payload captured");
				},
			},
		);
		await stream.result();

		expect(payload?.tools?.[0].function.parameters).toEqual({
			properties: { path: { type: "string" } },
			required: ["path"],
			type: "object",
		});
	});
});
