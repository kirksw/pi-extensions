# Architecture Decision Records

These records define the active Context Flow architecture decisions.
Each ADR uses [Open Knowledge Format (OKF)](https://github.com/melandlabs/opencontext/tree/main/packages/okf) YAML frontmatter.
The `status` field expresses its lifecycle.

| Status | Meaning |
| --- | --- |
| `draft` | Proposed; not yet adopted. |
| `active` | Adopted and currently applicable. |
| `superseded` | Replaced by a later ADR; retain it for history and set `superseded_by`. |
| `deprecated` | Retained for reference but should not guide new work. |

| ADR | Decision | Status |
| --- | --- | --- |
| [000](000-context-flow-boundaries.md) | Separate Context In and Context Out. | active |
| [001](001-context-in-is-an-invalidatable-worktree-cache.md) | Treat Context In as an invalidatable session/worktree cache. | active |
| [002](002-context-out-uses-append-only-observation-events.md) | Use append-only event ledgers for Context Out. | active |
| [003](003-promotion-is-a-semantic-review-gate.md) | Use semantic review for promotion. | active |
| [004](004-consolidation-creates-reviewable-promotion-candidates.md) | Consolidate observations into reviewable promotion candidates. | active |
| [005](005-evidence-references-expose-bounded-analysis-capabilities.md) | Replace large outputs with queryable evidence references and use a read-only REPL only as a fallback. | active |
