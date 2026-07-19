# Tool policy and approvals

`tool-policy.ts` provides a UI-independent authorization layer for agent tools. It separates four concerns:

1. `ToolSpec` declares a tool's potential risk, side effects, resources, and permissions.
2. `ToolPolicy` deterministically selects `allow`, `deny`, or `require_approval`.
3. `ApprovalRequest` and `ApprovalGrant` carry serializable, revision-bound authority.
4. `createToolPolicyAdapter()` adapts the result to `AgentLoopConfig.beforeToolCall` and harness before-tool hooks.

This module is a policy decision point, not an isolation boundary. A dishonest `ToolSpec`, an incorrect resource resolver, or code that bypasses the adapter can still exercise the process's full authority. Use an operating-system, container, or VM boundary for adversarial tools.

## Declare tools

Tool declarations contain no executable callbacks and can be stored as JSON:

```ts
import type { ToolSpec } from "@earendil-works/pi-agent-core";

const updateRecordSpec: ToolSpec = {
  name: "update_record",
  revision: "update_record@2",
  retrySafe: false,
  risk: {
    level: "high",
    rationale: ["Changes durable application state"],
  },
  sideEffects: ["write_state"],
  resources: [
    { kind: "record-store", access: ["write"], dynamic: true },
  ],
  permissions: [
    { id: "records.write", description: "Modify records" },
  ],
  tags: ["mutation"],
};
```

Increment `ToolSpec.revision` whenever security-relevant behavior or declarations change. Existing approval grants are rejected when the revision differs.

`retrySafe` is explicit because recovery cannot infer idempotency from risk or side-effect labels. Set it to `true` only when repeating an interrupted invocation cannot duplicate or corrupt effects. `AgentHarness` writes this value into `tool_call_started` runtime events; tools without a registered spec are recorded as `retrySafe: false`.

Resource kinds, locators, permission ids, and tags are application-defined. The core does not recognize tool names or assign meaning to a particular resource namespace.

## Define policy

Policies are also serializable:

```ts
import type { ToolPolicy } from "@earendil-works/pi-agent-core";

const policy: ToolPolicy = {
  revision: "workspace-policy@4",
  rules: [
    {
      id: "deny-admin",
      priority: 100,
      effect: "deny",
      reason: "Administrative resource access is disabled",
      match: { resourceAccessAny: ["admin"] },
    },
    {
      id: "approve-writes",
      priority: 50,
      effect: "require_approval",
      reason: "Durable writes require operator approval",
      match: { sideEffectsAny: ["write_state"] },
      approval: {
        expiresInMs: 60_000,
        scope: "call",
        oneShot: true,
      },
    },
    {
      id: "allow-reads",
      priority: 10,
      effect: "allow",
      reason: "Declared reads are allowed",
      match: { sideEffectsAll: ["read_state"] },
    },
  ],
  default: { effect: "deny", reason: "No policy rule allowed this tool" },
};
```

Rule evaluation is deterministic:

- higher `priority` runs first;
- equal priorities are ordered by rule id using code-point order;
- the first matching rule wins;
- every populated field in `match` must match;
- `Any` arrays require one match and `All` arrays require every match;
- the default applies when no rule matches.

Missing `ToolSpec` declarations are denied. `missingSpec: "use_default"` is an explicit escape hatch for applications that need a compatibility period. A missing declaration cannot use an approval default because grants must bind to a concrete tool revision.

Increment `ToolPolicy.revision` for every authority-relevant policy change. Grants from another revision are rejected. Revision discipline is part of the security contract.

## Approval model

Approval scopes are intentionally small:

- `call`: one tool call id;
- `tool`: the named tool across calls;
- `session`: the named tool inside one application-provided session id.

Requests and grants include their schema revision, policy revision, tool revision, rule id, scope, expiry, and a SHA-256 binding of the canonical tool name, arguments, and resolved resources. A grant returned for a request must have the same exact-action hash, scope, and one-shot setting and cannot outlive the request. `createApprovalGrant()` enforces those constraints.

