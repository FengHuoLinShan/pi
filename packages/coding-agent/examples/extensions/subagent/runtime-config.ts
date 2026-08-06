import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const MODEL_POLICY_VALUES = ["inherit-parent", "child-default"] as const;

export type ModelPolicy = (typeof MODEL_POLICY_VALUES)[number];

export interface AgentRuntimeConfig {
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	modelPolicy?: ModelPolicy;
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

export interface ParentModelSnapshot {
	provider: string;
	id: string;
}

export type RuntimeDiagnosticCode =
	| "SUBAGENT_MODEL_POLICY_CONFLICT"
	| "SUBAGENT_PARENT_MODEL_UNAVAILABLE"
	| "SUBAGENT_MODEL_NOT_FOUND"
	| "SUBAGENT_MODEL_AUTH_UNAVAILABLE"
	| "SUBAGENT_MODEL_EFFORT_UNSUPPORTED"
	| "SUBAGENT_CHILD_RESOURCE_UNAVAILABLE"
	| "SUBAGENT_PARENT_RUNTIME_ONLY";

export interface RuntimeFailureDiagnostic {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	supportedThinking: readonly ThinkingLevel[];
}

export interface RuntimeThinkingAdjustment {
	from: ThinkingLevel;
	to: ThinkingLevel;
	message: string;
}

export interface RuntimeValidationResult {
	runtime?: AgentRuntimeConfig;
	adjustment?: RuntimeThinkingAdjustment;
	errorCode?: RuntimeDiagnosticCode;
	error?: string;
	diagnostic?: RuntimeFailureDiagnostic;
}

export interface RuntimeValidationOptions {
	parentModel?: ParentModelSnapshot;
	childRegistry?: RuntimeModelRegistry;
}

export interface ChildRuntimePreflightResult {
	registry?: RuntimeModelRegistry;
	errorCode?: RuntimeDiagnosticCode;
	error?: string;
}

const RUNTIME_DIAGNOSTIC_MESSAGES: Record<RuntimeDiagnosticCode, string> = {
	SUBAGENT_MODEL_POLICY_CONFLICT: "Subagent model configuration conflicts with the selected model policy.",
	SUBAGENT_PARENT_MODEL_UNAVAILABLE: "No parent model is active for subagent model inheritance.",
	SUBAGENT_MODEL_NOT_FOUND: "Selected subagent model is not available in the child runtime.",
	SUBAGENT_MODEL_AUTH_UNAVAILABLE: "Selected subagent model has no child-equivalent authentication.",
	SUBAGENT_MODEL_EFFORT_UNSUPPORTED: "Selected subagent model does not support effort.",
	SUBAGENT_CHILD_RESOURCE_UNAVAILABLE: "Child model resources could not be loaded for subagent preflight.",
	SUBAGENT_PARENT_RUNTIME_ONLY:
		"Selected subagent model depends on parent process-local credentials or an extension provider unavailable to the child.",
};

function runtimeFailure(code: RuntimeDiagnosticCode, diagnostic?: RuntimeFailureDiagnostic): RuntimeValidationResult {
	const error = RUNTIME_DIAGNOSTIC_MESSAGES[code];
	return diagnostic ? { errorCode: code, error, diagnostic } : { errorCode: code, error };
}

export function formatRuntimeDiagnostic(result: Pick<RuntimeValidationResult, "errorCode" | "error">): string {
	if (!result.errorCode) return result.error ?? RUNTIME_DIAGNOSTIC_MESSAGES.SUBAGENT_CHILD_RESOURCE_UNAVAILABLE;
	return `${result.errorCode}: ${result.error ?? RUNTIME_DIAGNOSTIC_MESSAGES[result.errorCode]}`;
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

export function isModelPolicy(value: unknown): value is ModelPolicy {
	return typeof value === "string" && MODEL_POLICY_VALUES.includes(value as ModelPolicy);
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
		const modelPolicyValue = value.modelPolicy;
		if (modelPolicyValue !== undefined && !isModelPolicy(modelPolicyValue)) {
			throw new Error(`agents.${name}.modelPolicy must be one of: ${MODEL_POLICY_VALUES.join(", ")}`);
		}
		agents[name] = { provider, model, thinking: thinkingValue, modelPolicy: modelPolicyValue };
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

const EXPLICIT_MODEL_SELECTOR_FIELDS = ["provider", "model"] as const;
const MODEL_SELECTOR_FIELDS = [...EXPLICIT_MODEL_SELECTOR_FIELDS, "modelPolicy"] as const;

interface AgentRuntimeResolution {
	runtime: AgentRuntimeConfig;
	consumedAgentDefaultFields: ReadonlySet<keyof AgentRuntimeConfig>;
}

function resolveAgentRuntimeLayers(
	agentDefaults: AgentRuntimeConfig,
	userOverride: AgentRuntimeConfig | undefined,
	taskOverride: AgentRuntimeConfig,
	isQualifiedModelReference?: (modelReference: string) => boolean,
): AgentRuntimeResolution {
	const layers = [agentDefaults, userOverride, taskOverride];
	let selectorIndex = -1;
	for (let index = layers.length - 1; index >= 0; index--) {
		const layer = layers[index];
		if (layer && MODEL_SELECTOR_FIELDS.some((field) => layer[field] !== undefined)) {
			selectorIndex = index;
			break;
		}
	}
	const selector = selectorIndex >= 0 ? layers[selectorIndex] : undefined;
	const runtime: AgentRuntimeConfig = {};
	const consumedAgentDefaultFields = new Set<keyof AgentRuntimeConfig>();

	if (selector?.modelPolicy !== undefined) {
		runtime.modelPolicy = selector.modelPolicy;
		if (selectorIndex === 0) consumedAgentDefaultFields.add("modelPolicy");
	} else if (selectorIndex >= 0) {
		for (const field of EXPLICIT_MODEL_SELECTOR_FIELDS) {
			for (let index = selectorIndex; index >= 0; index--) {
				const layer = layers[index];
				if (!layer || layer.modelPolicy !== undefined || layer[field] === undefined) continue;
				runtime[field] = layer[field];
				if (index === 0) consumedAgentDefaultFields.add(field);
				break;
			}
		}
		if (
			runtime.provider === undefined &&
			(runtime.model === undefined || !isQualifiedModelReference?.(runtime.model))
		) {
			consumedAgentDefaultFields.add("provider");
		}
		if (runtime.model === undefined) consumedAgentDefaultFields.add("model");
	} else {
		for (const field of MODEL_SELECTOR_FIELDS) consumedAgentDefaultFields.add(field);
	}

	let thinkingIndex = -1;
	for (let index = layers.length - 1; index >= 0; index--) {
		if (layers[index]?.thinking !== undefined) {
			thinkingIndex = index;
			break;
		}
	}
	const lowerThinkingIsDiscarded = selector?.modelPolicy === "child-default" && thinkingIndex < selectorIndex;
	if (thinkingIndex >= 0 && !lowerThinkingIsDiscarded) runtime.thinking = layers[thinkingIndex]?.thinking;
	if (thinkingIndex === 0 || (thinkingIndex < 0 && !lowerThinkingIsDiscarded)) {
		consumedAgentDefaultFields.add("thinking");
	}

	return { runtime, consumedAgentDefaultFields };
}

export function resolveAgentRuntime(
	agentDefaults: AgentRuntimeConfig,
	userOverride: AgentRuntimeConfig | undefined,
	taskOverride: AgentRuntimeConfig,
): AgentRuntimeConfig {
	return resolveAgentRuntimeLayers(agentDefaults, userOverride, taskOverride).runtime;
}

export function buildRuntimeArgs(runtime: AgentRuntimeConfig): string[] {
	const args: string[] = [];
	if (runtime.provider) args.push("--provider", runtime.provider);
	if (runtime.model) args.push("--model", runtime.model);
	if (runtime.thinking) args.push("--thinking", runtime.thinking);
	return args;
}

function parseKnownProviderModelReference(
	modelReference: string,
	models: readonly Model<Api>[],
): { provider: string; modelId: string } | undefined {
	const slashIndex = modelReference.indexOf("/");
	if (slashIndex <= 0 || slashIndex === modelReference.length - 1) return undefined;
	const providerPrefix = modelReference.slice(0, slashIndex);
	const provider = models.find((model) => model.provider.toLowerCase() === providerPrefix.toLowerCase())?.provider;
	if (!provider) return undefined;
	return { provider, modelId: modelReference.slice(slashIndex + 1) };
}

function findConfiguredModel(
	runtime: AgentRuntimeConfig,
	registry: RuntimeModelRegistry,
	configuredModelsSnapshot?: readonly Model<Api>[],
): Model<Api> | undefined {
	if (!runtime.model) return undefined;
	if (runtime.provider) return registry.find(runtime.provider, runtime.model);

	const configuredModels = configuredModelsSnapshot ?? registry.getAll();
	const qualifiedReference = parseKnownProviderModelReference(runtime.model, configuredModels);
	if (qualifiedReference) {
		return registry.find(qualifiedReference.provider, qualifiedReference.modelId);
	}

	const availableMatches = registry.getAvailable().filter((model) => model.id === runtime.model);
	if (availableMatches.length === 1) return availableMatches[0];
	if (availableMatches.length > 1) return undefined;
	const configuredMatches = configuredModels.filter((model) => model.id === runtime.model);
	return configuredMatches.length === 1 ? configuredMatches[0] : undefined;
}

function registryHasAvailableModel(runtime: AgentRuntimeConfig, registry: RuntimeModelRegistry): boolean {
	const model = findConfiguredModel(runtime, registry);
	return Boolean(
		model &&
			registry
				.getAvailable()
				.some((candidate) => candidate.provider === model.provider && candidate.id === model.id),
	);
}

function parentCanRunModel(
	runtime: AgentRuntimeConfig,
	registry: RuntimeModelRegistry,
	parentModel: ParentModelSnapshot | undefined,
): boolean {
	const configured = findConfiguredModel(runtime, registry);
	if (configured && parentModel?.provider === configured.provider && parentModel.id === configured.id) return true;
	return registryHasAvailableModel(runtime, registry);
}

function parentCanRunResolvedModel(
	model: Model<Api>,
	registry: RuntimeModelRegistry,
	parentModel: ParentModelSnapshot | undefined,
): boolean {
	const configured = registry.find(model.provider, model.id);
	if (configured && parentModel?.provider === model.provider && parentModel.id === model.id) return true;
	return registry
		.getAvailable()
		.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
}

function validateAgentRuntimeWithChildModels(
	runtime: AgentRuntimeConfig,
	parentRegistry: RuntimeModelRegistry,
	options: RuntimeValidationOptions,
	configuredChildModelsSnapshot?: readonly Model<Api>[],
	adjustUnsupportedDefaultThinking = false,
): RuntimeValidationResult {
	try {
		const childRegistry = options.childRegistry ?? parentRegistry;
		if (runtime.modelPolicy && (runtime.provider || runtime.model)) {
			return runtimeFailure("SUBAGENT_MODEL_POLICY_CONFLICT");
		}
		if (!runtime.model) {
			if (runtime.provider) return runtimeFailure("SUBAGENT_MODEL_NOT_FOUND");
			if (runtime.modelPolicy === "child-default" && runtime.thinking) {
				return runtimeFailure("SUBAGENT_MODEL_POLICY_CONFLICT");
			}
			if (runtime.modelPolicy === "child-default") {
				if (childRegistry.getAvailable().length === 0) {
					return runtimeFailure("SUBAGENT_MODEL_AUTH_UNAVAILABLE");
				}
				return { runtime: { modelPolicy: "child-default" } };
			}
			return runtimeFailure("SUBAGENT_PARENT_MODEL_UNAVAILABLE");
		}

		const model = findConfiguredModel(runtime, childRegistry, configuredChildModelsSnapshot);
		if (!model) {
			return parentCanRunModel(runtime, parentRegistry, options.parentModel)
				? runtimeFailure("SUBAGENT_PARENT_RUNTIME_ONLY")
				: runtimeFailure("SUBAGENT_MODEL_NOT_FOUND");
		}
		const isAvailable = childRegistry
			.getAvailable()
			.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
		if (!isAvailable) {
			return parentCanRunResolvedModel(model, parentRegistry, options.parentModel)
				? runtimeFailure("SUBAGENT_PARENT_RUNTIME_ONLY")
				: runtimeFailure("SUBAGENT_MODEL_AUTH_UNAVAILABLE");
		}

		const supportedThinking = getSupportedThinkingLevels(model);
		if (runtime.thinking && !supportedThinking.includes(runtime.thinking)) {
			if (adjustUnsupportedDefaultThinking) {
				const adjustedThinking = clampThinkingLevel(model, runtime.thinking);
				return {
					runtime: {
						provider: model.provider,
						model: model.id,
						thinking: adjustedThinking,
						modelPolicy: runtime.modelPolicy,
					},
					adjustment: {
						from: runtime.thinking,
						to: adjustedThinking,
						message: `Adjusted default thinking from ${runtime.thinking} to ${adjustedThinking} for model compatibility.`,
					},
				};
			}
			return runtimeFailure("SUBAGENT_MODEL_EFFORT_UNSUPPORTED", {
				provider: model.provider,
				model: model.id,
				thinking: runtime.thinking,
				supportedThinking,
			});
		}

		return {
			runtime: {
				provider: model.provider,
				model: model.id,
				thinking: runtime.thinking,
				modelPolicy: runtime.modelPolicy,
			},
		};
	} catch {
		return runtimeFailure("SUBAGENT_CHILD_RESOURCE_UNAVAILABLE");
	}
}

export function validateAgentRuntime(
	runtime: AgentRuntimeConfig,
	parentRegistry: RuntimeModelRegistry,
	options: RuntimeValidationOptions = {},
): RuntimeValidationResult {
	return validateAgentRuntimeWithChildModels(runtime, parentRegistry, options);
}

function hasModelPolicyConflict(layer: AgentRuntimeConfig | undefined, fieldErrors?: AgentRuntimeFieldErrors): boolean {
	if (!layer && !fieldErrors) return false;
	const isPresent = (field: keyof AgentRuntimeConfig) =>
		layer?.[field] !== undefined || fieldErrors?.[field] !== undefined;
	const hasPolicy = isPresent("modelPolicy");
	const hasExplicitSelector = EXPLICIT_MODEL_SELECTOR_FIELDS.some(isPresent);
	return hasPolicy && (hasExplicitSelector || (layer?.modelPolicy === "child-default" && isPresent("thinking")));
}

export function resolveAndValidateAgentRuntime(
	agentDefaults: AgentRuntimeConfig,
	userOverride: AgentRuntimeConfig | undefined,
	taskOverride: AgentRuntimeConfig,
	frontmatterErrors: AgentRuntimeFieldErrors | undefined,
	parentRegistry: RuntimeModelRegistry,
	options: RuntimeValidationOptions = {},
): RuntimeValidationResult {
	if (
		hasModelPolicyConflict(agentDefaults, frontmatterErrors) ||
		hasModelPolicyConflict(userOverride) ||
		hasModelPolicyConflict(taskOverride)
	) {
		return runtimeFailure("SUBAGENT_MODEL_POLICY_CONFLICT");
	}
	let resolution: AgentRuntimeResolution;
	let configuredChildModelsSnapshot: Model<Api>[] | undefined;
	try {
		const childRegistry = options.childRegistry ?? parentRegistry;
		resolution = resolveAgentRuntimeLayers(agentDefaults, userOverride, taskOverride, (modelReference) => {
			configuredChildModelsSnapshot ??= childRegistry.getAll();
			return parseKnownProviderModelReference(modelReference, configuredChildModelsSnapshot) !== undefined;
		});
	} catch {
		return runtimeFailure("SUBAGENT_CHILD_RESOURCE_UNAVAILABLE");
	}
	if (frontmatterErrors) {
		for (const field of resolution.consumedAgentDefaultFields) {
			const error = frontmatterErrors[field];
			if (error) return { error };
		}
	}
	const resolved = resolution.runtime;
	let inheritedParent = false;
	if (!resolved.model && !resolved.provider && resolved.modelPolicy !== "child-default") {
		if (!options.parentModel) return runtimeFailure("SUBAGENT_PARENT_MODEL_UNAVAILABLE");
		resolved.provider = options.parentModel.provider;
		resolved.model = options.parentModel.id;
		delete resolved.modelPolicy;
		inheritedParent = true;
	} else if (resolved.model) {
		delete resolved.modelPolicy;
	}
	const validation = validateAgentRuntimeWithChildModels(
		resolved,
		parentRegistry,
		options,
		configuredChildModelsSnapshot,
		taskOverride.thinking === undefined,
	);
	if (inheritedParent && validation.runtime) validation.runtime.modelPolicy = "inherit-parent";
	return validation;
}

export async function createChildRuntimePreflight(agentDir = getAgentDir()): Promise<ChildRuntimePreflightResult> {
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		return {
			registry: {
				getAll: () => [...runtime.getModels()],
				getAvailable: () => [...runtime.getAvailableSnapshot()],
				find: (provider, modelId) => runtime.getModel(provider, modelId),
			},
		};
	} catch {
		return runtimeFailure("SUBAGENT_CHILD_RESOURCE_UNAVAILABLE");
	}
}
