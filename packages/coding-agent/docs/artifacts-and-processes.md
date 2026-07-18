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
});

const processSession = await manager.start({
  command: "/usr/bin/git",
  args: ["status", "--short"],
});

const completed = await manager.waitForExit(processSession.id);
const stdout = await manager.readOutput(completed.id, "stdout");
```

The event log is `<root>/process-sessions.jsonl`. Appends are flushed before state is published. On open, a partial unterminated tail is discarded before new events are appended, valid events are replayed in sequence, and impossible lifecycle transitions are rejected.

## Recovery and Attach Semantics

A backend decides whether a durable handle can be reattached. During recovery:

- an attachable active handle remains `running`
- an already-exited handle receives a recovered `process_exited` event
- a missing or non-attachable handle receives `process_interrupted`

`NodeProcessSessionBackend` is deliberately conservative. It can attach only while the same backend instance still owns the live `ChildProcess`; a new pi process does not infer ownership from a PID or claim cross-process reattachment. Persisted local sessions that were active at a crash therefore become `interrupted`.

Container, VM, or remote-sandbox integrations can implement `ProcessSessionBackend` with durable remote handles, `attach`, `status`, and `terminate` operations.

## Execution Boundary

Passing `executionBoundary` changes construction to fail closed:

- the profile must attest `process.mode: "isolated"`
- an explicit process backend is required; pi never falls back to the local Node backend
- the backend binding must match both the boundary backend id and exact profile digest
- the process working directory is the attested boundary working directory
- only environment variables declared by the boundary profile are delegated

This contract does not create isolation. The backend remains responsible for enforcing its attested container, VM, operating-system, or remote-sandbox policy. See [Security](security.md) and [Containerization](containerization.md).

## Integration Status

These modules are exported from the public SDK but remain intentionally separate from the current foreground `bash` implementation. Wiring them into the interactive tool surface requires an explicit product choice about foreground versus durable/background command behavior, output presentation, retention, and cleanup policy. Importing the modules does not change existing `bash` behavior or session JSONL format.
