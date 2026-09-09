# Review Red/Green Sequence

Tests only: production behavior is deliberately unchanged. Run from `pi-context-flow/`.
The regressions assert the desired contracts, not the reviewed broken behavior; do
not turn failures into skips or expected throws to make CI green.

## Automated Order

1. `npx tsx --test test/review-regressions.test.ts` exercises disposable subprocess
   capture, schema, SQL, bounded read and restart; jq compatibility and bounded
   streams; overlapping worktree writers; shutdown followed by another process;
   and PATH-only synthetic Docker/Podman executables. Each request and worker has
   a deadline; workers are killed and reaped before temporary storage removal.
   The concurrent test intentionally holds the first initialized process alive.
   Shutdown uses the registered hook while the former extension process remains
   alive, rather than disguising leaked native handles with process exit.
2. `npx tsx --test test/interception-boundary.test.ts` calls the actual registered
   `tool_result` hook. Existing tests already cover JSON/log positive controls,
   mixed image/text bypass, serialization, thresholds and failure preservation.
   Added cases cover comma-rich prose, INFO in source and retained source details
   on errors. Pi merges partial hook results: omitted `isError` preserves the
   original flag, but replacement `details` must retain meaningful original keys.
3. `npx tsx --test test/context-out-*.test.ts` covers recording, event replay,
   restart/retrieval, retract, supersede and proposal. The new registered-tool
   restart/supersede test injects a temporary Context Out home and verifies a
   pre-existing authoritative document is byte-identical after proposing it.
   Existing tests additionally cover missing evidence and deleted worktrees.
4. Run real container acceptance below, separately from unit tests.
5. Only after approval, run the manual full-profile smoke below.

### jq Representation

Zero stdout documents retain existing `null`; one document retains its existing
value (including arrays and null); two or more documents become an ordered array.
This intentionally does not distinguish one array from a stream of its elements.
Pretty-printed objects and embedded escaped newlines must work, not merely
newline splitting. Above the response budget, retain bounded preview plus derived
evidence rather than parsing a clipped document. The existing context-in tests
cover environment allowlisting and complete oversized jq evidence; the new case
adds oversized multi-document stdout. jq absence is an explicit prerequisite skip.

## Real Container Acceptance (Opt-In)

```sh
CONTEXT_FLOW_CONTAINER_ACCEPTANCE=1 npx tsx --test test/review-container.test.ts
```

Requires an installed Docker/Podman CLI, reachable daemon, and **already cached**
`python:3.12-alpine`. No image pulls, package installs or model calls occur. Skips
separately identify missing CLI, inaccessible daemon and missing image. The first
CLI found is used; if multiple runtimes exist, select one via PATH for a deliberate
acceptance run. Normal `npm test` skips all three daemon cases.

A temporary transparent CLI wrapper adds only a UUID name and ownership label.
It neither adds security flags nor performs production cleanup. It uses the same
PATH discovery route as the regression: current discovery failure can block deeper
checks. Do not bypass it and claim end-to-end REPL acceptance. After discovery is
fixed, the security probe requires selected workspace AND evidence input reads
under uid 65534 (catching the 0700 staging-directory issue), rejects writes, checks
synthetic-secret absence and denied network connection, and inspects daemon
configuration for network, read-only mounts/root, capabilities, no-new-privileges,
CPU, memory and PID limits. This checks configured CPU/memory/PID ceilings, not
exhaustion behavior; hostile exhaustion and cross-platform Podman field differences
remain manual acceptance work.

Timeout and overflow cases inspect the daemon and require no surviving owned
container **before** finally cleanup. All daemon commands are bounded. Finally
kills/reaps the worker, removes only resources selected by the unique test label,
and removes the temporary workspace. If interrupted externally, inspect/remove
only that run's `context-flow-review=context-review-<UUID>` resources; never prune
the daemon. Daemon cleanup has not been proven by the executable fixtures.

## Personal-Experimental Profile Smoke (Manual, Approval Required)

No real Pi invocation was launched for this change. Before performing this stage,
read the installed Pi README and applicable extension, session, package and CLI
docs in full, plus wrapper/profile and scoped working instructions. Do not infer
runtime API behavior from the unit harness. Confirm the wrapper selects
`NIX_AGENTS_PROFILE=personal-experimental`; do not change/install profile packages
or settings, and obtain approval before model calls.

