# @earendil-works/pi-codegraph

Optional polyglot code graph for pi. The package is dormant until its `codegraph` lazy extension is activated, and indexing starts only when the `code_graph` tool is called.

```bash
pi install npm:@earendil-works/pi-codegraph
```

## Extension

After installation, ask the `capability` tool to load the `codegraph` extension. The extension exposes one tool with these actions:

- `status`: inspect cache and index state.
- `sync`: synchronize the graph with the workspace.
- `reindex`: force a complete rebuild.
- `search`: find symbols by name, kind, or file.
- `dependencies`: follow outgoing dependency paths.
- `dependents`: follow incoming dependency paths.
- `impact`: find symbols transitively affected by a symbol or file.
- `plan_verification`: map supplied PatchSet paths through the graph and select checks from `.pi/checks.json`.
- `verify`: execute the selected checks and return a content-addressed evidence bundle.

The index covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.py`, `.go`, and `.rs`. It honors the nearest `tsconfig.json` or `jsconfig.json` and the workspace `go.mod` when present. Cache snapshots contain graph metadata and source locations, not source text.

TypeScript and JavaScript use the TypeScript compiler for declarations, references, calls, inheritance, and module resolution. Python, Go, and Rust use conservative structural adapters: they index files, top-level declarations, and statically resolvable workspace imports. Dynamic imports and call relationships stay unresolved instead of receiving inferred semantic confidence. The `status` result reports each adapter, its precision tier, and indexed file count.

Host workspaces and transactional overlay workspaces are indexed through their current logical root. Execution-boundary workspaces fail closed because an in-process extension cannot directly inspect paths that exist only inside the boundary.

Impact verification requires project trust and a versioned direct-command catalog:

```json
{
  "version": 1,
  "checks": [
    {
      "id": "targeted-tests",
      "command": "node",
      "args": ["test/affected.test.ts"],
      "selection": { "mode": "affected", "paths": ["src/**", "test/**"] }
    },
    {
      "id": "full-suite",
      "command": "./test.sh",
      "selection": { "mode": "fallback" }
    }
  ]
}
```

Selection modes are `always`, `direct`, `affected`, and `fallback`. Unindexed, truncated, or uncovered changes select fallback checks. If no configured check covers every affected path, verification stops as blocked without executing a partial plan.

## SDK

```ts
import { openTypeScriptCodeGraph } from "@earendil-works/pi-codegraph";

const graph = await openTypeScriptCodeGraph({ workspaceRoot: process.cwd() });
await graph.sync();

const matches = graph.search("AgentSession");
const dependencies = graph.dependencies(matches[0].node.id, { maxDepth: 2 });

await graph.dispose();
```

`openTypeScriptCodeGraph` retains its existing name for API compatibility while the service indexes all supported languages.

The default cache lives under pi's agent cache directory and is partitioned by a SHA-256 hash of the canonical workspace path. Pass `cacheDir` to keep it elsewhere.
