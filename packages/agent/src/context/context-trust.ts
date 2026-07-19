import type { ContextFragment } from "./context-compiler.ts";

/** Authority assigned by the application that obtained the context. */
export type ContextTrustLevel = "trusted" | "partially_trusted" | "untrusted";

/** Whether model-visible text may direct the agent or is only reference material. */
export type ContextRole = "instruction" | "data";

/** Application-assigned disclosure classification. It does not itself grant access. */
export type ContextSensitivity = "public" | "internal" | "confidential" | "restricted";

/** Stable origin metadata supplied by the application. */
export interface ContextSourceLabel {
	kind: string;
	id: string;
	labels?: readonly string[];
}

/** A context fragment with explicit authority and provenance labels. */
export interface LabeledContextFragment extends ContextFragment {
	role: ContextRole;
	trust: ContextTrustLevel;
	sensitivity: ContextSensitivity;
	source: ContextSourceLabel;
}

export type ContextRiskSeverity = "info" | "warning" | "high";

/** A detector observation. Signals are evidence for policy, not a security verdict. */
export interface ContextRiskSignal {
	code: string;
	severity: ContextRiskSeverity;
	message: string;
	start?: number;
	end?: number;
}

export interface DetectedContextRiskSignal extends ContextRiskSignal {
	detectorId: string;
}

/** Detectors are deliberately synchronous, side-effect-free signal producers. */
export interface ContextSignalDetector {
	id: string;
	detect(fragment: Readonly<LabeledContextFragment>): readonly ContextRiskSignal[];
}

export type ContextProtectionAction = "allow" | "drop" | "quarantine" | "escape" | "demote";

export interface ContextTrustPolicyInput {
	fragment: Readonly<LabeledContextFragment>;
	signals: readonly DetectedContextRiskSignal[];
}

export interface ContextTrustPolicyDecision {
	action: ContextProtectionAction;
	/** Stable, human-readable policy rationale recorded in provenance. */
	reason: string;
}

export type ContextTrustPolicy = (input: ContextTrustPolicyInput) => ContextTrustPolicyDecision;

export interface ContextProtectionRequest {
	fragments: readonly LabeledContextFragment[];
	/** Defaults to {@link defaultContextTrustPolicy}. */
	policy?: ContextTrustPolicy;
	/** Defaults to the conservative built-in signal detector. Pass an empty array to disable detection. */
	detectors?: readonly ContextSignalDetector[];
}

/** Model-visible output. It remains structurally compatible with ContextFragment. */
export interface ProtectedContextFragment extends ContextFragment {
	role: ContextRole;
	trust: ContextTrustLevel;
	sensitivity: ContextSensitivity;
	source: ContextSourceLabel;
}

export interface ContextProtectionDiagnostic {
	code: string;
	severity: "info" | "warning" | "error";
	fragmentId: string;
	action: ContextProtectionAction;
	message: string;
	detectorId?: string;
}

export interface ContextProtectionProvenance {
	fragmentId: string;
	source: ContextSourceLabel;
	input: {
		role: ContextRole;
		trust: ContextTrustLevel;
		sensitivity: ContextSensitivity;
		contentLength: number;
	};
	output?: {
		role: ContextRole;
		trust: ContextTrustLevel;
		sensitivity: ContextSensitivity;
		contentLength: number;
	};
	action: ContextProtectionAction;
	reason: string;
	included: boolean;
	contentTransformed: boolean;
	signals: DetectedContextRiskSignal[];
}

/** Deterministic result. Quarantined content is retained for explicit application review. */
export interface ContextProtectionResult {
	revision: 1;
	fragments: ProtectedContextFragment[];
	quarantined: LabeledContextFragment[];
	droppedIds: string[];
	diagnostics: ContextProtectionDiagnostic[];
	provenance: ContextProtectionProvenance[];
}

export type ContextProtectionErrorCode =
	| "invalid_argument"
	| "duplicate_fragment"
	| "invalid_detector"
	| "invalid_policy_decision";

export class ContextProtectionError extends Error {
	public code: ContextProtectionErrorCode;
	public fragmentId?: string;

	constructor(code: ContextProtectionErrorCode, message: string, fragmentId?: string) {
		super(message);
		this.name = "ContextProtectionError";
		this.code = code;
		this.fragmentId = fragmentId;
	}
}

