---
title: Observation Lifecycle Survives Worktree Evidence
resource: adr-006-observation-lifecycle-survives-worktree-evidence
type: mental_model
status: active
description: Persist observations independently of worktrees while explicitly tracking unavailable support and governing evidence retention.
tags:
  - architecture
  - observations
  - lifecycle
  - provenance
  - governance
---

# Observation Lifecycle Survives Worktree Evidence

## Status

Active.
Approved lifecycle contract; not a claim that the current implementation satisfies it.

## Context

Useful observations must survive session end and deletion of their originating worktree.
Their raw supporting evidence is worktree-local and may not survive.
An observation can survive its evidence, but must not silently retain the same verification status.
Evidence availability, claim validity, freshness, and promotion authority are different concerns.

## Decision

### Ownership and persistence

New observations retain their originating worktree/session scope.
A successful observation write means its event has been persisted in repository-local storage that survives deletion of the originating worktree.
Repository-local storage is shared storage for that repository on the current machine, not files automatically committed to Git.
Storage location does not confer repository knowledge scope or authorize default cross-worktree retrieval.

Each session writes its own append-only event shard in that storage.
DuckDB is a rebuildable projection, not the authoritative record.
The concrete storage path, repository identity resolution, non-Git behavior, and migration of existing worktree-local records require an implementation plan.

Raw evidence remains worktree-local by default.
Recording an observation does not implicitly copy potentially large or sensitive evidence into shared storage.
This extends [ADR 002](002-context-out-uses-append-only-observation-events.md) by defining shard ownership independently of the originating worktree's lifetime.

### Independent states

| Dimension | States | Meaning |
| --- | --- | --- |
| Claim lifecycle | `active`, `superseded`, `retracted` | Whether the conclusion is still asserted. |
| Evidence availability | `available`, `partial`, `unavailable`, `unverified` | Whether recorded support can currently be inspected. |
| Promotion review | `pending`, `approved`, `rejected`, `deferred` | Whether a proposed scope change has been reviewed. |

Promotion review belongs to a candidate, not to every observation.
Losing evidence does not retract a claim, and available evidence does not establish that a claim remains correct.
Freshness and applicability against the current repository state remain separate from evidence availability.
An observation about an old revision may be fully inspectable but no longer applicable.

Availability reporting must explain which supporting references are inspectable, missing, or not verified.
Transient read failures report `unverified`, not permanent loss.
Availability is an assessment of access to recorded support, not a semantic endorsement of that support.

### Provenance and worktree deletion

Observation events and their provenance survive deletion of the originating worktree.
The durable provenance snapshot records repository, worktree, and session identity; branch and revision when available; evidence IDs and hashes; query IDs and definitions; and capture times.
Missing origin metadata must remain explicit rather than being invented.
Snapshots do not imply retention of raw evidence or complete derived-result dependencies.

Later retrieval returns the conclusion with an explicit warning when its support is partially available, unavailable, or unverified.
A newly captured result must not silently replace the original evidence.
Any new supporting capture retains its own identity and is linked through an explicit event.
Default retrieval continues to follow [ADR 003](003-promotion-is-a-semantic-review-gate.md): current-worktree material plus repository-scoped promoted knowledge, with explicit cross-worktree search.

### Promotion and evidence retention

Promotion approval requires an explicit support decision in addition to semantic review.
The reviewer can choose one of two routes:

- Preserve support by approving retention of selected supporting evidence in repository-local storage.
- Accept without inspectable support through an explicit reviewer exception with a recorded rationale.

Retained subsets must identify their coverage and missing dependencies rather than claim complete support.
An exception does not remove the promoted observation's evidence-availability warning.
Evidence preservation is an explicit retention action, not automatic cross-worktree evidence discovery or a change to the default capture policy in [ADR 001](001-context-in-is-an-invalidatable-worktree-cache.md).

Neither route writes authoritative documentation automatically.
Artifact creation remains a separate, approved action under [ADR 003](003-promotion-is-a-semantic-review-gate.md).
Candidate review states and repository-scoped projections retain the semantics in [ADR 004](004-consolidation-creates-reviewable-promotion-candidates.md).

### Retention and deletion

The initial implementation has no automatic expiration.
Rejecting a candidate does not delete its observations or supporting evidence.
Supersession and retraction append events instead of erasing history.
An evidence-deletion operation must disclose affected observations and candidates before approval.

Append-only history is not a promise to retain sensitive data forever.
Explicit purge is a separate destructive operation whose detailed policy remains deferred.
Ordinary lifecycle operations must not act as implicit purges.

## Initial implementation scope

Implement durable event ownership, provenance snapshots, evidence-availability reporting, and bounded later-session retrieval first.
Defer evidence-copying and purge automation, and report unavailable support explicitly until retention capabilities exist.
Automatic consolidation follows a usable memory and review lifecycle rather than preceding it.

## Consequences

- Worktree deletion does not erase successfully recorded conclusions or their provenance snapshots.
- Repository-local persistence does not silently promote worktree claims into shared project truth.
- Retaining observations does not promise indefinite access to their raw supporting data.
- Retrieval can explain limitations without conflating missing evidence with a retracted or stale claim.
- Promotion remains possible without inspectable support only through a recorded reviewer exception.
- Existing worktree-local observation storage needs migration before it can meet this contract.
