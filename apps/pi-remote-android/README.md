# Pi Remote for Android

Native Android client for controlling local Pi sessions through the orchestrator's
authenticated HTTP/SSE gateway.

## Capabilities

- Task list with running, approval, completed, failed, offline, stop, and resume states
- Live conversation timeline for answers, thinking, tool calls, and file changes
- Text, Android speech recognition, image, file, steer, queued follow-up, and abort input
- Command, diff, approval, and rollback-warning center
- Model, thinking level, context metrics, session tree, compaction, clone, fork, and terminal controls
- Foreground event service with completion and approval notifications
- Android Keystore-backed token storage

## Start the local gateway

From the Pi repository:

```bash
npx tsx packages/orchestrator/src/cli.ts serve --remote
npx tsx packages/orchestrator/src/cli.ts remote-token
```

The default endpoint is `http://127.0.0.1:8787`. For the Android emulator:

```bash
adb reverse tcp:8787 tcp:8787
```

For a physical phone, expose the loopback gateway through an authenticated private
network and HTTPS, such as Tailscale Serve. The release manifest rejects cleartext
HTTP; cleartext is enabled only in debug builds for emulator development.

## Build

Use JDK 17 and Android SDK 34 or newer:

```bash
./gradlew :app:assembleDebug
./gradlew :app:installDebug
```

When creating a task, enable **信任项目内配置** only for a directory whose `.pi`
extensions and settings you trust. The approval applies to that Pi process.
