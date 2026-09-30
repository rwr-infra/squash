# ADR 0001: Ship portable bundles with a pinned Node.js runtime

- Status: Accepted
- Date: 2026-09-29

## Context

Deploying squash required Node.js 24 on the target machine, which was the main barrier
for Windows desktop operators. Options considered for removing it:

1. Portable archive per OS/arch that carries the official Node.js runtime in `runtime/`.
2. Single-file executable via `@yao-pkg/pkg` (prototyped on branch `feature/pkg`, 4d3be41).
3. Node.js Single Executable Applications (SEA).
4. Rewriting the backend in Go.

## Decision

Option 1. Each release archive contains `runtime/node(.exe)` extracted from the official
Node.js archive whose version is pinned in `.node-version` and whose SHA-256 is pinned in
`scripts/node-runtime.sha256`. Launchers (`start.bat` / `start.sh`) run only that runtime.
CI builds on every target OS with the same version and smoke-tests the final archive
before a release can be published.

## Consequences

- Users unzip and run; no Node, npm or build tools. The bundle stays a multi-file
  directory (~50 MB compressed) and `config/`, `logs/`, `.env` live inside it.
- The application code runs unmodified (`node dist/index.js`); no bundler, no patched
  dependencies, no extraction of assets to temp dirs.
- Bumping Node means editing `.node-version` and `scripts/node-runtime.sha256` together.
- node-pty ships N-API prebuilds for all six platform/arch pairs, so the runtime and
  node-pty don't have to match an ABI; packaging still runs per OS in CI.

## Rejected

- **pkg single file** — needs esbuild bundling to CJS, a `patch-package` patch so
  node-pty's `spawn-helper` runs from the snapshot, and copying the frontend out of the
  read-only snapshot at startup; Node version tied to pkg-fetch builds. Kept on
  `feature/pkg` as a reference, not merged.
- **SEA** — still evolving in Node 24; embedding and module loading limits, and node-pty
  native files plus frontend assets would need the same special handling as pkg.
- **Go rewrite** — reimplements PTY/ConPTY, process supervision, Windows crash recovery
  and the API; high regression risk.

Revisit only with deployment data: repeated Node/node-pty install failures across
releases, a hard single-file requirement, and a stable API/terminal contract with
cross-implementation regression tests (including a validated real `rwr_server`).
