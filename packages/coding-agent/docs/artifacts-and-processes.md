# Artifacts and Durable Process Sessions

Pi's low-level artifact and process-session modules keep large tool output outside conversation and lifecycle event logs. They are SDK building blocks; the default interactive `bash` tool does not create durable process sessions yet.

## Artifact Store

`ArtifactStore` is a local, content-addressed store:

```typescript
const { store, recovery } = await ArtifactStore.open({
  root: "/trusted/pi-state/artifacts",
  allowedRoots: ["/trusted/pi-state"],
});

const artifact = await store.put(output, {
  mediaType: "text/plain",
  provenance: {
    producer: "build-process",
    processSessionId: "process-123",
    attributes: { stream: "stdout" },
  },
});
```

The returned reference is `sha256:<64 lowercase hex characters>`. Equal bytes share one immutable object. Each write creates a separate small provenance sidecar, so repeated uses of the same content retain their individual origin records without copying the object.

Storage layout:

```text
<root>/
  objects/sha256/ab/<digest>
  metadata/sha256/ab/<digest>/<record-id>.json
```

Objects and sidecars use same-directory staging and atomic rename. Store paths are canonicalized with `realpath`, checked against `allowedRoots`, and revalidated immediately before mutation. An explicit empty allowlist denies all paths. These checks reduce accidental and confused-path access; like the built-in file-tool checks, they are not an OS sandbox and cannot eliminate filesystem races against a hostile local process.

`ArtifactStore.open()` scans the object and metadata trees, verifies object hashes, and rebuilds its in-memory index. It reports corrupt objects, invalid sidecars, and objects recovered without metadata. `read(ref)` verifies the content hash again before returning bytes.

## Process Session Contract

`ProcessSessionManager` records an explicit append-only lifecycle:

```text
process_created
  -> process_started | process_failed | process_interrupted
process_started
  -> process_output*        (ArtifactRef only)
  -> process_termination_requested?
  -> process_exited | process_failed | process_interrupted
```

The API exposes `start`, `attach`, `status`, `terminate`, `waitForExit`, and `readOutput`. Every process has a stable session id and backend handle. Standard output and standard error chunks are stored in `ArtifactStore`; `process_output` events contain only the artifact reference, stream, and byte length. Environment variable values are delegated to the backend but are never written to the process event log.

```typescript
const { manager } = await ProcessSessionManager.open({
  root: "/trusted/pi-state/processes",
  artifactStore: store,
  defaultCwd: "/workspace",
  maxOutputBytesPerSession: 10 * 1024 * 1024,
});

const processSession = await manager.start({
  command: "/usr/bin/git",
  args: ["status", "--short"],
});

const completed = await manager.waitForExit(processSession.id);
const stdoutTail = await manager.readOutputTail(completed.id, {
  stream: "stdout",
  maxBytes: 64 * 1024,
});
```

The event log is `<root>/process-sessions.jsonl`. Appends are flushed before state is published. On open, a partial unterminated tail is discarded before new events are appended, valid events are replayed in sequence, and impossible lifecycle transitions are rejected.

`maxOutputBytesPerSession` is optional for SDK compatibility. When configured, the manager persists at most that many output bytes, records a durable `process_failed` event at the limit, and terminates the backend handle. `readOutputTail()` bounds returned output and reads only the newest artifact records needed for the requested tail; `readOutput()` remains available when a caller explicitly needs the complete retained output.

`pruneTerminalSessions(ids)` irreversibly removes the selected terminal sessions from the process journal, then removes their artifact provenance sidecars. It rejects active and unknown session IDs before changing the journal. Content objects referenced by another provenance record are retained; an object is deleted only when no known or unknown sidecar remains. Invalid or newer-version journal lines are preserved byte-for-byte during the atomic journal rewrite. Artifact cleanup runs after the process journal becomes authoritative and reports a separate `artifactCleanupError` if physical cleanup cannot finish.

## Recovery and Attach Semantics

A backend decides whether a durable handle can be reattached. During recovery:

- an attachable active handle remains `running`
- an already-exited handle receives a recovered `process_exited` event
- a missing or non-attachable handle receives `process_interrupted`

`NodeProcessSessionBackend` is deliberately conservative. It can attach only while the same backend instance still owns the live `ChildProcess`; a new pi process does not infer ownership from a PID or claim cross-process reattachment. Persisted local sessions that were active at a crash therefore become `interrupted`.

