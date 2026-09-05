# context-mode

## Source And Scope

- Upstream: [mksglu/context-mode](https://github.com/mksglu/context-mode), with the [npm package](https://www.npmjs.com/package/context-mode).
- The inspected upstream revision was `5801143d87f662648ff40b21af676caa75ee8b8f`.
- Relevant Pi adapter: [`src/adapters/pi/extension.ts`](https://github.com/mksglu/context-mode/blob/main/src/adapters/pi/extension.ts).

## What It Does

context-mode uses sandbox-first tools such as `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute` to process information outside model context and return only command output.
Its `ctx_fetch_and_index` and `ctx_index` paths fetch, transform, chunk, and persist material for later retrieval instead of returning whole pages.
For Pi, a `tool_call` hook blocks several inline HTTP clients and stdout-producing `curl` or `wget` patterns, directing the model toward controlled sandbox tools.
It deliberately allows quiet file-output HTTP commands as an escape hatch when MCP is unavailable.

The extension initializes session state at `session_start`, extracts selected tool/session events at `tool_result`, injects concise routing and resume guidance at `before_agent_start`, and persists a resume snapshot before compaction.
It uses SQLite with FTS5 for durable text retrieval, including heading-aware Markdown chunking, source metadata, match-centered snippets, staleness detection, and combined stem/trigram ranking.
Its compact resume state is a bounded table of contents that points to retrieval rather than replaying the full session.

## Lessons For Context Flow

The project provides practical evidence that instructions alone are insufficient: Pi lifecycle hooks can enforce context-boundary routing.
It also demonstrates a useful split between ephemeral external computation and durable indexed retrieval.
The bounded resume index, source labels, staleness checks, cache TTLs, heading-aware chunks, and snippet-centered retrieval are strong ideas if Context Flow adds text search.

## Gaps Relative To This Concept

context-mode does not provide a first-class immutable `evidence://` object for every tool response with raw JSON, arguments, invocation metadata, and a stable ID.
It does not implement schema-on-read with DuckDB, SQL, `jq`, or a query ledger for structured evidence.
Its session events are operational state rather than explicitly authored observations linked to exact evidence and query IDs.
It does not expose the full `Artifact -> Observation -> Query -> Evidence -> Invocation` lineage or candidate-only promotion to AGENTS files, ADRs, RFCs, runbooks, and documentation-drift flags.
Its subprocess boundary is not a complete operating-system sandbox, and command-pattern blocking can fail open.

## POC Decisions Suggested

- Preserve explicit interception and replacement of large structured tool outputs, while adding opt-in routing policy for tools that should never materialize raw data.
- Separate ephemeral computations from retained evidence and index each according to its lifetime.
- Add a bounded resume index of recent high-priority observations that links back to evidence/query retrieval.
- If text search is added, adopt source-aware chunks, snippets, staleness tracking, and retention/TTL controls.
- Test interception coverage, replacement-size guarantees, compaction recovery, query lineage, and evidence purge behavior.

## Open Questions

- Which classes of built-in, MCP, and custom tools require interception versus routing before execution?
- What policy handles non-JSON large outputs without silently allowing them into active context?
- Should durable text indexing live beside DuckDB or be delegated to a dedicated FTS engine?
