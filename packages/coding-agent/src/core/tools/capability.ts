import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const capabilitySchema = Type.Union([
	Type.Object({
		action: Type.Literal("search"),
		kind: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("skill"), Type.Literal("extension")])),
		query: Type.Optional(Type.String()),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	}),
	Type.Object({
		action: Type.Literal("load"),
		kind: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("extension")])),
		id: Type.String({ minLength: 1 }),
		retry: Type.Optional(Type.Boolean()),
	}),
]);

export type CapabilityToolInput = Static<typeof capabilitySchema>;
export type CapabilityKind = "skill" | "extension";

export interface CapabilitySearchMatch {
	id: string;
	kind: CapabilityKind;
	description: string;
	status?: string;
}

export interface CapabilityLoadResult {
	id: string;
	kind: CapabilityKind;
	description: string;
	status?: string;
	content?: string;
	baseDir?: string;
	error?: string;
}

export interface CapabilityToolDetails {
	action: "search" | "load";
	results: CapabilitySearchMatch[] | CapabilityLoadResult[];
}

export interface CapabilityToolOptions {
	search(kind: "all" | CapabilityKind, query: string, limit: number): CapabilitySearchMatch[];
	load(id: string, retry: boolean, kind?: CapabilityKind): Promise<CapabilityLoadResult>;
}

export function createCapabilityToolDefinition(
	options: CapabilityToolOptions,
): ToolDefinition<typeof capabilitySchema, CapabilityToolDetails> {
	return {
		name: "capability",
		label: "Capability",
		description:
			"Search specialized skills and dormant extensions, then load one capability by id. Search before loading when the exact id is unknown.",
		promptSnippet: "Search and load specialized skills or dormant extensions on demand",
		promptGuidelines: [
			"Use capability search before loading a specialized skill or extension when its exact id is unknown.",
		],
		parameters: capabilitySchema,
		execute: async (_toolCallId, params) => {
			if (params.action === "search") {
				const results = options.search(params.kind ?? "all", params.query?.trim() ?? "", params.limit ?? 10);
				return {
					content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
					details: { action: "search", results },
				};
			}

			const id = params.id.trim();
			if (!id) throw new Error("capability load requires a non-empty id");
			const result = await options.load(id, params.retry ?? false, params.kind);
			const text =
				result.kind === "skill" && result.content !== undefined
					? `<skill name="${result.id}">\nReferences are relative to ${result.baseDir}.\n\n${result.content}\n</skill>`
					: JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text }],
				details: { action: "load", results: [result] },
			};
		},
	};
}
