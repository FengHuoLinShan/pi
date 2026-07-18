import { compileToolSchemas } from "../tool-schema.ts";
import type { Context, Tool } from "../types.ts";

export type ToolNameNormalizer = (name: string) => string;

const identityToolName: ToolNameNormalizer = (name) => name;

export interface DeferredToolVisibility {
	readonly name: string;
	readonly normalizedName: string;
	readonly visibility: "immediate" | "deferred";
	readonly schemaHash: string;
}

export interface DeferredToolSplit {
	readonly immediate: Tool[];
	readonly deferred: Map<string, Tool>;
	/** Build hash-bearing placement metadata only when diagnostics/telemetry requests it. */
	inspect(): DeferredToolInspection;
}

export interface DeferredToolInspection {
	readonly visibility: readonly DeferredToolVisibility[];
	readonly toolsetHash: string;
}

/** Split current tools into prefix and transcript-loaded definitions. */
export function splitDeferredTools(
	context: Context,
	enabled: boolean,
	normalizeName: ToolNameNormalizer = identityToolName,
): DeferredToolSplit {
	const uniqueTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) uniqueTools.set(normalizeName(tool.name), tool);

	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();
	if (enabled) {
		for (const message of context.messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") usedNames.add(normalizeName(block.name));
				}
			} else if (message.role === "toolResult") {
				for (const name of message.addedToolNames ?? []) {
					const normalizedName = normalizeName(name);
					if (!usedNames.has(normalizedName)) deferredNames.add(normalizedName);
				}
			}
		}
	}

	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const [name, tool] of uniqueTools) {
		if (deferredNames.has(name)) deferred.set(name, tool);
		else immediate.push(tool);
	}
	return {
		immediate,
		deferred,
		inspect: () => {
			const compilation = compileToolSchemas([...uniqueTools.values()]);
			const visibility = Array.from(uniqueTools.entries(), ([normalizedName, tool], index) => ({
				name: tool.name,
				normalizedName,
				visibility: deferred.has(normalizedName) ? ("deferred" as const) : ("immediate" as const),
				schemaHash: compilation.tools[index].canonical.hash,
			}));
			return { visibility, toolsetHash: compilation.toolsetHash };
		},
	};
}
