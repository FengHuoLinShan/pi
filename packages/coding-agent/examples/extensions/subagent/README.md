# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Global progress panel**: See active tasks from multiple simultaneous subagent tool calls in one Pi widget
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Per-task runtimes**: Select provider, model, reasoning effort, and parent-inheritance or child-default model policy per agent or task
- **Task control**: Extensions can observe live task state and cancel one parallel task without stopping siblings
- **Bounded execution**: Every task has a finite wall-clock timeout (default 180000 ms) with SIGTERM/SIGKILL cleanup
- **Workspace containment**: Task working directories are canonical existing directories contained by the parent workspace

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── progress-display.ts  # Aggregated multi-call progress state and formatting
├── runtime-config.ts    # Runtime override parsing and validation
├── task-control.ts      # Per-task cancellation and process cleanup
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── researcher.md    # Multi-source evidence, reconciliation, and uncertainty
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/progress-display.ts" ~/.pi/agent/extensions/subagent/progress-display.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/runtime-config.ts" ~/.pi/agent/extensions/subagent/runtime-config.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/task-control.ts" ~/.pi/agent/extensions/subagent/task-control.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

Every call requires an explicit call-level `timeoutMs`; parallel and chain items may override it individually. Use at least `180000` ms for a focused single-file task and `300000` ms for a bounded multi-file review. Each task or step must describe one bounded deliverable, and broad repository, test, and artifact audits should be split into independent tasks instead of assigning an exhaustive review a short deadline. Task-stated scope and explicit paths are hard boundaries: children must not inspect unrelated dirty changes or run broad repository scans unless requested, must report nonexistent paths once without searching outside scope, and must return as soon as a narrow acceptance checklist is satisfied. Relative or omitted `cwd` values resolve from the parent `ctx.cwd`; canonical `..` and symlink escapes are rejected. `timeoutMs` must be a positive finite integer no greater than 2147483647. Internal normalization retains a 180000 ms fallback for direct programmatic invocations that bypass tool-schema validation.

At session start, the tool description lists every available user role with its resolved provider/model, effective effort, and model-supported effort levels when child-equivalent preflight can determine them. When an unsupported role or personal default effort is adjusted, the description includes the original and resolved effort. Inherited parents, child defaults, model defaults, and unavailable preflight data are labeled as resolved at invocation rather than guessed. Unknown roles remain runtime-rejected with the current available-role list, including opt-in project roles that cannot be safely advertised before scope selection.

Runtime fields use this precedence:

1. Task override
2. `~/.pi/agent/agent-runtimes.json`
3. Agent frontmatter

Model selectors replace each other across precedence layers: a higher `modelPolicy` clears lower provider/model fields, while higher explicit provider/model fields clear a lower policy. When explicit selection wins, missing provider or model fields may be completed independently from lower explicit provider/model layers, skipping policy layers. Frontmatter parse errors are discarded with lower fields discarded by a higher selector, while errors for fields still consumed by a partial explicit selector are retained. A model-only override replaces a lower provider only when its first slash separates a non-empty, child-equivalent-registry-known provider from a non-empty remaining model ID; malformed slashes and unknown prefixes remain unqualified and still consume the lower provider. A policy combined with provider/model in the same layer is rejected.

When no model selector remains, `modelPolicy` defaults to `inherit-parent`: the tool captures one immutable provider/model snapshot from `ctx.model` at the start of the tool execution and shares it across every single, parallel, or chain task. Thinking resolves independently by the same precedence, so a thinking-only override does not clear provider/model selected by a lower layer. To replace a personal explicit model with the parent model, set `modelPolicy: "inherit-parent"` explicitly on the task; task thinking then applies to that inherited parent model. A higher `child-default` discards lower thinking, intentionally omits provider/model CLI flags, and preserves the child CLI's own default-model selection; combining it with thinking in the same layer is rejected. A task-level thinking override unsupported by the resolved model is strictly rejected during preflight and is never silently clamped. When the task omits thinking, an unsupported role or personal default is transparently normalized with the official model clamp and reported as `Adjusted default thinking from <old> to <new>`; supported defaults remain unchanged. Provider-without-model and same-layer policy conflicts fail with fixed diagnostics rather than guessing.

Before spawning any child, the tool creates one local child-equivalent model preflight for the tool execution. It uses the same agent directory, `auth.json`, `models.json`, and ambient environment as the child with model network refresh disabled. It verifies model presence, child-visible authentication, and thinking support without returning credentials, resolved keys, headers, or auth values and never adds `--api-key`. Parent process-local runtime credentials and user/dynamic extension providers are rejected when those resources cannot be reproduced by the child.

Run `/agent-config` to edit personal runtime overrides without changing agent Markdown files.

Child processes pass `-p --no-session --no-extensions --no-prompt-templates`, so they start with one delegated user task and never copy the parent transcript. The appended deterministic context names the child role and source, parent model, resolved child runtime, canonical cwd, task id, configured timeout, and task boundary. It directs children to search before broad reads, use one default bounded read for likely small files, and add `offset`/`limit` only for truncated output or task-relevant ranges. Logs and large files use targeted `rg` queries before bounded reads and are not read sequentially to EOF unless the task requires complete evidence. Read-only tasks conditionally prohibit mutation, temporary probes belong under the OS temporary directory, and applicable `AGENTS.md` command/test rules remain binding. The final response begins with an exact `RESULT: completed|partial|blocked` marker, then follows the role persona's response format while explicitly covering evidence and unresolved issues. Roles without a defined format fall back to concise `SUMMARY:`, `EVIDENCE:`, and `OPEN_ISSUES:` sections. `--no-extensions` disables discovered user/project extensions, but Pi's built-in inline extensions are still installed by the CLI and are not disabled by that flag. Context-file discovery remains enabled so `AGENTS.md` or `CLAUDE.md` policies are loaded once by the child itself rather than preloaded and listed again by the parent. Skill discovery also remains enabled because skills provide task-relevant procedures rather than recursively executable extensions; there is no separate subagent skill toggle in Phase B.