const ACTIONS = ["allow", "drop", "quarantine", "escape", "demote"] as const;
const ROLES = ["instruction", "data"] as const;
const TRUST_LEVELS = ["trusted", "partially_trusted", "untrusted"] as const;
const SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
const SEVERITIES = ["info", "warning", "high"] as const;

/**
 * Fail-closed default policy. Only trusted instructions are admitted. Untrusted
 * data is escaped into an explicit data boundary; detector signals never gain
 * authority and can only cause additional containment.
 */
export const defaultContextTrustPolicy: ContextTrustPolicy = ({ fragment, signals }) => {
	if (fragment.role === "instruction" && fragment.trust !== "trusted") {
		return {
			action: "quarantine",
			reason: "Only trusted context may supply instructions",
		};
	}
	if (hasHighSignal(signals)) {
		return {
			action: fragment.role === "instruction" ? "quarantine" : "escape",
			reason:
				fragment.role === "instruction"
					? "High-risk detector signals require instruction quarantine"
					: "High-risk detector signals require an escaped model-visible boundary",
		};
	}
	if (fragment.role === "data" && (fragment.trust !== "trusted" || hasElevatedSignal(signals))) {
		return {
			action: "escape",
			reason:
				fragment.trust !== "trusted"
					? "Non-trusted data requires an escaped model-visible boundary"
					: "Detector signals require an escaped model-visible boundary",
		};
	}
	return { action: "allow", reason: "Trusted context admitted by default policy" };
};

/**
 * Conservative lexical detector for common instruction-redirection and
 * envelope-breaking patterns. It is intentionally a signal source, not proof
 * that content is safe or malicious.
 */
export const promptInjectionSignalDetector: ContextSignalDetector = {
	id: "prompt-injection-lexical-v1",
	detect(fragment) {
		const patterns: readonly {
			code: string;
			severity: ContextRiskSeverity;
			message: string;
			pattern: RegExp;
		}[] = [
			{
				code: "instruction_redirection",
				severity: "warning",
				message: "Content contains language commonly used to redirect instructions",
				pattern: /\b(?:ignore|disregard|override)\b[^\n]{0,80}\b(?:instruction|prompt|policy|system)\b/i,
			},
			{
				code: "privilege_claim",
				severity: "warning",
				message: "Content contains an embedded privileged-role marker",
				pattern: /(?:^|\n)\s*(?:system|developer|assistant)\s*:/i,
			},
			{
				code: "context_envelope_breakout",
				severity: "high",
				message: "Content contains a context envelope delimiter",
				pattern: /<\/?context_(?:fragment|data_boundary)\b/i,
			},
		];
		const signals: ContextRiskSignal[] = [];
		for (const candidate of patterns) {
			const match = candidate.pattern.exec(fragment.content);
			if (!match || match.index === undefined) continue;
			signals.push({
				code: candidate.code,
				severity: candidate.severity,
				message: candidate.message,
				start: match.index,
				end: match.index + match[0].length,
			});
		}
		return signals;
	},
};

/** Apply detector signals and one explicit policy before context compilation. */
export function protectContext(request: ContextProtectionRequest): ContextProtectionResult {
	if (!request || !Array.isArray(request.fragments)) {
		throw new ContextProtectionError("invalid_argument", "Context protection fragments must be an array");
	}
	const policy = request.policy ?? defaultContextTrustPolicy;
	if (typeof policy !== "function") {
		throw new ContextProtectionError("invalid_argument", "Context trust policy must be a function");
	}
	const detectors = normalizeDetectors(request.detectors ?? [promptInjectionSignalDetector]);
	const fragments = normalizeFragments(request.fragments);
	const protectedFragments: ProtectedContextFragment[] = [];
	const quarantined: LabeledContextFragment[] = [];
	const droppedIds: string[] = [];
	const diagnostics: ContextProtectionDiagnostic[] = [];
	const provenance: ContextProtectionProvenance[] = [];

	for (const fragment of fragments) {
		const signals = detectSignals(fragment, detectors);
		const decision = normalizeDecision(policy({ fragment: cloneFragment(fragment), signals }), fragment.id);
		const output = applyDecision(fragment, decision.action);

		if (decision.action === "quarantine") quarantined.push(cloneFragment(fragment));
		else if (decision.action === "drop") droppedIds.push(fragment.id);
		else if (output) protectedFragments.push(output);

		diagnostics.push({
			code: `context_${decision.action}`,
			severity: decision.action === "quarantine" ? "error" : decision.action === "allow" ? "info" : "warning",
			fragmentId: fragment.id,
			action: decision.action,
			message: decision.reason,
		});
		for (const signal of signals) {
			diagnostics.push({
				code: signal.code,
				severity: signal.severity === "high" ? "error" : signal.severity,
				fragmentId: fragment.id,
				action: decision.action,
				message: signal.message,
				detectorId: signal.detectorId,
			});
		}
		provenance.push({
			fragmentId: fragment.id,
			source: cloneSource(fragment.source),
			input: tagsAndLength(fragment),
			output: output ? tagsAndLength(output) : undefined,
			action: decision.action,
			reason: decision.reason,
			included: output !== undefined,
			contentTransformed: output !== undefined && output.content !== fragment.content,
			signals: signals.map((signal) => ({ ...signal })),
		});
	}

	return {
		revision: 1,
		fragments: protectedFragments,
		quarantined,
		droppedIds,
		diagnostics,
		provenance,
	};
}

