# Bidirectional Context Management for Pi

## POC One-Pager

### Concept

LLM context should be treated as a **scarce working set**, not as the agent’s database or durable memory.

Our Pi extension POC should optimize both sides of the context boundary:

```text
External systems
      ↓
filter / query / retrieve
      ↓
┌─────────────────────┐
│     LLM Context     │
│ minimum useful view │
└─────────────────────┘
      ↓
reasoning
      ↓
observations / decisions
      ↓
memory
      ↓
durable artifacts
```

The core principle is:

> **Selectively materialize context on ingress, deliberately externalize knowledge on egress.**

---

## 1. Context Ingress

Large MCP responses should **not automatically enter the LLM context**.

Instead:

```text
MCP / CLI / API
      ↓
raw response
      ↓
Evidence Store
JSON + DuckDB
      ↓
query / jq / SQL / search
      ↓
small relevant result
      ↓
LLM
```

### POC requirements

* Intercept MCP/tool responses before they enter context.
* Persist the complete raw response locally.
* Register each response as an addressable **evidence object**.
* Use DuckDB as the primary structured-data query engine.
* Support schema inspection for unfamiliar JSON.
* Allow the agent to query evidence using:

  * SQL
  * `jq`
  * direct object retrieval
  * optionally text search
* Return only query results to the model.
* Preserve metadata:

  * tool
  * arguments
  * timestamp
  * source
  * evidence ID

Example:

```text
linear.searchIssues(...)
        ↓
evidence://01K...
        ↓
SELECT id, title, priority
FROM evidence
WHERE status != 'Done'
        ↓
6 relevant rows enter context
```

---

## 2. Context Egress

Useful reasoning should not disappear when conversation context is compacted or the session ends.

The extension should distinguish:

```text
Evidence     = what the systems returned
Observation  = what the agent learned
Artifact     = what should become durable truth
```

Observations should capture things such as:

* decisions,
* discovered constraints,
* failed approaches,
* important relationships,
* unresolved work,
* reusable operational knowledge.

They should remain compact and reference underlying evidence where possible.

Example:

```yaml
observation:
  "Iceberg writer failures correlate with memory pressure
   introduced after deployment abc123."

evidence:
  - evidence://01K...
  - query://018...
```

---

## 3. Durable Knowledge Promotion

Observational memory is **not** the final knowledge store.

Stable knowledge should be promoted into authoritative artifacts.

```text
Observation
     ↓
scope + significance
     ↓
┌───────────────┬──────────────┬──────────────┐
│ Repo          │ Architecture │ Organisation │
├───────────────┼──────────────┼──────────────┤
│ AGENTS.md     │ ADR          │ RFC          │
│ docs/         │ design docs  │ Wiki         │
│ runbooks/     │              │ Handbook     │
│ config/policy │              │              │
└───────────────┴──────────────┴──────────────┘
```

POC promotion rules should initially produce **candidates**, not autonomous writes.

Examples:

* repeated repository constraint → suggest `AGENTS.md` / docs update
* architectural decision → suggest ADR
* cross-project design decision → suggest RFC
* operational discovery → suggest runbook
* stale artifact contradicted by current evidence → flag documentation drift

---

## 4. Provenance

Knowledge should remain traceable.

```text
Artifact
   ↓
Observation
   ↓
Evidence Query
   ↓
Evidence Object
   ↓
MCP / API invocation
```

The POC should preserve this lineage even if the first implementation only exposes it through IDs.

This allows the agent to answer:

> Why do we believe this?

without keeping all supporting data in context.

---

## 5. Storage Model

A simple first implementation:

```text
.pi/
  context/
    state.duckdb

    evidence/
      raw/
        <call-id>.json

    observations/
      ledger.jsonl

    queries/
      <query-id>.sql
```

DuckDB metadata tables:

```text
evidence
evidence_queries
observations
observation_evidence
artifact_candidates
```

Raw JSON remains the lossless source.

DuckDB provides schema-on-read and optional materialization.

---

## 6. Pi Extension Responsibilities

The extension should provide four primitives:

```text
capture
query
observe
promote
```

### `capture`

Intercept and persist large structured tool responses.

### `query`

Allow the agent to inspect and reduce evidence before adding anything to context.

### `observe`

Extract durable semantic state from reasoning and conversation.

### `promote`

Identify observations that should become repository or organisational artifacts.

These four primitives create the full lifecycle:

```text
CAPTURE → QUERY → REASON → OBSERVE → PROMOTE
```

---

## 7. POC Success Criteria

The POC is successful if we can demonstrate one realistic workflow where:

1. An MCP returns a large structured payload.
2. The full payload never enters the model context.
3. The agent discovers its schema and queries it through DuckDB.
4. Only a small relevant result is materialized into context.
5. The agent reaches a useful conclusion.
6. The conclusion becomes an observation linked to its evidence.
7. A sufficiently durable observation becomes an artifact candidate.
8. A later session can recover both:

   * the semantic conclusion from memory,
   * the exact supporting data from evidence.

The key metric is therefore not simply token reduction.

It is:

> **How much useful work and durable knowledge can the agent derive per token of active context?**
