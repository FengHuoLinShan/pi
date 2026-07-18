import type { ToolSchemaTarget } from "./tool-schema.ts";
import type { Api, Model, ModelThinkingLevel } from "./types.ts";

export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export type DeferredToolLoading = "none" | "native" | "transcript";

export interface CapabilityProfile {
	readonly version: 1;
	readonly provider: string;
	readonly model: string;
	readonly api: Api;
	readonly input: {
		readonly modalities: readonly ("text" | "image")[];
	};
	readonly reasoning: {
		readonly supported: boolean;
		readonly levels: readonly ModelThinkingLevel[];
	};
	readonly limits: {
		readonly contextWindow: number;
		readonly maxOutputTokens: number;
	};
	readonly tools: {
		readonly support: CapabilitySupport;
		readonly schemaTarget: ToolSchemaTarget;
		readonly strictMode: CapabilitySupport;
		readonly deferredLoading: DeferredToolLoading;
	};
}

export interface CapabilityProfileOverrides {
	input?: Partial<CapabilityProfile["input"]>;
	reasoning?: Partial<CapabilityProfile["reasoning"]>;
	limits?: Partial<CapabilityProfile["limits"]>;
	tools?: Partial<CapabilityProfile["tools"]>;
}

const EXTENDED_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const TOOL_APIS = new Set<Api>([
	"openai-completions",
	"mistral-conversations",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"pi-messages",
]);

function getThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function defaultAnthropicToolReferences(model: Model<Api>): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

function getDeferredToolLoading(model: Model<Api>): DeferredToolLoading {
	if (model.api === "anthropic-messages") {
		const compat = model.compat as { supportsToolReferences?: boolean } | undefined;
		return (compat?.supportsToolReferences ?? defaultAnthropicToolReferences(model)) ? "native" : "none";
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		const compat = model.compat as { supportsToolSearch?: boolean } | undefined;
		return compat?.supportsToolSearch === true ? "native" : "none";
	}
	if (model.api === "openai-completions") {
		const compat = model.compat as { deferredToolsMode?: "kimi" } | undefined;
		return compat?.deferredToolsMode === "kimi" ? "transcript" : "none";
	}
	return "none";
}

function supportsOpenAICompletionsStrictMode(model: Model<Api>): boolean {
	const compat = model.compat as { supportsStrictMode?: boolean } | undefined;
	if (compat?.supportsStrictMode !== undefined) return compat.supportsStrictMode;
	const provider = model.provider;
	const baseUrl = model.baseUrl;
	return !(
		provider === "moonshotai" ||
		provider === "moonshotai-cn" ||
		baseUrl.includes("api.moonshot.") ||
		provider === "together" ||
		baseUrl.includes("api.together.ai") ||
		baseUrl.includes("api.together.xyz") ||
		provider === "cloudflare-ai-gateway" ||
		baseUrl.includes("gateway.ai.cloudflare.com") ||
		provider === "nvidia" ||
		baseUrl.includes("integrate.api.nvidia.com")
	);
}

function getSchemaTarget(api: Api): ToolSchemaTarget {
	if (api === "anthropic-messages") return "anthropic-input-schema";
	return "json-schema";
}

function getStrictMode(model: Model<Api>): CapabilitySupport {
	if (model.api === "openai-completions") {
		return supportsOpenAICompletionsStrictMode(model) ? "supported" : "unsupported";
	}
	if (
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "mistral-conversations"
	) {
		return "supported";
	}
	return TOOL_APIS.has(model.api) ? "unsupported" : "unknown";
}

/**
 * Derive the provider/model capabilities used by pi's adapter boundary.
 * Provider factories can layer explicit overrides without changing Model.
 */
export function deriveCapabilityProfile(
	model: Model<Api>,
	overrides: CapabilityProfileOverrides = {},
): CapabilityProfile {
	const profile: CapabilityProfile = {
		version: 1,
		provider: model.provider,
		model: model.id,
		api: model.api,
		input: { modalities: [...model.input] },
		reasoning: { supported: model.reasoning, levels: getThinkingLevels(model) },
		limits: { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens },
		tools: {
			support: TOOL_APIS.has(model.api) ? "supported" : "unknown",
			schemaTarget: getSchemaTarget(model.api),
			strictMode: getStrictMode(model),
			deferredLoading: getDeferredToolLoading(model),
		},
	};

	return {
		...profile,
		input: { ...profile.input, ...overrides.input },
		reasoning: { ...profile.reasoning, ...overrides.reasoning },
		limits: { ...profile.limits, ...overrides.limits },
		tools: { ...profile.tools, ...overrides.tools },
	};
}
