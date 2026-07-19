import type {
	CapabilityProfile,
	CapabilitySupport,
	DeferredToolLoading,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export type ModelRouteAvailability = "available" | "degraded" | "unavailable";
export type UnknownCapabilityPolicy = "reject" | "allow";

export interface ModelRouteCandidate {
	id: string;
	profile: CapabilityProfile;
	availability?: ModelRouteAvailability;
	/** Lower values are preferred. Default: 0. */
	priority?: number;
	/** Caller-computed preference; higher values win after priority. Default: 0. */
	preferenceScore?: number;
	labels?: readonly string[];
}

export interface ModelToolRouteRequirements {
	required?: boolean;
	strictMode?: boolean;
	deferredLoading?: "any" | Exclude<DeferredToolLoading, "none">;
}

export interface ModelRouteRequirements {
	modalities?: readonly ("text" | "image")[];
	reasoningLevel?: ModelThinkingLevel;
	minContextWindow?: number;
	minOutputTokens?: number;
	tools?: ModelToolRouteRequirements;
	allowedProviders?: readonly string[];
	excludedCandidateIds?: readonly string[];
	allowDegraded?: boolean;
	unknownCapabilities?: UnknownCapabilityPolicy;
}

export interface RouteModelsOptions {
	requestId: string;
	candidates: readonly ModelRouteCandidate[];
	requirements?: ModelRouteRequirements;
	/** Maximum selected plus fallback candidates. Default: all eligible candidates. */
	maxCandidates?: number;
}

export type ModelRouteIssueCode =
	| "unavailable"
	| "degraded"
	| "candidate_excluded"
	| "provider_not_allowed"
	| "modality_missing"
	| "reasoning_unsupported"
	| "reasoning_level_unsupported"
	| "context_window_too_small"
	| "output_limit_too_small"
	| "tools_unsupported"
	| "tools_unknown"
	| "strict_tools_unsupported"
	| "strict_tools_unknown"
	| "deferred_tools_unsupported";

export interface ModelRouteIssue {
	code: ModelRouteIssueCode;
	severity: "warning" | "rejection";
	message: string;
}

export interface ModelRouteEvaluation {
	candidate: ModelRouteCandidate;
	eligible: boolean;
	issues: ModelRouteIssue[];
}

export interface ModelRoutePlan {
	version: 1;
	requestId: string;
	selected?: ModelRouteCandidate;
	fallbacks: ModelRouteCandidate[];
	evaluations: ModelRouteEvaluation[];
}

export type ModelRoutingErrorCode = "invalid_request" | "invalid_candidate";

export class ModelRoutingError extends Error {
	public code: ModelRoutingErrorCode;

	constructor(code: ModelRoutingErrorCode, message: string) {
		super(message);
		this.name = "ModelRoutingError";
		this.code = code;
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function requireNonEmpty(value: unknown, label: string, code: ModelRoutingErrorCode): asserts value is string {
	if (typeof value !== "string" || value.trim() === "")
		throw new ModelRoutingError(code, `${label} must not be empty`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function cloneProfile(profile: CapabilityProfile): CapabilityProfile {
	return {
		...profile,
		input: { modalities: [...profile.input.modalities] },
		reasoning: { ...profile.reasoning, levels: [...profile.reasoning.levels] },
		limits: { ...profile.limits },
		tools: { ...profile.tools },
	};
}

function cloneCandidate(candidate: ModelRouteCandidate): ModelRouteCandidate {
	return {
		...candidate,
		profile: cloneProfile(candidate.profile),
		labels: candidate.labels ? [...new Set(candidate.labels)].sort(compareStrings) : undefined,
	};
}

function validateCapabilitySupport(value: CapabilitySupport, label: string): void {
	if (value !== "supported" && value !== "unsupported" && value !== "unknown") {
		throw new ModelRoutingError("invalid_candidate", `${label} is invalid`);
	}
}

function validateCandidate(candidate: ModelRouteCandidate): ModelRouteCandidate {
	if (!isPlainObject(candidate)) {
		throw new ModelRoutingError("invalid_candidate", "Model route candidate must be an object");
	}
	requireNonEmpty(candidate.id, "Model route candidate id", "invalid_candidate");
	if (!isPlainObject(candidate.profile) || candidate.profile.version !== 1) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has an invalid capability profile`);
	}
	requireNonEmpty(candidate.profile.provider, `Candidate ${candidate.id} provider`, "invalid_candidate");
	requireNonEmpty(candidate.profile.model, `Candidate ${candidate.id} model`, "invalid_candidate");
	requireNonEmpty(candidate.profile.api, `Candidate ${candidate.id} API`, "invalid_candidate");
	if (
		!isPlainObject(candidate.profile.input) ||
		!Array.isArray(candidate.profile.input.modalities) ||
		candidate.profile.input.modalities.length === 0 ||
		candidate.profile.input.modalities.some((modality) => modality !== "text" && modality !== "image")
	) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has invalid input modalities`);
	}
	if (
		!isPlainObject(candidate.profile.reasoning) ||
		typeof candidate.profile.reasoning.supported !== "boolean" ||
		!Array.isArray(candidate.profile.reasoning.levels) ||
		!candidate.profile.reasoning.levels.includes("off") ||
		candidate.profile.reasoning.levels.some(
			(level) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
		) ||
		new Set(candidate.profile.reasoning.levels).size !== candidate.profile.reasoning.levels.length ||
		(!candidate.profile.reasoning.supported && candidate.profile.reasoning.levels.some((level) => level !== "off"))
	) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has invalid reasoning capabilities`);
	}
	if (
		!isPlainObject(candidate.profile.limits) ||
		!Number.isSafeInteger(candidate.profile.limits.contextWindow) ||
		candidate.profile.limits.contextWindow <= 0 ||
		!Number.isSafeInteger(candidate.profile.limits.maxOutputTokens) ||
		candidate.profile.limits.maxOutputTokens <= 0
	) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has invalid token limits`);
	}
	if (!isPlainObject(candidate.profile.tools)) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has invalid tool capabilities`);
	}
	validateCapabilitySupport(candidate.profile.tools.support, `Candidate ${candidate.id} tool support`);
	validateCapabilitySupport(candidate.profile.tools.strictMode, `Candidate ${candidate.id} strict tool support`);
	if (
		candidate.profile.tools.schemaTarget !== "json-schema" &&
		candidate.profile.tools.schemaTarget !== "openapi-3.0" &&
		candidate.profile.tools.schemaTarget !== "anthropic-input-schema"
	) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has invalid tool schema target`);
	}
	if (
		candidate.profile.tools.deferredLoading !== "none" &&
		candidate.profile.tools.deferredLoading !== "native" &&
		candidate.profile.tools.deferredLoading !== "transcript"
	) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has invalid deferred tool loading`);
	}
	if (
		candidate.availability !== undefined &&
		!["available", "degraded", "unavailable"].includes(candidate.availability)
	) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} has invalid availability`);
	}
	for (const [label, value] of [
		["priority", candidate.priority],
		["preference score", candidate.preferenceScore],
	] as const) {
		if (value !== undefined && !Number.isFinite(value)) {
			throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} ${label} must be finite`);
		}
	}
	if (candidate.labels !== undefined && !Array.isArray(candidate.labels)) {
		throw new ModelRoutingError("invalid_candidate", `Candidate ${candidate.id} labels must be an array`);
	}
	for (const label of candidate.labels ?? []) {
		requireNonEmpty(label, `Candidate ${candidate.id} label`, "invalid_candidate");
	}
	return cloneCandidate(candidate);
}

function validateRequirements(requirements: ModelRouteRequirements | undefined): ModelRouteRequirements {
	if (requirements === undefined) return {};
	if (!isPlainObject(requirements)) {
		throw new ModelRoutingError("invalid_request", "Model route requirements must be an object");
	}
	const normalized = requirements as unknown as ModelRouteRequirements;
	if (
		(normalized.modalities !== undefined &&
			(!Array.isArray(normalized.modalities) ||
				normalized.modalities.some((modality) => modality !== "text" && modality !== "image"))) ||
		(normalized.reasoningLevel !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized.reasoningLevel))
	) {
		throw new ModelRoutingError("invalid_request", "Model route requirements contain an invalid capability value");
	}
	validatePositiveInteger(normalized.minContextWindow, "Minimum context window");
	validatePositiveInteger(normalized.minOutputTokens, "Minimum output tokens");
	if (normalized.allowDegraded !== undefined && typeof normalized.allowDegraded !== "boolean") {
		throw new ModelRoutingError("invalid_request", "allowDegraded must be boolean");
	}
	for (const [label, values] of [
		["Allowed providers", normalized.allowedProviders],
		["Excluded candidates", normalized.excludedCandidateIds],
	] as const) {
		if (
			values !== undefined &&
			(!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim() === ""))
		) {
			throw new ModelRoutingError("invalid_request", `${label} must contain non-empty strings`);
		}
	}
	if (normalized.tools !== undefined && !isPlainObject(normalized.tools)) {
		throw new ModelRoutingError("invalid_request", "Model tool-route requirements must be an object");
	}
	const tools = normalized.tools as ModelToolRouteRequirements | undefined;
	if (
		(tools?.required !== undefined && typeof tools.required !== "boolean") ||
		(tools?.strictMode !== undefined && typeof tools.strictMode !== "boolean") ||
		(tools?.deferredLoading !== undefined && !["any", "native", "transcript"].includes(tools.deferredLoading))
	) {
		throw new ModelRoutingError("invalid_request", "Model tool-route requirements are invalid");
	}
	if (
		normalized.unknownCapabilities !== undefined &&
		normalized.unknownCapabilities !== "reject" &&
		normalized.unknownCapabilities !== "allow"
	) {
		throw new ModelRoutingError("invalid_request", "Unknown-capability policy is invalid");
	}
	return normalized;
}

function validatePositiveInteger(value: number | undefined, label: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new ModelRoutingError("invalid_request", `${label} must be a positive integer`);
	}
}

function capabilityIssue(
	support: CapabilitySupport,
	unknownPolicy: UnknownCapabilityPolicy,
	unsupported: { code: ModelRouteIssueCode; message: string },
	unknown: { code: ModelRouteIssueCode; message: string },
): ModelRouteIssue | undefined {
	if (support === "unsupported") return { ...unsupported, severity: "rejection" };
	if (support === "unknown") {
		return { ...unknown, severity: unknownPolicy === "allow" ? "warning" : "rejection" };
	}
	return undefined;
}

function evaluateCandidate(candidate: ModelRouteCandidate, requirements: ModelRouteRequirements): ModelRouteEvaluation {
	const issues: ModelRouteIssue[] = [];
	const availability = candidate.availability ?? "available";
	if (availability === "unavailable") {
		issues.push({ code: "unavailable", severity: "rejection", message: "Candidate is unavailable" });
	} else if (availability === "degraded") {
		issues.push({
			code: "degraded",
			severity: requirements.allowDegraded ? "warning" : "rejection",
			message: "Candidate is degraded",
		});
	}
	if (requirements.excludedCandidateIds?.includes(candidate.id)) {
		issues.push({ code: "candidate_excluded", severity: "rejection", message: "Candidate was explicitly excluded" });
	}
	if (requirements.allowedProviders && !requirements.allowedProviders.includes(candidate.profile.provider)) {
		issues.push({
			code: "provider_not_allowed",
			severity: "rejection",
			message: `Provider ${candidate.profile.provider} is not allowed`,
		});
	}
	for (const modality of requirements.modalities ?? []) {
		if (!candidate.profile.input.modalities.includes(modality)) {
			issues.push({
				code: "modality_missing",
				severity: "rejection",
				message: `Required ${modality} input is unsupported`,
			});
		}
	}
	const reasoningLevel = requirements.reasoningLevel;
	if (reasoningLevel && reasoningLevel !== "off") {
		if (!candidate.profile.reasoning.supported) {
			issues.push({
				code: "reasoning_unsupported",
				severity: "rejection",
				message: "Reasoning is unsupported",
			});
		} else if (!candidate.profile.reasoning.levels.includes(reasoningLevel)) {
			issues.push({
				code: "reasoning_level_unsupported",
				severity: "rejection",
				message: `Reasoning level ${reasoningLevel} is unsupported`,
			});
		}
	}
	if (
		requirements.minContextWindow !== undefined &&
		candidate.profile.limits.contextWindow < requirements.minContextWindow
	) {
		issues.push({
			code: "context_window_too_small",
			severity: "rejection",
			message: `Context window ${candidate.profile.limits.contextWindow} is below ${requirements.minContextWindow}`,
		});
	}
	if (
		requirements.minOutputTokens !== undefined &&
		candidate.profile.limits.maxOutputTokens < requirements.minOutputTokens
	) {
		issues.push({
			code: "output_limit_too_small",
			severity: "rejection",
			message: `Output limit ${candidate.profile.limits.maxOutputTokens} is below ${requirements.minOutputTokens}`,
		});
	}
	const unknownPolicy = requirements.unknownCapabilities ?? "reject";
	if (requirements.tools?.required || requirements.tools?.strictMode || requirements.tools?.deferredLoading) {
		const issue = capabilityIssue(
			candidate.profile.tools.support,
			unknownPolicy,
			{ code: "tools_unsupported", message: "Tool calls are unsupported" },
			{ code: "tools_unknown", message: "Tool-call support is unknown" },
		);
		if (issue) issues.push(issue);
	}
	if (requirements.tools?.strictMode) {
		const issue = capabilityIssue(
			candidate.profile.tools.strictMode,
			unknownPolicy,
			{ code: "strict_tools_unsupported", message: "Strict tool schemas are unsupported" },
			{ code: "strict_tools_unknown", message: "Strict tool-schema support is unknown" },
		);
		if (issue) issues.push(issue);
	}
	const deferred = requirements.tools?.deferredLoading;
	if (
		deferred &&
		(deferred === "any"
			? candidate.profile.tools.deferredLoading === "none"
			: candidate.profile.tools.deferredLoading !== deferred)
	) {
		issues.push({
			code: "deferred_tools_unsupported",
			severity: "rejection",
			message: `Deferred tool loading ${deferred} is unsupported`,
		});
	}
	return { candidate, eligible: !issues.some((issue) => issue.severity === "rejection"), issues };
}

/** Build a deterministic route plan. This function never invokes a provider. */
export function routeModels(options: RouteModelsOptions): ModelRoutePlan {
	if (!isPlainObject(options)) {
		throw new ModelRoutingError("invalid_request", "Model routing options must be an object");
	}
	requireNonEmpty(options.requestId, "Model route request id", "invalid_request");
	if (!Array.isArray(options.candidates) || options.candidates.length === 0) {
		throw new ModelRoutingError("invalid_request", "Model routing requires at least one candidate");
	}
	validatePositiveInteger(options.maxCandidates, "maxCandidates");
	const requirements = validateRequirements(options.requirements);
	const ids = new Set<string>();
	const candidates = options.candidates.map((candidate) => {
		const normalized = validateCandidate(candidate);
		if (ids.has(normalized.id)) {
			throw new ModelRoutingError("invalid_candidate", `Duplicate model route candidate id: ${normalized.id}`);
		}
		ids.add(normalized.id);
		return normalized;
	});
	const evaluations = candidates.map((candidate) => evaluateCandidate(candidate, requirements));
	const eligible = evaluations
		.filter((evaluation) => evaluation.eligible)
		.map((evaluation) => evaluation.candidate)
		.sort(
			(left, right) =>
				(left.priority ?? 0) - (right.priority ?? 0) ||
				(right.preferenceScore ?? 0) - (left.preferenceScore ?? 0) ||
				compareStrings(left.profile.provider, right.profile.provider) ||
				compareStrings(left.profile.model, right.profile.model) ||
				compareStrings(left.id, right.id),
		);
	const routed = eligible.slice(0, options.maxCandidates ?? eligible.length);
	return {
		version: 1,
		requestId: options.requestId,
		selected: routed[0],
		fallbacks: routed.slice(1),
		evaluations,
	};
}
