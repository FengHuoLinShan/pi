import type { BeforeToolCallContext, BeforeToolCallResult } from "./types.ts";

/** Coarse risk classification declared by a tool author. Policy determines what each level means. */
export type ToolRiskLevel = "low" | "medium" | "high" | "critical";

/** Observable effects a tool may produce. */
export type ToolSideEffect = "none" | "read_state" | "write_state" | "execute_code" | "network" | "external_state";

/** Access requested for a resource. Resource kinds and locators are application-defined. */
export type ToolResourceAccess = "read" | "write" | "execute" | "connect" | "admin";

export interface ToolResourceDeclaration {
	/** Application-defined resource namespace, for example `filesystem` or `database`. */
	readonly kind: string;
	/** Access modes this tool may request. */
	readonly access: readonly ToolResourceAccess[];
	/** Static locator, when every invocation uses the same resource. */
	readonly locator?: string;
	/** Whether the concrete locator is resolved from invocation arguments. */
	readonly dynamic?: boolean;
}

export interface ToolPermissionDeclaration {
	/** Stable application-defined permission identifier. */
	readonly id: string;
	/** Human-readable explanation suitable for an approval surface. */
	readonly description: string;
	/** Optional application-defined scope label. */
	readonly scope?: string;
}

/**
 * Serializable security metadata for one tool revision.
 *
 * ToolSpec describes potential behavior; it does not grant authority and is not
 * a sandbox. Keep argument-dependent resolution outside this data structure.
 */
export interface ToolSpec {
	readonly name: string;
	/** Changes whenever security-relevant behavior or declarations change. */
	readonly revision: string;
	/** Whether an interrupted invocation may be explicitly retried without duplicating side effects. */
	readonly retrySafe: boolean;
	readonly risk: {
		readonly level: ToolRiskLevel;
		readonly rationale?: readonly string[];
	};
	readonly sideEffects: readonly ToolSideEffect[];
	readonly resources: readonly ToolResourceDeclaration[];
	readonly permissions: readonly ToolPermissionDeclaration[];
	readonly tags?: readonly string[];
}

/** Concrete resource resolved for one invocation. */
export interface ToolInvocationResource {
	kind: string;
	access: ToolResourceAccess;
	locator?: string;
}

/** Runtime facts evaluated by the policy engine. */
export interface ToolPolicyInvocation {
	toolCallId: string;
	toolName: string;
	arguments: unknown;
	sessionId?: string;
	resources?: readonly ToolInvocationResource[];
	/** SHA-256 binding of the canonical tool name, arguments, and resolved resources. */
	resolvedCallHash?: string;
}

export type ToolPolicyEffect = "allow" | "deny" | "require_approval";
export type ApprovalScopeKind = "call" | "tool" | "session";

export interface ToolApprovalRequirement {
	/** Maximum lifetime of requests and grants created for this decision. */
	expiresInMs: number;
	/** Authority represented by a resulting grant. */
	scope: ApprovalScopeKind;
	/** Consume the grant after its first successful use. */
	oneShot: boolean;
}

/** All populated match fields must match. Array fields use explicit any/all semantics. */
export interface ToolPolicyRuleMatch {
	toolNames?: readonly string[];
	riskLevels?: readonly ToolRiskLevel[];
	sideEffectsAny?: readonly ToolSideEffect[];
	sideEffectsAll?: readonly ToolSideEffect[];
	resourceKindsAny?: readonly string[];
	resourceAccessAny?: readonly ToolResourceAccess[];
	permissionIdsAny?: readonly string[];
	permissionIdsAll?: readonly string[];
	tagsAny?: readonly string[];
	tagsAll?: readonly string[];
}

export interface ToolPolicyRule {
	id: string;
	/** Higher priority wins; ties are broken by rule id in code-point order. */
	priority?: number;
	effect: ToolPolicyEffect;
	reason: string;
	match?: ToolPolicyRuleMatch;
	/** Required exactly when effect is `require_approval`. */
	approval?: ToolApprovalRequirement;
}

export interface ToolPolicyDefault {
	effect: ToolPolicyEffect;
	reason: string;
	approval?: ToolApprovalRequirement;
}

/** Serializable, deterministic policy definition. */
export interface ToolPolicy {
	revision: string;
	rules: readonly ToolPolicyRule[];
	default: ToolPolicyDefault;
	/** Missing ToolSpec declarations fail closed unless this is explicitly `use_default`. */
	missingSpec?: "deny" | "use_default";
}

export interface ToolPolicyDecision {
	decision: ToolPolicyEffect;
	reason: string;
	policyRevision: string;
	toolName: string;
	toolSpecRevision?: string;
	ruleId?: string;
	approval?: ToolApprovalRequirement;
}