Use a disposable clone with synthetic data and an isolated Pi session/config area.
**Context Out home is independent of the Pi profile.** Arrange an isolated test
entry point using `registerContextFlow(pi, { home: temporaryHome })` (or the
`contextOut` injection); changing only Pi's agent directory is insufficient.
Verify loaded extensions and paths before recording anything. Do not use actual
worktree `.pi/context`, user observation storage, credentials or production data.

Record a matrix with wrapper/profile versions, model, extensions and permissions:

- Single agent: capture/schema/SQL/jq/read; record input/output byte counts and
  model-visible context/token counts before and after interception.
- Herdr: two sessions on one disposable worktree, bounded tool calls and clean
  shutdown/reload; distinguish concurrent-write failures from permission denial.
- Observational memory: record, restart, retrieve, retract, supersede and propose;
  verify claims remain separate from raw evidence and authoritative docs unchanged.
- Permission extension: deny a selected operation and verify Context Flow does not
  circumvent denial or turn an error into success. Repeat allowed operations.
- Tracing: verify original tool identity/error metadata and evidence lineage remain
  visible without raw synthetic bulk being injected back into model context.
- Interaction order: exercise interception with tracing/observational memory active,
  compare against a no-Context-Flow baseline using identical synthetic payloads;
  report measured context savings and failures, not estimated unit-test savings.

Archive only sanitized test artifacts outside this checkout. Stop if an operation
would touch real profiles, observations, documents or require an unapproved pull.

## Validation Commands

```sh
npm run check
npx tsx --test --test-concurrency=1 test/review-*.test.ts test/interception-boundary.test.ts test/context-out-tools.test.ts
# Existing test baseline, excluding all newly named review/acceptance cases:
npx tsx --test --test-concurrency=1 --test-skip-pattern='review:|real container acceptance:' test/**/*.test.ts
npm test
git diff --check
```

Record exact failures, pass/skip counts and prerequisite skips when running this
sequence. Red regression failures are not passing validation. Native errors must
be contained by workers; request-deadline or fixture-shape failures are harness
bugs, not evidence of a production regression.

## Recorded Review Baseline

On this checkout, with production unchanged:

| Command | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: |
| Targeted sequence (three review files, interception, Context Out tools) | 20 | 8 | 3 | 1 |
| Existing baseline using `--test-skip-pattern` | 76 | 0 | 1 | 0 |
| `npm test` | 79 | 8 | 4 | 1 |
| Opt-in real container acceptance | 0 | 0 | 3 | 0 |

`npm run check` and `git diff --check` pass. The baseline's existing REPL case
skips because its runtime/cached Bash prerequisite is unavailable. All three
opt-in daemon cases skip specifically because `python:3.12-alpine` is not cached;
the CLI and daemon preflight succeeds. No container security/cleanup acceptance
is claimed. Normal full-suite skips additionally include the three opt-in cases.

Exact intentional red tests:

- `review: hook bypasses comma-rich prose`: captured as CSV instead of bypass.
- `review: hook bypasses source containing INFO`: captured as mixed evidence.
- `review: captured errors preserve effective error flag and meaningful source details`:
  original detail key is lost (effective error flag assertion passes).
- `review: same-worktree concurrent processes can capture without native lock failure`:
  native DuckDB `INTERNAL Error: Attempted to dereference unique_ptr that is NULL!`.
- `review: registered shutdown releases Context In while old process remains alive`:
  same native DuckDB lock/open error.
- `review: jq scalar document stream`: JSON parser rejects second stdout document.
- `review: jq pretty object document stream`: JSON parser rejects second document.
- `review: container CLI discovered and executed from nonstandard PATH without secrets`:
  REPL reports Docker/Podman unavailable despite the executable fixtures.

An initial harness assertion expected bare bounded-read data rather than its
`value` envelope; that harness error was corrected and restart now passes. An
initial negative-lookahead name filter did not exclude review tests under this
Node runner; the recorded green baseline uses the verified skip-pattern command.
No outstanding harness failures or deadline hangs occurred in the final runs.
Full-profile smoke, live container checks and resource-exhaustion acceptance remain
unvalidated. No Task/delegation tool is exposed in this subagent environment, so
an independent `bottleneck` quality check could not be invoked here.
