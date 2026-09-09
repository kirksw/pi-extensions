# Context Out lifecycle implementation plan

## Status and approval boundary

Proposed implementation plan for the approved contract in [ADR 006](../adrs/006-observation-lifecycle-survives-worktree-evidence.md).
No runtime implementation is included in this plan.
The user-level authoritative storage root and canonical-remote-derived repository identity are approved.
Local clone/worktree identity mechanics, projection placement, non-Git behavior, migration, and initial retrieval choices below still require approval before implementation.
ADRs 000–004 and 006 remain the governing invariants.

## Outcome and invariants

A later session can retrieve a successfully recorded conclusion after its originating linked worktree is deleted, identify the original supporting evidence, and see exactly which support cannot currently be inspected.

- A successful write commits an immutable event before updating any query projection.
- Storage shared by a repository does not promote worktree observations or authorize default cross-worktree search.
- Invalid provenance links fail before any observation event is committed.
- Evidence availability, claim lifecycle, review state, and freshness are independent.
- Raw evidence remains in Context In unless explicitly retained through a future approved action.
- No automatic artifact writes, retention cleanup, scope promotion, or host-execution fallback is introduced.
- Existing Context In capture, query, isolation, and bounded-response behavior stays unchanged.

## Proposed design decisions

### 1. Storage and repository identity

For Git repositories, resolve the canonical worktree root and common Git directory using Git, not by parsing `.git` files manually.
Store authoritative Context Out data under the approved user-level root `~/.config/pi-context-flow/`, partitioned by repository ID.
Expand `~` from the current user's home directory; do not interpret it relative to the worktree.
Resolve relative Git paths against the invocation directory and canonicalize paths before comparing identities.
This location survives deletion of a linked worktree or the entire checkout and is outside tracked repository content.
Deleting a checkout does not delete its stored observations.
This milestone does not provide backup, remote sync, or automatic identity reassociation after a repository is moved or recreated.

```text
~/.config/pi-context-flow/
  registry.json                   # local repository identity and locator mappings
  repositories/<repository-id>/
    repository.json               # repository identity and canonicalization version
    origins/                      # worktree identity registry
    events/<session>/<writer>.jsonl # authoritative, single-writer event shards

<worktree>/.pi/context/
  state.duckdb                     # existing Context In store, unchanged
  evidence/raw/                    # existing raw evidence, unchanged
  context-out/projections/         # disposable, per-process DuckDB projections
```

Derive repository identity from a versioned canonical form of the `origin` fetch URL using SHA-256.
Equivalent supported SSH and HTTPS URLs, such as `git@github.com:owner/repo.git` and `https://github.com/owner/repo`, resolve to the same repository ID.
Remove credentials before persisting or hashing the URL, and never include raw credential-bearing URLs in diagnostics.
Normalize known hosting-provider URL forms conservatively; preserve meaningful path case and nonstandard endpoints rather than guessing equivalence.
Specify canonicalization fixtures before coding, including trailing `.git`, ports, local paths, host aliases, and malformed URLs.
Ambiguous remote configurations require explicit selection rather than choosing arbitrarily.
Do not substitute `upstream` for `origin`; forks remain distinct repositories.
Repository renames, host aliases, remote changes, and canonicalization-version changes require explicit identity reassociation rather than silent history merging.
A Git repository without a usable remote receives a local UUID; adding a remote later requires explicit reassociation.
Non-Git directories remain governed by the separate proposed policy below.

