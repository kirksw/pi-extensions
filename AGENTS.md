# Repository Guide

This repository contains independent Pi extension projects.
Run development commands from the relevant project directory.
The root package is an installation wrapper, not a shared build/test workspace.

## Choose the project

| Task | Location | Start here |
| --- | --- | --- |
| Context capture, evidence inspection/querying, tool-output interception, or sandboxed REPL | `pi-context-flow/` | `pi-context-flow/README.md`, then `pi-context-flow/src/index.ts` |
| Observations, provenance, lifecycle, migration, or promotion candidates | `pi-context-flow/` | `pi-context-flow/README.md`, then `pi-context-flow/src/context-out/` |
| Context Flow architecture or future work | `pi-context-flow/docs/` | `pi-context-flow/docs/adrs/README.md` and `pi-context-flow/docs/ROADMAP.md` |
| Repository-wide navigation or documentation | Repository root | `README.md` and this file |

`pi-context-flow/` is currently the only extension project.
For an unspecified project, use it only when the request clearly concerns Context Flow; otherwise ask which project or new extension is intended.
Keep project-specific changes inside that project unless the task requires a repository-wide change.
When adding a project, update this routing table and the root README, give it its own README and package manifest, and add its entry point and dependency installation to the root manifest.
Read any more-specific `AGENTS.md` before editing within its scope.

## Read before changing behavior

- Read the project's README for implemented behavior, setup, and known limitations.
- Read relevant active ADRs through `pi-context-flow/docs/adrs/README.md` before design or implementation.
- Use `pi-context-flow/docs/CONCEPT.md` for background, not as proof of current behavior.
- Treat roadmap items, research, and implementation plans as context, not approval to implement additional work.
- Preserve existing architectural invariants; obtain explicit approval before changing them.
- Keep Context In evidence separate from Context Out observations and reviewed artifacts.
  Promotion creates candidates, not automatic writes to authoritative documentation.
- Preserve bounded evidence access and the container-only REPL baseline; do not add unsandboxed fallbacks.

## Package setup

`pi-context-flow/package.json` declares the Pi extension entry point as `./src/index.ts`.
The root `package.json` declares that nested entry point and installs the project's dependencies through `npm ci --prefix pi-context-flow` in `postinstall`.
Keep dependencies and development commands owned by the child project; do not migrate to workspaces without approval.
Both packages are private; Git and local installation are supported, not npm publication.
See `README.md` for the Git installation command, which requires these files to be committed and pushed.

From the repository root, install dependencies and register the local package:

```bash
npm ci
pi install .
```

`pi install .` changes user-level Pi settings and references this checkout; run it only when installation is requested.
For a temporary collection run after dependency installation, use `pi -e .` from the repository root.
For standalone project installation, run `npm ci` and `pi install .` inside `pi-context-flow/` instead.
Do not disable npm lifecycle scripts when installing the collection.
`jq` is required for jq queries, and a usable Docker or Podman server is required for REPL integration.

## Validation

Run the narrowest relevant tests while working.
Before finishing changes to `pi-context-flow/`, run from that directory:

```bash
npm run check
npm test
git diff --check
```

For documentation-only changes, inspect the diff, verify referenced paths and commands, and run `git diff --check`.
Report skipped or unavailable integrations separately from passing checks.
Use `npm run benchmark:complex` only when benchmark validation is relevant; inspect its runner and prerequisites first.
Do not manually edit generated fixtures or benchmark artifacts; use their generators or runners when regeneration is required.
Do not modify runtime evidence under `.pi/context/` or user-level observation storage as part of source edits.
