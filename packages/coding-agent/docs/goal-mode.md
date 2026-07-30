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
| `/goal pause` | Persist a pause and abort the active run |
| `/goal resume` | Continue an active, paused, or blocked goal |
| `/goal stop` | Permanently stop the unfinished goal |

Only one unfinished goal can exist on a session branch. Complete or stop it before starting another.

## Agent Protocol

While a goal is active, Pi exposes a `goal` tool with four actions:

- `status` reads the current objective and state.
- `update` persists a concise progress checkpoint.
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

## Persistence and Limits

Every state transition is a custom session entry that does not enter model context. `/tree`, `/fork`, and session resume therefore restore the state from the selected branch. Restoring an active goal does not spend tokens by itself; run `/goal resume` or send a message to continue.

New goals also create a durable work graph with separate work, verification, and completion nodes. The graph records dependency transitions, attempts, bounded per-node budgets, and low-sensitivity evidence references. Its optimistic revision check prevents concurrent writers from silently overwriting newer task state. Interrupted runtimes can release leases and recover running nodes to a resumable state through the exported work-graph API.

Each new goal also owns a revision-aware working set. The objective, progress decisions, failed attempts, and completion evidence remain available after context compaction and branch restoration. Source-bound facts are rehashed in the logical workspace before injection; stale required facts block the goal instead of being reused.

Each activation grants 25 autonomous agent runs. Reaching that limit pauses the goal for review. `/goal resume` grants another batch, up to a lifetime maximum of 1,000 runs. The limit prevents an unattended model from looping indefinitely; it is not a completion signal.

Goal mode requires the `goal` tool. Pi rejects start or resume when that tool was disabled with `--exclude-tools`, `--no-tools`, or an equivalent tool allowlist.