Clones with the same canonical remote share one repository namespace, but retain distinct random clone UUIDs and worktree UUIDs.
Repository-shared storage makes reviewed repository knowledge discoverable across these clones; it does not make unreviewed observations part of default cross-clone context.
The common Git directory identifies a local clone and is a locator, not the event-storage root.
Maintain clone/worktree locator mappings in the user-level registry with serialized atomic updates and exclusive identity creation.
Define local identity persistence across moves and distinguish deleted/recreated checkouts before implementation; path equality alone must not attach a new clone or worktree to an old origin.
A clone identity marker in the common Git directory is a possible implementation mechanism, not an event-storage location.
Create the user-level root and repository data with user-only permissions, and never pool observations across repository partitions during default lookup.
Record paths as provenance locators, not as the sole durable identity.
Subdirectory invocations must resolve to the same worktree identity.
Test moves, detached HEAD, unavailable revision metadata, and concurrent initialization explicitly.
If local identity cannot be resolved safely, report the limitation rather than merge origin histories heuristically.

Use one disposable projection per extension process and repository, avoiding a shared multi-process DuckDB writer.
Serialize updates within that process and import all committed shards idempotently.
Projection files are caches and never the only location of observation or candidate data.
Removing them explicitly must be safe; automated cache cleanup is outside this milestone.

### 2. Non-Git behavior

Keep Context In working unchanged outside Git.
For this milestone, Context Out returns an explicit unsupported-repository error outside a resolvable Git repository; return an explicit storage error when the user-level storage root is unwritable.
Do not silently fall back to worktree-local observation storage or an unpartitioned global pool.
A configurable standalone durable root can be designed later.
This deliberately changes the POC's non-Git observation behavior and is an approval gate.
Tests that exercise Context Out must create temporary Git repositories rather than plain temporary directories.

### 3. Event and provenance contract

Introduce a versioned event envelope with event ID, observation/candidate ID, event type, repository and origin scope, session and writer IDs, per-writer sequence, timestamp, idempotency key, and payload.
Tag each observation with repository ID, clone ID, worktree ID, session ID, branch name at recording time, exact Git revision when available, and capture timestamp.
Record detached HEAD, unborn branches, and unavailable metadata explicitly rather than inventing a branch or revision.
Branch names are provenance and search filters, not identity or promotion authority: branches can move, be renamed, or share names across clones.
Keep the recorded branch/revision immutable when the checkout changes.
A revision does not describe uncommitted changes; record dirty/unknown working-tree status without claiming it is an exact snapshot of those changes.
Switching branches in one worktree does not silently relabel old observations or establish their applicability on the new branch.
Default worktree retrieval retains origin history with its original branch/revision labels and freshness limitations; callers can explicitly filter by branch/revision.
Reviewed repository-scoped knowledge retains its originating tags and supporting observation links rather than losing provenance when promoted.
Initial event types cover observation creation, supersession, retraction, explicit support linking, and candidate proposal.
Approval/rejection/deferral events belong to the subsequent review milestone and must not be exposed prematurely.

Each observation creation retains evidence metadata snapshots and query snapshots obtained from the authoritative local Context In store.
Snapshots include evidence IDs, raw hashes, capture times, source, shape, size, dependency IDs, known partial-result information, query IDs, definitions, language, timestamps, and input/output evidence links when present.
Do not copy raw payloads, arbitrary tool arguments, or session transcripts into the event ledger.
Query definitions can themselves contain sensitive literals; document that these snapshots persist beyond worktree deletion.
Resolve known dependency metadata under a declared event-size budget; reject oversized new writes rather than silently claim complete lineage.
Preserve exact existing lineage without inventing source ranges or asserting that a query result proves the observation.

Normalize accepted `observation://`, `evidence://`, and `query://` references before lookup.
Validate every supplied link and its repository/origin ownership before commit.
An observation with no evidence or query links remains permitted but is explicitly unsupported, not labeled as having available support.
An unknown direct evidence ID and an unknown query ID must both leave zero new observation state.

### 4. Commit, retry, and replay semantics

Replace `appendJsonLine` for Context Out: it currently reads and rewrites the entire ledger and is unsafe for concurrent writers.
Give each live writer a unique shard and serialize that writer's appends.
Append one bounded JSON event plus newline, synchronize the file before acknowledging success, and establish directory durability when creating the shard where supported.
Document filesystem assumptions and test the supported local filesystem behavior rather than claiming network-filesystem guarantees.