## Output Display

**Parent-model terminal content**:
- Returns one compact deterministic summary per result in input order
- JSON-quotes metadata values so embedded whitespace, quotes, or key-like text cannot forge adjacent fields
- Includes task ID, role, terminal status, canonical cwd, timeout, provider/model/thinking, parsed child `reportedOutcome`, any default-thinking adjustment, and turns/input/output/cacheRead/cacheWrite/contextTokens/cost counters
- Includes a uniform child outcome line with `exitCode`, `stopReason`, and `errorMessage` (`null` when absent), independently of transport success
- Applies a strict 8 KB encoded cap to error text; complete timeout diagnostics fit below that cap and retain elapsed/configured deadlines and bounded-task retry guidance
- Includes all text parts from only each child's final assistant message, capped at 50 KB, rather than copying complete child message histories; full messages remain in structured `details`

**Global live panel**:
- Aggregates every active `subagent` tool call instead of showing only one call's current tool row
- Groups single, parallel, and chain calls while showing queued, running, completed, failed, and cancelled siblings together
- Shows bounded activity metadata only: responding phase, validated/redacted tool name, inactivity warning, runtime, turns, tokens, and cost; raw assistant text deltas and tool arguments are never published, and snapshot records also carry canonical cwd and timeout
- Disappears after all active calls finish; completed tool results remain in the transcript
- Displays up to 6 call groups and 12 task rows at once, then reports omitted calls and tasks

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls by name; raw child tool arguments are withheld from stored results and tool details, and every renderer explicitly labels their arguments as redacted
- Final assistant text rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Emits one revisioned full snapshot per `toolCallId`, with `expectedTasks` and every task; stale or child-only snapshots are ignored
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress and on a 30-second heartbeat before timeout
- Shows "2/3 done, 1 running" status, counting only completed, failed, timed-out, skipped, or cancelled tasks as done
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns the same fixed preflight diagnostic to the parent model and TUI in every mode: error code, fixed message, resolved runtime, supported thinking levels, canonical cwd, and effective timeout
- Keeps preflight diagnostics credential-blind: raw exceptions, stderr, keys, auth/header/environment/credential values, API keys, and model config values are excluded
- Keeps only a redacted 64 KB stderr tail and returns bounded, redacted failure diagnostics when a child exits before producing output

**Tool call display**:
- Tool call IDs and names remain available for sequencing and expanded-result display
- Raw child tool arguments are replaced at the message parsing boundary with `arguments: {}` plus sibling `argumentMetadata: { visibility: "redacted", count }`, regardless of whether values appear sensitive
- Renderers recognize the explicit metadata before any tool-specific formatting and display `tool call <name> — arguments redacted`; built-in and custom tool schemas cannot collide with the redaction representation
- A legacy empty arguments object is treated as redacted with unknown count, never as evidence that arguments were omitted
- Argument-derived names, commands, paths, patterns, credentials, and other values are not retained or rendered

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
provider: anthropic
model: claude-haiku-4-5
thinking: low
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

Personal runtime overrides are stored separately with private file permissions:

```json
{
  "version": 1,
  "agents": {
    "scout": {
      "provider": "openai-codex",
      "model": "gpt-5.6-codex",
      "thinking": "low"
    }
  }
}
```

Use a policy-only override when no provider/model is selected:

```json
{
  "version": 1,
  "agents": {
    "researcher": {
      "modelPolicy": "inherit-parent",
      "thinking": "high"
    }
  }
}
```

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon and compressed handoff | Haiku | read, grep, find, ls, bash |
| `researcher` | Multi-source evidence, conflict reconciliation, and explicit uncertainty | Parent model | read, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

The subagent extension is an orchestrator: a successfully returned `AgentToolResult` means the orchestration transport completed, not that every child succeeded. Extension tool return values do not support an `isError` field; Pi only marks the transport as failed when `execute()` throws. This extension does not throw for child failures because doing so would replace the structured child outcomes rather than return their `details`. Parent sessions therefore continue normally and may exit 0 after handling a failed child.

Process outcomes are authoritative in `details.results[*].status`, `exitCode`, `stopReason`, and `errorMessage`, and the same fields are summarized in parent-model-visible terminal content. A child's exact first-line `RESULT:` marker is parsed separately into `reportedOutcome`; it never overwrites process status.

- **Exit code != 0**: Child result uses a failed status and includes bounded stderr/error output
- **stopReason "error"**: Child LLM error is represented in the child result and parent-visible summary
- **stopReason "aborted"**: User or parent cancellation remains `cancelled` and distinct from timeout
- **status "timed_out"**: Wall-clock deadline sends SIGTERM, escalates to SIGKILL after 5 seconds if needed, and reports a distinct terminal result
- **Chain mode**: Stops at first failing/timed-out step and marks unstarted steps `skipped`, leaving no queued/running final records

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- Global progress panel displays at most 6 call groups and 12 task rows at once
