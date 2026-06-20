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

- Node.js >= 24 (the only runtime requirement; works on Linux, macOS, and Windows)
- Docker — optional, for containerized deployment
- PTY behavior is validated on Linux; macOS has known node-pty permission quirks (see Known Issues)

### Docker (Recommended)

```bash
# Build image
docker build -t rwr-infra/squash .

# Run container (login is enabled by default; CHANGE the password before
# exposing the port — the defaults admin/admin are well-known)
docker run -d \
  --name squash \
  -p 3000:3000 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD=change-me \
  -v squash-data:/app/config \
  -v squash-logs:/app/logs \
  rwr-infra/squash
```

Then open `http://localhost:3000`.

### Docker Environment Variables

Same variables as the [Configuration](#configuration-env) section below
(`PORT`, `HOST`, `LOG_LEVEL`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_TOKEN`, `CORS_ORIGIN`).
In the image `SQUASH_STATIC_DIR` defaults to `/app/frontend/dist`. Mount `/app/config` and
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
| `HOST` | `0.0.0.0` | Bind address. **When the default credentials are in use, this falls back to `127.0.0.1`** so a freshly unpacked instance can't be reached from the network — set real credentials to expose it. |
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
them before exposing the server** — and as a safety net, while the defaults are
in effect the server binds to `127.0.0.1` only (see `HOST`), so it can't be
reached from the network at all. The boot log prints a warning when the default
credentials are active.

The login (`POST /api/auth/login`) issues a session token (7-day TTL, kept in
memory — restarting the server invalidates sessions). The frontend stores the
token in `localStorage` and sends it as `Authorization: Bearer <token>` (and as
a `?token=` query param for the terminal WebSocket).

A static `AUTH_TOKEN` is still accepted for backward-compatible/programmatic
use, alongside login.

### Audit log

User actions are recorded to `logs/audit.log` (JSONL) and exposed via `GET /api/audit`.
Recorded actions: `login`, `create`, `start`, `stop`, `restart`, `delete`, and `command`
(which captures the command text sent via the terminal's quick-command box). Each entry
has `time`, `user`, `action`, and optional `instanceId` / `detail`. The web UI shows them
in the **Audit log** drawer on the instance list page.

### Portable distribution (Windows without Docker)

`npm run package` produces a self-contained bundle for the **current OS/arch** under
`release/` (a `.zip` on Windows, `.tar.gz` elsewhere) containing the compiled server,
the built frontend, production `node_modules`, `start.bat` / `start.sh` launchers,
a `.env.example` template (the real `.env`, if you create one, is never bundled),
and both `README.md` / `README.zh-CN.md`.

```bash
npm run package
```

On the target machine (which only needs **Node.js >= 24** installed — no build tools):

1. Unzip the bundle.
2. Launch it: on Windows double-click `start.bat` (or run it in a terminal); on
   Linux/macOS run `./start.sh`. It works out of the box with the default
   `admin/admin` login (bound to `127.0.0.1`, so only reachable locally). Open
   `http://localhost:3000`.
3. To expose it on the network: copy `.env.example` to `.env` (or edit the
   launcher) and set **both** `AUTH_USERNAME` and `AUTH_PASSWORD` to strong
   values — the server binds to `0.0.0.0` only once real credentials are set.

`config/` (instance definitions) and `logs/` (per-instance logs) are created
next to the bundle on first run.

> Because `node-pty` is a native module, a bundle must be produced **on the same OS/arch**
> it will run on. Build it on a Windows machine (or use the CI matrix below) for a Windows
> distribution.

### Cross-platform builds (CI)

[`.github/workflows/release.yml`](.github/workflows/release.yml) runs `npm run package` on a
matrix of `ubuntu-latest`, `macos-latest`, and `windows-latest`, uploading each bundle as a
build artifact. Pushing a `v*` tag additionally publishes them to a GitHub Release.

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

- **macOS `posix_spawnp failed`**: node-pty spawn-helper binary may lack execute bit on macOS. Fix: `chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`. Linux is unaffected.
- **Real `rwr_server` runtime validation** has not been performed on an actual game server binary yet.

## Roadmap

- [ ] Real game server runtime validation (Linux)
- [x] Auto-restart strategy on crash
- [ ] Health probing via `status` output parsing
- [ ] Log rotation
- [ ] SQLite config storage (planned)

## License

MIT License. See [LICENSE](LICENSE) for details.