Use a scoped writer lock or equivalent exclusive ownership for resumed-session deduplication; two processes resuming one session must not append under the same logical writer concurrently.
A stable caller-supplied retry key can deduplicate across tool invocations; tool-call identity can cover transport retries of one invocation.
Scope keys to repository and session, and reject reuse with a different payload.
A new tool call with no shared retry key is not assumed to be the same observation based on text similarity.
Define lock release and stale-owner recovery before coding; do not steal a lock based only on elapsed time.

The ledger commit is the success boundary.
If projection update fails after commit, return the committed ID and an explicit projection-pending warning rather than imply that recording failed.
Retry and replay must recover the same event without duplicate projections.
If commit outcome is uncertain after an I/O error, report that uncertainty and require retry with the same key.

Import complete records transactionally into the disposable projection, tracking event IDs, writer sequences, and shard offsets.
Ignore an incomplete final record until a complete commit is visible, reporting degraded coverage; never silently skip malformed complete records or unsupported schema versions.
A restarted writer creates a fresh shard rather than appending after an incomplete tail.
Replay has deterministic ordering and explicit handling of conflicting lifecycle events; do not silently pick a winner by wall-clock timestamp.
A proposed initial rule is compare-and-set lifecycle transitions referencing predecessor events, with conflicting successors exposed as a conflict that requires review.

### 5. Evidence availability

Return per-reference assessment, assessment time, reason, and aggregate support coverage.
Only label a reference available after the selected bounded inspection establishes accessible matching content; a path existing is not sufficient.
Missing files or a removed registered origin are unavailable; permission errors, timeouts, and unchecked references are unverified.
Hash mismatches are explicit integrity failures and must never be presented as verified support.
Mixed accessible and missing support is partial; incomplete assessment must retain an explicit unverified component rather than disappear into the aggregate label.
No linked support is reported explicitly as unsupported, not vacuously available.

Perform bounded checks on demand and disclose when size/time budgets prevent verification.
Search returns compact stored provenance and assessment timestamps, not an unbounded raw-evidence verification pass over every result.
Detailed observation retrieval can assess selected references with streaming hashing and explicit byte/time limits.
Raw evidence access remains through bounded Context In capabilities.
Do not open another worktree's DuckDB as an implicit cross-worktree evidence service.
A future explicit cross-worktree support inspection must use registered origin locators and a narrowly scoped read-only path; it must not accept arbitrary paths embedded in imported events.
Until that adapter exists, report those references as unverified with the reason and original identity.

### 6. Retrieval and compatibility

Add bounded observation read and search tools, proposed names `context_read_observation` and `context_search_observations`.
Default search selects the current worktree's observations plus genuinely approved repository-scoped observations.
There are no approved repository-scoped observations produced by this milestone.
Cross-worktree search and direct reads of other origins require an explicit scope parameter.
Do not let a known observation ID bypass the scope filter.
Older observations remain searchable without a mandatory 21-day cutoff; the 21-day window belongs to the future candidate review inbox.

Start with deterministic bounded lexical scanning of the observation projection, with explicit scan completeness, stable pagination, result limits, query limits, and response-byte/time limits.
Declare concrete budgets and test them before implementation is accepted.
This is basic retrieval, not ADR 004's lexical FTS plus semantic consolidation; those capabilities remain deferred, not redefined.
Return claim state, origin, branch/revision, support warnings, and projection coverage with every result.
Expose retracted/superseded claims only through explicit history filters or direct reads with their status intact.
Do not reuse the existing oversized-output helper to capture Context Out results as worktree-local raw evidence; truncate/page directly instead.

