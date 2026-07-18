# Durable AgentHarness and session design

<!-- Synced from jot zmnps2zu. Edit this file in-repo going forward. -->

Durable AgentHarness / session design notes.

## Framing

A fully durable `AgentHarness` is not realistic by itself because important dependencies are runtime JS supplied by the host app:

- tool implementations
- model/auth providers
- extensions and hook handlers
- resource loaders
- system-prompt callbacks/modifiers

Tool registries are runtime dependencies. The harness should persist serializable tool configuration, such as active tool names, but not concrete tool implementations.

The practical target is a semi-durable harness:

- session is the durable append-only state tree
- harness persists the state it owns into session entries
- the host app is responsible for recreating compatible non-persistable dependencies on resume
- recovery restarts from durable boundaries, not from an in-flight provider stream

## Session owns durable state

Treat session as all durable agent state, not just transcript history.

Existing session state already includes harness state:

- model changes
- thinking-level changes
- active-tool changes
- leaf entries
- labels
- compactions and branch summaries
- custom messages and custom entries

That suggests continuing with one durable session log rather than adding harness sidecars. Sidecars may still be useful for large blobs, but the session entry should remain the source-of-truth reference.

## What the app must provide on resume

The app must recreate compatible runtime dependencies:

- model registry / model objects
- tool registry
- extension set, versions, and ordering
- resource loaders
- system prompt providers/hooks
- auth providers
- app-specific hooks

Harness can validate stable IDs/versions/hashes when available, but it cannot serialize these dependencies itself.

## Runtime configuration and restore

Constructor options remain explicit runtime configuration and do not read session state. Hidden async restore in a constructor would make failure handling ambiguous.

The async `restoreAgentHarness()` factory owns durable restore:

```ts
const { harness, recovery } = await restoreAgentHarness({
  env,
  session,
  models,
  model: defaultModel,
  tools: runtimeTools,
  activeToolNames: ["read", "edit"],
});
```

The factory opens or accepts the runtime journal, conservatively marks interrupted work, constructs the harness, applies unapplied writes, restores branch-selected configuration and queues, validates app-supplied runtime dependencies, and emits `source: "restore"` updates where state changes.

For active tools:

- `active_tools_change` entries are branch-scoped durable config.
- If no `active_tools_change` exists on the branch, restore uses builder defaults, or all registered tools if no default active names were supplied.
- Active tool names must be unique.
- Tool registry names must be unique.
- Missing restored active tool names should fail restore by default; permissive drop/disable policies can be added explicitly later.
- Concrete tools are never restored from session; the host app must provide compatible tools.

## What harness should persist

Minimum useful durability entries:

- branch-scoped active tool names
- queued steer/followUp/nextTurn messages
- queue consumption tied to a turn
- pending session writes accepted during active operations
- pending write application status
- operation start/finish/interruption
- turn start/finish
- provider request start/finish, if needed for recovery diagnostics
- tool call start/finish, if we want safe tool recovery

Potential entries:

```ts
type DurableHarnessEntry =
  | QueueEnqueuedEntry
  | QueueConsumedEntry
  | PendingWriteEnqueuedEntry
  | PendingWriteAppliedEntry
  | OperationStartedEntry
  | OperationFinishedEntry
  | OperationInterruptedEntry
  | TurnStartedEntry
  | TurnFinishedEntry
  | ProviderRequestStartedEntry
  | ProviderRequestFinishedEntry
  | ToolCallStartedEntry
  | ToolCallFinishedEntry;
```

Every accepted mutation must be durable before the public API resolves.

## Recovery model

On startup:

1. Host app registers tools/models/extensions/resources/auth/hooks.
2. Harness opens session.
3. Harness reduces session entries into:
   - current leaf
   - conversation branch
   - harness config, including active tool names
   - queues
   - pending writes
   - active operation/turn/tool state
4. Harness validates required runtime dependencies, including restored active tool names against the app-provided tool registry.
5. Harness reconciles unfinished operation state.

Provider streams are not resumable. Recovery can only retry from a durable boundary or mark the operation interrupted.

## Recovery policies

Default conservative policy:

- unfinished agent turn: mark interrupted, preserve durable queues/pending writes, return idle
- unfinished provider request: mark interrupted; do not retry automatically
- unfinished tool call: append interrupted/error tool result; retry only if the tool declares retry-safe/idempotent
- unfinished compaction: rerun if no compaction entry exists
- unfinished branch summary/tree navigation: rerun/apply missing summary or leaf entries if safe