function normalizeFragments(fragments: readonly LabeledContextFragment[]): LabeledContextFragment[] {
	const ids = new Set<string>();
	return fragments.map((fragment) => {
		if (!isPlainObject(fragment)) {
			throw new ContextProtectionError("invalid_argument", "Context fragment must be an object");
		}
		assertSingleLineNonEmpty(fragment.id, "Context fragment id", fragment.id);
		if (ids.has(fragment.id)) {
			throw new ContextProtectionError(
				"duplicate_fragment",
				`Duplicate context fragment id: ${fragment.id}`,
				fragment.id,
			);
		}
		ids.add(fragment.id);
		if (!(ROLES as readonly string[]).includes(fragment.role)) {
			throw new ContextProtectionError("invalid_argument", `Invalid context role: ${fragment.role}`, fragment.id);
		}
		if (!(TRUST_LEVELS as readonly string[]).includes(fragment.trust)) {
			throw new ContextProtectionError(
				"invalid_argument",
				`Invalid context trust level: ${fragment.trust}`,
				fragment.id,
			);
		}
		if (!(SENSITIVITIES as readonly string[]).includes(fragment.sensitivity)) {
			throw new ContextProtectionError(
				"invalid_argument",
				`Invalid context sensitivity: ${fragment.sensitivity}`,
				fragment.id,
			);
		}
		if (typeof fragment.content !== "string") {
			throw new ContextProtectionError(
				"invalid_argument",
				`Context fragment ${fragment.id} content must be a string`,
				fragment.id,
			);
		}
		return cloneFragment(fragment);
	});
}

function normalizeDetectors(detectors: readonly ContextSignalDetector[]): ContextSignalDetector[] {
	const ids = new Set<string>();
	return detectors.map((detector) => {
		if (!detector || typeof detector.detect !== "function") {
			throw new ContextProtectionError("invalid_detector", "Context detector must provide a detect function");
		}
		assertSingleLineNonEmpty(detector.id, "Context detector id");
		if (ids.has(detector.id)) {
			throw new ContextProtectionError("invalid_detector", `Duplicate context detector id: ${detector.id}`);
		}
		ids.add(detector.id);
		return detector;
	});
}

function detectSignals(
	fragment: LabeledContextFragment,
	detectors: readonly ContextSignalDetector[],
): DetectedContextRiskSignal[] {
	const signals: DetectedContextRiskSignal[] = [];
	for (const detector of detectors) {
		const detected = detector.detect(cloneFragment(fragment));
		if (!Array.isArray(detected)) {
			throw new ContextProtectionError(
				"invalid_detector",
				`Context detector ${detector.id} must return an array`,
				fragment.id,
			);
		}
		for (const signal of detected) {
			if (!isPlainObject(signal)) {
				throw new ContextProtectionError(
					"invalid_detector",
					`Context detector ${detector.id} must return signal objects`,
					fragment.id,
				);
			}
			const normalizedSignal = signal as unknown as ContextRiskSignal;
			assertSingleLineNonEmpty(normalizedSignal.code, `Context detector ${detector.id} signal code`, fragment.id);
			assertSingleLineNonEmpty(
				normalizedSignal.message,
				`Context detector ${detector.id} signal message`,
				fragment.id,
			);
			if (!(SEVERITIES as readonly string[]).includes(normalizedSignal.severity)) {
				throw new ContextProtectionError(
					"invalid_detector",
					`Context detector ${detector.id} returned invalid severity: ${normalizedSignal.severity}`,
					fragment.id,
				);
			}
			validateSpan(normalizedSignal, fragment.content.length, detector.id, fragment.id);
			signals.push({ ...normalizedSignal, detectorId: detector.id });
		}
	}
	return signals.sort(compareSignals);
}