Keep `context_observe` and `context_promote` names and the no-artifact-write behavior.
Add an optional retry key and version the returned details if fields change.
Candidate proposals must also be event-backed so moving observation ownership does not strand candidates in the old DuckDB.
Existing `repo`, `architecture`, and `organization` candidate values remain artifact target categories for compatibility; they must not become observation visibility scopes.
Expose a clear mapping from legacy `candidate` status to pending proposal review without treating any legacy proposal as approved knowledge.

### 7. Legacy migration

Provide an explicit dry-run and import operation, not an automatic startup rewrite.
Discover legacy data only in the selected current worktree unless the user explicitly selects additional registered origins.
Read both `observations/ledger.jsonl` and the old DuckDB observations, links, queries, and artifact candidates.
Database-only observations can result from failed writes in the current POC and must not be silently blessed as committed observations.

The dry-run reports ledger-backed observations, matching database rows, database-only rows, conflicts, malformed records, missing links, candidates, and proposed origin assignments.
Import consistent ledger-backed observations and their resolvable candidate proposals with deterministic migration keys while preserving original IDs and timestamps.
Require explicit resolution or skip reporting for conflicts, database-only rows, and orphan candidates.
Preserve historically broken evidence references as unverified legacy lineage with migration warnings; do not apply this exception to new writes.
Unknown original session, branch, or revision stays unknown rather than borrowing the current checkout's metadata.

Import is repeatable and leaves all legacy files and tables untouched.
Report accepted, skipped, and unresolved counts and IDs, with bounded output and a durable migration record.
Never drop old tables or delete evidence as part of migration.
Archived worktrees already deleted before migration cannot be recovered without an external copy; state that limitation explicitly.

## Ordered implementation work

Execute these phases in dependency order, validating one phase before starting the next.
Suggested file boundaries are new modules, not a commitment to unrelated refactoring.

| Phase | Depends on | Work and likely files | Acceptance gate |
| --- | --- | --- | --- |
| 1. Identity and storage | Plan approval | `src/context-out/identity.ts`, storage helpers, temporary Git fixtures | Linked worktrees share repository identity; subdirectories resolve correctly; same-remote clones share repository identity but retain distinct origins; forks and unrelated remotes stay isolated under the user root; checkout deletion preserves events; non-Git and unwritable user roots fail explicitly. |
| 2. Durable events | 1 | `src/context-out/events.ts`, event types, narrow provenance-read API in `src/store.ts` | Invalid links leave no event; concurrent writers preserve every event; retries deduplicate; interrupted writes and uncertain commits recover without false success. |
| 3. Projection and lifecycle | 2 | `src/context-out/projection.ts`, lifecycle reducer | Rebuild from events yields identical claims/candidates; duplicate import is inert; conflicting transitions and corrupt shards remain visible; no shared DuckDB writer. |
| 4. Legacy import | 3 | `src/context-out/migration.ts`, explicit migration entry point | Dry-run makes no writes; repeat import is inert; conflicts and database-only rows require resolution; old data remains byte-for-byte unchanged. |
| 5. Retrieval and tool integration | 3, 4 | `src/context-out/availability.ts`, `src/context-out/store.ts`, targeted changes to `src/index.ts` and `src/types.ts` | Scope filtering, bounded reads/search, honest support warnings, session identity, and candidate compatibility work through registered tools. |
| 6. Lifecycle acceptance and documentation | 5 | New `test/context-out-*.test.ts`, targeted `test/store.test.ts` updates, README and roadmap | End-to-end worktree-deletion scenario and regression suite pass; documentation separates implemented behavior from deferred review/consolidation. |

Before phase 5, read the installed Pi extension documentation and linked session/lifecycle APIs completely as required by repository instructions.
Use actual harness session identity rather than inventing it from `cwd` or a process timestamp.
Session forks/resumes and multiple sessions in one process require explicit coverage.
Keep observations separate from the `stores` map currently keyed only by invocation directory.

## Validation matrix

