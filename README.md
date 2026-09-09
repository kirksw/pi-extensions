# pi-extensions

Collection of custom Pi extensions.
The root package is an installation wrapper; each project owns its dependencies and development commands.

## Install

Install the collection from GitHub:

```bash
pi install git:github.com/kirksw/pi-extensions
```

Pi installs the root package's dependencies, whose `postinstall` script runs `npm ci --prefix pi-context-flow` using the project's lockfile.
Do not disable npm lifecycle scripts for this installation.
The GitHub command requires the root package files to be committed and pushed first.

To install from a local checkout, run from the repository root:

```bash
npm ci
pi install .
```

`pi install` registers the package in user-level Pi settings by default.
Use `pi install -l .` for project-local registration instead.
Local installs reference the checkout rather than copying it, and require the explicit dependency installation shown above.
To try the collection without persistent registration after installing dependencies, run `pi -e .`.

## Projects

| Project | Purpose |
| --- | --- |
| [pi-context-flow](pi-context-flow/README.md) | Bounded evidence capture and querying, provenance-backed observations, and explicit promotion candidates. |

`pi-context-flow` can also be installed independently:

```bash
cd pi-context-flow
npm ci
pi install .
```

Dependency installation includes native DuckDB bindings and may require platform-specific build tools if a prebuilt binary is unavailable.
`jq` is required for jq queries; Docker or Podman is required for the sandboxed REPL.
See the project README for behavior, limitations, and development commands.

## Development

See [AGENTS.md](AGENTS.md) for project routing and validation guidance.
There are no root build or test commands; run checks inside the affected project.
When adding another extension, update the root Pi manifest and installation script as well as the project list.
