---
title: Evidence References Expose Bounded Analysis Capabilities
resource: adr-005-evidence-reference-analysis-capabilities
type: mental_model
status: active
description: Replace large tool outputs with queryable evidence references, then select analysis capabilities from their content shape.
tags:
  - architecture
  - evidence
  - retrieval
  - sandbox
  - provenance
---

# Evidence References Expose Bounded Analysis Capabilities

## Status

Active.

## Context

A large tool result is useful evidence but is too expensive and distracting to place directly in the LLM context.
A bare identifier is also insufficient because the model needs to discover what the retained material contains and how to investigate it.
Structured JSON, free text, and mixed artifacts such as logs need different retrieval and analysis methods.

## Decision

Context In replaces a captured large tool result with a stable evidence reference rather than its raw payload.
The replacement states the reference ID, source, size, capture time, shape, and the bounded operations available for that evidence.
The raw payload remains lossless in the session and worktree-scoped evidence store.

Capture automatically derives queryable materializations from the evidence shape without changing or discarding the raw payload:

- Structured JSON is exposed through schema inspection and read-only DuckDB relations and SQL.
- Text is chunked with source offsets and metadata, then exposed through lexical FTS and, when available, hybrid lexical and semantic retrieval.
- Mixed content, including logs and JSON-bearing text, may expose both a derived relation for parsed fields and text search over the original event or chunk text.
- All materializations preserve links to the evidence reference and exact source ranges so a model can retrieve the supporting subset.

The primary tools are schema or metadata inspection, bounded SQL, text search, and exact subset reads.
They return selected rows, chunks, or ranges rather than materializing a complete large artifact into the conversation.

A read-only REPL is the fallback when the primary tools cannot express the required analysis.
It accepts Python or Bash only and runs in an OS-enforced sandbox with read-only access to the workspace and explicitly selected session artifacts.
It has no network, secret or host-home access, package installation, writable artifact or workspace mounts, or subprocess escape from the sandbox.
CPU, wall time, memory, process count, input-read, and output limits are enforced.
Oversized REPL output is captured as new evidence and returned as a reference.
REPL invocations record their code, declared inputs, effective limits, exit state, output evidence, and provenance.

## Consequences

- Interception remains the default context-boundary enforcement mechanism while the LLM retains control over the sequence of evidence operations.
- A reference is a capability-bearing artifact, not a dead-end pointer.
- DuckDB is the primary engine for structured analysis, while text retrieval provides discovery over unstructured evidence.
- The REPL provides flexible, derived analysis without making arbitrary host execution the normal data-access path.
- Every derived result remains auditable through evidence, source-range, query, and REPL-invocation lineage.
- Automatic parsing and indexing preserve provenance and raw evidence without changing the immutable captured artifact.
