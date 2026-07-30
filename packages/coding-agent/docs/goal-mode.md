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

## Persistence and Limits

Every state transition is a custom session entry that does not enter model context. `/tree`, `/fork`, and session resume therefore restore the state from the selected branch. Restoring an active goal does not spend tokens by itself; run `/goal resume` or send a message to continue.

Each activation grants 25 autonomous agent runs. Reaching that limit pauses the goal for review. `/goal resume` grants another batch, up to a lifetime maximum of 1,000 runs. The limit prevents an unattended model from looping indefinitely; it is not a completion signal.

Goal mode requires the `goal` tool. Pi rejects start or resume when that tool was disabled with `--exclude-tools`, `--no-tools`, or an equivalent tool allowlist.