export type ApprovalScope =
	| { kind: "call"; toolName: string; toolCallId: string }
	| { kind: "tool"; toolName: string }
	| { kind: "session"; toolName: string; sessionId: string };

/** Serializable approval prompt payload. UI and transport layers own presentation. */
export interface ApprovalRequest {
	revision: 1;
	id: string;
	createdAt: number;
	expiresAt: number;
	policyRevision: string;
	toolSpecRevision: string;
	ruleId?: string;
	toolCallId: string;
	toolName: string;
	resolvedCallHash: string;
	reason: string;
	scope: ApprovalScope;
	oneShot: boolean;
	resources: readonly ToolInvocationResource[];
}

/** Serializable authority issued in response to an ApprovalRequest. */
export interface ApprovalGrant {
	revision: 1;
	id: string;
	requestId: string;
	issuedAt: number;
	expiresAt: number;
	policyRevision: string;
	toolSpecRevision: string;
	resolvedCallHash: string;
	ruleId?: string;
	scope: ApprovalScope;
	oneShot: boolean;
}

export interface ApprovalGrantStoreSnapshot {
	revision: 1;
	grants: ApprovalGrant[];
	consumedGrantIds: string[];
}

export interface ApprovalGrantStore {
	list(): readonly ApprovalGrant[];
	add(grant: ApprovalGrant): void;
	isConsumed(grantId: string): boolean;
	consume(grantId: string): void;
	snapshot(): ApprovalGrantStoreSnapshot;
}

/** In-memory implementation whose snapshot can be persisted by an application. */
export class InMemoryApprovalGrantStore implements ApprovalGrantStore {
	private readonly grants = new Map<string, ApprovalGrant>();
	private readonly consumed = new Set<string>();

	constructor(snapshot?: ApprovalGrantStoreSnapshot) {
		if (!snapshot) return;
		if (snapshot.revision !== 1) throw new Error(`Unsupported approval store revision: ${snapshot.revision}`);
		for (const grant of snapshot.grants) this.add(grant);
		for (const grantId of snapshot.consumedGrantIds) {
			if (!this.grants.has(grantId)) throw new Error(`Consumed approval grant not found: ${grantId}`);
			this.consumed.add(grantId);
		}
	}

	list(): readonly ApprovalGrant[] {
		return structuredClone([...this.grants.values()].sort((left, right) => compareStrings(left.id, right.id)));
	}

	add(grant: ApprovalGrant): void {
		validateApprovalGrantShape(grant);
		const existing = this.grants.get(grant.id);
		if (existing && JSON.stringify(existing) !== JSON.stringify(grant)) {
			throw new Error(`Approval grant id already exists with different contents: ${grant.id}`);
		}
		this.grants.set(grant.id, structuredClone(grant));
	}

	isConsumed(grantId: string): boolean {
		return this.consumed.has(grantId);
	}

	consume(grantId: string): void {
		if (!this.grants.has(grantId)) throw new Error(`Approval grant not found: ${grantId}`);
		this.consumed.add(grantId);
	}

	snapshot(): ApprovalGrantStoreSnapshot {
		return {
			revision: 1,
			grants: structuredClone([...this.grants.values()].sort((left, right) => compareStrings(left.id, right.id))),
			consumedGrantIds: [...this.consumed].sort(compareStrings),
		};
	}
}

export interface CreateApprovalRequestOptions {
	id: string;
	now: number;
}

export interface CreateApprovalGrantOptions {
	id: string;
	issuedAt: number;
	/** Defaults to the request expiry and may not exceed it. */
	expiresAt?: number;
}

export type ApprovalValidationResult = { valid: true } | { valid: false; reason: string };

export interface ToolPolicyAuthorization {
	allowed: boolean;
	decision: ToolPolicyDecision;
	reason?: string;
	approvalRequest?: ApprovalRequest;
	approvalGrantId?: string;
}

export type ToolSpecResolver = (toolName: string) => ToolSpec | undefined;

export interface ToolPolicyAdapterInvocationContext {
	sessionId?: string;
	resources?: readonly ToolInvocationResource[];
}

export interface ToolPolicyAdapterOptions {
	policy: ToolPolicy;
	specs: readonly ToolSpec[] | ToolSpecResolver;
	grantStore?: ApprovalGrantStore;
	/** Resolve argument-dependent resources or session identity. */
	resolveInvocation?: (
		context: BeforeToolCallContext,
	) => ToolPolicyAdapterInvocationContext | Promise<ToolPolicyAdapterInvocationContext>;
	/**
	 * External approval transport. The core does not render UI. Returning undefined
	 * declines the request. The returned grant is validated before use.
	 */
	requestApproval?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalGrant | undefined>;
	now?: () => number;
	createRequestId?: (decision: ToolPolicyDecision, invocation: ToolPolicyInvocation) => string;
}

