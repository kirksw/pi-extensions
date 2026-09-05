# pi-context-flow

`pi-context-flow` is a local-first Pi extension that treats model context as a scarce working set.
Context In captures large tool responses outside the conversation as lossless, worktree-local evidence and exposes only bounded ways to investigate them.
Context Out remains explicit and governed: observations and artifact candidates are never written to repository documentation automatically.

## Context In guarantees

- Qualifying tool text responses over 8 KiB of original UTF-8 text are replaced with a compact `evidence://` reference and shape.
  Automatic interception accepts only plain, safely serializable text blocks, and every block must independently qualify as JSON/JSONL, CSV/TSV, XML with a declaration, conservative YAML, or a recognizable log.
  Multi-item captures preserve content order and chunk boundaries in a deterministic envelope; single-text captures retain the original text and JSON-RPC handling.
  Mixed image/text, unsupported or cyclic content, source, prose, binary, unknown text, `read`, `grep`, `find`, `ls`, and every `context_*` result bypass interception.
  Capture metadata and capabilities remain in result details; use `context_metadata` for model-visible provenance and `context_schema` for structured analysis.
- JSON, CSV/TSV, XML, and YAML are schema-inspectable and available to one strict, read-only DuckDB query.
  CSV/TSV are imported directly by DuckDB; XML and YAML are validated and parsed locally with entity expansion and YAML aliases disabled, then materialized only in the isolated in-memory query relation.
  JSON alone also supports bounded `jq` queries.
  Plain text is deterministically chunked with byte and line offsets for bounded lexical search.
  Mixed logs/artifacts retain original-text search and best-effort JSON-line/log materialization metadata.
- Reads, searches, SQL, and jq are bounded.
  There is no full raw-evidence escape hatch: compatibility `context_get_evidence` returns at most 16 KiB.
- Capture records a raw SHA-256, capture time, source, and dependency lineage.
  Evidence is an immutable historical record of the captured result; callers that need current source data must obtain a new tool result or explicitly recapture a file.
  Queries, derived result evidence, materializations, and REPL invocations retain DuckDB provenance.
- `context_repl` is a Docker/Podman-only adapter.
  It never executes on the host and returns unavailable if no runtime exists.
  Containers have network disabled, a read-only root and input mount, no inherited environment, dropped capabilities, no-new-privileges, memory/CPU/PID/wall-time/output limits, and only selected evidence or regular workspace files staged read-only.

## Install and run

```bash
npm install
pi -e ./src/index.ts
```

For project-local auto-discovery, configure Pi to load this package or place the extension entry point in `.pi/extensions/`.

## Context In tools

- `context_capture`: explicitly capture text or JSON and return a capability-bearing reference.
- `context_capture_file`: explicitly capture a workspace-relative regular JSON, CSV, TSV, XML, YAML, JSONL, or recognizable log file (8 MiB maximum).
  Symlinks must resolve inside the worktree; `.pi/context`, binary data, source, prose, and unknown text are rejected.
- `context_metadata`: return capture provenance, integrity hash, dependencies, and JSON-RPC transport lineage for an evidence reference.
- `context_schema`: return the authoritative DuckDB schema, row count, and query examples for JSON, CSV, TSV, XML, YAML, and mixed structured evidence; concise nested types are the default and `detail: "full"` expands them.
  A recognized JSON-RPC response creates primary evidence from its `result` or `error` payload, with the exact transport envelope retained as linked provenance.
- `context_query_structured`: compile bounded filters, groups, and count/sum/min/max aggregations over a typed list-of-structs column into read-only DuckDB SQL.
- `context_query_records`: opt-in one-turn lookup for structured JSON records.
  It derives the authoritative DuckDB type internally, resolves an exact `collectionHint` to one nested LIST-of-STRUCT collection, and supports bounded scalar `filters` (`equals` or `oneOf`), `select`, `orderBy`, and mandatory `limit`.
  It fails closed for missing/ambiguous collections, non-scalar paths, malformed requests, and type-mismatched filter values; compact candidates are returned.
  It does not parse natural language or guess schema paths, so no preceding `context_schema` call is needed.
- `context_read`: read a bounded JSON path or text byte/line range (16 KiB maximum).
- `context_search`: paged local lexical search across text or mixed chunks, including evidence larger than 64 KiB.
  Searches scan at most 4,096 chunks or 16 MiB in 64-chunk pages, retain at most 50 candidates, and return at most 64 KiB of compact JSON.
  Queries accept up to 1,024 UTF-8 bytes and 32 unique lexical terms.
  Results expose `complete`, `truncated`, scanned counts, and an explanation when the scan budget is exhausted.
  `complete` describes scan coverage; `truncated` also reports omitted matches due to result limits.
  A two-second deadline includes database waits; on timeout, one outstanding bounded page may finish but no further pages are scanned.
  `hybrid` explicitly reports unavailable because no local semantic index is bundled.
