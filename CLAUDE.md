# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**squash** is a terminal proxy for managing multiple Running with Rifles (`rwr_server`) game-server instances over PTYs — start/stop/restart instances and stream their live terminals to browsers via WebSocket (think MCSManager). Backend is Node.js + TypeScript + Fastify; frontend is React + Vite + Ant Design + xterm.js. The project is early-stage and explicitly unstable.

## Commands

Backend (run from repo root):

```bash
npm install
npm run typecheck                 # tsc --noEmit — the ONLY backend verification command (no test runner configured)
npm run smoke:pty                 # interactive PTY smoke harness (scripts/pty-rwr-smoke.ts)
AUTH_TOKEN=secret npx tsx src/index.ts   # run the server (executed directly via tsx, never compiled)
```

Frontend (run from `frontend/`):

```bash
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build → frontend/dist
npm run lint       # eslint
```

There is **no test framework and no compiled build step** for the backend — `tsx` runs the `.ts` sources directly in dev and in the Docker image. `npm run typecheck` is the only gate; run it after backend changes.

## ESM / import conventions

`tsconfig` is `NodeNext` ESM. **Relative imports must use the `.js` extension even though the files are `.ts`** (e.g. `import { x } from './foo.js'` resolves `foo.ts`). All backend types are `readonly` and the code leans on `strict` mode — match the existing immutability style.

## Architecture

Dependency wiring is explicit and top-down in [src/index.ts](src/index.ts): it constructs the config store + registry, injects them into services, then into the HTTP server and WebSocket gateway. There is no DI container — everything is hand-wired in `main()`.

Layers (request flows downward; PTY output flows back up):

- **`src/core/`** — domain primitives, written as factory functions returning closure-based objects (not classes):
  - `pty/pty-process-adapter.ts` wraps `node-pty` behind the `PtyProcess` interface so the rest of the code never touches `node-pty` directly.
  - `instance/instance-supervisor.ts` is the heart: **one supervisor per instance**, owning a small state machine (`stopped → starting → running → stopping → stopped`, or `→ crashed` on unexpected exit). Transitions are guarded by `assertInstanceState`; `canStart` only from `stopped`/`crashed`, `canStop` only from `starting`/`running`. The supervisor binds PTY `onData`/`onExit`, pushes output through the parser to the log writer, and fans out to registered `dataListeners`.
  - `instance/instance-registry.ts` holds three parallel `Map`s keyed by instance id: `configs`, `runtimes`, `supervisors`. This is the single source of truth shared across services and the WS gateway.
  - `log/output-parser.ts` is a stateful line-buffer (splits on `\r?\n`, retains the trailing partial line until the next chunk); `log/log-writer.ts` appends ISO-timestamped lines to `logs/<id>.log`.
- **`src/services/`** — thin orchestration classes over the registry. `InstanceService` is the only one that mutates persistent state (creates supervisors, saves/deletes configs); `TerminalService` and `LogService` are stateless lookups.
- **`src/api/`** — Fastify. `http/http-server.ts` registers cors, websocket, static-file serving, the auth `preHandler` hook, and routes. `http/routes/instance-routes.ts` is the REST surface; request bodies/params are validated with Zod schemas in `http/schemas/`. `ws/terminal-gateway.ts` manages per-instance sets of WebSocket connections, subscribes each socket to its supervisor's `onData`, and relays `input`/`resize`/`ping` messages back into the supervisor.
- **`src/app/`** — `paths.ts` derives `config/`, `logs/`, and `config/instances.json` paths relative to the repo root; `bootstrap.ts` ensures those dirs exist on startup.

### Terminal data path (key flow to understand)

`rwr_server` stdout → `node-pty` → supervisor `onData` → `output-parser` (line buffering) → `log-writer` (timestamped append) **and** every `dataListener` → `terminal-gateway` broadcasts `{type:'output'}` to all WebSocket clients of that instance. Browser keystrokes travel the reverse path: WS `{type:'input'}` → gateway → `supervisor.sendRawInput` → `pty.write`.

### Auth

When `AUTH_TOKEN` is set, a Fastify `preHandler` hook requires `Authorization: Bearer <token>` on all routes except `/health` and `/terminal*`. WebSocket connections authenticate via a `?token=` query parameter instead (browsers can't set WS headers). Frontend reads `VITE_AUTH_TOKEN`, `VITE_API_URL`, `VITE_WS_URL` from `frontend/.env.local`.

## Current incomplete state (important)

The committed tree does **not** typecheck or run as-is: [src/index.ts](src/index.ts) imports `./core/config/instance-config-store.js` and [src/api/http/http-server.ts](src/api/http/http-server.ts) imports `./auth.js` (`validateBearerToken`, `isAuthEnabled`), but **neither `src/core/config/instance-config-store.ts` nor `src/api/http/auth.ts` exists** in the repo. These modules are referenced throughout (`InstanceConfigStore` is a typed dependency of `InstanceService` and the registry's `loadFromStore`). If you're asked to make the backend run, these two missing modules are the gap to fill — `instance-config-store` is expected to persist `InstanceConfig`s to `config/instances.json` (with `list()`/`save()`/`delete()`), and `auth` provides bearer-token validation. Run `npm run typecheck` to surface the current breakage.

## Platform notes

PTY behavior is validated on Linux only. On macOS, `node-pty`'s `spawn-helper` may lack the execute bit (`posix_spawnp failed`); the README documents the `chmod +x` fix. The Docker image runs `tsx src/index.ts` under `tini` as a non-root `squash` user, with `config/` and `logs/` intended as mounted volumes.
