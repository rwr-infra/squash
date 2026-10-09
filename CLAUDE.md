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
npm run smoke:release  # extract that archive, run it via its launcher without system Node, check API/PTY/bind gate and graceful shutdown (no orphaned instance, exit 0)
npm run smoke:pty      # interactive PTY smoke harness (scripts/pty-rwr-smoke.ts)
npm run smoke:supervisor  # supervisor state-machine smoke (fake node child through node-pty)
npm run smoke:auth     # /api auth regression: route inventory, path spellings, absolute-form, WS upgrades (in CI)
```

Frontend (run from `frontend/`):

```bash
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build → frontend/dist
npm run lint       # eslint
```

There is **no unit test framework**. The backend is compiled with `tsc` to `dist/`; `npm start`, the Docker image and the portable bundles all run `node dist/index.js` (`tsx` is dev-only). Run `npm run typecheck` after backend changes, `npm run smoke:auth` after touching auth or adding/changing `/api` routes, `npm run smoke:supervisor` after changes to supervisor status/stop/restart logic, and `npm run package && npm run smoke:release` after changes to packaging, launchers, startup, shutdown/signal handling, or auth/bind logic. For an end-to-end UI check without the split dev setup, run `npm --prefix frontend run build` and let `npm run dev` serve `frontend/dist` from the backend port (same-origin WS — the Vite dev server has no WS proxy).

## ESM / import conventions

`tsconfig` is `NodeNext` ESM. **Relative imports must use the `.js` extension even though the files are `.ts`** (e.g. `import { x } from './foo.js'` resolves `foo.ts`). All backend types are `readonly` and the code leans on `strict` mode — match the existing immutability style.

## Architecture

Dependency wiring is explicit and top-down in [src/index.ts](src/index.ts): it constructs the config store + registry, injects them into services, then into the HTTP server and WebSocket gateway. There is no DI container — everything is hand-wired in `main()`.

Layers (request flows downward; PTY output flows back up):

- **`src/core/`** — domain primitives, written as factory functions returning closure-based objects (not classes):
  - `pty/pty-process-adapter.ts` wraps `node-pty` behind the `PtyProcess` interface so the rest of the code never touches `node-pty` directly.
  - `instance/instance-supervisor.ts` is the heart: **one supervisor per instance**, owning a small state machine (`stopped → starting → running → stopping → stopped`, or `→ crashed` on unexpected exit). Transitions are guarded by `assertInstanceState`; `canStart` only from `stopped`/`crashed`, `canStop` from `starting`/`running`/`stopping` — while `stopping`, `stop()` is a no-op unless `{ force: true }` (the UI's confirmed Force stop). Every stop — `stop`, `restart`, `dispose`, squash's shutdown — goes through `beginStop`: the instance's `stopCommand` lines (1s apart; a blank line after the first sends a bare Enter) or the platform's graceful kill (SIGHUP; `taskkill /T /F` on Windows), then a force-kill of the process group after `stopTimeoutMs`. `restart()` starts the new process only after the old one's `onExit`, and any stop/dispose meanwhile cancels it; `dispose()` is terminal (the supervisor never spawns again) and resolves once the process is gone. The supervisor binds PTY `onData`/`onExit`, pushes output through the parser to the log writer, and fans out to registered `dataListeners`. Only the lifecycle calls (`start`/`stop`/`restart`/`dispose`), spawn-failure rollback and `onExit` may change `status`; output and watchdog callbacks must not (a stray `running` write in `onData` once turned user stops into crash-restarts).
  - `instance/instance-registry.ts` holds two `Map`s keyed by instance id, `configs` and `supervisors`; runtimes are read live from each supervisor (`getRuntime()`), never cached. This is the single source of truth shared across services and the WS gateway.
  - `log/output-parser.ts` is a stateful line-buffer (splits on `\r?\n`, retains the trailing partial line until the next chunk); `log/log-writer.ts` appends ISO-timestamped lines to `logs/<id>.log`.
- **`src/services/`** — thin orchestration classes over the registry. `InstanceService` is the only one that mutates persistent state (creates supervisors, saves/deletes configs); `TerminalService` and `LogService` are stateless lookups.
- **`src/api/`** — Fastify. `http/http-server.ts` registers cors, websocket, static-file serving, the auth `preHandler` hook, and routes. `http/routes/instance-routes.ts` is the REST surface; request bodies/params are validated with Zod schemas in `http/schemas/`. `ws/terminal-gateway.ts` manages per-instance sets of WebSocket connections, subscribes each socket to its supervisor's `onData`, and relays `input`/`resize`/`ping` messages back into the supervisor.
- **`src/index.ts` shutdown** — on SIGINT/SIGTERM/SIGHUP (+SIGBREAK on Windows) it disposes every supervisor and closes the HTTP server in parallel, force-kills stragglers before the budget (longest `stopTimeoutMs` + 2s) runs out, and always exits 0 — `start.bat` treats any other code as a failure. Repeats within 1s are the same request (a closed terminal or npm's Ctrl+C delivers two). Its pino logger writes through an explicit `pino.destination` that drops output after the first write error: once the terminal is closed every write fails with EIO, and the default destination's exit-time `flushSync` retries forever, hanging squash — don't switch back.
- **frontend** — the instance modal reuses a page-level `Form.useForm()` instance whose store outlives the modal content and, on remount, wins over new `initialValues` (editing B after A showed and saved A's values). `ResetFormOnMount` resets it and must stay the `<Form>`'s last child.
- **`src/app/`** — `paths.ts` derives `config/`, `logs/`, and `config/instances.json` paths relative to the repo root; `bootstrap.ts` ensures those dirs exist on startup.

### Terminal data path (key flow to understand)

`rwr_server` stdout → `node-pty` → supervisor `onData` → `output-parser` (line buffering) → `log-writer` (timestamped append) **and** every `dataListener` → `terminal-gateway` broadcasts `{type:'output'}` to all WebSocket clients of that instance. Browser keystrokes travel the reverse path: WS `{type:'input'}` → gateway → `supervisor.sendRawInput` → `pty.write`. Terminal size takes the same route: the page sends `{type:'resize'}` on every (re)connect, every `running` push and every xterm resize; the gateway drops values that are not integers in 1–1000, and the supervisor remembers the last size (also while stopped) and spawns every process with it.

### Auth

Login is on by default (`admin`/`admin`, overridable via `AUTH_USERNAME`/`AUTH_PASSWORD`; `AUTH_TOKEN` is an optional static bearer token). All endpoints live under `/api`. The auth `preHandler` is registered inside the `/api` plugin and requires `Authorization: Bearer <token>` for every route there unless the route's own options set `config: { public: true }` (today `GET /api/health`, `GET /api/auth/status`, `POST /api/auth/login`, and the terminal WebSocket `/api/terminal/:instanceId`, which checks a `?token=` query parameter itself — browsers can't set WS headers). **Never decide auth from the raw `request.url`**: the router decodes `%xx` escapes and accepts absolute-form request lines, so a URL-string check can be bypassed (it was, until 2026-10-09). A new `/api` route must be added to the protected list in `scripts/smoke-auth.ts` or marked public on purpose — `smoke:auth` (in CI) fails otherwise. Frontend dev overrides (`VITE_API_URL`, `VITE_WS_URL`, `VITE_AUTH_TOKEN`) live in `frontend/.env.local`.

**Non-negotiable:** while weakly protected — password `admin` (case/whitespace-insensitive) or blank, or no auth at all (`isWeaklyProtected` in `src/api/http/auth.ts`) — the server must never listen on a non-loopback address: unset `HOST` falls back to `127.0.0.1`, an explicit non-loopback `HOST` aborts startup. The listen address is decided only by `resolveBindHost` in `src/app/bind-host.ts`; any new auth mechanism must update `isWeaklyProtected`.

## Platform notes

CI (`release.yml`, every push) runs typecheck, `smoke:auth`, `smoke:supervisor`, package, `smoke:restart-policy` and `smoke:release` on Linux, macOS and Windows; a real `rwr_server` has been validated by hand on Windows Server only, not on Linux. `rwr_server` answers `quit` with `Exit requested` and exits only on one more Enter, so its stopCommand is `quit` plus an empty line. On Windows both kill modes are `taskkill /T /F`, so without a stopCommand a stop produces no shutdown output — the smoke's stopCommand cases are what exercise output while `stopping` there; under ConPTY a node child reads each written `<cmd>\r` as `<cmd>\r\n`. Under ConPTY a node child never gets stdout `'resize'`, and `process.stdout.getWindowSize()` only returns the size cached by that event — a smoke child that must observe its size reads `process.stdout._handle.getWindowSize()`. On macOS, `node-pty`'s `spawn-helper` may lack the execute bit (`posix_spawnp failed`); the README documents the `chmod +x` fix. The Docker image runs `node dist/index.js` under `tini` as a non-root `squash` user, with `config/` and `logs/` intended as mounted volumes; `docker stop` needs a grace period above the longest `stopTimeoutMs` + 2s (`--stop-timeout 20` for the default).

## Release bundles

Portable archives carry their own Node runtime (`runtime/`) — see [docs/adr/0001](docs/adr/0001-portable-bundle-with-pinned-node-runtime.md).

- The bundled runtime comes **only** from the official archive pinned by `.node-version` + `scripts/node-runtime.sha256` (`scripts/node-runtime.mjs`); never copy the build machine's `node`. Bump both files together (CI's setup-node reads `.node-version`).
- Packaging refuses `VITE_API_URL` / `VITE_WS_URL` / `VITE_AUTH_TOKEN` from `frontend/.env*` because Vite bakes them into the bundle — move a dev `frontend/.env.local` aside before `npm run package`.
- Windows: call tar via `tarCommand()` (System32 bsdtar, not Git's GNU tar) and pass non-ASCII target dirs as `cwd`, not `-C` (bsdtar mangles non-ASCII argv).
- Launchers are generated in `scripts/package.mjs`: `start.bat` captures `%~dp0` once up front, uses `pushd`, never expands paths inside parenthesized blocks, and is written with CRLF; `start.sh` must `exec` the bundled node so signals reach the server.
