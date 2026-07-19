# Containerization

Pi runs with all permissions by default, but in some cases, you will want to have more control over what directories Pi can write to and which accesses it has.

There are two general options. You can either
1. run the whole `pi` process inside an isolated environment, or
2. run `pi` on the host and route tool execution into an isolated environment.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin extension | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | See [`examples/extensions/gondolin/`](../examples/extensions/gondolin/). |
| SDK execution boundary | Built-in tools and `AgentSession.executeBash()` | Applications with an existing container, VM, or remote-sandbox backend | Backend adapter must attest every requested policy capability. |
| Plain Docker | Whole `pi` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `pi` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway |

Extensions run wherever the `pi` process runs. If you run host `pi` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## SDK execution boundary

Use `createAgentSession({ executionBoundary })` when an application already owns a real container, VM, micro-VM, or remote-sandbox runtime and needs pi to route built-in tools through it. A profile declares:

- host/remote workspace sources, backend mount targets, and `read-only` or `read-write` access
- whether process execution is denied or isolated
- denied, allowlisted, or unrestricted network access
- the exact environment variable and secret names that may enter tool processes

The adapter supplies operations for `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`, then attests the exact profile digest and its enforcement capabilities. File and search operations provide canonical `realpath`; `grep` additionally provides delegated `search`, so pi does not start host `rg` for bounded searches. Pi validates that assertion before creating tools. It fails closed when a required operation or capability is missing, when the digest differs, or when a caller tries to override boundary-owned operations. Canonical root checks remain defense in depth; the adapter's external enforcement is the security boundary.

This contract does not manufacture isolation or independently verify a third-party runtime. The adapter is trusted enforcement code and must derive its attestation from an initialized backend, not merely echo the requested profile. Provider requests and trusted extension hooks continue to run in the host process. SDK custom tools and extension-registered tools are rejected for bounded sessions because they would bypass the built-in operation adapters.

Use the generic `createTool(name, cwd, { boundary })` factory when only selected built-in tools are needed. `createAgentSession()` requires operations for the complete built-in tool surface so later tool activation cannot silently fall back to the host.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM.
Use the [example extension](../examples/extensions/gondolin) when you want `pi` on the host but all built-in tools routed into the VM.

Setup:

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
```

Run from the project you want mounted:

```bash
cd /path/to/project
pi -e ~/.pi/agent/extensions/gondolin
```

The extension mounts the host cwd at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
User `!` commands are routed into the VM, as well.
File changes under `/workspace` write through to the host.

Requirements: Node.js >= 23.6.0 for `@earendil-works/gondolin`, plus QEMU (requires installation through your package manager).

## Plain Docker

Run the whole `pi` process in Docker when you want the simplest local container boundary.

`Dockerfile.pi`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

Build and run:

```bash
docker build -t pi-sandbox -f Dockerfile.pi .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

The `-v "$PWD:/workspace"` mounts your current directory into the container at /workspace such that reads and writes in `/workspace` inside Docker directly affect your host files, like in the Gondolin example.

Use a named volume for `/root/.pi/agent` if you want container-local settings and sessions. Mounting your host `~/.pi/agent` exposes host auth and session files to the container.

## OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) when you want a policy-controlled sandbox with filesystem, process, network, credential, and inference controls.
OpenShell can run sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Every sandbox requires an active gateway.
Register and select one before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch `pi` inside an OpenShell sandbox:

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

In this pattern, the whole `pi` process runs inside the sandbox.
Built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

If the gateway is remote, project files are not bind-mounted from the host, meaning writes in the sandbox are not reflected on your machine.
Clone the repository inside the sandbox or use OpenShell file transfer commands:

```bash
openshell sandbox upload pi-sandbox ./repo /workspace
openshell sandbox download pi-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox.
When inference routing is configured, code inside the sandbox can call `https://inference.local`, and the gateway injects the configured provider credentials upstream.
Configure Pi to use the corresponding OpenAI-compatible or Anthropic-compatible endpoint if you want model traffic to use this route.
