---
title: Context Flow Boundaries
resource: adr-000-context-flow-boundaries
type: mental_model
status: active
description: Separate invalidatable context ingress from durable, governed context egress.
tags:
  - architecture
  - context-management
  - provenance
generated:
  at: 2026-09-02T06:08:00Z
  by: context-flow
---

# Context Flow Boundaries

## Status

Active.

## Context

An LLM context window is a scarce working set, not a durable database.

Context Flow manages information on both sides of that boundary.
Incoming material is frequently volatile, checkout-specific, and too large to materialize by default.
Outgoing learnings can remain useful after a session or worktree ends, but must not become project truth without review.

## Decision

Context Flow has two separately scoped subsystems:

- **Context In:** captures external evidence outside the active context and selectively materializes bounded, provenance-linked views from an evidence reference.
- **Context Out:** records compact, provenance-linked observations and offers them for governed consolidation and promotion.

MemGPT-style tiering is a policy across both subsystems: it decides what belongs in the bounded active working set and what remains external.

## Consequences

- RLM-style externalization, deterministic inspection, and capability-bearing evidence references apply to Context In.
- Observational Memory and TA-Mem-style retrieval apply to Context Out.
- Raw evidence, observations, artifact candidates, and durable artifacts remain distinct concepts.
- No tool response, observation, or agent session becomes durable repository truth implicitly.
