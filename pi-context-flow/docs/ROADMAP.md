# Roadmap

## Context In: remaining gaps

The core capture, inspection, querying, and bounded-search workflow is implemented.
The following items remain open; recording them here does not approve implementation or change existing architectural decisions.
See [ADR 005](adrs/005-evidence-references-expose-bounded-analysis-capabilities.md) for the current reference, retrieval, and provenance contract.

### Container sandbox integration validation

Priority: high before relying on the REPL security guarantees.
The container integration test was skipped during hardening because a usable runtime/image was unavailable.
Run the suite on a host or CI runner with Docker/Podman and the required images.
Exercise forbidden file reads/writes, network access, environment and secret leakage, subprocess escape, resource exhaustion, and cleanup after timeout.
Verify the 8 MiB output boundary and explicit partial-output reporting.
Record validated platforms and runtime versions, and distinguish an unavailable backend from a passing security test.
This work applies to the current container backend independently of the optional native backends below.

### Exact source-range and derived-result provenance

Priority: medium–high when conclusions must be auditable.
Text chunks and mixed rows retain exact offsets, and derived evidence retains evidence/query links, but exact supporting ranges are not recorded for every materialization.
Define lineage semantics for projections, joins, aggregates, and outputs supported by multiple disjoint inputs.
Do not invent a single contiguous source range for an aggregate.
Implement the approved lineage representation and test tracing returned results to their supporting raw evidence.
Reconcile any necessary change to ADR 005 through explicit approval.

### Large-evidence retrieval: FTS or an approved scanning scope

Priority: medium; high if large-log investigation is a core acceptance requirement.
Current lexical search uses bounded paging rather than the FTS specified by ADR 005.
Search can stop before late matches, and explicitly reports incomplete scan coverage.
Evaluate a worktree-local full-text index against representative large logs and repeated searches, measuring capture overhead, index storage, query latency, and retrieval correctness.
Preserve chunk IDs and exact source offsets, plus query-time, result-count, and response-byte limits.
Define index creation, recovery, and eventual deletion behavior before adopting FTS.
Alternatively, explicitly approve bounded scanning as the intended scope and revise ADR 005; scanning and FTS must not be described as equivalent.
Semantic search remains optional and is not implied by FTS.

### Visible reference metadata and capability discovery

Priority: low; primarily discoverability and specification alignment.
Automatic replacements currently expose only the evidence reference and shape, while ADR 005 also requires source, size, capture time, and available operations in the visible replacement.
Metadata is available separately through `context_metadata`, and structured discovery through `context_schema`.
Compare the compact reference with a richer bounded reference using unfamiliar-evidence tasks, measuring successful tool selection, extra turns, and context overhead.
Either implement the documented visible fields or explicitly approve the compact-reference contract and update the ADR and tests together.

### Deferred evidence retention and deletion

Priority: future lifecycle policy, not a blocker for the current POC scope.
Evidence remains immutable historical data until an explicit retention policy is defined, as recorded in [ADR 001](adrs/001-context-in-is-an-invalidatable-worktree-cache.md).
Define user-controlled retention and deletion with clear treatment of dependent derived evidence, query lineage, observations, and any future search indexes.
Do not silently expire evidence or introduce destructive cleanup without approval.

## Future direction: native REPL sandbox backends

Status: deferred exploration, not an implementation commitment.
Docker/Podman remains the supported REPL isolation backend.
The current container-only invariant remains unchanged until an alternative design is explicitly approved and validated.

### Linux: bubblewrap

Evaluate bubblewrap as an optional lightweight backend to reduce container setup and startup overhead.
Use an explicitly constructed filesystem view, selected read-only inputs, and network isolation.
Check required namespace support at runtime and fail closed if it is unavailable.
Add separate enforcement for memory, CPU, process count, wall time, and output limits; bubblewrap alone is not the complete resource-control solution.
Define how Python/Bash and their libraries are exposed without exposing unrelated host files or secrets.

### macOS: sandbox-exec

Evaluate `sandbox-exec` only as an experimental backend.
Its deprecated interface and platform-specific profiles create compatibility and maintenance risks.
Validate filesystem, network, and subprocess restrictions on each supported macOS version, with separate resource-limit enforcement.
Do not assume protection equivalent to a container running inside a Linux VM.

### Acceptance gates for either backend

- Explicitly approve any change to the container-only REPL invariant before implementation.
- Keep backend selection explicit and preserve the container baseline.
- Fail closed when a required protection is unavailable; never fall back to unsandboxed execution.
- Test forbidden file reads and writes, network access, environment and secret leakage, subprocess escape, resource exhaustion, and timeout cleanup.
- Preserve selected read-only inputs, bounded outputs, derived-evidence capture, and invocation provenance.
- Record the selected backend and effective restrictions in invocation provenance.
- Compare startup latency, installation effort, runtime reproducibility, and maintenance cost before promoting a backend from experimental to supported.

References: [bubblewrap documentation](https://github.com/containers/bubblewrap) and [sandbox-exec deprecation notice](https://keith.github.io/xcode-man-pages/sandbox-exec.1.html).

## Context Out: lifecycle foundation and remaining gaps

[ADR 006](adrs/006-observation-lifecycle-survives-worktree-evidence.md) defines the lifecycle contract.
See the [implementation plan and execution notes](plans/context-out-lifecycle.md) for design choices, acceptance gates, and limitations.
The event-backed observation, lifecycle, proposal, migration, and scoped retrieval foundation is implemented.
Events are stored under `~/.config/pi-context-flow/`, partitioned by canonical-remote-derived repository identity, with distinct clone/worktree provenance.
Raw evidence remains worktree-local; retrieval reports support availability separately from claim state and freshness.

Remaining work:

- Replace full in-memory event replay and full projection refresh with bounded incremental ingestion for large histories.
- Strengthen native query and filesystem assessment deadlines where hard termination is required; current deadlines are cooperative.
- Provide explicit identity reassociation and verified abandoned-session-lock recovery workflows.
- Add a read-only cross-origin evidence adapter if explicit inspection beyond missing-origin detection is required.
- Add candidate approval/rejection/deferral and repository-scoped reviewed knowledge, with explicit support decisions or reviewer exceptions.
- Add lexical FTS and semantic retrieval-assisted consolidation only after the review lifecycle is usable.

The proposal inbox is not an approval gate and does not create authoritative repository knowledge.
Evidence-copying and purge automation remain deferred; no automatic expiration is approved.