An `ApprovalGrant` is bearer authority, not a cryptographic proof. Keep persisted snapshots inside the application's trusted state and authenticate any external approval transport before accepting its returned grant.

`oneShot: true` consumes a grant after one successful authorization. Persist both the grants and consumed ids from `InMemoryApprovalGrantStore.snapshot()` if approvals must survive restart:

```ts
const snapshot = store.snapshot();
const restored = new InMemoryApprovalGrantStore(snapshot);
```

Approval requests include resolved resources for display and audit. Resource entries do not independently grant authority. The adapter recomputes the exact-action hash after argument transformation and resource resolution, and a stored tool- or session-scoped grant is reusable only when that hash, the scope, and both policy and tool revisions still match.

## Loop and harness adapter

The adapter owns no UI. The application supplies an approval callback, which may use a TUI, RPC round trip, remote control plane, or a deterministic unattended policy:

```ts
import {
  createApprovalGrant,
  createToolPolicyAdapter,
} from "@earendil-works/pi-agent-core";

const adapter = createToolPolicyAdapter({
  policy,
  specs: [updateRecordSpec],
  observeAuthorization: (observation) => {
    authorizationMetrics.record(observation);
  },
  resolveInvocation: (context) => ({
    sessionId: activeSessionId,
    resources: [{
      kind: "record-store",
      access: "write",
      locator: String((context.args as { id: string }).id),
    }],
  }),
  requestApproval: async (request, signal) => {
    const approved = await approvalTransport.request(request, signal);
    if (!approved) return undefined;
    return createApprovalGrant(request, {
      id: approved.grantId,
      issuedAt: approved.issuedAt,
    });
  },
});

const config = {
  // Other AgentLoopConfig fields...
  beforeToolCall: adapter.beforeToolCall,
};
```

If no approval callback is configured, `require_approval` produces a blocked tool call. Use `adapter.authorize()` when the caller needs the structured decision and `ApprovalRequest`; use `adapter.beforeToolCall()` when only the existing block hook is needed.

`observeAuthorization` is an opt-in, passive outcome hook. It receives the policy and tool revisions, matched rule id, resolved-call hash, decision, allow/block outcome, and whether approval was unnecessary, granted, or not granted. It never receives tool arguments, resolved resources or locators, session identity, policy reasons, or approval grant ids. Observer throws and rejected promises are isolated and cannot change the authorization result. The observer receives a detached, flat observation object; mutating or retaining it cannot change the authorization result or grant state.

The resolved-call hash is a deterministic integrity binding and correlatable pseudonym, not anonymization. Low-entropy argument or resource combinations may be recoverable by dictionary testing. Tool names and application-provided tool-call ids are also visible. Do not encode secrets in identifiers, and do not export observations outside the trust boundary unless the receiving system's threat model accepts these fields. Applications that require unlinkable external telemetry should omit the hash at their own projection boundary or replace it with an application-owned keyed binding before export.

An authorization observation proves only what this adapter decided for a resolved invocation. It does not prove that the tool executed, that execution matched the declaration, or that another execution path did not bypass the adapter. Correlate it with trusted runtime events when execution evidence is required, and use a sandbox for process-level enforcement.

`AgentHarness` accepts the adapter directly:

```ts
const harness = new AgentHarness({
  // Other AgentHarnessOptions fields...
  toolPolicy: adapter,
});
```

Harness `tool_call` hooks run first so argument transformations are included in authorization. A hook may block a call, but `{ block: false }` cannot override a policy denial. The harness supplies its session id to the adapter for session-scoped approvals.

`adapter.getSpec(name)` returns a validated defensive copy for runtime metadata and inspection. Resolver-backed specs are snapshotted on first lookup so runtime retry metadata and authorization use the same declaration; recreate the adapter to install a new spec revision. `adapter.authorizeInvocation()` remains available for hosts that integrate an invocation shape other than the low-level loop or `AgentHarness`.

The adapter fails closed for missing specs, declined approvals, expired grants, stale policy or tool revisions, broader scopes, reused one-shot grants, and session-scoped rules without a session id.

