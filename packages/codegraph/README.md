# @earendil-works/pi-codegraph

Optional TypeScript and JavaScript code graph for pi. The package is dormant until its `codegraph` lazy extension is activated, and indexing starts only when the `code_graph` tool is called.

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

The index covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs`. It honors the nearest `tsconfig.json` or `jsconfig.json` when present. Cache snapshots contain graph metadata and source locations, not source text.

## SDK

```ts
import { openTypeScriptCodeGraph } from "@earendil-works/pi-codegraph";

const graph = await openTypeScriptCodeGraph({ workspaceRoot: process.cwd() });
await graph.sync();

const matches = graph.search("AgentSession");
const dependencies = graph.dependencies(matches[0].node.id, { maxDepth: 2 });

await graph.dispose();
```

The default cache lives under pi's agent cache directory and is partitioned by a SHA-256 hash of the canonical workspace path. Pass `cacheDir` to keep it elsewhere.
