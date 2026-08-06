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

### Remote durable executor

`RemoteProcessSessionBackend.connect()` supplies the standard implementation for a replay-capable remote executor:

```typescript
const backend = await RemoteProcessSessionBackend.connect(transport, {
  pollIntervalMs: 250,
  maxConsecutiveTransportFailures: 5,
  environmentAllowlist: ["CI", "LANG"],
});

const { manager, recovery } = await ProcessSessionManager.open({
  root: "/trusted/pi-state/processes",
  artifactStore: store,
  backend,
});
```

The transport negotiates protocol version 1 and must attest durable handles, ordered cursor replay, cancellation, a bounded replay page, and a bounded output chunk. Start and terminate requests carry idempotency keys. The backend retries an ambiguously failed start a bounded number of times with the same key; the executor must durably return the same process handle for every duplicate start key. Exhausting that recovery budget reports an explicitly unknown start outcome. Persisted process handles bind the executor id, executor instance, protocol version, and last durably consumed event cursor.

Host environment variables are not forwarded by default. `environmentAllowlist` explicitly selects names that may leave the host; when an execution boundary is also active, both the attested boundary policy and this remote allowlist must permit a name.

Output and exit events use contiguous cursors. The manager writes output to `ArtifactStore` before advancing the handle cursor in its journal. After a client crash, a new backend instance starts replay after that persisted cursor, so acknowledged output is not duplicated and unacknowledged output is not skipped. Cursor gaps, invalid base64, oversized chunks, executor-instance mismatches, missing terminal events, and unsupported capabilities fail closed.

The backend tolerates a bounded number of transient start and replay transport failures. `close()` disconnects local polling without terminating the remote process; reopening the manager with a newly negotiated backend reattaches it. `terminate()` requests remote cancellation, while the terminal event remains authoritative.

`RemoteProcessExecutorTransport` is transport-neutral. An application can implement it over authenticated HTTPS, RPC, SSH, or a sandbox control plane. The adapter does not add authentication, encryption, server-side isolation, retention, or idempotency storage by itself. Those remain requirements of the remote executor.

## Interactive Managed Jobs

Start pi with `--managed-jobs` to enable a user-controlled background process surface:

```text
/job start --name dev npm run dev
/job list
/job recipes
/job run <recipe>
/job status <id>
/job output <id> [stdout|stderr|all]
/job send <id> [stdout|stderr|all]
/job wait <id> --contains <text> [--stream stdout|stderr|all] [--timeout 1-120]
/job stop <id>
/job prune <id>
/job prune --all
```

Commands use direct executable-and-argument spawning, not a shell. Quotes and escaped whitespace group arguments, but pipes, redirects, variable expansion, and other shell syntax are not interpreted. If shell behavior is intentionally required, invoke the shell executable explicitly.

`--name` assigns a stable job ID for later commands such as `/job output dev`; names must be 1-64 characters, begin with an alphanumeric character, and otherwise contain only alphanumerics, `.`, `_`, or `-`. Names are unique and immutable within the workspace journal. Without `--name`, pi generates a UUID and accepts an unambiguous prefix of at least four characters.

The built-in policy permits at most four active jobs per workspace, retains at most 10 MiB of artifact-backed output per job, and displays at most the newest 16 KiB. Reaching the output limit durably fails and terminates the job. Job IDs, commands, arguments, working directories, backend handles, environment variable names, lifecycle states, and artifact references are journaled; environment values and output bytes are not. Do not put credentials directly in command arguments.

Managed jobs are workspace-scoped and share one live local backend while pi is running. A clean pi quit stops active jobs and records their terminal state. After a crash or restart, the local backend does not claim the old PID, so active records become `interrupted`; use a remote durable backend through the SDK when cross-process reattachment is required.

With only `--managed-jobs`, this interactive surface remains human-controlled and does not register an LLM tool. Add the separate `--managed-jobs-agent-read` flag to expose `managed_job_read`, which lets the coding agent list jobs, inspect structured lifecycle status, read at most the newest 16 KiB of retained output, or wait up to 30 seconds for literal readiness text. A wait returns only its outcome and job status, not the matched output. The tool does not expose stored commands or arguments and cannot start, stop, or prune jobs. Those state-changing operations remain user-controlled through `/job`.

Managed-job tool results are JSON-framed as untrusted data. Unlike `/job output`, a successful tool read enters model context automatically, so retained process output may disclose credentials or other sensitive data to the selected provider. Enable agent reads only for jobs whose output is safe to share.

`--managed-jobs-agent-read` is unavailable when the SDK session uses an execution boundary. Extension tools execute in the host process and are rejected before activation; human `/job` commands remain a separate explicit control surface.

### Agent-Controlled Fixed Recipes

Add `--managed-jobs-agent-control` to let the coding agent use `managed_job_control`. This requires `--managed-jobs`, a trusted project, no SDK execution boundary, and a regular non-symbolic-link `.pi/managed-jobs.json` no larger than 256 KiB:

