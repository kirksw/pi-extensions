# Recursive Language Models

## Source And Status

- Paper: [Recursive Language Models](https://arxiv.org/abs/2512.24601) by Alex L. Zhang, Tim Kraska, and Omar Khattab.
- The current research source is arXiv v3, published 11 May 2026, so it remains a preprint rather than peer-reviewed evidence.
- The authors also maintain an [implementation repository](https://github.com/alexzhang13/rlm), which is useful implementation evidence but not independent validation.

## What It Contributes

RLM treats a large prompt as an external programmable environment instead of direct model input.
A root model sees metadata and uses a persistent REPL to inspect, filter, split, transform, and retain derived buffers from the external context.
Only the REPL outputs chosen by the root model enter its active context.
The root model can invoke bounded sub-model calls over constructed snippets and aggregate or verify their results.
The published implementation limits recursion to depth one, so subcalls are ordinary language-model calls rather than nested RLM environments.

## Evidence And Limits

The paper reports experiments with GPT-5 and Qwen3-Coder on S-NIAH, BrowseComp-Plus, OOLONG, OOLONG-Pairs, and LongBench-v2 CodeQA.
It claims operation over inputs up to ten million tokens and, on selected tasks, gains over compaction and coding-agent baselines at comparable median cost.
The no-subcall ablation still exceeds the base context limit, while subcalls help most on information-dense workloads that require semantic processing across much of the data.
These are author-reported preprint results and have no identified independent replication.
Costs and latency have long tails because calls in the evaluated implementation are sequential and trajectories may make many redundant calls.
Reliability depends on model coding skill, output limits, query plans, and brittle finalization conventions.
The reference REPL shares local process resources and is not suitable for executing untrusted model-generated code without isolation.

## Mapping To Context Flow

RLM strongly supports Context Flow's central claim that raw MCP and API payloads should be external evidence, not automatic conversation content.
`evidence://` should act as a programmable object with metadata, schema, size estimates, raw retrieval, and bounded derived views.
A durable `query://` object should record its evidence inputs, data hash, engine and version, query text, timestamp, limits, and materialized result metadata.
This turns query results into stable RLM-like buffers and makes lineage executable rather than merely descriptive.
Deterministic reduction through SQL, `jq`, JSON paths, counts, joins, and hashes should precede any semantic model subcall.
Semantic subcalls should be an explicit escalation with a depth, concurrency, token, cost, and wall-clock budget.
A query or subcall result is reproducible working state, while an observation is a compact semantic conclusion that references it.
Artifact candidates remain deliberately separate and require human approval before any authoritative file changes.

## POC Decisions Suggested

- Add byte, row, token, query, iteration, and time budgets to every materialization path.
- Record result limits and stop reasons, including whether a result was truncated or paginated.
- Prefer declared query primitives over arbitrary model-generated code.
- If arbitrary code is added, run it in an isolated sandbox with explicit filesystem, network, and retention policy.
- Evaluate with a realistic large structured MCP result, grounded answer quality, context materialized, cost, latency, and provenance replay.

## Open Questions

- Which derived results should be persisted, content-addressed, and reusable across sessions?
- When should semantic chunk processing be allowed rather than requesting a better deterministic query?
- What retention, deletion, and privacy rules apply to locally captured evidence?