export interface ToolPolicyAdapter {
	readonly grantStore: ApprovalGrantStore;
	/** Return a validated defensive copy of the registered spec. */
	getSpec(toolName: string): ToolSpec | undefined;
	authorizeInvocation(invocation: ToolPolicyInvocation, signal?: AbortSignal): Promise<ToolPolicyAuthorization>;
	authorize(
		context: BeforeToolCallContext,
		signal?: AbortSignal,
		invocationContext?: ToolPolicyAdapterInvocationContext,
	): Promise<ToolPolicyAuthorization>;
	beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined>;
}

/**
 * Bind an approval to the exact resolved action without retaining its arguments.
 * Tool call and session identifiers are deliberately excluded because approval
 * scope already controls where the resulting authority may be reused.
 */
export async function hashToolPolicyInvocation(invocation: ToolPolicyInvocation): Promise<string> {
	assertNonEmpty(invocation.toolName, "Tool policy invocation tool name");
	const resources = (invocation.resources ?? []).map((resource) => {
		assertNonEmpty(resource.kind, "Tool policy invocation resource kind");
		validateResourceAccess(resource.access, `Tool policy invocation resource ${resource.kind}`);
		return {
			kind: resource.kind,
			access: resource.access,
			...(resource.locator === undefined ? {} : { locator: resource.locator }),
		};
	});
	resources.sort((left, right) => compareStrings(canonicalJson(left), canonicalJson(right)));
	const canonical = canonicalJson({
		toolName: invocation.toolName,
		arguments: invocation.arguments,
		resources,
	});
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Validate and evaluate policy without consulting approvals or external state. */
export function evaluateToolPolicy(
	policy: ToolPolicy,
	spec: ToolSpec | undefined,
	invocation: ToolPolicyInvocation,
): ToolPolicyDecision {
	validateToolPolicy(policy);
	if (!spec) {
		if (policy.missingSpec !== "use_default") {
			return {
				decision: "deny",
				reason: `No ToolSpec is registered for tool ${invocation.toolName}`,
				policyRevision: policy.revision,
				toolName: invocation.toolName,
			};
		}
		return decisionFromDefault(policy, invocation.toolName, undefined);
	}
	validateToolSpec(spec);
	if (spec.name !== invocation.toolName) {
		throw new Error(`ToolSpec name ${spec.name} does not match invocation tool ${invocation.toolName}`);
	}

	const rule = [...policy.rules]
		.sort(compareRules)
		.find((candidate) => matchesRule(candidate.match, spec, invocation));
	if (!rule) return decisionFromDefault(policy, invocation.toolName, spec.revision);
	return {
		decision: rule.effect,
		reason: rule.reason,
		policyRevision: policy.revision,
		toolName: invocation.toolName,
		toolSpecRevision: spec.revision,
		ruleId: rule.id,
		approval: rule.approval ? structuredClone(rule.approval) : undefined,
	};
}

/** Create a serializable request for a `require_approval` decision. */
export function createApprovalRequest(
	decision: ToolPolicyDecision,
	invocation: ToolPolicyInvocation,
	options: CreateApprovalRequestOptions,
): ApprovalRequest {
	if (decision.decision !== "require_approval" || !decision.approval) {
		throw new Error("Approval requests require a require_approval policy decision");
	}
	if (!decision.toolSpecRevision) throw new Error("Approval requests require a ToolSpec revision");
	if (!invocation.resolvedCallHash) throw new Error("Approval requests require a resolved call hash");
	validateResolvedCallHash(invocation.resolvedCallHash, "Approval request resolved call hash");
	assertNonEmpty(options.id, "Approval request id");
	assertFiniteTimestamp(options.now, "Approval request creation time");
	const scope = createApprovalScope(decision.approval.scope, invocation);
	const expiresAt = options.now + decision.approval.expiresInMs;
	assertFiniteTimestamp(expiresAt, "Approval request expiry");
	return {
		revision: 1,
		id: options.id,
		createdAt: options.now,
		expiresAt,
		policyRevision: decision.policyRevision,
		toolSpecRevision: decision.toolSpecRevision,
		ruleId: decision.ruleId,
		toolCallId: invocation.toolCallId,
		toolName: invocation.toolName,
		resolvedCallHash: invocation.resolvedCallHash,
		reason: decision.reason,
		scope,
		oneShot: decision.approval.oneShot,
		resources: structuredClone(invocation.resources ?? []),
	};
}

/** Issue a grant that cannot exceed or broaden its request. */
export function createApprovalGrant(request: ApprovalRequest, options: CreateApprovalGrantOptions): ApprovalGrant {
	validateApprovalRequestShape(request);
	assertNonEmpty(options.id, "Approval grant id");
	assertFiniteTimestamp(options.issuedAt, "Approval grant issue time");
	const expiresAt = options.expiresAt ?? request.expiresAt;
	assertFiniteTimestamp(expiresAt, "Approval grant expiry");
	if (options.issuedAt < request.createdAt || options.issuedAt >= request.expiresAt) {
		throw new Error("Approval grant issue time must be within the request lifetime");
	}
	if (expiresAt <= options.issuedAt || expiresAt > request.expiresAt) {
		throw new Error("Approval grant expiry must be after issue time and no later than request expiry");
	}
	return {
		revision: 1,
		id: options.id,
		requestId: request.id,
		issuedAt: options.issuedAt,
		expiresAt,
		policyRevision: request.policyRevision,
		toolSpecRevision: request.toolSpecRevision,
		resolvedCallHash: request.resolvedCallHash,
		ruleId: request.ruleId,
		scope: structuredClone(request.scope),
		oneShot: request.oneShot,
	};
}

/** Validate that a newly returned grant is an unbroadened response to a request. */
export function validateApprovalGrantForRequest(
	grant: ApprovalGrant,
	request: ApprovalRequest,
	now: number,
): ApprovalValidationResult {
	try {
		validateApprovalGrantShape(grant);
		validateApprovalRequestShape(request);
		assertFiniteTimestamp(now, "Approval validation time");
	} catch (error) {
		return { valid: false, reason: error instanceof Error ? error.message : String(error) };
	}
	if (grant.requestId !== request.id) return { valid: false, reason: "Grant request id does not match" };
	if (grant.policyRevision !== request.policyRevision)
		return { valid: false, reason: "Grant policy revision is stale" };
	if (grant.toolSpecRevision !== request.toolSpecRevision) {
		return { valid: false, reason: "Grant ToolSpec revision is stale" };
	}
	if (grant.resolvedCallHash !== request.resolvedCallHash) {
		return { valid: false, reason: "Grant resolved call hash does not match" };
	}
	if (grant.ruleId !== request.ruleId) return { valid: false, reason: "Grant policy rule does not match" };
	if (!approvalScopesEqual(grant.scope, request.scope))
		return { valid: false, reason: "Grant scope is broader than requested" };
	if (grant.oneShot !== request.oneShot) return { valid: false, reason: "Grant one-shot mode does not match" };
	if (grant.issuedAt < request.createdAt || grant.expiresAt > request.expiresAt) {
		return { valid: false, reason: "Grant lifetime exceeds request lifetime" };
	}
	if (now >= request.expiresAt) return { valid: false, reason: "Approval request has expired" };
	if (grant.issuedAt > now) return { valid: false, reason: "Approval grant is not active yet" };
	if (now >= grant.expiresAt) return { valid: false, reason: "Approval grant has expired" };
	return { valid: true };
}

/** Validate a stored grant against the current decision and invocation. */
export function validateApprovalGrantForInvocation(
	grant: ApprovalGrant,
	decision: ToolPolicyDecision,
	invocation: ToolPolicyInvocation,
	now: number,
	consumed: boolean,
): ApprovalValidationResult {
	try {
		validateApprovalGrantShape(grant);
		assertFiniteTimestamp(now, "Approval validation time");
	} catch (error) {
		return { valid: false, reason: error instanceof Error ? error.message : String(error) };
	}
	if (decision.decision !== "require_approval")
		return { valid: false, reason: "Current policy does not require approval" };
	if (grant.policyRevision !== decision.policyRevision)
		return { valid: false, reason: "Grant policy revision is stale" };
	if (grant.toolSpecRevision !== decision.toolSpecRevision) {
		return { valid: false, reason: "Grant ToolSpec revision is stale" };
	}
	if (!invocation.resolvedCallHash || grant.resolvedCallHash !== invocation.resolvedCallHash) {
		return { valid: false, reason: "Approval grant resolved call hash is stale" };
	}
	if (grant.ruleId !== decision.ruleId) return { valid: false, reason: "Grant policy rule is stale" };
	if (!decision.approval) return { valid: false, reason: "Current policy has no approval requirements" };
	if (grant.scope.kind !== decision.approval.scope) {
		return { valid: false, reason: "Approval grant scope kind is stale" };
	}
	if (grant.oneShot !== decision.approval.oneShot) {
		return { valid: false, reason: "Approval grant one-shot mode is stale" };
	}
	if (grant.issuedAt > now) return { valid: false, reason: "Approval grant is not active yet" };
	if (now >= grant.expiresAt) return { valid: false, reason: "Approval grant has expired" };
	if (grant.oneShot && consumed) return { valid: false, reason: "One-shot approval grant was already consumed" };
	if (!approvalScopeCoversInvocation(grant.scope, invocation)) {
		return { valid: false, reason: "Approval grant scope does not cover this invocation" };
	}
	return { valid: true };
}

/**
 * Build a fail-closed adapter for AgentLoopConfig.beforeToolCall or an
 * AgentHarness before-tool hook. Approval presentation remains external.
 */
export function createToolPolicyAdapter(options: ToolPolicyAdapterOptions): ToolPolicyAdapter {
	validateToolPolicy(options.policy);
	const resolveSpec = createSpecResolver(options.specs);
	const specCache = new Map<string, ToolSpec | undefined>();
	const getSpec = (toolName: string): ToolSpec | undefined => {
		if (specCache.has(toolName)) return structuredClone(specCache.get(toolName));
		const spec = resolveSpec(toolName);
		if (!spec) {
			specCache.set(toolName, undefined);
			return undefined;
		}
		validateToolSpec(spec);
		const snapshot = structuredClone(spec);
		specCache.set(toolName, snapshot);
		return structuredClone(snapshot);
	};
	const grantStore = options.grantStore ?? new InMemoryApprovalGrantStore();
	const now = options.now ?? Date.now;
	const createRequestId =
		options.createRequestId ??
		((decision: ToolPolicyDecision, invocation: ToolPolicyInvocation) =>
			`${invocation.toolCallId}:${decision.policyRevision}:${decision.ruleId ?? "default"}:${invocation.resolvedCallHash ?? "unresolved"}`);

	const authorizeInvocation = async (
		invocation: ToolPolicyInvocation,
		signal?: AbortSignal,
	): Promise<ToolPolicyAuthorization> => {
		const resolvedInvocation = { ...invocation, resolvedCallHash: await hashToolPolicyInvocation(invocation) };
		const decision = evaluateToolPolicy(options.policy, getSpec(resolvedInvocation.toolName), resolvedInvocation);
		if (decision.decision === "allow") return { allowed: true, decision };
		if (decision.decision === "deny") return { allowed: false, decision, reason: decision.reason };

		const timestamp = now();
		const existingGrant = findApplicableGrant(grantStore, decision, resolvedInvocation, timestamp);
		if (existingGrant) {
			if (existingGrant.oneShot) grantStore.consume(existingGrant.id);
			return { allowed: true, decision, approvalGrantId: existingGrant.id };
		}

		let request: ApprovalRequest;
		try {
			request = createApprovalRequest(decision, resolvedInvocation, {
				id: createRequestId(decision, resolvedInvocation),
				now: timestamp,
			});
		} catch (error) {
			return {
				allowed: false,
				decision,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		if (!options.requestApproval) {
			return { allowed: false, decision, reason: decision.reason, approvalRequest: request };
		}

		const grant = await options.requestApproval(request, signal);
		if (signal?.aborted) {
			return { allowed: false, decision, reason: "Approval request was aborted", approvalRequest: request };
		}
		if (!grant) return { allowed: false, decision, reason: "Approval was not granted", approvalRequest: request };
		const validationTime = now();
		const requestValidation = validateApprovalGrantForRequest(grant, request, validationTime);
		if (!requestValidation.valid) {
			return { allowed: false, decision, reason: requestValidation.reason, approvalRequest: request };
		}
		const invocationValidation = validateApprovalGrantForInvocation(
			grant,
			decision,
			resolvedInvocation,
			validationTime,
			grantStore.isConsumed(grant.id),
		);
		if (!invocationValidation.valid) {
			return { allowed: false, decision, reason: invocationValidation.reason, approvalRequest: request };
		}
		grantStore.add(grant);
		if (grant.oneShot) grantStore.consume(grant.id);
		return { allowed: true, decision, approvalRequest: request, approvalGrantId: grant.id };
	};
	const authorize = async (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
		invocationContext?: ToolPolicyAdapterInvocationContext,
	): Promise<ToolPolicyAuthorization> => {
		const resolved = (await options.resolveInvocation?.(context)) ?? {};
		return authorizeInvocation(
			{
				toolCallId: context.toolCall.id,
				toolName: context.toolCall.name,
				arguments: context.args,
				sessionId: resolved.sessionId ?? invocationContext?.sessionId,
				resources: resolved.resources ?? invocationContext?.resources,
			},
			signal,
		);
	};

	return {
		grantStore,
		getSpec,
		authorizeInvocation,
		authorize,
		beforeToolCall: async (context, signal) => {
			const authorization = await authorize(context, signal);
			if (authorization.allowed) return undefined;
			return { block: true, reason: authorization.reason ?? authorization.decision.reason };
		},
	};
}

export function validateToolSpec(spec: ToolSpec): void {
	assertNonEmpty(spec.name, "ToolSpec name");
	assertNonEmpty(spec.revision, "ToolSpec revision");
	if (typeof spec.retrySafe !== "boolean") throw new Error("ToolSpec retrySafe must be boolean");
	if (!(["low", "medium", "high", "critical"] as const).includes(spec.risk.level)) {
		throw new Error(`Invalid ToolSpec risk level: ${spec.risk.level}`);
	}
	for (const sideEffect of spec.sideEffects) validateSideEffect(sideEffect);
	for (const resource of spec.resources) {
		assertNonEmpty(resource.kind, "ToolSpec resource kind");
		if (resource.access.length === 0) throw new Error(`ToolSpec resource ${resource.kind} must declare access`);
		for (const access of resource.access) validateResourceAccess(access, `ToolSpec resource ${resource.kind}`);
		if (resource.dynamic && resource.locator !== undefined) {
			throw new Error(`ToolSpec resource ${resource.kind} cannot be both dynamic and static`);
		}
	}
	if (spec.sideEffects.includes("none") && spec.sideEffects.length > 1) {
		throw new Error("ToolSpec side effect none cannot be combined with other effects");
	}
	for (const permission of spec.permissions) {
		assertNonEmpty(permission.id, "ToolSpec permission id");
		assertNonEmpty(permission.description, `ToolSpec permission ${permission.id} description`);
	}
}

export function validateToolPolicy(policy: ToolPolicy): void {
	assertNonEmpty(policy.revision, "Tool policy revision");
	if (policy.missingSpec !== undefined && policy.missingSpec !== "deny" && policy.missingSpec !== "use_default") {
		throw new Error(`Invalid missing ToolSpec policy: ${policy.missingSpec}`);
	}
	validateEffect(policy.default.effect, policy.default.approval, "Tool policy default");
	if (policy.missingSpec === "use_default" && policy.default.effect === "require_approval") {
		throw new Error("Missing ToolSpecs cannot use an approval default because grants require a ToolSpec revision");
	}
	const ids = new Set<string>();
	for (const rule of policy.rules) {
		assertNonEmpty(rule.id, "Tool policy rule id");
		if (ids.has(rule.id)) throw new Error(`Duplicate tool policy rule id: ${rule.id}`);
		ids.add(rule.id);
		if (rule.priority !== undefined && !Number.isFinite(rule.priority)) {
			throw new Error(`Tool policy rule ${rule.id} priority must be finite`);
		}
		assertNonEmpty(rule.reason, `Tool policy rule ${rule.id} reason`);
		validateEffect(rule.effect, rule.approval, `Tool policy rule ${rule.id}`);
		validateRuleMatch(rule.match, rule.id);
	}
}

function decisionFromDefault(
	policy: ToolPolicy,
	toolName: string,
	toolSpecRevision: string | undefined,
): ToolPolicyDecision {
	return {
		decision: policy.default.effect,
		reason: policy.default.reason,
		policyRevision: policy.revision,
		toolName,
		toolSpecRevision,
		approval: policy.default.approval ? structuredClone(policy.default.approval) : undefined,
	};
}

function matchesRule(
	match: ToolPolicyRuleMatch | undefined,
	spec: ToolSpec,
	invocation: ToolPolicyInvocation,
): boolean {
	if (!match) return true;
	const resourceKinds = new Set([
		...spec.resources.map((resource) => resource.kind),
		...(invocation.resources ?? []).map((resource) => resource.kind),
	]);
	const resourceAccess = new Set([
		...spec.resources.flatMap((resource) => resource.access),
		...(invocation.resources ?? []).map((resource) => resource.access),
	]);
	const sideEffects = new Set(spec.sideEffects);
	const permissionIds = new Set(spec.permissions.map((permission) => permission.id));
	const tags = new Set(spec.tags ?? []);
	return (
		includesIfPresent(match.toolNames, invocation.toolName) &&
		includesIfPresent(match.riskLevels, spec.risk.level) &&
		intersectsIfPresent(match.sideEffectsAny, sideEffects) &&
		containsAllIfPresent(match.sideEffectsAll, sideEffects) &&
		intersectsIfPresent(match.resourceKindsAny, resourceKinds) &&
		intersectsIfPresent(match.resourceAccessAny, resourceAccess) &&
		intersectsIfPresent(match.permissionIdsAny, permissionIds) &&
		containsAllIfPresent(match.permissionIdsAll, permissionIds) &&
		intersectsIfPresent(match.tagsAny, tags) &&
		containsAllIfPresent(match.tagsAll, tags)
	);
}

function includesIfPresent<T>(values: readonly T[] | undefined, value: T): boolean {
	return values === undefined || values.includes(value);
}

function intersectsIfPresent<T>(values: readonly T[] | undefined, actual: ReadonlySet<T>): boolean {
	return values === undefined || values.some((value) => actual.has(value));
}

function containsAllIfPresent<T>(values: readonly T[] | undefined, actual: ReadonlySet<T>): boolean {
	return values === undefined || values.every((value) => actual.has(value));
}

function compareRules(left: ToolPolicyRule, right: ToolPolicyRule): number {
	const priorityDifference = (right.priority ?? 0) - (left.priority ?? 0);
	return priorityDifference || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function createApprovalScope(scope: ApprovalScopeKind, invocation: ToolPolicyInvocation): ApprovalScope {
	if (scope === "call") return { kind: "call", toolName: invocation.toolName, toolCallId: invocation.toolCallId };
	if (scope === "tool") return { kind: "tool", toolName: invocation.toolName };
	if (!invocation.sessionId) throw new Error("Session-scoped approval requires a session id");
	return { kind: "session", toolName: invocation.toolName, sessionId: invocation.sessionId };
}

function approvalScopeCoversInvocation(scope: ApprovalScope, invocation: ToolPolicyInvocation): boolean {
	if (scope.toolName !== invocation.toolName) return false;
	if (scope.kind === "call") return scope.toolCallId === invocation.toolCallId;
	if (scope.kind === "session") return scope.sessionId === invocation.sessionId;
	return true;
}

function approvalScopesEqual(left: ApprovalScope, right: ApprovalScope): boolean {
	if (left.kind !== right.kind || left.toolName !== right.toolName) return false;
	if (left.kind === "call" && right.kind === "call") return left.toolCallId === right.toolCallId;
	if (left.kind === "session" && right.kind === "session") return left.sessionId === right.sessionId;
	return left.kind === "tool" && right.kind === "tool";
}

function findApplicableGrant(
	store: ApprovalGrantStore,
	decision: ToolPolicyDecision,
	invocation: ToolPolicyInvocation,
	now: number,
): ApprovalGrant | undefined {
	return [...store.list()]
		.sort((left, right) => compareStrings(left.id, right.id))
		.find(
			(grant) =>
				validateApprovalGrantForInvocation(grant, decision, invocation, now, store.isConsumed(grant.id)).valid,
		);
}

function createSpecResolver(specs: readonly ToolSpec[] | ToolSpecResolver): ToolSpecResolver {
	if (typeof specs === "function") return specs;
	const byName = new Map<string, ToolSpec>();
	for (const spec of specs) {
		validateToolSpec(spec);
		if (byName.has(spec.name)) throw new Error(`Duplicate ToolSpec name: ${spec.name}`);
		byName.set(spec.name, structuredClone(spec));
	}
	return (toolName) => byName.get(toolName);
}

function validateEffect(
	effect: ToolPolicyEffect,
	approval: ToolApprovalRequirement | undefined,
	context: string,
): void {
	if (!(["allow", "deny", "require_approval"] as const).includes(effect)) {
		throw new Error(`${context} has invalid effect: ${effect}`);
	}
	if (effect === "require_approval") {
		if (!approval) throw new Error(`${context} requires approval settings`);
		if (!Number.isFinite(approval.expiresInMs) || approval.expiresInMs <= 0) {
			throw new Error(`${context} approval expiry must be a positive finite number`);
		}
		if (!(["call", "tool", "session"] as const).includes(approval.scope)) {
			throw new Error(`${context} has invalid approval scope: ${approval.scope}`);
		}
		if (typeof approval.oneShot !== "boolean") throw new Error(`${context} approval oneShot must be boolean`);
	} else if (approval !== undefined) {
		throw new Error(`${context} may only set approval for require_approval`);
	}
}

function validateApprovalRequestShape(request: ApprovalRequest): void {
	if (request.revision !== 1) throw new Error(`Unsupported approval request revision: ${request.revision}`);
	assertNonEmpty(request.id, "Approval request id");
	assertNonEmpty(request.toolCallId, "Approval request tool call id");
	assertNonEmpty(request.toolName, "Approval request tool name");
	assertNonEmpty(request.policyRevision, "Approval request policy revision");
	assertNonEmpty(request.toolSpecRevision, "Approval request ToolSpec revision");
	validateResolvedCallHash(request.resolvedCallHash, "Approval request resolved call hash");
	assertFiniteTimestamp(request.createdAt, "Approval request creation time");
	assertFiniteTimestamp(request.expiresAt, "Approval request expiry");
	if (request.expiresAt <= request.createdAt) throw new Error("Approval request expiry must be after creation");
	if (typeof request.oneShot !== "boolean") throw new Error("Approval request oneShot must be boolean");
	validateApprovalScope(request.scope);
	if (request.scope.toolName !== request.toolName) throw new Error("Approval request scope tool does not match");
	if (request.scope.kind === "call" && request.scope.toolCallId !== request.toolCallId) {
		throw new Error("Approval request call scope does not match the tool call");
	}
	for (const resource of request.resources) {
		assertNonEmpty(resource.kind, "Approval request resource kind");
		validateResourceAccess(resource.access, `Approval request resource ${resource.kind}`);
	}
}

function validateApprovalGrantShape(grant: ApprovalGrant): void {
	if (grant.revision !== 1) throw new Error(`Unsupported approval grant revision: ${grant.revision}`);
	assertNonEmpty(grant.id, "Approval grant id");
	assertNonEmpty(grant.requestId, "Approval grant request id");
	assertNonEmpty(grant.policyRevision, "Approval grant policy revision");
	assertNonEmpty(grant.toolSpecRevision, "Approval grant ToolSpec revision");
	validateResolvedCallHash(grant.resolvedCallHash, "Approval grant resolved call hash");
	assertFiniteTimestamp(grant.issuedAt, "Approval grant issue time");
	assertFiniteTimestamp(grant.expiresAt, "Approval grant expiry");
	if (grant.expiresAt <= grant.issuedAt) throw new Error("Approval grant expiry must be after issue time");
	if (typeof grant.oneShot !== "boolean") throw new Error("Approval grant oneShot must be boolean");
	validateApprovalScope(grant.scope);
}

function validateApprovalScope(scope: ApprovalScope): void {
	assertNonEmpty(scope.toolName, "Approval scope tool name");
	if (!(["call", "tool", "session"] as const).includes(scope.kind)) {
		throw new Error(`Invalid approval scope kind: ${scope.kind}`);
	}
	if (scope.kind === "call") assertNonEmpty(scope.toolCallId, "Approval call scope tool call id");
	if (scope.kind === "session") assertNonEmpty(scope.sessionId, "Approval session scope session id");
}

function validateRuleMatch(match: ToolPolicyRuleMatch | undefined, ruleId: string): void {
	if (!match) return;
	for (const toolName of match.toolNames ?? []) assertNonEmpty(toolName, `Tool policy rule ${ruleId} tool name`);
	for (const riskLevel of match.riskLevels ?? []) {
		if (!(["low", "medium", "high", "critical"] as const).includes(riskLevel)) {
			throw new Error(`Tool policy rule ${ruleId} has invalid risk level: ${riskLevel}`);
		}
	}
	for (const sideEffect of [...(match.sideEffectsAny ?? []), ...(match.sideEffectsAll ?? [])]) {
		validateSideEffect(sideEffect, `Tool policy rule ${ruleId}`);
	}
	for (const resourceKind of match.resourceKindsAny ?? []) {
		assertNonEmpty(resourceKind, `Tool policy rule ${ruleId} resource kind`);
	}
	for (const permissionId of [...(match.permissionIdsAny ?? []), ...(match.permissionIdsAll ?? [])]) {
		assertNonEmpty(permissionId, `Tool policy rule ${ruleId} permission id`);
	}
	for (const tag of [...(match.tagsAny ?? []), ...(match.tagsAll ?? [])]) {
		assertNonEmpty(tag, `Tool policy rule ${ruleId} tag`);
	}
	for (const access of match.resourceAccessAny ?? []) {
		validateResourceAccess(access, `Tool policy rule ${ruleId}`);
	}
}

function validateSideEffect(sideEffect: ToolSideEffect, context = "ToolSpec"): void {
	if (
		!(["none", "read_state", "write_state", "execute_code", "network", "external_state"] as const).includes(
			sideEffect,
		)
	) {
		throw new Error(`${context} has invalid side effect: ${sideEffect}`);
	}
}

function validateResourceAccess(access: ToolResourceAccess, context: string): void {
	if (!(["read", "write", "execute", "connect", "admin"] as const).includes(access)) {
		throw new Error(`${context} has invalid resource access: ${access}`);
	}
}

function assertNonEmpty(value: string, label: string): void {
	if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function assertFiniteTimestamp(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function validateResolvedCallHash(value: string, label: string): void {
	if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function canonicalJson(value: unknown): string {
	const ancestors = new Set<object>();
	const normalize = (candidate: unknown): null | boolean | number | string | unknown[] | Record<string, unknown> => {
		if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") return candidate;
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) throw new Error("Tool policy invocation contains a non-finite number");
			return Object.is(candidate, -0) ? 0 : candidate;
		}
		if (typeof candidate !== "object") {
			throw new Error(`Tool policy invocation contains unsupported ${typeof candidate} data`);
		}
		if (ancestors.has(candidate)) throw new Error("Tool policy invocation contains a circular value");
		ancestors.add(candidate);
		try {
			if (Array.isArray(candidate)) return candidate.map((item) => normalize(item));
			const prototype = Object.getPrototypeOf(candidate);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new Error("Tool policy invocation contains a non-plain object");
			}
			const normalized: Record<string, unknown> = {};
			for (const key of Object.keys(candidate).sort(compareStrings)) {
				normalized[key] = normalize((candidate as Record<string, unknown>)[key]);
			}
			return normalized;
		} finally {
			ancestors.delete(candidate);
		}
	};
	return JSON.stringify(normalize(value));
}
