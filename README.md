# squash

> [中文说明](README.zh-CN.md) | English

> [!WARNING]
> **Active Development**: This project is in its early stages and should be considered **unstable**. Features may change or break without notice.

**squash** is a community project under the [rwr-infra](https://github.com/rwr-infra) organization — a terminal proxy tool for Running with Rifles (`rwr_server`) game server multi-instance management, similar to MCSManager.

## Disclaimer

**squash** is a community-driven project under the [rwr-infra](https://github.com/rwr-infra) organization and is **not** affiliated with, authorized, maintained, sponsored, or endorsed by **Osumia Games**.

All **Running With Rifles** related content, assets, and trademarks—including but not limited to the game data parsed by this tool—are the sole property of **Osumia Games**. This utility is provided purely as a community resource to interface with game files provided by the original installation.

## Features

- **PTY-based terminal forwarding** — captures full stdin/stdout of `rwr_server` instances
- **Multi-instance management** — run multiple game server instances with separate working directories
- **Real-time terminal streaming** — WebSocket-based terminal with xterm.js
- **Instance lifecycle management** — start, stop, restart, delete instances
- **Crash auto-restart** — opt-in per instance, with exponential backoff, a max-attempt cap, and a cooldown that resets the counter after stable uptime
- **Windows crash-dialog recovery** — detects the engine's `rwr_crashdump.dmp` and force-kills a process hung behind the "unhandled exception" dialog, so auto-restart still fires
- **Timestamped logging** — per-instance log files with line-buffered output

## Tech Stack

**Backend**: Node.js 24 + TypeScript + Fastify + node-pty + Zod + Pino
**Frontend**: React + Vite + Ant Design + xterm.js + TanStack Query

## Project Structure

```
squash/
├── src/                    # Backend
│   ├── core/pty/          # PTY adapter
│   ├── core/instance/     # Instance supervisor & registry
│   ├── core/log/          # Log writer & output parser
│   ├── services/          # Business logic
│   └── api/               # HTTP + WebSocket endpoints
├── frontend/              # Frontend (React + Vite)
├── scripts/               # Dev scripts (PTY smoke test)
├── config/                # Instance configs (instances.json)
├── Dockerfile             # Container image
└── LICENSE
```

## Getting Started

### Prerequisites

- **Release bundles: nothing.** Each bundle ships its own Node.js runtime — download,
  unzip, run (see [Portable distribution](#portable-distribution-no-nodejs-required)).
- **From source:** [Node.js](https://nodejs.org/en/download) 24. The exact version that CI
  and the bundles use is pinned in [`.node-version`](.node-version).
- Docker — optional, for containerized deployment
- PTY round-trips are smoke-tested in CI on Linux, macOS and Windows with a plain shell; a real `rwr_server` hasn't been validated yet, and macOS has known node-pty quirks (see Known Issues)

### Docker (Recommended)

```bash
# Build image
docker build -t rwr-infra/squash .

# Run container. AUTH_PASSWORD is REQUIRED: the image listens on 0.0.0.0, and the
# server refuses to start on a non-loopback address with the default password.
# Generate a random one and keep the printed value — it's your login password.
SQUASH_PASSWORD="$(openssl rand -hex 16)"; echo "squash password: $SQUASH_PASSWORD"
docker run -d \
  --name squash \
  -p 3000:3000 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD="$SQUASH_PASSWORD" \
  -v squash-data:/app/config \
  -v squash-logs:/app/logs \
  rwr-infra/squash
```

Then open `http://localhost:3000`.

### Docker Environment Variables

Same variables as the [Configuration](#configuration-env) section below
(`PORT`, `HOST`, `LOG_LEVEL`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_TOKEN`, `CORS_ORIGIN`).
In the image `HOST` defaults to `0.0.0.0` (so the container never falls back to loopback —
it refuses to start without a non-default `AUTH_PASSWORD`) and `SQUASH_STATIC_DIR` defaults
to `/app/frontend/dist`. Mount `/app/config` and
`/app/logs` as volumes to persist instance configs and logs.

### Development

```bash
npm install
npm run dev          # tsx watch — runs src/index.ts and reloads on change
```

### Production (compiled)

The server is compiled to plain JavaScript and run with `node` (no `tsx` at runtime):

```bash
npm install
npm run build        # compiles the server to dist/ and the frontend to frontend/dist/
npm start            # node dist/index.js
```

### Configuration (`.env`)

On startup the server automatically loads a `.env` file from the working directory
(via Node's built-in env-file loader — no extra dependency). Copy the template and edit:

```bash
cp .env.example .env
```

Environment variables (all optional; settable via `.env` or the real environment):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | _(auto)_ | Bind address. Unset: `127.0.0.1` while the panel is **weakly protected** (password is the default `admin` in any case, blank, or no auth at all), `0.0.0.0` otherwise. An explicit non-loopback `HOST` (e.g. `0.0.0.0`) while weakly protected makes the server **refuse to start** — set a strong `AUTH_PASSWORD` first. Loopback values (`127.x.x.x`, `localhost`, `::1`) are always allowed. |
| `LOG_LEVEL` | `info` | Pino log level |
| `AUTH_USERNAME` | `admin` | Login username. Login is enabled **by default** with `admin/admin`; change before exposing the server. |
| `AUTH_PASSWORD` | `admin` | Login password. |
| `AUTH_TOKEN` | _(none)_ | Optional static bearer token (accepted alongside login; legacy) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin for the API |
| `SQUASH_STATIC_DIR` | _(next to the app)_ | Frontend static files path (auto-derived; override only if you relocate `frontend/dist`) |

### Authentication

Login is **enabled by default** with the credentials `admin` / `admin`. This is
deliberate: a freshly unpacked instance shouldn't be drivable by the first
person to reach its port. The defaults are well-known weak values, so **change
them before exposing the server** — and as a safety net, while the password is
`admin` (whether left unset or written explicitly, e.g. by copying `.env.example`)
or no authentication is configured at all, the server only listens on loopback:
an unset `HOST` falls back to `127.0.0.1`, and an explicit non-loopback `HOST`
aborts startup with an error (see `HOST`). The boot log prints a warning when the
default password is active.

The login (`POST /api/auth/login`) issues a session token (7-day TTL, kept in
memory — restarting the server invalidates sessions). The frontend stores the
token in `localStorage` and sends it as `Authorization: Bearer <token>` (and as
a `?token=` query param for the terminal WebSocket).

A static `AUTH_TOKEN` is still accepted for backward-compatible/programmatic
use, alongside login.

**Token-only (API/automation):** set `AUTH_PASSWORD=` (empty) to turn
username/password login off and set `AUTH_TOKEN` to a long random value; clients
then send `Authorization: Bearer <token>`. The web UI can't be used this way (it
has no place to enter a token and its login page will reject every attempt), so
keep login enabled if people use the browser. The token's strength isn't checked:
with a non-empty `AUTH_TOKEN` and `HOST` unset the server listens on `0.0.0.0`.
With neither a password nor a token the API is open — the server then refuses any
non-loopback `HOST`.

> **Upgrading from an earlier version:** the server now refuses to start (exit
> code 1, `Refusing to listen on …` in the log) when `HOST` is a non-loopback
> address while the password is still `admin` or no auth is configured. This
> hits a `.env` copied from the old `.env.example` (which set `HOST=0.0.0.0`
> with `admin/admin`) and `docker run` without `AUTH_PASSWORD`. Set a strong
> `AUTH_PASSWORD`, or remove `HOST` to stay local-only. Likewise, with `HOST` unset
> a password of `admin` written explicitly in `.env` (or no auth at all) now means
> `127.0.0.1` only — previously it listened on `0.0.0.0`.

### Audit log

User actions are recorded to `logs/audit.log` (JSONL) and exposed via `GET /api/audit`.
Recorded actions: `login`, `create`, `start`, `stop`, `restart`, `delete`, and `command`
(which captures the command text sent via the terminal's quick-command box). Each entry
has `time`, `user`, `action`, and optional `instanceId` / `detail`. The web UI shows them
in the **Audit log** drawer on the instance list page.

### Portable distribution (no Node.js required)

Each [GitHub Release](https://github.com/rwr-infra/squash/releases) carries one archive
per platform. The archive includes its own pinned Node.js runtime (`runtime/`), so the
target machine needs **no Node.js, npm or build tools**.

| Platform | Archive | Notes |
|----------|---------|-------|
| Windows x64 | `squash-<ver>-win32-x64.zip` | Windows 10/11, Server 2019+ (needs ConPTY); CI tests on Windows Server 2025 |
| Linux x64 | `squash-<ver>-linux-x64.tar.gz` | glibc 2.28+ (e.g. Debian 10+, Ubuntu 20.04+, RHEL 8+); not Alpine/musl |
| macOS Apple silicon | `squash-<ver>-darwin-arm64.tar.gz` | best effort — see Known Issues |

Other targets (linux-arm64, win32-arm64, darwin-x64) have pinned runtimes and can be
built with `npm run package` on that platform, but aren't released or tested in CI.

1. **Verify** the download against `SHA256SUMS.txt` from the same release:
   - Linux: `grep linux-x64 SHA256SUMS.txt | sha256sum -c`
   - macOS: `grep darwin-arm64 SHA256SUMS.txt | shasum -a 256 -c`
   - Windows (PowerShell): `(Get-FileHash .\squash-<ver>-win32-x64.zip).Hash` — compare with
     the matching line (case doesn't matter).
2. **Extract** into a new, empty folder your user can write to — the archive has no
   top-level folder, and `config/` and `logs/` are created inside it (so not
   `C:\Program Files`). Windows: right-click → *Extract All…* into e.g.
   `C:\squash`. Linux/macOS: `mkdir squash && tar -xzf squash-<ver>-<platform>-<arch>.tar.gz -C squash`.
3. **Start** it: on Windows double-click `start.bat` (if startup fails, the window
   pauses so the error can be read); on Linux/macOS run `./start.sh`. Stop it with
   Ctrl+C. With the default `admin/admin` login it listens on `127.0.0.1` only. Open
   `http://localhost:3000`.
4. **To expose it on the network**, create `.env` from the template (`copy .env.example .env`
   on Windows, `cp .env.example .env` elsewhere — Notepad may save it as `.env.txt`),
   set **both** `AUTH_USERNAME` and `AUTH_PASSWORD` to strong values and restart. The
   server listens on `0.0.0.0` only once the password is no longer `admin` (see
   [Authentication](#authentication)); allow the port in the firewall (Windows asks on
   first start). Put it behind a reverse proxy with TLS if it will be reachable beyond a
   trusted LAN.

Startup problems end the process with a non-zero exit code and a log line whose `msg`
says what to do — a port already in use (or reserved by Windows), a folder that isn't
writable, a missing `runtime/` folder. `build-info.json` records the source commit and
the bundled Node.js and node-pty versions for support requests.

**Upgrading:** your data lives in `config/` (instance definitions), `logs/` (instance
and audit logs) and `.env` inside the squash folder. Keep game server files **outside**
the squash folder and give instances absolute `cwd` paths, so they don't depend on it.
Stop the running instances and squash, extract the new version into a **new** folder,
copy those three over from the old folder, then start the new one. Keep the old folder
until the new version runs — rolling back is starting the old one again. (Launchers
before this version forced `PORT=3000`; now `PORT` in `.env` takes effect.)

**Building a bundle yourself** (on the OS/arch it's for — node-pty ships prebuilt
native binaries per platform):

```bash
npm run package          # build server + frontend, bundle for this OS/arch → release/
npm run smoke:release    # extract the archive and test it the way a user runs it
```

- Packaging downloads the Node.js version from `.node-version` and checks it against the
  SHA-256 pinned in [`scripts/node-runtime.sha256`](scripts/node-runtime.sha256)
  (cached in `.cache/node-runtime/`). Behind a proxy set `NODE_USE_ENV_PROXY=1` (with
  `HTTPS_PROXY`), or use a mirror: `SQUASH_NODE_MIRROR=https://npmmirror.com/mirrors/node`
  — the pinned checksums still apply.
- Packaging stops if `frontend/.env*` (or the environment) sets `VITE_API_URL`,
  `VITE_WS_URL` or `VITE_AUTH_TOKEN`, because Vite would bake them into the bundle.
  Move a dev `frontend/.env.local` aside while packaging. (If it sets only
  `VITE_API_URL`, `VITE_API_URL= npm run package` in a POSIX shell also works; an
  empty `VITE_WS_URL` is still rejected because it would break the WebSocket.)
- To move to a newer Node.js, edit `.node-version`, replace the hash lines in
  `scripts/node-runtime.sha256` (its header has the command), then run
  `npm run package && npm run smoke:release`. The Docker image (`node:24-slim`)
  doesn't follow `.node-version`.

### Cross-platform builds (CI)

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds on `ubuntu-latest`,
`macos-latest` and `windows-latest` with the Node.js version from `.node-version`. Each job
runs `npm run package` and then `npm run smoke:release` on its **final archive** (extracted to
a path with spaces and non-ASCII characters, no system Node, started through the launcher):
health, frontend, login, a PTY round-trip, loopback-only default, the weak-password refusal, and
that terminating the launcher stops the server and frees its port. Pushing a `v*` tag publishes a GitHub Release only if every platform passed;
the release gets the archives plus `SHA256SUMS.txt`.

### Frontend (Development)

```bash
cd frontend
npm install

# Point the frontend at the backend (MUST set both — API and WebSocket)
echo "VITE_API_URL=http://localhost:3000" > .env.local
echo "VITE_WS_URL=ws://localhost:3000" >> .env.local

npm run dev
```

Frontend dev server runs at `http://localhost:5173`. When login is enabled you sign in
through the app's login page (no token in `.env.local` needed — it's obtained at login
and stored in `localStorage`). `VITE_AUTH_TOKEN` is still honored as a fallback for
static-token setups.

> In the split dev setup set **both** `VITE_API_URL` and `VITE_WS_URL` to the backend's
> origin. If `VITE_WS_URL` is missing it falls back to the page's own origin (correct for
> production same-origin, but wrong when the dev backend is on a different port).

### Quick Test

```bash
# Health check
curl http://localhost:3000/api/health

# Create a test instance
curl -X POST http://localhost:3000/api/instances \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-1",
    "name": "Test Server",
    "cwd": "/tmp",
    "executable": "sleep",
    "args": ["10"],
    "logDir": "logs"
  }'

# Start it
curl -X POST http://localhost:3000/api/instances/test-1/start

# List instances
curl http://localhost:3000/api/instances
```

> When login is enabled, add `-H "Authorization: Bearer <token>"` (get a token from `POST /api/auth/login`).

## API Endpoints

All backend endpoints are served under the `/api` prefix; every other path is the SPA.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | public | Health check |
| GET | `/api/auth/status` | public | Whether login is required (`{ loginEnabled }`) |
| POST | `/api/auth/login` | public | Log in with `{ username, password }` → `{ token }` |
| GET | `/api/auth/me` | yes | Current user for the supplied token |
| POST | `/api/auth/logout` | yes | Invalidate the current session token |
| GET | `/api/instances` | yes | List all instances |
| POST | `/api/instances` | yes | Create instance |
| GET | `/api/instances/:id` | yes | Get instance details |
| PUT | `/api/instances/:id` | yes | Update instance config (must be stopped/crashed) |
| DELETE | `/api/instances/:id` | yes | Delete instance |
| POST | `/api/instances/:id/start` | yes | Start instance |
| POST | `/api/instances/:id/stop` | yes | Stop instance |
| POST | `/api/instances/:id/restart` | yes | Restart instance |
| POST | `/api/instances/:id/command` | yes | Send a command to the instance's stdin |
| GET | `/api/instances/:id/logs/tail` | yes | Tail instance logs |
| GET | `/api/audit` | yes | Recent audit-log entries (`?limit=`) |

"Auth: yes" endpoints require `Authorization: Bearer <token>` when login (or `AUTH_TOKEN`) is configured.

### Sending commands

`POST /instances/:id/command` forwards a command to the running instance's stdin
(the same channel as the interactive terminal). Useful for issuing in-game console
commands such as `status` programmatically.

```bash
# Fire-and-forget (a trailing \r is appended by default)
curl -X POST http://localhost:3000/api/instances/test-1/command \
  -H "Content-Type: application/json" \
  -d '{ "command": "status" }'

# Capture output produced within a time window (ms) and return it
curl -X POST http://localhost:3000/api/instances/test-1/command \
  -H "Content-Type: application/json" \
  -d '{ "command": "status", "captureMs": 1500 }'
```

| Field | Default | Description |
|-------|---------|-------------|
| `command` | _(required)_ | The command string |
| `appendNewline` | `true` | Append `\r` (set `false` to write raw bytes) |
| `captureMs` | _(none)_ | If > 0, collect stdout for this many ms (max 10000) and return it as `data.output`; otherwise returns `data.accepted: true` |

> Note: the PTY is a single output stream, so captured output may include
> unrelated periodic logging and is not a strict request/response. It is
> intended for fast-echoing console commands like `status`.

WebSocket (terminal stream): `ws://localhost:3000/api/terminal/:instanceId?token=<token>`

## Windows deployment

When `rwr_server.exe` crashes on Windows, the RWR engine's own crash handler
writes a dump (`rwr_crashdump.dmp`) and pops a modal **"An unhandled exception
occurred!"** dialog (a `bad allocation` variant shows on out-of-memory). The
process then **hangs** in that dialog's message loop — it never exits on its
own, so `onExit` never fires and ordinary auto-restart cannot trigger. Note this
is *not* a Windows Error Reporting (WER) dialog: the engine catches the exception
before WER ever sees it, so suppressing WER does nothing here.

For instances with `autoRestart` enabled, squash runs a watchdog that detects
the crash dump: the engine writes `rwr_crashdump.dmp` next to the server (in the
instance's working directory) at crash time, so when a dump newer than the
current run appears, squash force-kills the hung process tree (`taskkill /T /F`,
which terminates a process even while it's stuck in a `MessageBox`) and then
auto-restarts it.

You can also always recover manually by clicking **Restart** in the UI — it
force-kills the hung process the same way, regardless of dialog type.

## Auto-restart

Set `autoRestart: true` (and optionally `restartDelayMs`, default `3000`) when
creating an instance. On an unexpected exit (`crashed`), squash restarts it with
exponential backoff (`restartDelayMs * 2^n`, capped at 60s), up to 5 consecutive
attempts; the instance then stays `crashed`. Once an instance runs cleanly for
60s, the attempt counter resets. Manual stop/restart always clears the counter.

## Known Issues

- **macOS `posix_spawnp failed`**: node-pty spawn-helper binary may lack execute bit on macOS. Fix: `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` (in a source checkout using pnpm: `node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`). Linux is unaffected.
- **macOS: a bundle downloaded with a browser may fail to load its native modules** —
  Gatekeeper can quarantine the ad-hoc-signed `pty.node` / `spawn-helper`. Clear the flag on
  the unpacked folder: `xattr -dr com.apple.quarantine <squash-folder>`.
- **Stopping an instance can be recorded as a crash**: if the server prints output while it is
  shutting down, the stop may be reported as `crashed` and — since `autoRestart` defaults to
  on — restarted. Tracked for a fix.
- **Bundles are not code-signed**: Windows SmartScreen may warn on first launch of `start.bat`.
- **Real `rwr_server` runtime validation** has not been performed on an actual game server binary yet.

## Roadmap

- [ ] Real game server runtime validation (Linux)
- [x] Auto-restart strategy on crash
- [ ] Health probing via `status` output parsing
- [ ] Log rotation
- [ ] SQLite config storage (planned)

## License

MIT License. See [LICENSE](LICENSE) for details.
