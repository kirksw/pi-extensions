# MemGPT

## Source And Status

- Paper: [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) by Charles Packer et al., originally submitted in 2023.
- The [paper HTML](https://arxiv.org/html/2310.08560v2), [project site](https://research.memgpt.ai/), and archived [MemGPT repository](https://github.com/cpacker/MemGPT) are the primary historical sources.
- The project is now Letta; use the paper and archived implementation for claims about MemGPT itself.

## What It Contributes

MemGPT models prompt context as limited RAM and external memory as disk.
Its main context comprises read-only instructions, mutable working memory for salient facts, and a FIFO queue for recent events.
Evicted queue content is summarized recursively but remains in recall storage for later search.
Archival storage holds arbitrary-length content that the model can search, read, and write.
The model chooses memory functions itself, receives bounded and paginated results, and can chain calls through heartbeat-style follow-up turns.
Memory-pressure warnings give the model a chance to preserve important working facts before a flush threshold requires eviction.

## Evidence And Limits

The paper reports better multi-session memory question answering than fixed-context, summary-only baselines by searching stored conversation history.
It reports long-document QA using iterative archival retrieval and a synthetic multi-hop key-value task where MemGPT with GPT-4 completed deeper lookups than fixed-context baselines.
The evidence validates the virtual-context framing, but not an unlimited-context guarantee.
Embedding retrieval can rank required information too low, and agents may stop paginating before reaching it.
Tool-use reliability varies sharply with the underlying model.
Several evaluations use limited samples or LLM-generated/judged tasks, so results do not establish broad production reliability.
The paper does not directly evaluate structured tool-result fidelity, provenance across external systems, retention/deletion, documentation drift, or safe promotion to repository authority.

## Mapping To Context Flow

MemGPT directly supports the concept that active model context is a scarce working set while source material remains external.
Context Flow extends the model for engineering work: it intercepts structured MCP, CLI, and API responses; retains raw JSON losslessly; and uses DuckDB, SQL, and `jq` for reproducible reduction.
The useful three-layer correspondence is:

```text
MemGPT external and recall storage -> Context Flow Evidence
MemGPT working facts and summaries   -> Context Flow Observations
No direct MemGPT equivalent          -> Context Flow Artifacts
```

Context Flow should keep these layers distinct rather than flattening them into vector memory.
An observation is fallible, compact working knowledge; an artifact candidate proposes, but never autonomously writes, durable authority.

## POC Decisions Suggested

- Add explicit context budgets, warning thresholds, and compaction-time observation capture.
- Return cursor/page metadata, result counts, truncation flags, and stop reasons for retrieval tools.
- Bound every query result by rows and bytes, and require deterministic predicates before semantic retrieval when possible.
- Preserve `evidence://` and `query://` lineage for every materialized value and observation.
- Test the entire `CAPTURE -> QUERY -> REASON -> OBSERVE -> PROMOTE` lifecycle across a later session.

## Open Questions

- Which observations belong in a compact resume index after compaction?
- Which triggers should prompt observation capture before context is lost?
- What data-retention and deletion policy applies to evidence, observations, and derived result caches?
