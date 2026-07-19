# Workspace Change Discipline

`createWorkspaceChangeDisciplineVerifier()` is an opt-in completion verifier for an application-owned `WorkspacePatchSet` resolved at verification time. It can constrain workspace-relative paths, create/update/delete/mode operations, changed file count, total changed bytes, and per-file changed bytes.

Policy evaluation is a foreground, read-only check. The host-supplied `getPatchSet` resolver may capture a PatchSet or read application state, but the verifier does not select a Shadow Run, apply a PatchSet, or discard an overlay. Hosts retain explicit control over every workspace mutation.

```ts
import {
  createWorkspaceChangeDisciplineVerifier,
  type ShadowRunVerificationContext,
} from "@earendil-works/pi-coding-agent";

const verifier = createWorkspaceChangeDisciplineVerifier<
  ShadowRunVerificationContext<{ model: string }, { score: number }>
>({
  id: "workspace-discipline",
  policy: {
    allowedPaths: ["src/**", "test/**"],
    deniedPaths: ["src/generated/**", "**/*.pem"],
    allowedOperations: ["create", "update", "delete"],
    minFiles: 1,
    maxFiles: 20,
    maxChangedBytes: 256_000,
    maxFileBytes: 64_000,
  },
  getPatchSet: (context) => context.patchSet,
});
```

Pass the verifier through an explicit completion contract in `runShadowCandidates()`, `verifyCompletionContract()`, or `executeVerifiedRun()`. The verifier is never registered by the default CLI or interactive session.

`getPatchSet(context, signal)` may return a PatchSet directly or resolve one asynchronously; existing one-argument synchronous resolvers remain valid. The verifier checks cancellation before resolution and again after awaiting it. An abort during capture returns `blocked` without evaluating the resolved value or emitting evidence; a later resolver settlement is ignored, and a later rejection remains handled. Without an abort, resolver rejection remains a verifier exception, which the default completion runner isolates as an `error` report.

The verifier does not discover or interpret `AGENTS.md`, `CLAUDE.md`, or other repository instructions. An SDK host must translate applicable instructions into an explicit policy. In a Verified Run, the host must also supply `getPatchSet` and expose either the final PatchSet or the retained overlay/application state needed to capture it through the caller-owned verification context; `executeVerifiedRun()` does not infer a workspace or PatchSet from the Harness.

## Policy semantics

- `allowedPaths` and `deniedPaths` are case-sensitive, portable workspace-relative minimatch globs. Dot paths are included. Leading `!` and `#` are literal characters, not negation or comment syntax. Deny rules take precedence. Omitting `allowedPaths` allows every path; an empty array allows none.
- `allowedOperations` is optional. A content update and a mode update are separate operations. A pure mode change requires only `mode`; a content-plus-mode change requires both `update` and `mode`. A created file's initial mode and a deleted file's removed mode are not mode operations.
- `minFiles` and `maxFiles` count PatchSet entries. `minFiles` defaults to no lower bound. `minFiles: 0` is valid but does not establish an effective gate; a positive value does. Any configured `maxFiles`, including zero, is an effective upper-bound gate. `minFiles` cannot exceed `maxFiles` when both are present.
- `maxChangedBytes` uses a conservative content-touch measure: create uses the new size, delete uses the old size, content update uses the larger side, and a mode-only update uses zero. `maxFileBytes` applies the same measure to each entry.
- An empty PatchSet passes unless a positive `minFiles` requires changes.

At least one effective policy gate must be configured; an empty `deniedPaths` array alone is not a gate. Sparse policy arrays, invalid patterns, duplicate operations, unsafe limits, and malformed PatchSets fail closed as verifier errors.

Runtime validation checks PatchSet structure and internal consistency. In particular, an update with the same before/after revision must report the same before/after byte length. It does not authenticate caller-supplied old sizes or prove that the description matches a live workspace. Use a PatchSet returned by the retained `WorkspaceOverlay`, and apply that exact reviewed PatchSet; `WorkspaceOverlay.applyPatchSet()` independently rejects overlay drift and workspace conflicts.

## Evidence privacy

Completion evidence contains aggregate counts and policy violations, but omits paths, the PatchSet id, and the base-snapshot id by default. It never includes file content, unified patches, or before/after content revisions.

A `min_files_not_met` evidence violation contains only the actual file count and configured limit; it does not add a path or other file identity.

`evaluateWorkspaceChangeDiscipline()` returns a direct application result whose violations contain plain paths. The evidence privacy options apply only to `createWorkspaceChangeDisciplineVerifier()` output.

Set `evidencePathMode: "digest"` to include deterministic SHA-256 path digests, or `evidencePathMode: "plain"` to include workspace-relative paths. A deterministic digest is only a correlatable pseudonym: it is not anonymization and can be guessed for common repository paths. Use the default `"omit"` mode when path names are sensitive.

Set `evidenceIdentityMode: "include"` to include the PatchSet reference and base-snapshot digest for explicit report correlation. These identifiers can correlate reports and the PatchSet id is caller controlled, so keep the default `"omit"` mode when identities are sensitive.

The verifier result is evidence about one PatchSet description, not an apply authorization token. `WorkspaceOverlay.applyPatchSet()` still performs its own current-overlay signature and workspace conflict checks before any explicit apply.
