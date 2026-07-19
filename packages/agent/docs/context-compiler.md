# Context compiler, repository map, and evidence ledger

These modules provide a small, deterministic context layer for applications built on `pi-agent-core`. They do not read the filesystem, call a model, choose a retriever, or mutate an `AgentHarness`. The application supplies facts and decides when to inject the resulting text.

## Context compiler

`compileContext()` accepts model-visible fragments with stable ids, priorities, output ordering, and truncation policies. It returns a versioned, JSON-serializable result containing:

- the compiled text
- included and omitted fragments
- approximate token use and remaining budget
- truncation state
- supporting evidence ids

Required fragments are considered before optional fragments. If a required fragment cannot fit under its declared truncation policy, compilation throws `ContextCompilerError` with code `required_fragment_overflow`; it is never silently removed. Optional fragments are admitted by descending priority, then emitted by `order` and id. This keeps relevance selection independent from prompt layout.

The built-in token estimate is fixed and deterministic: four ASCII code points or one non-ASCII code point per approximate token. It is not a provider tokenizer. Reserve enough headroom for provider-specific tokenization, messages, tool schemas, and output.

```ts
const context = compileContext({
  tokenBudget: 4_000,
  reserveTokens: 500,
  fragments: [
    {
      id: "task-policy",
      kind: "instruction",
      content: "Only edit files in the selected package.",
      priority: 100,
      required: true,
    },
    {
      id: "repo-map",
      kind: "repo_map",
      content: repoMap.text,
      priority: 20,
      truncation: "tail",
      evidenceIds: ["repo-scan-1"],
    },
  ],
});
```

## Repository map

`buildRepoMap()` formats caller-provided file, import, symbol, summary, language, and hash data into a budgeted map. It performs no directory walk and imports no parser. Applications can therefore use the same core with local filesystems, remote workspaces, prebuilt indexes, or tests.

Files are admitted by caller-supplied priority and rendered in stable path order. Imports and symbols are sorted deterministically. The result reports included, truncated, and omitted files and retains the underlying `CompiledContext` diagnostics.

```ts
const repoMap = buildRepoMap({
  root: "workspace",
  tokenBudget: 2_000,
  files: [{
    path: "src/run.ts",
    hash: "sha256:...",
    summary: "Runs one agent operation.",
    imports: ["./queue.ts"],
    symbols: [{ name: "run", kind: "function", line: 20, exported: true }],
    priority: 50,
  }],
});
```

## Evidence ledger

`EvidenceLedger` binds claims to a source, optional structured location, opaque content hash, observation time, and optional tool call. Hash calculation remains an application responsibility so the core does not assume Node crypto, a filesystem, or one digest algorithm.

Snapshots are explicitly versioned and JSON-serializable. `citation()` creates a stable plain-text citation. `checkFreshness()` compares records with caller-supplied current hashes and returns `fresh`, `stale`, or `missing`; it never performs hidden I/O.

```ts
const ledger = new EvidenceLedger();
ledger.append({
  id: "run-loop",
  source: { kind: "file", id: "src/run.ts" },
  location: { lineStart: 20, lineEnd: 45, symbol: "run" },
  hash: { algorithm: "sha256", value: "..." },
  claim: "The run loop persists the result before settlement.",
  toolCall: { id: "read-1", name: "read" },
  observedAt: Date.now(),
});

const citation = ledger.citation("run-loop");
const freshness = ledger.checkFreshness(currentSourceVersions);
```

For reproducible builds and tests, callers should supply stable priorities, hashes, and observation timestamps. Persist `EvidenceLedgerSnapshot` and the compiled context result alongside application/session state when replay diagnostics need to explain why a fragment was present.

## Trust labels and prompt-injection containment

`protectContext()` is an explicit pre-compilation boundary for retrieved or application-supplied context. Each `LabeledContextFragment` declares:

- whether it is an `instruction` or `data` fragment;
- `trusted`, `partially_trusted`, or `untrusted` authority;
- a disclosure sensitivity;
- stable source provenance.

The default policy quarantines every non-trusted instruction. Non-trusted data is XML-escaped inside an explicit data boundary before it reaches `compileContext()`. A conservative lexical prompt-injection detector contributes signals, not authority: applications can replace detectors and policy, and every allow, drop, quarantine, escape, or demote decision is recorded in diagnostics and provenance.

```ts
const protectedContext = protectContext({
  fragments: [{
    id: "issue-body",
    kind: "retrieved_text",
    content: issueBody,
    priority: 10,
    role: "data",
    trust: "untrusted",
    sensitivity: "internal",
    source: { kind: "issue", id: issueId, labels: ["external"] },
  }],
});

const compiled = compileContext({
  tokenBudget: 4_000,
  fragments: protectedContext.fragments,
});
```

Escaping is containment metadata for the model, not a proof that arbitrary content is safe. Tool policy, approvals, filesystem/process isolation, and secret controls remain independent enforcement layers.
