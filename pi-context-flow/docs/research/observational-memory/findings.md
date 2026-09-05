# pi-observational-memory

## Source And Scope

- Canonical upstream: [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory).
- Primary project documentation: [README](https://github.com/elpapi42/pi-observational-memory/blob/master/README.md), [how it works](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/how-it-works.md), and [concepts](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/concepts.md).
- The package is published as [pi-observational-memory](https://www.npmjs.com/package/pi-observational-memory).
- The user-facing project name may be shortened to “observation-memory,” but the upstream calls the concept observational memory.

## What It Contributes

The extension continuously distills work into compact observations intended to survive compaction, handoffs, and later sessions.
Its unit of persistence is semantic state: decisions, discoveries, constraints, failures, relationships, and work status, rather than raw tool output.
Relevant observations are recalled into active context as the agent continues work.
Observation IDs can support recovery of the detailed source context behind a compact record.
The upstream V3 notice describes a new memory model and does not read V2 settings, so memory format and migration deserve explicit lifecycle design.

## Mapping To Context Flow

This is direct precedent for Context Flow's egress layer.
The concept's Observation definition maps closely to compact semantic records that persist across context compaction and sessions.
Source-expandable identifiers strengthen the requirement that the agent can answer why it believes an observation without keeping all source material in active context.

Context Flow must add an evidence-first ingress model:

```text
Pi observational memory: observation -> conversation/source context
Context Flow:           observation -> query -> evidence -> invocation
```

A conversation-derived source reference is useful but not enough for arbitrary MCP and API payloads.
Context Flow requires lossless raw JSON, stable evidence IDs, tool arguments and metadata, reproducible SQL or `jq` query records, and explicit evidence-to-observation joins.
It also extends working memory with a separate promotion boundary: observations can propose documentation, ADR, RFC, runbook, or policy changes but cannot autonomously make them authoritative.

## POC Decisions Suggested

- Adopt compact, agent-authored observations as the egress primitive rather than saving transcript summaries as memory.
- Ensure every observation can reference `evidence://` and `query://` IDs in addition to conversational source context.
- Build a compact, prioritized cross-session recall index with an on-demand expansion path.
- Define retention, deletion, format-versioning, and migration behavior before observations become relied upon operational state.
- Keep promotion candidate-only and expose provenance before a user approves any artifact change.

## Open Questions

- What upstream observation schema, capture triggers, and source granularity should be adopted or made interoperable?
- How should Context Flow select observations for re-entry without overfilling active context?
- How should an observation behave when its backing evidence is redacted, expired, or contradicted by newer evidence?
