---
title: Consolidation Creates Reviewable Promotion Candidates
resource: adr-004-consolidation-reviewable-promotion-candidates
type: mental_model
status: active
description: Use retrieval-assisted observation consolidation to create promotion candidates for review rather than automatically sharing knowledge.
tags:
  - architecture
  - observations
  - promotion
  - retrieval
  - governance
generated:
  at: 2026-09-02T06:08:00Z
  by: context-flow
---

# Consolidation Creates Reviewable Promotion Candidates

## Status

Active.

## Context

Observational Memory can process observations created during a session and compare them with historical worktree and repository observations.
Recurring, independently supported observations often represent reusable project knowledge.
However, recurrence alone can amplify an unsupported claim, and a single well-evidenced decision can be valuable even without repetition.

## Decision

The observational-memory consolidation process uses lexical full-text search and semantic retrieval to discover related historical observations.
It creates or updates a reviewable promotion candidate when the available signals indicate that a worktree-scoped observation may be valuable at repository scope.
It does not automatically change an observation's scope.

Candidate ranking combines:

- lexical and semantic cluster recurrence over a configurable recent review period;
- independent session and worktree corroboration;
- linked evidence and query lineage;
- relevance and freshness against the current repository state;
- novelty relative to existing repository observations and artifacts;
- penalties for contradictions, staleness, duplication, and unsupported claims.

The default review window is 21 days.
Older observations remain searchable and can be selected for promotion explicitly.

A candidate records the proposed repository-scoped observation, supporting observations and provenance, evidence/query links, ranking reasons, warnings, and a review state of `pending`, `approved`, `rejected`, or `deferred`.

## Consequences

- Consolidation provides useful automation without silently making agent memory shared project knowledge.
- Candidates can be surfaced after session end, after compaction, on demand through a promotion-review tool, or as a compact session-start notice.
- Promotion approval creates a repository-scoped projection; rejection or deferral preserves the underlying worktree-scoped observations and review history.
- Repository scope is the default durable target; global scope requires an explicit cross-repository rationale.
- The harness can explain why every candidate was flagged and allow users to assess its evidence before approval.
