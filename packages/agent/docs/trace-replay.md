# Telemetry, trace bundles, and replay

`packages/agent` separates three concerns:

- canonical runtime events are the durable source of truth;
- telemetry is a passive operational projection;
- trace bundles are sanitized, portable snapshots for offline diagnostics and replay.

Telemetry is not used to recover a session. A trace bundle does not replace the session event log.

## Privacy-safe telemetry

Attach a sink to an `AgentHarness`:

```ts
import { attachHarnessTelemetry } from "@earendil-works/pi-agent-core";

const unsubscribe = attachHarnessTelemetry(harness, {
  emit(record) {
    telemetryQueue.push(record);
  },
});
```

The projection emits versioned span, log, and metric records. A run contains turn spans, provider request spans, and tool-call spans. Metrics use low-cardinality dimensions such as provider, model, tool name, and status. Trace identifiers correlate records but never become metric dimensions.

The default projection never copies:

- prompts or completions;
- provider request payloads or response bodies;
- headers, API keys, or environment values;
- tool arguments, results, shell output, or file contents;
- session identifiers.

It may record counts and encoded byte lengths. Sink exceptions and rejected promises are isolated from harness execution. Telemetry listeners are passive; use hooks for control-plane behavior.

Tool-result logs and tool span ends include the bounded `attemptOutcome` classification. Missing or unsupported values are bucketed as `unknown` on logs, spans, and the `pi.agent.tool_attempt_outcomes` counter. That counter uses only the normalized classification as a dimension; it never adds tool names, call ids, reasons, or other dynamic values.

## Trace bundles

`createTraceBundle()` builds a versioned bundle containing:

- a manifest, checksum, and replay capability declaration;
- pseudonymized canonical runtime events;
- sanitized effective configuration and provider metadata;
- schema hashes and policy decisions;
- workspace revision and an optional diff reference;
- optional model/tool exchange recordings and artifact metadata;
- metrics and a redaction report.

Per-call tool-attempt outcomes are an operational telemetry and audit projection, not an additional trace-bundle event or replay claim. Hosts may export fixed-name aggregate counts through `metrics`, but must not construct metric names from tools, call ids, errors, or reasons.

```ts
const bundle = await createTraceBundle({
  sessionId,
  canonicalEvents: runtimeStore.getEvents(),
  effectiveConfig,
  providerMetadata,
  schemaHashes,
  policyDecisions,
  modelExchanges,
  toolExchanges,
  artifacts,
  metrics,
});

if (!(await verifyTraceBundle(bundle))) {
  throw new Error("trace bundle checksum mismatch");
}
```

By default, embedded queue messages, pending writes, model inputs/outputs, tool inputs/results, workspace diffs, artifact bodies, free-form configuration strings, and policy reasons become `{ capture: "redacted", sha256, bytes }` descriptors. The original session ID becomes a stable bundle-local pseudonym. Structural fields needed for state replay remain intact.

Exact content requires an explicit per-item opt-in:

```ts
const bundle = await createTraceBundle(source, {
  contentCapture: {
    include(kind, id) {
      return approvedForDiagnosticExport(kind, id);
    },
  },
});
```

If `transform` is configured, the captured value is marked non-exact and cannot be used for exact model-input or deterministic-tool replay. Hosts should preview the bundle, scan explicitly captured content for secrets, enforce an export size limit, and apply their own encrypted storage, retention, and deletion policy.

## Replay levels

The bundle declares which levels are available:

1. `replayUi()` projects canonical events into a content-free timeline.
2. `replayState()` rebuilds the durable runtime projection with the canonical reducer.
3. `replayModelInputs()` returns exactly captured provider inputs without invoking a provider.
4. `createDeterministicToolReplay()` verifies tool identity and input hash, then returns the recorded result without executing the tool.
5. `replayLive()` explicitly invokes host-provided model/tool adapters and compares output hashes.

```ts
const timeline = await replayUi(bundle);
const state = await replayState(bundle);

const recordedTools = await createDeterministicToolReplay(bundle);
const result = await recordedTools.invoke({
  toolCallId,
  toolName: "read",
  input: { path: "src/index.ts" },
});
```

Model output is usually nondeterministic. Live replay reports `match`, `different`, `not_comparable`, or `error`; it does not promise identical output. Live adapters are an explicit side-effect boundary and must apply current policy, sandbox, approval, network, and secret controls.

## Forkable replay

`createReplayBranch()` creates an immutable branch plan before one canonical event sequence. The prefix is reduced into `stateAtFork`; model and tool exchanges at or after the boundary become ordered branch steps. Creating a branch performs no provider or tool work.

Exact recorded inputs are required unless the caller supplies an explicit input override. A changed provider, model, tool name, or input never reuses the old response implicitly: the caller must provide an override response or opt into an adapter invocation.

```ts
const branch = await createReplayBranch(bundle, {
  branchId: "alternate-model",
  forkBeforeSequence: 42,
  overrides: [{
    kind: "model",
    requestId: "request-7",
    provider: "provider-b",
    modelId: "model-b",
    input: { value: alternateInput },
    response: { source: "adapter" },
  }],
});

const execution = await executeReplayBranch(branch, {
  invokeModel: (step, signal) => callModel(step, signal),
  invokeTool: (step, signal) => callSandboxedTool(step, signal),
});
```

Recorded and override responses never call adapters. Missing adapters produce a blocked execution instead of silently performing live work. `verifyReplayBranch()` detects plan mutation, and `compareReplayBranches()` compares result hashes without copying raw result content into the comparison.

## Operational rules

- Verify the bundle checksum before import or replay.
- Use canonical event sequence, not timestamps, for ordering.
- Treat exact content capture as privileged diagnostic access.
- Never execute real tools during deterministic-tool replay.
- Reapply current authorization and isolation for live replay.
- Treat every branch adapter as a new live execution boundary.
- Keep event-log retention and telemetry retention independently configurable.