Optional policy:

```ts
recovery: "mark_interrupted" | "retry_unfinished"
```

`retry_unfinished` must be guarded around non-idempotent tool calls.

## Implemented runtime-event foundation

`SessionRuntimeEventStore` persists versioned `RuntimeEventEnvelope` values as `pi.runtime_event` custom entries in the active session branch. It does not create a sidecar log. The session remains the single durable source of truth.

The implemented event bodies cover:

- queued messages, consumed atomically by `turn_started`
- pending-write enqueue/apply state with deterministic target entry ids
- operation and turn start/finish/interruption
- provider-request and tool-call start/finish/interruption
- recovery markers and checkpoints

`reduceRuntimeEvent()` is a pure reducer. It requires contiguous branch-local sequences and valid causal transitions. `replayRuntimeEvents()` validates the envelope stream and resumes from the latest checkpoint. `SessionRuntimeEventStore.open()` reduces the current session branch explicitly; constructors do not perform hidden asynchronous restore.

Runtime envelopes are session-scoped. A session fork retains source entries so the tree parent chain stays intact, but the fork ignores inherited source-session runtime envelopes and begins its own sequence at 1.

`SessionRuntimeEventStore.recover()` implements the conservative policy:

- active provider requests, tool calls, turns, and operations are marked interrupted in dependency order
- queued messages and unapplied pending writes are returned to the host unchanged
- retry-safe tool calls are reported as eligible for an explicit host decision, but are never retried automatically

JSONL session open also repairs a malformed final line only when the line is unterminated, which identifies an interrupted append. Malformed complete lines and malformed middle lines remain hard errors. Callers can opt back into strict final-line handling with `repairPartialTail: false`.

`AgentHarness` writes these lifecycle events for operations, turns, provider requests, tool calls, queues, and pending session writes. The store and reducer intentionally do not serialize tool implementations, provider clients, hooks, or other host-owned runtime dependencies.

## Critical scenarios

### Queues

- Crash before `queue_enqueued`: message was not accepted.
- Crash after `queue_enqueued`: message is restored.
- Crash after queue drain but before durable turn record: risk of loss/duplication.
- Required invariant: consumed queue IDs must be recorded in `turn_started` or equivalent before they are considered consumed.

### Pending writes

- Crash before `pending_write_enqueued`: write was not accepted.
- Crash after enqueue before apply: recovery applies it.
- Crash after apply before applied marker: deterministic target entry IDs let recovery detect the entry already exists and mark it applied.

### Agent loop turn

- Crash before provider request: retry or mark interrupted.
- Crash during provider request: mark interrupted by default.
- Crash after provider response before assistant message persisted: response is lost unless provider result was journaled.
- Crash after assistant message persisted: recover from durable message.

### Tool calls

- Crash after tool call starts but before result: external side effects may already have happened.
- Default recovery should not rerun non-idempotent tools.
- Tool calls need stable IDs and retry-safety metadata for automatic recovery.

### Compaction

- Crash before summary generation: rerun preparation/summary.
- Crash after generated summary but before compaction entry: rerun unless summary was journaled.
- Crash after compaction entry: operation is complete; append finish marker if missing.

### Branch summary / tree navigation

- Crash before summary: rerun or mark interrupted.
- Crash after summary entry before leaf entry: append missing leaf entry.
- Crash after leaf entry: operation is complete; append finish marker if missing.

## Implemented minimum recovery contract

1. Queue acceptance is durable and queue consumption is tied atomically to a turn-start event.
2. Pending writes use deterministic target IDs and are reconciled idempotently.
3. Operations, turns, provider requests, and tool calls have explicit terminal or interrupted state.
4. Restore reduces the session journal and marks unfinished work interrupted by default.
5. Unfinished tool calls are never retried automatically; retry-safe metadata only makes them eligible for an explicit host decision.
6. Provider streams resume only from durable boundaries.

## Open questions

- Which remaining harness config entries should move into session first: resources, stream options, system prompt refs?
- Should resolved system prompt text be snapshotted per turn for audit/debug?
- Do we require strict dependency ID/version matching on resume?
- How much provider request data should be journaled?
- Should recovery append user-visible assistant interruption messages or only internal operation entries?
