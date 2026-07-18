import type { CapabilityProfile } from "./capabilities.ts";
import type { Tool } from "./types.ts";
import { shortHash } from "./utils/hash.ts";

export type ToolSchemaTarget = "json-schema" | "openapi-3.0" | "anthropic-input-schema";

export interface ToolSchemaDiagnostic {
	readonly severity: "warning";
	readonly code: "schema-keyword-dropped" | "schema-root-coerced";
	readonly toolName: string;
	readonly path: string;
	readonly message: string;
}

export interface CompiledToolSchema {
	readonly name: string;
	readonly description: string;
	readonly canonical: {
		readonly schema: Record<string, unknown>;
		readonly hash: string;
	};
	readonly provider: {
		readonly target: ToolSchemaTarget;
		readonly schema: Record<string, unknown>;
		readonly hash: string;
	};
	readonly diagnostics: readonly ToolSchemaDiagnostic[];
}

export interface ToolSchemaCompilation {
	readonly target: ToolSchemaTarget;
	readonly profile?: CapabilityProfile;
	/** Stable identity of tool names, descriptions, and canonical schemas. */
	readonly toolsetHash: string;
	readonly tools: readonly CompiledToolSchema[];
	readonly diagnostics: readonly ToolSchemaDiagnostic[];
}

export interface CompileToolSchemasOptions {
	profile?: CapabilityProfile;
	target?: ToolSchemaTarget;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown, seen: Set<object>): JsonValue | undefined {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) throw new Error("Tool schemas must not contain circular references");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry) => canonicalize(entry, seen) ?? null);
		}
		const result: Record<string, JsonValue> = {};
		for (const key of Object.keys(value).sort()) {
			const entry = canonicalize((value as Record<string, unknown>)[key], seen);
			if (entry !== undefined) result[key] = entry;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function canonicalSchema(schema: unknown): Record<string, unknown> {
	const value = canonicalize(schema, new Set());
	if (!isRecord(value)) throw new Error("Tool parameter schemas must be JSON objects");
	return value;
}

function stableHash(value: unknown): string {
	const canonical = canonicalize(value, new Set());
	return `pi-schema-v1-${shortHash(JSON.stringify(canonical))}`;
}

function escapeJsonPointer(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function toOpenApiSchema(value: unknown, toolName: string, path: string, diagnostics: ToolSchemaDiagnostic[]): unknown {
	if (Array.isArray(value)) {
		return value.map((entry, index) => toOpenApiSchema(entry, toolName, `${path}/${index}`, diagnostics));
	}
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		const entryPath = `${path}/${escapeJsonPointer(key)}`;
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) {
			diagnostics.push({
				severity: "warning",
				code: "schema-keyword-dropped",
				toolName,
				path: entryPath,
				message: `${key} is not emitted in the OpenAPI 3.0 tool schema view`,
			});
			continue;
		}
		result[key] = toOpenApiSchema(entry, toolName, entryPath, diagnostics);
	}
	return result;
}

function toAnthropicInputSchema(
	schema: Record<string, unknown>,
	toolName: string,
	diagnostics: ToolSchemaDiagnostic[],
): Record<string, unknown> {
	if (schema.type !== undefined && schema.type !== "object") {
		diagnostics.push({
			severity: "warning",
			code: "schema-root-coerced",
			toolName,
			path: "/type",
			message: "Anthropic tool input schemas are emitted with an object root",
		});
	}
	for (const key of Object.keys(schema)) {
		if (key === "type" || key === "properties" || key === "required") continue;
		diagnostics.push({
			severity: "warning",
			code: "schema-keyword-dropped",
			toolName,
			path: `/${escapeJsonPointer(key)}`,
			message: `${key} is not emitted at the Anthropic tool schema root`,
		});
	}
	return {
		type: "object",
		properties: isRecord(schema.properties) ? schema.properties : {},
		required: Array.isArray(schema.required) ? schema.required : [],
	};
}

function compileProviderSchema(
	schema: Record<string, unknown>,
	toolName: string,
	target: ToolSchemaTarget,
	diagnostics: ToolSchemaDiagnostic[],
): Record<string, unknown> {
	if (target === "json-schema") return schema;
	if (target === "anthropic-input-schema") return toAnthropicInputSchema(schema, toolName, diagnostics);
	return toOpenApiSchema(schema, toolName, "", diagnostics) as Record<string, unknown>;
}

export function hashToolSchema(schema: unknown): string {
	return stableHash(canonicalSchema(schema));
}

export function compileToolSchemas(
	tools: readonly Tool[],
	options: CompileToolSchemasOptions = {},
): ToolSchemaCompilation {
	const target = options.target ?? options.profile?.tools.schemaTarget ?? "json-schema";
	const compiled = tools.map((tool): CompiledToolSchema => {
		const schema = canonicalSchema(tool.parameters);
		const diagnostics: ToolSchemaDiagnostic[] = [];
		const providerSchema = compileProviderSchema(schema, tool.name, target, diagnostics);
		return {
			name: tool.name,
			description: tool.description,
			canonical: { schema, hash: stableHash(schema) },
			provider: { target, schema: providerSchema, hash: stableHash(providerSchema) },
			diagnostics,
		};
	});
	const identity = compiled
		.map((tool) => ({ name: tool.name, description: tool.description, schemaHash: tool.canonical.hash }))
		.sort((left, right) => left.name.localeCompare(right.name));
	return {
		target,
		profile: options.profile,
		toolsetHash: stableHash(identity),
		tools: compiled,
		diagnostics: compiled.flatMap((tool) => tool.diagnostics),
	};
}