- Record through the registered tool in a linked worktree, restart the extension, and recover the conclusion in that same origin.
- Record in a linked worktree, remove it using Git, start in a surviving worktree, and recover the conclusion only with explicit cross-worktree scope.
- Confirm default search excludes that other-origin conclusion, while its evidence is unavailable or explicitly unverified rather than silently considered intact.
- Validate both direct evidence and query links, prefixed IDs, empty-support observations, mixed dependency availability, hash mismatches, and permission failures.
- Inject failures before append, during append, after synchronization, and during projection update; assert committed IDs and retry semantics.
- Verify equivalent supported SSH/HTTPS remotes share repository identity, credentials never persist, forks remain separate, no-remote repositories get a local UUID, and remote changes require explicit reassociation.
- Verify branch switches preserve recorded tags, same-name branches in different clones remain distinct origins, and detached/dirty states do not imply false revision applicability.
- Run multi-process writers and resumed-session contention; assert event counts, no overwritten bytes, and deterministic replay.
- Remove only a disposable projection and rebuild; compare conclusions, lifecycle history, candidates, IDs, and provenance snapshots.
- Migrate fixtures with ledger/database disagreement, unknown origin metadata, orphan candidates, and broken legacy lineage; verify dry-run and repeatability.
- Exercise bounded search, late matches, broad queries, large snapshots, pagination under new appends, and explicit incomplete coverage.
- Assert observation data cannot authorize arbitrary file reads and no tool writes the proposed artifact or implicitly copies raw evidence.
- Run `npm run check`, focused Context Out tests, `npm test`, and `git diff --check`.
- Report unavailable container integration separately from passing checks; Context In security guarantees must not be inferred from Context Out tests.

## Deferred work and subsequent milestones

The next milestone introduces the review inbox, explicit approval/rejection/deferral history, repository-scoped projection, and reviewer support exceptions.
Evidence retention requires a separately approved copying operation, disclosure of stored content, and coverage/dependency semantics.
Only after that workflow is usable should lexical FTS and semantic retrieval assist consolidation under ADR 004.
Same-remote clones share local repository storage, but automatic cross-clone semantic consolidation remains deferred.
No automatic expiry, purge, remote sync, or authoritative artifact writer is included here.

## Approval requested

The user-level event root `~/.config/pi-context-flow/` and canonical-remote-derived repository identity are approved.
Approve local clone/worktree identity persistence mechanics and per-process disposable projections.
Approve explicit non-Git rejection for Context Out while preserving Context In.
Approve opt-in, non-destructive legacy migration with unresolved records reported rather than silently imported.
Approve bounded lexical retrieval as the foundation milestone, with semantic consolidation and evidence copying explicitly deferred.

## Phase 1 execution result

Implemented the standalone identity/storage foundation in `src/context-out/identity.ts`.
It is not wired into the existing tools yet; event-backed tool integration remains phase 5.
Known hosting-provider SSH/HTTPS forms share a versioned SHA-256 repository ID, while unknown endpoints retain transport distinctions.
Local paths, unsupported URL forms, and absent remotes use the approved local-UUID fallback.
Remote identity changes fail with an explicit reassociation requirement; reassociation itself is not implemented.

Clone and worktree identity markers live in Git metadata, not a mutable user-level registry.
Exclusive publication of fully written marker files lets concurrent initialization converge without a registry lock.
This refines the proposed registry design: canonical remote identity selects the user-level partition directly, and markers distinguish local origins across moves and recreation.
A cross-origin locator registry is deferred until retrieval needs it; no implicit cross-worktree evidence access is added here.
Event directories and repository metadata live only under the selected user's `~/.config/pi-context-flow/` root.

Validation: five focused identity tests pass and `npm run check` passes.
Tests cover credential stripping, URL equivalence, endpoint separation, clone isolation, forks, remote changes, linked worktrees, subdirectories, detached HEAD, clone moves, deletion survival, concurrent initialization, and non-Git/invalid storage errors.
This phase does not establish event commit durability, raw evidence retention, or end-to-end observation survival; those require subsequent phases.

