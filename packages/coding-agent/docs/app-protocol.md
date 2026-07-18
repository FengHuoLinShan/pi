# Harness App Protocol

The Harness App Protocol is a stable, transport-independent contract for a future local daemon, desktop app, IDE, or web facade. It is separate from the legacy `--mode rpc` JSONL command protocol. The protocol package validates and correlates messages; it does not start turns, execute tools, approve actions, or open a network listener.

Source: `src/app-protocol/`.

## Boundary

The application chooses the transport and owns authentication, authorization, backpressure, and business handlers. A transport can frame the same envelopes over strict JSONL, a Unix socket, or WebSocket. The connection receives parsed JSON values or JSON text and returns:

- `outbound`: protocol responses to send;
- `actions`: validated requests for the application to handle;
- `issues`: violations that cannot receive a JSON-RPC response, such as an unknown response ID or invalid notification.

No handler callback is invoked from the protocol layer. The application explicitly consumes an action and calls `completeRequest()` or `failRequest()`.

## Envelope

Messages use strict JSON-RPC 2.0-style envelopes. Batch messages and unknown envelope fields are rejected. Request IDs are strings or safe integers.

```json
{"jsonrpc":"2.0","id":"turn-1","method":"turn/start","params":{}}
{"jsonrpc":"2.0","id":"turn-1","result":{}}
{"jsonrpc":"2.0","method":"turn/started","params":{}}
```

Runtime validation covers the envelope, every built-in method's params, reverse-request results, and lifecycle events. Unknown method parameters and unsupported schema versions fail closed.

## Handshake and negotiation

The first message must be an `initialize` request. Other requests receive `NOT_INITIALIZED`. After the initialize response, the client must send the `initialized` notification with the negotiated version before any application method is accepted.

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "initialize",
  "params": {
    "protocolVersion": "1.1",
    "supportedProtocolVersions": ["1.0"],
    "client": {"name": "my-ide", "version": "0.8"},
    "capabilities": {
      "streaming": true,
      "approvals": true,
      "images": true,
      "terminal": true,
      "replay": true
    },
    "requiredCapabilities": ["streaming"],
    "limits": {"maxPendingRequests": 16, "maxEventReplayEvents": 500},
    "auth": {"scheme": "local-peer"}
  }
}
```

The server returns the selected protocol version, the intersection of client and server capabilities, the lower client/server limits, feature flags, and the current replay cursor range. Missing optional capabilities are treated as unsupported. An unavailable `requiredCapabilities` entry fails initialization instead of silently degrading.

Authentication is not performed by this package. A socket or HTTP facade must authenticate the peer before creating a protocol connection. `allowedAuthSchemes` only validates that an advertised scheme is compatible with the facade's configuration.

## Thread, Turn, and Item events

Canonical entities carry both `schemaVersion: 1` on the event and a monotonically increasing entity `version`. UI clients consume lifecycle events instead of inferring state from text logs:

- `thread/started`, `thread/completed`;
- `turn/started`, `turn/completed`;
- `item/started`, `item/delta`, `item/completed`.

Item kinds include messages, tool calls, commands, file changes, approvals, and user input. Terminal item/turn statuses distinguish `completed`, `failed`, `cancelled`, and `interrupted`.

Each live event is a notification with a cursor and timestamp:

```json
{
  "jsonrpc": "2.0",
  "method": "item/delta",
  "params": {
    "protocolVersion": "1.1",
    "cursor": 42,
    "timestamp": "2026-07-19T00:00:00.000Z",
    "event": {
      "type": "item/delta",
      "schemaVersion": 1,
      "threadId": "thread-1",
      "turnId": "turn-2",
      "itemId": "item-3",
      "itemVersion": 4,
      "deltaIndex": 7,
      "delta": {"text": "..."}
    }
  }
}
```

## Turn controls

The protocol intentionally exposes separate methods:

- `turn/start`: begin a new work cycle;
- `turn/steer`: queue new input for the next safe model/tool boundary;
- `turn/cancel`: request graceful turn cancellation and cleanup;
- `turn/interrupt`: immediately interrupt `model`, `process`, or `all`, while the runtime still performs consistency cleanup.

The protocol action only preserves this intent. The harness runtime is responsible for queueing steer input at safe boundaries and propagating cancellation or interruption through model streams, tool scheduling, executors, and child processes.

## Reverse requests

After negotiation, the server can issue correlated `approval/request` and `userInput/request` requests. `createReverseRequest()` checks the negotiated capability and pending-request limit. The next matching client response becomes a typed `reverse_response` or `reverse_error` action. Unknown response IDs are protocol issues and never resolve another request.

Approval results are exactly `{decision: "allow" | "deny", grantId?: string}`. User input results are exactly `{value: string}` or `{cancelled: true}`. Approval policy, grant binding, expiry, and input handling remain runtime responsibilities.

## Replay and reconnect

`BoundedEventReplay` is injected into connections and can be retained across disconnects. `events/replay` accepts an `afterCursor` and optional limit. Responses include `nextCursor`, `latestCursor`, and `hasMore` for bounded pagination.

If the requested cursor predates the retained window, the request fails with `REPLAY_GAP` and structured data:

```json
{
  "requestedCursor": 10,
  "earliestCursor": 25,
  "latestCursor": 40,
  "minimumResumeCursor": 24
}
```

The client must then fetch a canonical Thread/Turn projection snapshot from the application and resume after a cursor returned with that snapshot. It must not treat a partial replay as complete state.

## Error codes

Standard parse/request/method/params errors use JSON-RPC codes. Application protocol errors include:

| Code | Name | Meaning |
| --- | --- | --- |
| `-32002` | `NOT_INITIALIZED` | Handshake is incomplete |
| `-32003` | `ALREADY_INITIALIZED` | Duplicate initialize/initialized |
| `-32004` | `INCOMPATIBLE_PROTOCOL` | No common version or mismatched initialized version |
| `-32005` | `CAPABILITY_UNAVAILABLE` | A required or invoked capability is unavailable |
| `-32006` | `REPLAY_GAP` | Cursor fell outside the bounded event window |
| `-32007` | `DUPLICATE_REQUEST` | Request ID is already pending |
| `-32008` | `OVERLOADED` | Negotiated pending or payload limits were exceeded |

## Daemon integration checklist

- Authenticate the peer before constructing `AppProtocolServerConnection`.
- Keep one replay store per compatible protocol event schema and durable thread scope.
- Persist canonical runtime events before publishing them; the in-memory replay window is not the source of truth.
- Map request actions to Harness APIs without allowing the protocol adapter to execute tools directly.
- Prioritize terminal events and reverse requests over disposable text deltas under backpressure.
- On disconnect, cancel or retain pending reverse requests according to an explicit application policy.
- Enforce Origin/Host/CSRF checks for HTTP/WebSocket and peer credentials or bearer authentication for local sockets.
