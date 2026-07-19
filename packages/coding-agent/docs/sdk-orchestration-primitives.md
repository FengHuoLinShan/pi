# SDK orchestration primitives

The coding-agent package exposes optional workspace and orchestration primitives for SDK hosts. They are not enabled by the CLI or by `createAgentSession()` unless passed explicitly.

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
