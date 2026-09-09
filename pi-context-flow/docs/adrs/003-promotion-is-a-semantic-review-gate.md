---
title: Promotion Is a Semantic Review Gate
resource: adr-003-promotion-semantic-review-gate
type: mental_model
status: active
description: Promote useful observations to repository context through review, not Git merge inference or automatic writes.
tags:
  - architecture
  - promotion
  - governance
  - worktrees
generated:
  at: 2026-09-02T06:08:00Z
  by: context-flow
---

# Promotion Is a Semantic Review Gate

## Status

Active.

## Context

Git merge state, particularly after squash merges, describes code movement rather than whether an agent observation is still accurate, reusable, or appropriate as shared project knowledge.
Automatically merging all worktree context would retain failed experiments, outdated tickets, and competing branch assumptions.

## Decision

Promotion is an explicit semantic review gate.
It changes the scope or status of a supported observation and may create an artifact candidate, but it never autonomously writes an authoritative artifact.

The default promotion-review inbox uses a sliding time window, initially 21 days, to keep active parallel work reviewable.
It ranks observations by recency, support, relevance, value, and duplication against repository observations and artifacts.
Older observations remain searchable and may still be promoted explicitly.

Git or hosting-provider integration information, including PR merge status and patch equivalence, is optional provenance that can raise confidence or filter the review queue.
It is not promotion authority.

## Consequences

- Repository-scoped context consists of reviewed, promoted observations and approved artifacts rather than all worktree history.
- The default current-context search combines the current worktree's material with repository-scoped promoted knowledge.
- Cross-worktree search is explicit and carries scope, branch, revision, status, and freshness labels.
- Squash merges do not cause loss of useful knowledge, because promotion is independent of commit ancestry.
- Retraction and supersession are first-class events rather than destructive edits to the ledger.
