# Goal Mode

Goal mode keeps Pi working across autonomous continuations until an explicit objective is completed, blocked, paused, or stopped.

## Start and Control a Goal

Start a goal from interactive mode:

```text
/goal implement the requested change and verify it
```

The command persists the objective on the current session branch, shows its status above the editor, and starts the first model turn. Only a user command can create a goal.

| Command | Behavior |
|---------|----------|
| `/goal <objective>` | Start a new goal |
| `/goal start <objective>` | Explicit form of the start command |
| `/goal` or `/goal status` | Show the latest goal state |
| `/goal graph` | Show the durable work graph, active nodes, budgets, and leases |
| `/goal memory` | Show active and superseded engineering-memory records |
| `/goal pause` | Persist a pause and abort the active run |
| `/goal resume` | Continue an active, paused, or blocked goal |
| `/goal stop` | Permanently stop the unfinished goal |

Only one unfinished goal can exist on a session branch. Complete or stop it before starting another.

## Agent Protocol

While a goal is active, Pi exposes a `goal` tool with five actions:

- `status` reads the current objective and state.
- `update` persists a concise progress checkpoint.
- `remember` records a durable fact, decision, attempt, or evidence item.
- `complete` terminates the loop after the agent has verified the full objective.
- `blocked` terminates the loop when meaningful progress requires user input or an external state change.

A normal assistant response does not complete the goal. If the agent leaves it active, Pi adds a hidden follow-up and continues the run. Provider/runtime errors become a blocked goal, and an aborted run becomes paused.

## Completion Gate

A trusted project can require deterministic checks before the `complete` action succeeds by adding `.pi/goal.json`:

```json
{
  "version": 1,
  "checks": [
    {
      "id": "check",
      "command": "npm",
      "args": ["run", "check"],
      "timeoutMs": 120000
    }
  ]
}
```

Pi freezes the configuration's SHA-256 revision when the goal starts. The `complete` action reloads that exact revision and runs every direct command in the current logical workspace, including an active workspace overlay. A failed check keeps the goal active so the agent can repair and retry. A missing, invalid, or changed configuration blocks the goal instead of accepting a different completion contract.

Commands use direct argument arrays rather than a shell. Persisted goal state records only check IDs, statuses, exit codes, and the configuration revision. Bounded failure diagnostics are returned to the active agent but are not stored in the session.

Completion gates support host and workspace-overlay sessions. Pi rejects a configured gate in an execution-boundary session because extension commands run on the host and cannot safely claim boundary-local verification.

## Impact Completion Gate

When a trusted project contains `.pi/checks.json`, Goal mode enables impact verification by default and freezes the catalog revision at goal creation. Completion discovers the complete NUL-delimited Git worktree change set, synchronizes the CodeGraph provider for the current logical workspace, maps changed files through reverse dependencies, and runs only checks that cover the resulting impact.

The `codegraph` capability must be active for goals with changed files. Missing graph providers, catalog drift, unindexed changes without a fallback check, truncated or uncovered impact, Git discovery failures, and failed selected checks all fail closed. A content-addressed evidence id, coverage tier, aggregate changed/affected counts, and selected check ids are persisted; command output and file content are not.

Goals with both `.pi/goal.json` and `.pi/checks.json` must pass both the fixed completion checks and the dynamic impact plan. The work graph records the impact gate as a distinct verification node.

## Persistence and Limits

Every state transition is a custom session entry that does not enter model context. `/tree`, `/fork`, and session resume therefore restore the state from the selected branch. Restoring an active goal does not spend tokens by itself; run `/goal resume` or send a message to continue.

New goals also create a durable work graph with separate work, verification, and completion nodes. The graph records dependency transitions, attempts, bounded per-node budgets, and low-sensitivity evidence references. Its optimistic revision check prevents concurrent writers from silently overwriting newer task state. Interrupted runtimes can release leases and recover running nodes to a resumable state through the exported work-graph API.

The goal widget renders the live graph revision, succeeded/running/ready counts, active node policies, budget consumption, and leases. Restoring an active session conservatively moves interrupted running nodes back to ready; the next agent turn must claim the work node again before consuming its turn budget.

Each new goal also owns revisioned engineering memory. The objective, progress decisions, failed attempts, and completion evidence remain available after context compaction and branch restoration. The `remember` action can capture decision rationale and alternatives, attempt outcomes, evidence ids, and source-grounded facts. Source paths are hashed from the current logical workspace; facts cannot be stored without a source revision.

Every semantic record receives a stable SHA-256 id. When a conclusion changes, `remember` supplies the previous id in `replaces`. The old record remains reviewable but leaves active context. `/goal memory` shows the current revision and active/superseded counts. Before each agent run, only active records are compiled into bounded context; stale required facts block the goal instead of being reused.

Each activation grants 25 autonomous agent runs. Reaching that limit pauses the goal for review. `/goal resume` grants another batch, up to a lifetime maximum of 1,000 runs. The limit prevents an unattended model from looping indefinitely; it is not a completion signal.

Goal mode requires the `goal` tool. Pi rejects start or resume when that tool was disabled with `--exclude-tools`, `--no-tools`, or an equivalent tool allowlist.
