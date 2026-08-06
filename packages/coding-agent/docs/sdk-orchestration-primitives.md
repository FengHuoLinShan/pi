# SDK orchestration primitives

The coding-agent package exposes optional workspace and orchestration primitives for SDK hosts. `createAgentSession()` only enables them when passed explicitly. The interactive CLI can opt into a persistent `WorkspaceOverlay` with `--workspace-overlay` or reviewed multi-candidate runs with `--shadow-runs`.

## Local verified work runtime

`LocalVerifiedWorkRuntime` turns a persisted `WorkGraph` into an executable local scheduler. It recovers interrupted running nodes, claims ready nodes through optimistic revisions, executes compatible `parallel-read` nodes concurrently, and serializes every progress, budget, lease, and terminal-state mutation.

```ts
const runtime = new LocalVerifiedWorkRuntime(store, {
  execute: async (node, context) => {
    if (node.policy === "isolated-mutation") {
      await context.acquireLease({
        id: `write-${node.id}`,
        resource: "packages/agent",
        mode: "write",
      });
    }
    const result = await executeNode(node, context.signal);
    return {
      status: result.passed ? "succeeded" : "failed",
      summary: result.summary,
      evidence: result.evidence,
    };
  },
});

const report = await runtime.run(graph.id, { signal });
```

Only `parallel-read` nodes share an execution batch. Mutation, verification, approval, apply, and inline nodes are claimed one at a time. The runtime never invents an executor, retries an unsafe action, or treats pending descendants as complete. A graph passes only when every node succeeds.

## Transactional workspace overlays

`WorkspaceOverlay` materializes an isolated copy of a workspace and records a base revision for every file. Passing it to `createAgentSession()` routes built-in file, search, and bash tools into the overlay.

```ts
const { overlay, recovery } = await WorkspaceOverlay.open({ workspaceRoot: cwd });
if (recovery.action !== "none") auditRecovery(recovery);

const { session } = await createAgentSession({
  cwd,
  model,
  workspaceOverlay: overlay,
});

await session.prompt("Implement the requested change");
const patchSet = await overlay.createPatchSet();
await reviewPatchSet(patchSet);
await overlay.applyPatchSet(patchSet);
```

PatchSets include creates, updates, deletes, modes, content revisions, and text patches where available. Application preflight verifies every base revision before mutation. Application uses same-directory staging, backups, a durable journal, post-write verification, and compensating rollback. Reopening an overlay rolls back a prepared journal or finalizes a committed journal. `discard()` is explicit.

`ReviewablePatchStack` can capture immutable cumulative PatchSet checkpoints from one overlay. Each layer has an optimistic stack revision and an explicit pending, approved, or rejected review state. Applying requires every layer to be approved and delegates the final cumulative PatchSet back to `WorkspaceOverlay.applyPatchSet()`, so stack review never bypasses workspace conflict detection or rollback.

In interactive CLI mode, built-in tools run in the overlay. Agent settlement captures cumulative Patch Stack checkpoints; `/overlay stack`, `/overlay review [layer-id]`, `/overlay approve [layer-id]`, and `/overlay reject [layer-id]` expose review decisions. `/overlay apply` performs a final cumulative review, approves remaining pending layers, and applies through the overlay transaction. `/overlay status` and `/overlay discard` inspect or abandon the transaction. Applying or discarding exits the process so a later run starts from a fresh base snapshot. The CLI requires a persisted session and stores overlay state by session id under the agent directory. It also initializes independent Git metadata inside the overlay for local `git status` and `git diff`; that metadata is excluded from the PatchSet.

An overlay cannot be combined with `executionBoundary`, custom built-in operation overrides, or arbitrary allowed roots. `.git` is excluded by default, escaping symlinks are rejected, and worktree-style `.git` files cannot be copied.

The overlay is a transaction and review boundary, not an OS security sandbox. Built-in bash starts in the materialized workspace, but shell commands, extensions, and caller code still run in the host process and can address host paths; use `executionBoundary` instead when process or filesystem confinement is required.

## Incremental code graph

`IncrementalCodeGraph` is an in-memory, language-neutral graph. Parsers remain behind `CodeGraphExtractor<TInput>`; the graph performs no file reads or watching.

```ts
const revision = computeCodeGraphFileRevision(source);
await graph.extractAndUpsert(
  { path: "src/run.ts", previousRevision: null, revision },
  source,
  typescriptExtractor,
);

const impact = graph.findImpactPaths(["run"], {
  maxDepth: 4,
  edgeKinds: ["depends_on", "calls"],
});
```

Updates replace one file atomically under an expected revision. Snapshots are deterministic and restorable; node/edge ids have single-file ownership; targets may remain unresolved; forward, reverse, and impact queries have explicit depth, path, and edge-kind bounds.

## Architecture fitness

