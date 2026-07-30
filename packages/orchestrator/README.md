# @earendil-works/pi-orchestrator

Experimental. This package is under active development and may change or be removed without notice. Its CLI, APIs, and behavior are not yet stable.

Orchestrator package for pi.

## CLI

```bash
orchestrator --help
```

## Android and remote clients

Start the local orchestrator and its authenticated HTTP/SSE gateway:

```bash
orchestrator serve --remote
orchestrator remote-token
```

The gateway binds to `127.0.0.1:8787` by default. Use `adb reverse tcp:8787 tcp:8787`
for an Android emulator. For a physical device, prefer an HTTPS endpoint provided
by Tailscale Serve instead of exposing the gateway directly to the public internet.

The remote API provides instance lifecycle operations, lightweight task activity,
RPC snapshots and commands,
replayable server-sent events, extension UI responses, and uploads stored under the
orchestrator directory. A client can explicitly set `approveProject: true` when
starting a task to load trusted project-local `.pi` resources. Offline records with
a session file can be resumed through `POST /v1/instances/:id/resume`.
Graceful orchestrator shutdowns suspend child Pi processes while retaining their
session records, so a client can resume them after a service restart.
Pending interactive extension requests are buffered by the orchestrator until a
client connects and responds.
