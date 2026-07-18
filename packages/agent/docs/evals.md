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
