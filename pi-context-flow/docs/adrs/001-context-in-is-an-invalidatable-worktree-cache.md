---
title: Context In Retains Immutable Worktree Evidence
resource: adr-001-context-in-immutable-worktree-evidence
type: mental_model
status: active
description: Keep ingress evidence and derived materializations isolated to the current worktree as immutable historical captures.
tags:
  - architecture
  - worktrees
  - evidence
  - provenance
generated:
  at: 2026-09-02T06:08:00Z
  by: context-flow
---

# Context In Retains Immutable Worktree Evidence

## Status

Active.

## Context

Large MCP, CLI, and API responses are expensive to retain in model context.
They still need to remain available as an exact record of what the source tool returned at capture time.
Cross-worktree retrieval has little default value and can contaminate an agent's reasoning with unrelated branch state.

## Decision

Context In is an immutable evidence store scoped to the current worktree.
It captures raw evidence losslessly outside the model context, replaces large results with capability-bearing evidence references, and materializes only bounded query results when requested.
It does not search or inject other worktrees' evidence by default.

Evidence references record capture time, source, raw SHA-256, size, shape, dependencies, available analysis capabilities, and query/materialization lineage.
They do not report currentness, staleness, source revision, Git state, or expiry.
A capture remains an addressable historical artifact until explicitly removed by future retention policy.
Derived evidence records its parent evidence ID but does not inherit a validity state.

## Consequences

- Evidence answers what a tool returned at a recorded time, not what an external system or workspace contains now.
- Callers that need current remote or workspace data must obtain a new tool result or explicitly recapture a file.
- Query budgets, page limits, output limits, and recursive depth remain independent safety controls.
- Session/worktree isolation still prevents automatic cross-worktree evidence discovery.
