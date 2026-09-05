---
title: Context Out Uses Append-Only Observation Events
resource: adr-002-context-out-append-only-observation-events
type: mental_model
status: active
description: Record observations as immutable provenance-linked events, then derive their current interpretation through consolidation.
tags:
  - architecture
  - observations
  - concurrency
  - provenance
generated:
  at: 2026-09-02T06:08:00Z
  by: context-flow
---

# Context Out Uses Append-Only Observation Events

## Status

Active.

## Context

Parallel agents and Git worktrees can produce valid but conflicting observations.
A shared mutable observation record makes concurrent writes and later provenance reconstruction unnecessarily fragile.

## Decision

Context Out uses append-only observation events as its source of truth.
An event may create an observation or record its supersession, retraction, promotion, or review state.
Readers derive the current projection from the event history.

Each event includes an immutable event ID, observation ID, event type, scope, payload, timestamp, idempotency key, session and worktree provenance, and links to evidence and queries.

For the POC, each worktree or session writes its own append-only ledger shard.
A repository-level consolidator imports shards idempotently into a query projection.
DuckDB remains the local analytical store, but is not treated as a multi-process writer service.

## Consequences

- Parallel writers do not overwrite one another or require a globally mutable current-observation row.
- Contradictions remain inspectable rather than being silently lost; queries expose status and provenance.
- Consolidation makes observations searchable across worktrees but does not make them authoritative truth.
- A writer lock, single local writer queue, or shard-and-compact flow is required before multiple processes write a shared DuckDB file.
- Evidence remains lossless and separate from the concise semantic observation that references it.