function normalizeDecision(decision: ContextTrustPolicyDecision, fragmentId: string): ContextTrustPolicyDecision {
	if (!decision || !(ACTIONS as readonly string[]).includes(decision.action)) {
		throw new ContextProtectionError(
			"invalid_policy_decision",
			`Context policy returned an invalid action for fragment ${fragmentId}`,
			fragmentId,
		);
	}
	assertSingleLineNonEmpty(decision.reason, "Context policy decision reason", fragmentId);
	return { action: decision.action, reason: decision.reason };
}

function applyDecision(
	fragment: LabeledContextFragment,
	action: ContextProtectionAction,
): ProtectedContextFragment | undefined {
	if (action === "drop" || action === "quarantine") return undefined;
	if (action === "allow") return cloneFragment(fragment);
	const role: ContextRole = action === "demote" ? "data" : fragment.role;
	return {
		...cloneFragment(fragment),
		role,
		content: renderEscapedBoundary(fragment, role, action),
	};
}

function renderEscapedBoundary(
	fragment: LabeledContextFragment,
	role: ContextRole,
	action: "escape" | "demote",
): string {
	return `<context_data_boundary action="${action}" role="${role}" trust="${fragment.trust}" sensitivity="${fragment.sensitivity}" source_kind="${escapeXmlAttribute(fragment.source.kind)}" source_id="${escapeXmlAttribute(fragment.source.id)}">\n${escapeXmlText(fragment.content)}\n</context_data_boundary>`;
}

function tagsAndLength(fragment: LabeledContextFragment): ContextProtectionProvenance["input"] {
	return {
		role: fragment.role,
		trust: fragment.trust,
		sensitivity: fragment.sensitivity,
		contentLength: fragment.content.length,
	};
}

function cloneFragment<T extends LabeledContextFragment>(fragment: T): T {
	return {
		...fragment,
		evidenceIds: fragment.evidenceIds ? [...fragment.evidenceIds] : undefined,
		source: cloneSource(fragment.source),
	};
}

function cloneSource(source: ContextSourceLabel): ContextSourceLabel {
	if (!isPlainObject(source)) {
		throw new ContextProtectionError("invalid_argument", "Context source must be an object");
	}
	assertSingleLineNonEmpty(source.kind, "Context source kind");
	assertSingleLineNonEmpty(source.id, "Context source id");
	if (source.labels !== undefined && !Array.isArray(source.labels)) {
		throw new ContextProtectionError("invalid_argument", "Context source labels must be an array");
	}
	const labels = [...new Set(source.labels ?? [])].sort(compareStrings);
	for (const label of labels) assertSingleLineNonEmpty(label, "Context source label");
	return { kind: source.kind, id: source.id, labels };
}

function validateSpan(signal: ContextRiskSignal, contentLength: number, detectorId: string, fragmentId: string): void {
	if (signal.start === undefined && signal.end === undefined) return;
	if (
		signal.start === undefined ||
		signal.end === undefined ||
		!Number.isInteger(signal.start) ||
		!Number.isInteger(signal.end) ||
		signal.start < 0 ||
		signal.end <= signal.start ||
		signal.end > contentLength
	) {
		throw new ContextProtectionError(
			"invalid_detector",
			`Context detector ${detectorId} returned an invalid signal span`,
			fragmentId,
		);
	}
}

function hasElevatedSignal(signals: readonly DetectedContextRiskSignal[]): boolean {
	return signals.some((signal) => signal.severity === "warning" || signal.severity === "high");
}

function hasHighSignal(signals: readonly DetectedContextRiskSignal[]): boolean {
	return signals.some((signal) => signal.severity === "high");
}

function compareSignals(left: DetectedContextRiskSignal, right: DetectedContextRiskSignal): number {
	return (
		compareStrings(left.detectorId, right.detectorId) ||
		compareStrings(left.code, right.code) ||
		(left.start ?? -1) - (right.start ?? -1) ||
		(left.end ?? -1) - (right.end ?? -1)
	);
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replace(/"/g, "&quot;");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertSingleLineNonEmpty(value: string, label: string, fragmentId?: string): void {
	if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
		throw new ContextProtectionError(
			"invalid_argument",
			`${label} must be a non-empty single-line string`,
			fragmentId,
		);
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