`loadArchitectureFitnessPlan()` reads the verified project file `.pi/architecture.json`. `evaluateArchitectureFitness()` evaluates its revisioned rules against a deterministic `CodeGraphSnapshot`.

Supported rules prohibit selected dependencies, restrict a layer to explicit destinations, reject file-level cycles, and bound the number of files depending on selected files. Each violation has a stable content-derived id. `baselineViolationIds` suppresses only exact known violations, so unrelated architecture debt cannot mask a new regression. `compareArchitectureFitness()` reports new, resolved, and unchanged violation ids between two content-addressed reports.

The optional CodeGraph extension exposes the same evaluation through `code_graph` action `fitness` after synchronizing the current logical workspace. It requires a trusted project because the repository controls the rule file.

## Revisioned engineering memory

`SessionEngineeringMemoryStore` persists append-only `RevisionedEngineeringMemory` snapshots on the selected session branch with optimistic revisions. `resolveWorkspaceMemorySources()` hashes source paths from the current logical `WorkspaceView`, and `prepareWorkspaceEngineeringMemory()` revalidates every active source-bound record before compiling bounded context.

Goal mode creates one memory per goal. Its `remember` action records source-grounded facts, decisions with rationale and alternatives, attempts with outcomes, or evidence. Replacements retain the prior record in history while removing it from active context. Boundary-backed hosts must provide their own source resolver when source-bound memory is required.

## Shadow runs

`runShadowCandidates()` opens one overlay per caller-supplied candidate. Every overlay must share the same base snapshot before any runner starts. Execution is sequential by default; parallel execution requires `execution: "parallel"`.

```ts
const report = await runShadowCandidates({
  workspaceRoot: cwd,
  candidates,
  run: async ({ candidate, overlay, signal }) => {
    return runCandidateInSession(candidate, overlay, signal);
  },
  completion: { contract, verifiers },
});

const ranking = await rankShadowRuns(report, (run) => ({
  score: scoreCandidate(run),
  summary: summarizeCandidate(run),
}));
```

Candidate failures are isolated by default and retain partial PatchSets for inspection. Completion contracts can gate ranking. The SDK never chooses, applies, or discards a winner automatically; use the selected overlay's `applyPatchSet()` or call `discardShadowRunOverlays()` explicitly.

`applyShadowRunCandidate()` closes the host-side selection transaction without making the decision: the caller supplies one candidate id, the helper rejects incomplete, failed, completion-rejected, or empty candidates, applies its captured PatchSet, then discards every retained overlay. Apply conflicts leave every overlay intact. Cleanup failures after a successful commit are reported separately so the host cannot misreport an applied change as an all-or-nothing failure. Completion verifiers are required to be observational; a verifier that changes the candidate workspace fails that candidate.

## Interactive reviewed candidates

Start interactive pi with `--shadow-runs`, then use `/shadow run <objective>`. The built-in workflow reads the trusted project file `.pi/shadow-runs.json`:

```json
{
  "version": 1,
  "execution": "sequential",
  "candidates": [
    {
      "id": "minimal",
      "label": "Minimal patch",
      "instructions": "Make the smallest complete change."
    },
    {
      "id": "defensive",
      "label": "Defensive design",
      "instructions": "Prioritize failure handling and maintainability.",
      "thinkingLevel": "high"
    }
  ],
  "checks": [
    {
      "id": "check",
      "command": "npm",
      "args": ["run", "check"],
      "timeoutMs": 120000
    }
  ],
  "budget": {
    "maxModelCalls": 8,
    "maxToolCalls": 80,
    "maxWallTimeMs": 600000,
    "maxModelTokens": 200000,
    "maxCost": 2
  }
}
```

The workflow accepts two to four candidates and runs them sequentially unless parallel execution is explicitly configured. Every candidate uses the active model, its own isolated overlay and in-memory session, optional candidate-specific thinking, hard run budgets, loop detection, independent Git metadata, and no extensions. Configured checks execute directly without a shell inside each candidate overlay, inherit the host process environment, and form required completion-contract conditions. Checks must not mutate workspace contents.

The original workspace remains unchanged while `/shadow status` and `/shadow review [id]` expose candidate responses, usage, verifier evidence, and PatchSets. `/shadow apply [id]` accepts only a completed, non-empty candidate that passed every check, shows it for review, requests explicit confirmation, applies it atomically, and discards its peers. `/shadow discard` abandons all candidates. Session switching and forking are blocked while candidates remain; shutdown discards them.

The project must be trusted because its config supplies model instructions and executable commands. The CLI requires explicit cost approval before starting and rejects combination with an execution boundary, `--workspace-overlay`, `--task-contract`, or `--verify-loop`. Like `WorkspaceOverlay`, Shadow Runs provide a comparison and review boundary, not OS confinement: candidate shell commands could still address host paths.
