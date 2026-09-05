# Context In hardening implementation plans

## Invariants and scope

Follow ADR 000 and the existing Context In guarantees: preserve captured evidence, return bounded views, retain provenance, and never add a host-execution fallback.
Keep Context Out unchanged.
Keep the compact interception reference unchanged.
Do not add semantic search or retention policy.
Implement the four workstreams concurrently with non-overlapping ownership, then run the combined suite.

## 1. Interception boundary correctness

Owner: interception agent.
Files: `src/index.ts` and a new `test/interception-boundary.test.ts`.

Problem: the automatic hook classifies the serialized multi-item envelope as JSON, so unrelated prose, source, or image-bearing results can qualify accidentally.
Classify original content before constructing the storage envelope.
Require safely serializable supported text content and preserve the documented native-navigation and Context Flow tool exclusions.
Conservatively bypass mixed image/text and unsupported items rather than removing or altering content that the model needs.
For multiple qualifying text items, preserve their order and exact chunk boundaries in the stored envelope.
Preserve the existing single-text JSON and JSON-RPC handling.
Never replace the original result on capture failure.

Acceptance:
- Exercise the actual registered tool-result hook with a lightweight ExtensionAPI test harness.
- Large multi-item prose/source, image/text, cyclic and unsupported content bypass unchanged.
- Large qualifying single and multi-item data/log results capture losslessly.
- Native navigation, Context Flow tools and below-threshold results bypass.
- Existing compact-reference and JSON-RPC tests remain valid.

## 2. SQL resource bounds

Owner: SQL agent.
Files: SQL analysis/query portions of `src/store.ts`, optional new SQL helper modules, and a new `test/sql-resources.test.ts`.
Do not edit text-search methods/constants or existing shared test files.

The SQL helper already applies `LIMIT 201` before returning rows to JavaScript.
Preserve that protection.
Investigate and address oversized scalar values, full-result serialization, uncapped materialization time, and cancellation that currently closes a connection rather than proving interruption.
Use the smallest robust design that bounds processing before large values enter the extension process and makes timeout termination effective.
Inspect the installed DuckDB API before selecting interruption or isolation mechanisms.
Include schema inspection and record-query analysis if they share the same unbounded setup path.
Preserve read-only query validation, isolated evidence relations and provenance.
Never label row-limited or byte-limited retained results as complete.
Test a practical memory budget rather than blindly lowering it to match stale documentation.
Report the selected enforced limits and any distinction between DuckDB memory and total process memory for final documentation reconciliation.

Acceptance:
- Existing nested structured queries continue to work.
- Large cardinality and oversized individual-value queries remain bounded or fail explicitly.
- Expensive execution and materialization terminate within a tested wall-time envelope and do not leave workers running.
- Subsequent normal queries still work after errors/timeouts.
- Verify effective memory configuration and expected limit failure in a focused test.
- No new external-read or write escape is introduced.

## 3. Slack regression baseline

Owner: fixture-test agent.
Files: `test/context-in.test.ts` only, restricted to the realistic root-record-collections test.
Do not modify generated fixtures.

The Slack query asks for up to ten messages, but its expected output lists only two while the fixture now contains additional matching messages.
Inspect the fixture and independently derive the expected first ten matching messages in ascending timestamp order.
Update assertions to test the intended filtering, ordering, projections, nullable fields and limit without narrowing the query simply to recover the original two rows.
Retain the GitHub and Kubernetes coverage in the same test.
Avoid computing expected results through the production query helper.

Acceptance:
- The previously failing test passes against the existing fixture.
- Incorrect ordering, filtering, projection or limit would still fail the test.
- The complete original test file passes, apart from explicitly unavailable container integration.

## 4. Large-evidence lexical search

Owner: search agent.
Files: text-search method/constants and narrowly necessary search helpers in `src/store.ts`, optional new search helper modules, and a new `test/search-scale.test.ts`.
Do not edit SQL analysis helpers or existing shared test files.

Replace the whole-artifact refusal above sixteen chunks with a bounded search operation that can discover matches late in a large captured log.
Prefer existing storage and incremental or database-backed lexical selection over a new dependency unless it is necessary.
Bound work, candidate buffering, result count, response bytes and elapsed time explicitly.
If exhaustive search cannot complete within the budget, report that clearly rather than silently presenting an incomplete result as exhaustive.
Normalize evidence identifiers consistently before every lookup.
Preserve exact chunk byte/line offsets and deterministic ordering.
Do not suggest that a read operation changes the evidence being searched.
Keep hybrid mode explicitly unavailable.

Acceptance:
- Find a unique match near the end of evidence substantially larger than 64 KiB.
- Test raw IDs and `evidence://` references.
- Common terms, no matches, punctuation-only queries and oversized limits behave predictably.
- Returned results and buffered candidates stay bounded.
- Source ranges retrieve the original supporting content.
- Existing small-text search tests still pass.

## Integration and validation

The coordinating agent reviews each actual diff and resolves only cross-workstream compatibility issues.
Update README guarantees to the implemented and tested behavior, without silently revising active ADR decisions.
If a design requires changing an invariant, stop that workstream for approval.
Run `npm run check`, `npm test`, and whitespace validation on all changed/new source and plan files.
Record unavailable container validation separately from passing tests.
Do not claim release completeness solely from these four workstreams.

## Execution result

All four workstreams were implemented and their actual changes reviewed.
The fixture baseline also exposed an outdated Kubernetes expectation; the test now requests explicit name ordering and asserts the expected first ten running pods.
SQL analysis uses a killable subprocess, a 201-row native limit, and a 1 MiB retained-result check before binding conversion.
Its two-second deadline includes setup, and its 256 MB DuckDB / 128 MiB V8 budgets are explicitly not a total RSS cap.
Search uses bounded paging rather than FTS and reports incomplete scans explicitly.
README documents these limits and the remaining ADR 005 discrepancies without changing that ADR.

Validation:
- `npm run check`: passed.
- `npm test`: 42 passed, zero failed, one container integration skipped because a usable runtime/image was unavailable.
- Whitespace checks against the saved baseline and all new files: passed.
- `node --check src/sql-worker.mjs`: passed.
- Independent read-only correctness/security review: no actionable material defects identified; the reviewer could not execute commands, so test results above come from the coordinating agent.

Live model benchmarks and container isolation validation were not rerun.
