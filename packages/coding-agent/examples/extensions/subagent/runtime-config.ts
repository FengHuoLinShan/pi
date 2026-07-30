import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface AgentRuntimeConfig {
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
}

export type AgentRuntimeFieldErrors = Partial<Record<keyof AgentRuntimeConfig, string>>;

export interface AgentRuntimeOverridesFile {
	version: 1;
	agents: Record<string, AgentRuntimeConfig>;
}

export interface RuntimeOverridesLoadResult {
	config: AgentRuntimeOverridesFile;
	error?: string;
}

export interface RuntimeModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	find(provider: string, modelId: string): Model<Api> | undefined;
}

export function getRuntimeOverridesPath(): string {
	return join(getAgentDir(), "agent-runtimes.json");
}

function emptyOverrides(): AgentRuntimeOverridesFile {
	return { version: 1, agents: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value.trim();
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function parseRuntimeOverrides(raw: string): AgentRuntimeOverridesFile {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.agents)) {
		throw new Error('expected { "version": 1, "agents": { ... } }');
	}

	const agents: Record<string, AgentRuntimeConfig> = {};
	for (const [name, value] of Object.entries(parsed.agents)) {
		if (!isRecord(value)) throw new Error(`agents.${name} must be an object`);
		const provider = optionalString(value.provider, `agents.${name}.provider`);
		const model = optionalString(value.model, `agents.${name}.model`);
		const thinkingValue = value.thinking;
		if (thinkingValue !== undefined && !isThinkingLevel(thinkingValue)) {
			throw new Error(`agents.${name}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
		}
		agents[name] = { provider, model, thinking: thinkingValue };
	}

	return { version: 1, agents };
}

export function loadRuntimeOverrides(filePath = getRuntimeOverridesPath()): RuntimeOverridesLoadResult {
	try {
		return { config: parseRuntimeOverrides(readFileSync(filePath, "utf8")) };
	} catch (error) {
		const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") return { config: emptyOverrides() };
		return {
			config: emptyOverrides(),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function saveRuntimeOverrides(config: AgentRuntimeOverridesFile, filePath = getRuntimeOverridesPath()): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, filePath);
	chmodSync(filePath, 0o600);
}

export async function updateRuntimeOverride(
	agentName: string,
	runtime: AgentRuntimeConfig | undefined,
	filePath = getRuntimeOverridesPath(),
): Promise<void> {
	const lockPath = `${filePath}.lock`;
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	let locked = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			locked = true;
			break;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true });
			} catch {
				// Another process released the lock between the failed mkdir and stat.
			}
			await delay(25);
		}
	}
	if (!locked) throw new Error(`Timed out waiting to update ${filePath}`);

	try {
		const loaded = loadRuntimeOverrides(filePath);
		if (loaded.error) throw new Error(`Cannot edit ${filePath}: ${loaded.error}`);
		if (runtime) loaded.config.agents[agentName] = runtime;
		else delete loaded.config.agents[agentName];
		saveRuntimeOverrides(loaded.config, filePath);
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

export function resolveAgentRuntime(
	agentDefaults: AgentRuntimeConfig,
	userOverride: AgentRuntimeConfig | undefined,
	taskOverride: AgentRuntimeConfig,
): AgentRuntimeConfig {
	return {
		provider: taskOverride.provider ?? userOverride?.provider ?? agentDefaults.provider,
		model: taskOverride.model ?? userOverride?.model ?? agentDefaults.model,
		thinking: taskOverride.thinking ?? userOverride?.thinking ?? agentDefaults.thinking,
	};
}

export function buildRuntimeArgs(runtime: AgentRuntimeConfig): string[] {
	const args: string[] = [];
	if (runtime.provider) args.push("--provider", runtime.provider);
	if (runtime.model) args.push("--model", runtime.model);
	if (runtime.thinking) args.push("--thinking", runtime.thinking);
	return args;
}

function findConfiguredModel(runtime: AgentRuntimeConfig, registry: RuntimeModelRegistry): Model<Api> | undefined {
	if (!runtime.model) return undefined;
	if (runtime.provider) return registry.find(runtime.provider, runtime.model);

	const slashIndex = runtime.model.indexOf("/");
	if (slashIndex > 0) {
		return registry.find(runtime.model.slice(0, slashIndex), runtime.model.slice(slashIndex + 1));
	}

	const availableMatches = registry.getAvailable().filter((model) => model.id === runtime.model);
	if (availableMatches.length === 1) return availableMatches[0];
	if (availableMatches.length > 1) return undefined;
	const configuredMatches = registry.getAll().filter((model) => model.id === runtime.model);
	return configuredMatches.length === 1 ? configuredMatches[0] : undefined;
}

export function validateAgentRuntime(
	runtime: AgentRuntimeConfig,
	registry: RuntimeModelRegistry,
): { runtime?: AgentRuntimeConfig; error?: string } {
	if (!runtime.model) {
		if (runtime.provider) return { error: `Provider "${runtime.provider}" requires an explicit model` };
		if (runtime.thinking) return { error: "A thinking override requires an explicit model" };
		return { runtime };
	}

	const model = findConfiguredModel(runtime, registry);
	if (!model) {
		const target = runtime.provider ? `${runtime.provider}/${runtime.model}` : runtime.model;
		return { error: `Model "${target}" was not found or is ambiguous; specify provider and model explicitly` };
	}
	const isAvailable = registry
		.getAvailable()
		.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
	if (!isAvailable) return { error: `No configured authentication is available for provider "${model.provider}"` };

	if (runtime.thinking) {
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(runtime.thinking)) {
			return {
				error: `Model "${model.provider}/${model.id}" does not support effort "${runtime.thinking}"; supported: ${supported.join(", ")}`,
			};
		}
	}

	return {
		runtime: {
			provider: model.provider,
			model: model.id,
			thinking: runtime.thinking,
		},
	};
}

export function resolveAndValidateAgentRuntime(
	agentDefaults: AgentRuntimeConfig,
	userOverride: AgentRuntimeConfig | undefined,
	taskOverride: AgentRuntimeConfig,
	frontmatterErrors: AgentRuntimeFieldErrors | undefined,
	registry: RuntimeModelRegistry,
): { runtime?: AgentRuntimeConfig; error?: string } {
	if (frontmatterErrors) {
		for (const field of ["provider", "model", "thinking"] as const) {
			const error = frontmatterErrors[field];
			const providerInferredByHigherModel =
				field === "provider" && (taskOverride.model !== undefined || userOverride?.model !== undefined);
			if (
				error &&
				!providerInferredByHigherModel &&
				taskOverride[field] === undefined &&
				userOverride?.[field] === undefined
			) {
				return { error };
			}
		}
	}
	return validateAgentRuntime(resolveAgentRuntime(agentDefaults, userOverride, taskOverride), registry);
}
