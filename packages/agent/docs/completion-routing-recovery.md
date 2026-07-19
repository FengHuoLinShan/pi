# Completion contracts, model routing, and recovery

These APIs are explicit application primitives. They do not start background work, call a provider, retry a request, switch a model, or declare a task complete on their own.

## Completion contracts

`CompletionContract` declares required and optional conditions. Each condition references one or more `CompletionVerifier` ids and combines them with `all` or `any`.

```ts
const contract = {
  version: COMPLETION_CONTRACT_VERSION,
  id: "ship-change",
  objective: "Ship a verified change",
  conditions: [{
    id: "quality",
    description: "Tests and static checks pass",
    verifierIds: ["tests", "check"],
    mode: "all",
  }],
};

const report = await verifyCompletionContract(contract, verifiers, {
  context: { workspace, patchSet },
  signal,
});
```

Verifier results are `pass`, `fail`, `blocked`, or `error`. Exceptions are isolated by default and become structured error results; `errorMode: "throw"` is an explicit fail-fast option. Reports contain no generated timestamps or durations, evidence is JSON-safe and deterministically ordered, and `serializeCompletionReport()` produces canonical JSON.

## Verified runs

`executeVerifiedRun()` composes exactly one explicit `AgentHarness` prompt with a completion contract. It returns a versioned `VerifiedRunReport` with the Harness result, actual usage and termination, completion evidence, and caller-owned artifact/evidence references.

```ts
const report = await executeVerifiedRun(harness, {
  version: VERIFIED_RUN_SPEC_VERSION,
  id: "fix-3303",
  prompt: "Fix the scoped .gitignore regression.",
  completionContract: contract,
  evidenceRefs: [{ id: "issue", kind: "github-issue", reference: "issue:3303" }],
}, {
  context: { workspace },
  verifiers,
  signal,
});
```

Run status is `passed`, `failed`, `blocked`, or `interrupted`. Budget/deadline/loop termination is blocked, aborts are interrupted, provider/Harness errors fail, and only a passing completion report passes the run. References are opaque: the core sorts and copies them but never opens, creates, applies, or deletes their targets. The API does not retry, switch models, run in the background, or apply a patch.

## Capability-based model routing

`routeModels()` accepts candidates with pi-ai `CapabilityProfile` values. Requirements can constrain modalities, reasoning level, context/output limits, tool calls, strict schemas, deferred tool loading, providers, health, and explicit exclusions.

```ts
const plan = routeModels({
  requestId: "turn-12",
  candidates,
  requirements: {
    modalities: ["text", "image"],
    reasoningLevel: "high",
    minContextWindow: 128_000,
    tools: { required: true, strictMode: true },
  },
});
```

Unknown capabilities and degraded candidates fail closed unless the request allows them. Eligible candidates are ordered only by caller-supplied `priority`, then caller-supplied `preferenceScore`, followed by stable identifiers. The result includes every rejection and warning. It does not contact a provider or hide a fallback loop.

## Structured recovery

`classifyAssistantFailure()` converts pi-ai terminal messages into a small failure taxonomy for context overflow, transient provider errors, aborts, and unknown failures. Applications can construct more specific `StructuredFailure` values for authentication, quota, rate limit, tool, policy, and budget failures.

`planStructuredRecovery()` produces ordered alternatives such as:

- bounded same-route retry;
- switch to an explicit route-plan fallback;
- compact context;
- retry a retry-safe tool;
- reauthenticate;
- request approval;
- stop.

```ts
const recovery = planStructuredRecovery({
  failure,
  routePlan: plan,
  currentRouteId: plan.selected?.id,
  maxRequestAttempts: 2,
  maxRetryDelayMs: 5_000,
  compaction: { available: true, attempts: 0, maxAttempts: 1 },
});

await executeStructuredRecoveryAction(
  recovery,
  recovery.recommendedActionId,
  handlers,
  { signal },
);
```

Execution dispatches exactly one selected action to a caller-owned handler. It never chains actions into an autonomous recovery loop.