## Phase 2 execution result

Implemented versioned event shards and strict replay in `src/context-out/events.ts`, plus observation preparation and origin snapshots in `src/context-out/provenance.ts`.
`ContextStore.observationProvenance` provides a read-only snapshot API without copying raw payloads, tool arguments, or raw paths.
The preparation adapter verifies that the evidence store belongs to the selected worktree before creating a commit payload.
Unknown direct evidence and query references fail before event commit.
Snapshots preserve known partial-output markers and otherwise report coverage as unknown, not complete.

Events are bounded to 256 KiB, provenance to 192 KiB and 128 evidence dependencies, and observation text to 16 KiB.
A session has one exclusively locked writer, serialized appends, synchronized files/directories, and a fresh shard on reopening.
Retry keys identify committed events; changed payloads or origins conflict rather than overwrite history.
Callers must preserve the prepared input for same-key retries rather than recapture changed Git metadata.
Uncertain writes raise an explicit same-key retry error.
Incomplete tails are reported; malformed complete records fail replay.

Independent validation: typecheck, whitespace checks, and 18 focused identity/event/provenance/store tests pass.
Tests inject failures before append, after append, and after file synchronization and verify retry without duplicate events.
Concurrent writer tests currently use multiple writer instances in one process; separate-process crash and lock-owner recovery acceptance remains part of the end-to-end phase.
Abandoned locks are never stolen automatically and require operator verification before removal.
Replay streams individual records but currently retains all replay results in memory, and each append rescans session history; incremental projection work must address this scaling limitation.
No existing tool has switched to the new event path yet, so the legacy `observe` partial-write behavior is not claimed fixed at the user-facing boundary.

## Phases 3-5 execution result

Implemented disposable DuckDB projections, explicit compare-and-set claim transitions, conflicting/unresolved event reporting, bounded lexical paging, and scope checks on direct reads.
Legacy migration is explicit, read-only against the source database, bounded, and repeatable; unresolved lineage is reported rather than automatically imported.
Imported observations expose their original timestamp and explicitly unknown historical session in the compact projection.

Registered tools now use the event-backed Context Out service and real Pi session identity.
Semantic retry matching precedes evidence or Git recapture, and projection failures after commit preserve committed IDs with a warning.
Added observation search/read, paged provenance/history inspection, explicit lifecycle changes, proposal inbox, and migration tools.
The service closes projections on session shutdown.
Evidence assessment hashes fixed same-worktree raw paths only and reports missing, unverified, partial, or unsupported support explicitly.
Other-origin raw evidence is not opened.

Deferred limitations remain: full in-memory replay/refresh, cooperative native query deadlines, operator-only abandoned-lock handling, no identity reassociation tool, no approval/semantic-consolidation workflow, and no evidence copying or purge.

## Phase 6 validation

Registered-tool tests exercise recording, semantic retries after source changes, lifecycle predecessor checks, explicit cross-worktree recovery after linked-worktree deletion, proposal-only behavior, and evidence-integrity warnings.
Separate Node processes concurrently append independent session shards and replay preserves all events.
Fault injection covers uncertain append and synchronization outcomes; abandoned-lock recovery remains an explicit operator action, not an implemented automatic workflow.
The exact 8 MiB evidence-assessment boundary has a regression test.

The coordinating agent inspected implementation diffs and fixed migration timestamp/session labeling, parent-directory synchronization, the exact assessment byte boundary, and post-commit cleanup warning behavior.
An independent review agent could not read source because its environment denied access; this is not an independent review approval.
No live interactive Pi session or container-security revalidation was performed; extension behavior is exercised through the registered-tool harness.

Final checks: `npm run check` passes; `npm test` reports 74 passed, zero failed, and one skipped container integration because Docker/Podman or a cached image was unavailable.
Documentation link checks and `git diff --check` pass.
