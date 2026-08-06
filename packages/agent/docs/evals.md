# Deterministic AgentHarness evals

The eval runner executes declarative AgentHarness scenarios against fresh in-memory sessions, deterministic fixture tools, and the `pi-ai` faux provider. It never resolves real provider credentials, performs network requests, or spends provider tokens.

Run the tracked regression gate from the repository root:

```bash
npm run eval:harness
```

The command writes `.artifacts/agent-harness-evals.json` and compares every scenario with `packages/agent/evals/baseline.json`. It is separate from the default test command, so it does not change e2e activation behavior.

## Scenario schema

Suites are versioned JSON documents validated by `AgentHarnessEvalSuiteSchema`:

```json
{
  "version": 1,
  "name": "example",
  "scenarios": [
    {
      "version": 1,
      "id": "tool-roundtrip",
      "prompt": "Look up alpha.",
      "responses": [
        {
          "content": [
            {
              "type": "toolCall",
              "id": "lookup-1",
              "name": "lookup",
              "arguments": { "key": "alpha" }
            }
          ]
        },
        { "content": [{ "type": "text", "text": "alpha is 42" }] }
      ],
      "tools": [
        {
          "name": "lookup",
          "responses": [{ "content": [{ "type": "text", "text": "42" }] }]
        }
      ],
      "assertions": {
        "eventOrder": ["agent_start", "tool_execution_start:lookup", "agent_end", "settled"],
        "toolCalls": [{ "name": "lookup", "arguments": { "key": "alpha" } }],
        "finalOutput": { "equals": "alpha is 42" },
        "termination": { "status": "completed" },
        "usage": { "steps": 2, "modelCalls": 2, "toolCalls": 1, "maxCost": 0 },
        "replayDeterministic": true
      }
    }
  ]
}
```

`eventOrder` is an ordered subsequence assertion. Reports retain the full normalized event sequence, while streaming deltas are excluded because faux-provider chunk boundaries are transport details. Tool calls, final output, structured termination, budget usage, and normalized semantic events form the replay signature; timestamps and elapsed wall time do not.

Fixture tools consume their `responses` in order. A response can return text content, details, and `terminate`, or use `{ "error": "message" }` to throw deterministically. Assistant responses likewise consume the suite's scripted `responses` in order.

## Baseline gates

The baseline contains one semantic signature per scenario and explicit thresholds:

- `minimumPassRate`
- `maximumFailedScenarios`
- `maximumRegressions`
- `maximumUnbaselinedScenarios`
- `requireReplayDeterminism`

A signature change is a regression until reviewed, even if individual assertions still pass. Removed baseline scenarios also count as regressions. New scenarios are unbaselined and fail the default threshold until the baseline is intentionally refreshed.

After reviewing an intentional semantic change, update the baseline from a passing suite:

```bash
npm --prefix packages/agent run eval:harness:update
```

The updater refuses to create a baseline from a failing report. Review both the scenario and baseline diff; do not weaken thresholds to accept an unexplained change.

Library consumers can import `runAgentHarnessEvalSuite`, `compareAgentHarnessEvalReport`, schemas, report types, and baseline helpers from `@earendil-works/pi-agent-core/evals`.

## Lifecycle Fault Lab

The lifecycle fault lab snapshots a structured-cloneable scenario before its first asynchronous operation, then exercises the real session-backed runtime event store at every event in that immutable view. Each boundary is run twice: once with persistence rejected before the event becomes durable, and once with persistence rejected immediately after the durable write. Every case reopens the session from storage, performs conservative recovery, and verifies:

- contiguous canonical sequences and unique event ids
- deterministic replay equivalence
- at most one terminal event per operation, turn, provider request, and tool call
- valid operation/turn/request/tool ownership after recovery
- preservation of queued messages and pending writes
- retry exposure only for tool calls declared retry-safe
- no active runtime work after recovery

Run the independent gate from the repository root:

```bash
npm run eval:lifecycle-faults
```

The command writes `.artifacts/agent-lifecycle-fault-lab.json`. Reports contain event types, counts, fault positions, and invariant violations only. They never include queued messages, tool arguments, pending-write bodies, or entity ids.

## Mining replay regressions

`mineReplayEval()` converts an exact trace suffix from a failed or explicitly costly run into a versioned replay fixture. It selects the first failed tool/provider/turn boundary, or a configured metric-threshold breach, and retains only the replay steps at or after that critical sequence.

Mining is privacy-gated twice: the trace must already contain exact per-item captures, and the mining call must set `allowCapturedContent: true`. The fixture contains exact replay inputs, so it must follow the same secret scanning, access, retention, and deletion controls as its source bundle. Its baseline stores only result hashes and statuses.

```ts
const fixture = await mineReplayEval(bundle, {
  id: "retry-regression",
  allowCapturedContent: true,
  adapterKinds: ["model"],
  metricThresholds: { modelTokens: 20_000 },
});

const report = await runMinedReplayEval(fixture, {
  invokeModel: (step, signal) => callCandidateModel(step, signal),
  invokeTool: (step, signal) => callSandboxedTool(step, signal),
});
```

The default expectation is hash equivalence with the recorded baseline. Fixtures can instead require a different complete outcome or only require complete execution. `verifyMinedReplayEvalFixture()` checks both fixture and replay-branch integrity. Reports contain hashes and comparison statuses, never adapter result bodies.

## Eval corpus and controlled routing

`createReplayEvalCorpus()` and `appendReplayEvalCorpus()` promote reviewed mined fixtures into an append-only, optimistic-revision corpus. Addition snapshots its inputs before integrity checks, verifies exact baseline-to-candidate replay coverage plus branch structure and hashes, and then uses only the verified snapshots. Reusing a fixture id with different content fails; adding the same fixture hash is idempotent.

`runControlledModelRouting()` clones and verifies one corpus revision plus candidate metadata before invoking adapters, executes an isolated fixture clone through stable candidate-specific adapter references, and attaches a content-addressed qualification to each route candidate. Model replay steps are rebound to that candidate profile's provider and model before adapter invocation. It then invokes the normal capability router with a mandatory quality gate.

```ts
const corpus = await appendReplayEvalCorpus(
  createReplayEvalCorpus("coding-agent-regressions"),
  fixture,
  {
    expectedRevision: 0,
    addedAt: new Date().toISOString(),
    tags: ["tool", "regression"],
  },
);

const report = await runControlledModelRouting({
  requestId: "turn-42",
  corpus,
  candidates: candidateModels.map(({ route, adapters }) => ({
    candidate: route,
    adapters,
  })),
  requirements: {
    reasoningLevel: "high",
    tools: { required: true, strictMode: true },
  },
  policy: { minPassRate: 1, maxFailures: 0 },
});
```

Untested, failing, wrong-corpus, stale-revision, and below-threshold qualifications are explicit route rejections. Adapter exceptions and incomplete executions cannot qualify a candidate even when the policy allows ordinary replay mismatches. Qualification reports retain fixture ids, hashes, statuses, and replay comparison reports but never adapter result bodies.

Corpus fixtures still contain captured replay inputs. Keep the corpus under the same access, secret-scanning, retention, and review controls as its source trace bundles.