- `context_query_sql`: one read-only DuckDB `SELECT`/`WITH` query against an isolated in-memory `evidence` relation containing only the selected evidence.
  It accepts one trailing semicolon, supports compact `format: "json"` output, and rejects writes, chains, catalogs, `COPY`, extensions, pragmas, scans, and external reads.
  Each analysis runs in a subprocess with a two-second deadline covering startup, ingestion, native execution, and IPC; the child is killed and reaped before the call returns.
  DuckDB has a 256 MB managed-memory budget (reported as 244.1 MiB), one thread, and no disk spill; the subprocess V8 heap is limited to 128 MiB.
  These limits are not a total process RSS cap.
  At most 201 rows are materialized, and a native JSON-size check rejects retained results over 1 MiB before conversion to JavaScript.
  Schema inspection uses the same analysis limits; record queries perform separate schema and execution analyses, so their combined analysis time can approach four seconds.
- `context_query_jq`: local `jq` in the worktree with an allowlisted environment and five-second timeout.
  Responses use a 64 KiB context budget but retain complete output as derived evidence up to the declared 8 MiB artifact cap; output over that cap is explicitly partial.
- `context_repl`: Python/Bash fallback in the restricted external container described above; select evidence IDs and worktree-relative regular files only.
- `context_get_evidence`: compatibility preview with a strict 16 KiB cap; prefer `context_read`.

SQL results within the native materialization cap but above the 200-row or 64 KiB context budget produce derived preview evidence explicitly marked as a retained subset, not the complete query result.
SQL results exceeding the 1 MiB native materialization cap fail explicitly; project smaller values or aggregate instead.
Oversized jq, REPL, or tool results are captured as new derived evidence and returned by reference instead of being injected into context.
jq and REPL use a 64 KiB response budget and an 8 MiB artifact cap: output retained below the cap is complete; anything stopped at the cap is explicitly marked partial and is never labeled complete.

## Context Out tools

- `context_observe`: record a compact semantic conclusion with evidence/query lineage.
- `context_promote`: create a candidate for `repo`, `architecture`, or `organization` knowledge; it never writes the target artifact.

## Example workflow

```text
1. linear.searchIssues returns a large JSON response, or a CLI emits a large log.
2. pi-context-flow replaces it with evidence://evidence_<uuid> and its shape; use context_metadata when capture provenance is needed.
3. For a known record collection such as `issues`, use context_query_records directly with its exact hint, scalar paths, and limit. Recognized JSON-RPC responses already expose their `result` or `error` payload as the primary evidence. Otherwise for JSON, CSV, TSV, XML, or YAML: use context_schema to inspect the DuckDB relation and its query examples, then context_query_sql.
   For logs/text: use context_search then context_read with returned source offsets.
4. If needed, use context_read with a JSON path or a small exact line range.
5. Use context_repl only when the primary bounded operations cannot express analysis.
6. Record a supported conclusion with context_observe; context_promote only proposes a durable artifact.
```

## Storage

```text
.pi/context/
  state.duckdb
  evidence/raw/<evidence-id>.json|txt
  observations/ledger.jsonl
  queries/<query-id>.sql|jq
```

DuckDB records evidence provenance, text chunks, derived materializations, queries, REPL invocations, and the existing Context Out observation/promotion lineage.

## Roadmap

See the [roadmap](docs/ROADMAP.md) for remaining Context In validation, provenance, retrieval, reference-discovery, and retention work, plus optional native REPL sandbox backends on Linux and macOS.
Native backends are deferred explorations; Docker/Podman remains the supported baseline.

## Remaining contract gaps

ADR 005 describes a richer visible reference, lexical FTS, and exact source ranges for every materialization.
The current implementation instead uses compact visible references and paged lexical scanning, while exact offsets are retained for text chunks and mixed rows but not every derived materialization.
Those architectural decisions remain unresolved; this hardening pass does not claim full ADR compliance.

## Development

```bash
npm run check
npm test
git diff --check
```

`context_query_jq` requires `jq` on `PATH`.
`context_repl` requires a usable Docker or Podman server; its integration can be unavailable on development hosts without one.
