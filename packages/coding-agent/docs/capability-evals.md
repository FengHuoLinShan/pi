# Capability Evaluations

Pi's versioned capability suites compare MCP and browser integrations with the same lifecycle, budget, trace, artifact, and process-leak checks. They are intended for integration decisions, not provider-quality leaderboards.

## Layers

| Layer | Network/model | Purpose |
|---|---|---|
| `offline` | No model; local stdio and loopback MCP fixtures | Protocol initialization, pagination, errors, cancellation, and cleanup |
| `browser` | No model; local loopback web fixture | Pinned Playwright MCP and Playwright CLI browser behavior |
| `live` | Configured provider and local web fixture | End-to-end tool discovery, invocation, completion, and repeatability |

Run from the repository root:

```bash
npm run eval:capabilities:offline
npm run eval:capabilities:browser
RUN_PI_LIVE_CAPABILITY_EVALS=1 npm run eval:capabilities:live
```

The capability CLI also accepts repeatable `--scenario <id>` filters for targeted reruns.

Live evaluation requires both the environment opt-in and the command's internal `--allow-live` flag. Version 1 fixes the model to `opencode/deepseek-v4-flash-free:high`, runs three attempts per candidate, and requires at least two passing attempts.

## Browser Candidate Matrix

| Candidate | Exposure |
|---|---|
| `adapter-proxy` | One discovery and invocation proxy from `pi-mcp-adapter@2.11.0` |
| `adapter-hybrid` | Small direct safe-tool allowlist plus proxy fallback |
| `adapter-direct` | Direct safe Playwright tools with the proxy disabled |
| `playwright-cli-skill` | Pi `bash` plus the pinned official Playwright CLI skill |

The browser dependencies are fixed at `@playwright/mcp@0.0.78` and `@playwright/cli@0.1.17`.

The reference DeepSeek V4 Flash evaluation recommends `adapter-direct` for the default Playwright integration. The guarded CLI skill is a fallback, the proxy is a higher-cost compatibility and discovery path, and the hybrid exposure remains experimental until it is more reliable than the focused candidates.

## Evidence and Safety

Passing requires fixture state and lifecycle evidence in addition to model output. Browser sessions are headless and isolated, traffic is restricted to the loopback fixture, optional Playwright capabilities are disabled, and high-risk evaluate, run-code, upload, and drop tools are excluded. Child processes receive a narrow environment that omits credential variables; Pi reads credentials through its normal auth storage.

Reports and append-only redacted journals are written under `packages/coding-agent/.artifacts/capability-evals/`. Suite definitions and driver configurations are versioned under `packages/coding-agent/evals/`.