```json
{
  "version": 1,
  "recipes": [
    {
      "id": "dev",
      "description": "Start the reviewed local development server",
      "command": "npm",
      "args": ["run", "dev"],
      "inheritEnv": [],
      "maxAgentStarts": 4,
      "maxRuntimeSeconds": 3600,
      "requireApproval": true,
      "allowAgentOutput": true,
      "readiness": {
        "contains": "ready",
        "stream": "stdout",
        "timeoutSeconds": 30
      }
    }
  ]
}
```

The file accepts 1-16 fixed recipes. Recipe IDs are portable 1-64 character identifiers. An optional 1-256 character single-line `description` tells the agent and local reviewer what a recipe is intended to do without changing its authority. Each recipe uses direct argv execution in the workspace root and cannot define a different working directory or environment values. If `inheritEnv` is omitted, the recipe keeps the full shell environment for compatibility. If it is present, even as `[]`, the recipe receives only a cross-platform development baseline (`PATH`, home/user/temp/locale/terminal variables, CI, Windows application paths, and XDG paths) plus at most 32 explicitly named variables. Environment values never enter the config or tool result, while inherited names remain visible in the local process journal. This reduces accidental environment leakage but is not a sandbox: the host process still has normal user filesystem and network access. Optional `maxAgentStarts` limits that recipe to 1-100 starts per control-tool instance; failed process creation does not consume the budget, while a started process does even if readiness later fails. Human `/job run` remains outside this agent-only budget. Optional `maxRuntimeSeconds` automatically terminates either agent- or human-started recipe jobs after 1-86,400 seconds; omission keeps existing unlimited runtime. `requireApproval: true` requires a fresh local UI confirmation, showing the frozen revision and bounded command, before every agent start; headless use and declines fail closed without consuming the start budget. The explicit human `/job run` command does not prompt again. `allowAgentOutput: true` lets the control tool read only the newest 16 KiB of sanitized output from jobs it started for that recipe; omission or `false` denies the read. Optional readiness is a literal match over bounded artifact-backed output with a maximum 30-second wait. A timeout or cancelled readiness wait leaves the job running until its runtime limit, explicit stop, or application shutdown.

The extension loads and hashes the config once per extension instance. Later file edits do not change the in-memory recipes or the revision reported in tool results. `/job recipes` displays that frozen revision and bounded local command summaries when agent control is active; otherwise it previews the current file without enabling control. `/job run <recipe>` requires a trusted project and lets a person run the same frozen recipe, or the current validated config when agent control is inactive, including its bounded readiness wait. Human-run jobs remain outside the control tool's ownership. `managed_job_control recipes` returns structured descriptions, limits, starts used and remaining, output grants, and active tool-owned job IDs so the agent can recover state after long turns or context compaction; it never returns commands, arguments, or environment names. The control tool accepts `start` only with an exact loaded recipe ID, or `output`/`wait`/`stop` with an exact job ID that the same tool instance started. Output reads additionally require the frozen recipe's explicit grant and are JSON-framed as untrusted data. Completion waits are cancellable, bounded to 30 seconds, and return only lifecycle state and exit status, not process output. The tool rejects duplicate active runs of one recipe, cannot inspect, wait on, or stop user-started jobs, and inherits the four-active-job and 10 MiB output limits. Successful non-output tool results omit commands, arguments, stored process errors, and process output; operational tool failures also replace host error details with a local `/job status <id>` pointer. `--managed-jobs-agent-read` remains a separate, broader permission for inspecting any managed job's output.

These recipes execute on the host with normal user permissions and network access. A trusted recipe can run arbitrary code or expose accessible secrets through its output, even when environment inheritance is minimized. Review the config before enabling the flag; use an SDK execution boundary instead when host execution is not acceptable.

`/job send` is the explicit bridge into model context. It copies the selected bounded, sanitized output tail into a displayed `managed-job-output-v1` custom message without starting or steering a model turn. When idle, the message is stored immediately; during streaming, it is queued for the next turn and persisted when delivered. The message uses JSON framing, labels the output as untrusted data, and adds a system-prompt rule that it must never be treated as instructions. The copied tail enters the session JSONL and later model context, so inspect it for credentials or other sensitive data before sending. `/job output` only displays the tail locally and does not copy it into model context.

`/job wait` performs a literal readiness match against at most the newest 64 KiB of already artifact-backed output. It does not evaluate a regular expression or execute another command. The default timeout is 30 seconds and the accepted range is 1-120 seconds. The wait ends distinctly on match, timeout, cancellation, or a terminal job state, and never copies output into model context.

`/job prune` requires approval-capable UI and irreversibly removes terminal job journal entries, including stored commands and arguments, plus their output provenance. `/job prune --all` selects every terminal job and explicitly reports active jobs that will be retained. Shared artifact objects and objects with unknown sidecars remain intact.

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

These modules are exported from the public SDK and remain separate from the foreground `bash` implementation. The completion verifier is invoked only by a caller's explicit verification flow; it does not add background bash. The opt-in `/job` surface uses a bounded local manager with explicit user control. Importing the modules does not change existing `bash` behavior. Replay-capable backends add optional backend cursors to version-1 process events and handles; local backends continue to omit them.
