# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**squash** is a terminal proxy for managing multiple Running with Rifles (`rwr_server`) game-server instances over PTYs — start/stop/restart instances and stream their live terminals to browsers via WebSocket (think MCSManager). Backend is Node.js + TypeScript + Fastify; frontend is React + Vite + Ant Design + xterm.js. The project is early-stage and explicitly unstable.

## Commands

Backend (run from repo root):

```bash
npm install
npm run typecheck      # tsc --noEmit — backend type gate (no unit test runner)
npm run dev            # tsx watch src/index.ts
npm run build          # tsc → dist/, plus the frontend build
npm run package        # portable bundle for this OS/arch → release/ (downloads the pinned Node; needs network)
npm run smoke:release  # extract that archive, run it via its launcher without system Node, check API/PTY/bind gate
npm run smoke:pty      # interactive PTY smoke harness (scripts/pty-rwr-smoke.ts)
npm run smoke:supervisor  # supervisor state-machine smoke (fake node child through node-pty)
```

Frontend (run from `frontend/`):

```bash
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build → frontend/dist
npm run lint       # eslint
```

There is **no unit test framework**. The backend is compiled with `tsc` to `dist/`; `npm start`, the Docker image and the portable bundles all run `node dist/index.js` (`tsx` is dev-only). Run `npm run typecheck` after backend changes, `npm run smoke:supervisor` after changes to supervisor status/restart logic, and `npm run package && npm run smoke:release` after changes to packaging, launchers, startup, or auth/bind logic.

## ESM / import conventions

`tsconfig` is `NodeNext` ESM. **Relative imports must use the `.js` extension even though the files are `.ts`** (e.g. `import { x } from './foo.js'` resolves `foo.ts`). All backend types are `readonly` and the code leans on `strict` mode — match the existing immutability style.

## Architecture

Dependency wiring is explicit and top-down in [src/index.ts](src/index.ts): it constructs the config store + registry, injects them into services, then into the HTTP server and WebSocket gateway. There is no DI container — everything is hand-wired in `main()`.

Layers (request flows downward; PTY output flows back up):

- **`src/core/`** — domain primitives, written as factory functions returning closure-based objects (not classes):
  - `pty/pty-process-adapter.ts` wraps `node-pty` behind the `PtyProcess` interface so the rest of the code never touches `node-pty` directly.
  - `instance/instance-supervisor.ts` is the heart: **one supervisor per instance**, owning a small state machine (`stopped → starting → running → stopping → stopped`, or `→ crashed` on unexpected exit). Transitions are guarded by `assertInstanceState`; `canStart` only from `stopped`/`crashed`, `canStop` only from `starting`/`running`. The supervisor binds PTY `onData`/`onExit`, pushes output through the parser to the log writer, and fans out to registered `dataListeners`. Only the lifecycle calls (`start`/`stop`/`restart`/`dispose`), spawn-failure rollback and `onExit` may change `status`; output and watchdog callbacks must not (a stray `running` write in `onData` once turned user stops into crash-restarts).
  - `instance/instance-registry.ts` holds three parallel `Map`s keyed by instance id: `configs`, `runtimes`, `supervisors`. This is the single source of truth shared across services and the WS gateway.
  - `log/output-parser.ts` is a stateful line-buffer (splits on `\r?\n`, retains the trailing partial line until the next chunk); `log/log-writer.ts` appends ISO-timestamped lines to `logs/<id>.log`.
- **`src/services/`** — thin orchestration classes over the registry. `InstanceService` is the only one that mutates persistent state (creates supervisors, saves/deletes configs); `TerminalService` and `LogService` are stateless lookups.
- **`src/api/`** — Fastify. `http/http-server.ts` registers cors, websocket, static-file serving, the auth `preHandler` hook, and routes. `http/routes/instance-routes.ts` is the REST surface; request bodies/params are validated with Zod schemas in `http/schemas/`. `ws/terminal-gateway.ts` manages per-instance sets of WebSocket connections, subscribes each socket to its supervisor's `onData`, and relays `input`/`resize`/`ping` messages back into the supervisor.
- **`src/app/`** — `paths.ts` derives `config/`, `logs/`, and `config/instances.json` paths relative to the repo root; `bootstrap.ts` ensures those dirs exist on startup.

### Terminal data path (key flow to understand)

`rwr_server` stdout → `node-pty` → supervisor `onData` → `output-parser` (line buffering) → `log-writer` (timestamped append) **and** every `dataListener` → `terminal-gateway` broadcasts `{type:'output'}` to all WebSocket clients of that instance. Browser keystrokes travel the reverse path: WS `{type:'input'}` → gateway → `supervisor.sendRawInput` → `pty.write`.

### Auth

Login is on by default (`admin`/`admin`, overridable via `AUTH_USERNAME`/`AUTH_PASSWORD`; `AUTH_TOKEN` is an optional static bearer token). All endpoints live under `/api`; a Fastify `preHandler` requires `Authorization: Bearer <token>` except for `/api/health`, `/api/auth/login|status` and `/api/terminal*`, which authenticates via a `?token=` query parameter (browsers can't set WS headers). Frontend dev overrides (`VITE_API_URL`, `VITE_WS_URL`, `VITE_AUTH_TOKEN`) live in `frontend/.env.local`.

**Non-negotiable:** while weakly protected — password `admin` (case/whitespace-insensitive) or blank, or no auth at all (`isWeaklyProtected` in `src/api/http/auth.ts`) — the server must never listen on a non-loopback address: unset `HOST` falls back to `127.0.0.1`, an explicit non-loopback `HOST` aborts startup. The listen address is decided only by `resolveBindHost` in `src/app/bind-host.ts`; any new auth mechanism must update `isWeaklyProtected`.

## Platform notes

PTY round-trips are smoke-tested in CI on Linux, macOS and Windows (plain shell); a real `rwr_server` has not been validated. On macOS, `node-pty`'s `spawn-helper` may lack the execute bit (`posix_spawnp failed`); the README documents the `chmod +x` fix. The Docker image runs `node dist/index.js` under `tini` as a non-root `squash` user, with `config/` and `logs/` intended as mounted volumes.

## Release bundles

Portable archives carry their own Node runtime (`runtime/`) — see [docs/adr/0001](docs/adr/0001-portable-bundle-with-pinned-node-runtime.md).

- The bundled runtime comes **only** from the official archive pinned by `.node-version` + `scripts/node-runtime.sha256` (`scripts/node-runtime.mjs`); never copy the build machine's `node`. Bump both files together (CI's setup-node reads `.node-version`).
- Packaging refuses `VITE_API_URL` / `VITE_WS_URL` / `VITE_AUTH_TOKEN` from `frontend/.env*` because Vite bakes them into the bundle — move a dev `frontend/.env.local` aside before `npm run package`.
- Windows: call tar via `tarCommand()` (System32 bsdtar, not Git's GNU tar) and pass non-ASCII target dirs as `cwd`, not `-C` (bsdtar mangles non-ASCII argv).
- Launchers are generated in `scripts/package.mjs`: `start.bat` captures `%~dp0` once up front, uses `pushd`, never expands paths inside parenthesized blocks, and is written with CRLF; `start.sh` must `exec` the bundled node so signals reach the server.