## Opt-in Harness discipline audit

`createHarnessDisciplineAudit()` correlates policy outcomes with one Harness run without changing authorization or execution. Create a fresh audit for every `prompt()` call, pass its bound observer properties directly to the policy adapter and Harness, then evaluate it with an explicit completion verifier:

```ts
import {
  createHarnessDisciplineAudit,
  createHarnessDisciplineCompletionVerifier,
} from "@earendil-works/pi-agent-core";

const audit = createHarnessDisciplineAudit();
const adapter = createToolPolicyAdapter({
  policy,
  specs,
  observeAuthorization: audit.observeAuthorization,
});
const harness = new AgentHarness({
  // Other AgentHarnessOptions fields...
  toolPolicy: adapter,
});
const unsubscribe = harness.subscribe(audit.observeHarnessEvent);

await harness.prompt("perform the task");

const verifier = createHarnessDisciplineCompletionVerifier({
  id: "harness-discipline",
  getAudit: (context: { audit: typeof audit }) => context.audit,
  expectedPolicyRevision: policy.revision,
  requireEveryExecutionAuthorized: true,
  deniedAttempts: "fail",
  minAuthorizationDecisions: 1,
  requireEveryAttemptOutcome: true,
  allowedAttemptOutcomes: ["body_success"],
  requireSettled: true,
  maxNextTurnCount: 0,
});

unsubscribe();
```

The Harness emits `tool_execution_start` before argument validation, tool-call hooks, and policy authorization. The audit therefore records an execution attempt first and expects the authorization observation afterward. Its matching `tool_execution_end.attemptOutcome` is a closed, content-free terminal classification that distinguishes non-execution, tool-body, and after-hook paths without retaining the error or block reason. An authorization or outcome observed before its matching start, duplicate starts, decisions, or outcomes, mismatched tool names, malformed relevant events, duplicate settlement, and relevant events after settlement are structural violations and always fail the verifier.

`requireEveryExecutionAuthorized` separately controls whether starts with no matching allowed decision fail; this can include missing tools, invalid arguments, or calls blocked by an earlier Harness hook before policy runs. `requireEveryAttemptOutcome` controls whether legacy or external end events without a valid outcome fail. `allowedAttemptOutcomes` is a required, dense, duplicate-free allowlist over the closed outcome vocabulary; observed outcomes outside it fail independently of completeness. Both fields are snapshotted with the other verifier options at construction.

All behavior-affecting verifier options are explicit; there are no implicit policy defaults. The verifier copies its id, audit resolver, and policy options at construction, so later mutation of the caller-owned options object cannot change an existing verifier. `deniedAttempts: "allow"` permits observed denials only when `requireEveryExecutionAuthorized` is also false. `expectedPolicyRevision` constrains observed decisions but does not imply that one must exist; set `minAuthorizationDecisions` to at least `1` when a decision is required. `maxNextTurnCount` requires `requireSettled: true`.

The audit stores tool-call ids and tool names only inside the per-run correlator. Its version-2 public snapshot and completion evidence contain aggregate authorization, attempt-outcome, settlement, and anomaly counts only and never include ids, tool names, hashes, arguments, resources, paths, reasons, or locators. `attemptOutcomes.observed` and its per-outcome counts include only valid terminal outcomes that, when observed before settlement, matched an earlier start by both tool-call id and tool name; orphaned, mismatched, invalid, or late ends remain structural anomalies and do not affect behavioral outcome counts. The authorization observer is synchronously copied so later caller mutation cannot alter the audit. The audit ignores all Harness events except `tool_execution_start`, `tool_execution_end`, and `settled`; it does not modify the default Harness or CLI pipeline.

## Integration responsibilities

Applications should:

- register a `ToolSpec` for every reachable tool;
- resolve argument-dependent resources after schema validation;
- keep request and grant payloads in the durable event or audit stream;
- persist approval store snapshots when grants span process restarts;
- route every tool execution path through the adapter;
- increment revisions when authority changes;
- combine policy with a real sandbox where process-level isolation is required.
