# Capability evaluations

The version 1 suites compare MCP and Playwright integration strategies with deterministic lifecycle, budget, trace, artifact, and process-leak evidence.

## Commands

Run from `packages/coding-agent`:

```bash
npm run eval:capabilities:offline
npm run eval:capabilities:browser
RUN_PI_LIVE_CAPABILITY_EVALS=1 npm run eval:capabilities:live
```

Pass one or more `--scenario <id>` arguments to the underlying capability CLI to run only selected scenarios. This is useful for targeted live rechecks without repeating the full matrix.

Reports and append-only journals are written under `.artifacts/capability-evals/`.

The offline suite uses local stdio and HTTP MCP fixtures. The browser suite runs the pinned `@playwright/mcp@0.0.78` and `@playwright/cli@0.1.17` packages against a loopback-only fixture without a model. The live suite uses `opencode/deepseek-v4-flash-free:high` and makes three attempts per scenario; it requires both `RUN_PI_LIVE_CAPABILITY_EVALS=1` and the CLI's `--allow-live` flag.

## Candidate matrix

| Candidate | Tool exposure | Discovery path |
| --- | --- | --- |
| `adapter-proxy` | One `mcp` proxy | Search then invoke through `pi-mcp-adapter@2.11.0` |
| `adapter-hybrid` | Small direct safe-tool allowlist plus proxy | Direct first, proxy fallback |
| `adapter-direct` | Safe direct tools; proxy disabled | Direct invocation |
| `playwright-cli-skill` | Pi `bash` plus pinned Playwright CLI skill and an eval-only command guard | CLI help and skill instructions |

The reference DeepSeek V4 Flash run selects `adapter-direct` as the default integration: its narrow tool surface was the most reliable and efficient. Keep `playwright-cli-skill` as a guarded fallback and `adapter-proxy` as a higher-cost compatibility/discovery path. The hybrid candidate remains experimental because its direct-plus-proxy surface was less reliable than either focused strategy.

## Safety and isolation

- Every task URL and configured browser origin is the attempt's loopback fixture. Browser sessions are headless and isolated or in-memory. Playwright's origin option is defense in depth, not a network sandbox.
- Playwright MCP runs without optional capabilities and excludes `browser_evaluate`, `browser_run_code`, `browser_run_code_unsafe`, `browser_file_upload`, and `browser_drop` from every adapter candidate.
- Sampling and elicitation are disabled for adapter candidates. Browser profiles and generated MCP config files live in per-attempt temporary directories.
- Live runs expose the existing model/auth files through links in a per-attempt agent directory. Model children use an isolated HOME and a narrow environment allowlist that omits credential variables; the harness does not read, copy, print, or persist credentials. Adapter metadata is prewarmed without a model in that isolated agent directory so hybrid/direct measurements cannot silently fall back to proxy discovery. The CLI candidate's eval-only extension blocks general shell syntax, unsafe Playwright commands, options, and navigation outside the fixture origin.
- Child output, reports, and journals use credential-shape redaction, bounded output, time budgets, and explicit process cleanup.

Suites and the shared driver configuration are versioned JSON under `evals/suites/` and `evals/drivers.v1.json`.