Container, VM, or remote-sandbox integrations can implement `ProcessSessionBackend` with durable remote handles, `attach`, `status`, and `terminate` operations.

## Interactive Managed Jobs

Start pi with `--managed-jobs` to enable a user-controlled background process surface:

```text
/job start --name dev npm run dev
/job list
/job status <id>
/job output <id> [stdout|stderr|all]
/job send <id> [stdout|stderr|all]
/job wait <id> --contains <text> [--stream stdout|stderr|all] [--timeout 1-120]
/job stop <id>
```

Commands use direct executable-and-argument spawning, not a shell. Quotes and escaped whitespace group arguments, but pipes, redirects, variable expansion, and other shell syntax are not interpreted. If shell behavior is intentionally required, invoke the shell executable explicitly.

`--name` assigns a stable job ID for later commands such as `/job output dev`; names must be 1-64 characters, begin with an alphanumeric character, and otherwise contain only alphanumerics, `.`, `_`, or `-`. Names are unique and immutable within the workspace journal. Without `--name`, pi generates a UUID and accepts an unambiguous prefix of at least four characters.

The built-in policy permits at most four active jobs per workspace, retains at most 10 MiB of artifact-backed output per job, and displays at most the newest 16 KiB. Reaching the output limit durably fails and terminates the job. Job IDs, commands, arguments, working directories, backend handles, environment variable names, lifecycle states, and artifact references are journaled; environment values and output bytes are not. Do not put credentials directly in command arguments.

Managed jobs are workspace-scoped and share one live local backend while pi is running. A clean pi quit stops active jobs and records their terminal state. After a crash or restart, the local backend does not claim the old PID, so active records become `interrupted`; use a remote durable backend through the SDK when cross-process reattachment is required.

This first interactive surface is human-controlled. It does not register an LLM tool or let the coding agent start a background process without the user's `/job start` command.

`/job send` is the explicit bridge into model context. It copies the selected bounded, sanitized output tail into a displayed `managed-job-output-v1` custom message without starting or steering a model turn. When idle, the message is stored immediately; during streaming, it is queued for the next turn and persisted when delivered. The message uses JSON framing, labels the output as untrusted data, and adds a system-prompt rule that it must never be treated as instructions. The copied tail enters the session JSONL and later model context, so inspect it for credentials or other sensitive data before sending. `/job output` only displays the tail locally and does not copy it into model context.

`/job wait` performs a literal readiness match against at most the newest 64 KiB of already artifact-backed output. It does not evaluate a regular expression or execute another command. The default timeout is 30 seconds and the accepted range is 1-120 seconds. The wait ends distinctly on match, timeout, cancellation, or a terminal job state, and never copies output into model context.

## Execution Boundary

Passing `executionBoundary` changes construction to fail closed:

- the profile must attest `process.mode: "isolated"`
- an explicit process backend is required; pi never falls back to the local Node backend
- the backend binding must match both the boundary backend id and exact profile digest
- the process working directory is the attested boundary working directory
- only environment variables declared by the boundary profile are delegated

This contract does not create isolation. The backend remains responsible for enforcing its attested container, VM, operating-system, or remote-sandbox policy. See [Security](security.md) and [Containerization](containerization.md).

## Process-backed completion verification

`createProcessSessionCompletionVerifier()` is an opt-in bridge from completion contracts to `ProcessSessionManager`. Calling the verifier starts one foreground process, waits for its terminal state, and maps expected exit codes to `pass` or `fail`. Interrupted or unavailable process backends produce `blocked`; backend execution failures produce `error`.

```typescript
const focusedTests = createProcessSessionCompletionVerifier({
  id: "focused-tests",
  manager,
  command: process.execPath,
  args: ["node_modules/vitest/dist/cli.js", "--run", "test/focused.test.ts"],
});
```

Environment values and output content are never copied into completion evidence. Evidence contains process state, exit code, output byte counts, a `process-session:<id>` reference, and `sha256:<digest>` output references. Consumers can pass the verifier to `verifyCompletionContract()` or `executeVerifiedRun()` and resolve artifacts explicitly through their own `ArtifactStore` policy.

## Integration Status

These modules are exported from the public SDK and remain separate from the foreground `bash` implementation. The completion verifier is invoked only by a caller's explicit verification flow; it does not add background bash. The opt-in `/job` surface uses a bounded local manager with explicit user control. Importing the modules does not change existing `bash` behavior or session JSONL format.
