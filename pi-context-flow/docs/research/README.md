# Research Notes

These notes evaluate related papers and Pi extensions against the POC described in [`../CONCEPT.md`](../CONCEPT.md).
They distinguish source-backed findings from proposed Context Flow decisions.
Papers are preprints unless a note states otherwise, and upstream extension behavior can change after the inspected revision.

| Topic | Focus |
| --- | --- |
| [Recursive Language Models](recursive-language-models/findings.md) | External programmable context, selective materialization, bounded subcalls |
| [MemGPT](memgpt/findings.md) | Virtual context, tiered memory, pressure and pagination controls |
| [TA-Mem](ta-mem/findings.md) | Multi-index, tool-routed retrieval, bounded retrieval loops |
| [context-mode](context-mode/findings.md) | Pi hooks, external computation, text retrieval, compaction resume state |
| [pi-observational-memory](observational-memory/findings.md) | Compact semantic observations, provenance-aware cross-session recall |

## Cross-Cutting Position

The research supports a single architecture with distinct layers:

```text
Lossless source response -> Evidence
Reproducible reduction   -> Query or derived result
Compact semantic state   -> Observation
Human-approved authority -> Artifact candidate then artifact
```

The next POC steps should prioritize bounded materialization, query lineage, source-backed observation recall, and candidate-only promotion before adding unconstrained semantic agents or arbitrary code execution.
