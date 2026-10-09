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
- **rwr_server.log viewer** — browse an instance's `rwr_server.log` in the browser, however large: virtual scrolling, follows new lines, Ctrl+F search over the whole file (see [rwr_server.log viewer](#rwr_serverlog-viewer))
- **Instance templates** — save common settings (executable, stop command, restart policy, …) as templates and prefill the create form from one; RWR and SteamCMD templates are included (see [Instance templates](#instance-templates))
- **Bounded, graceful stops** — a per-instance console stop command (e.g. `quit`), a force-kill after a stop timeout, restarts that wait for the old process, and squash stopping every instance before it exits (see [Stopping](#stopping))
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
├── config/                # Instance configs and templates (instances.json, templates.json)
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
- PTY round-trips are smoke-tested in CI on Linux, macOS and Windows with a plain shell; a real `rwr_server` has been run by hand on Windows Server but not yet on Linux, and macOS has known node-pty quirks (see Known Issues)

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
  --stop-timeout 20 \
  -p 3000:3000 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD="$SQUASH_PASSWORD" \
  -v squash-data:/app/config \
  -v squash-logs:/app/logs \
  rwr-infra/squash
```

Then open `http://localhost:3000`.

`--stop-timeout 20` matters: on `docker stop` squash first stops its instances, which
takes up to the longest instance stop timeout (default 15s) plus 2s, and Docker's default
grace period is only 10s before it kills everything. With Compose use
`stop_grace_period: 20s`; raise both if you configure longer stop timeouts (see
[Stopping](#stopping)).

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

### Instance templates

A template holds any of the instance form's settings except the Instance ID — all
optional. In **Create Instance**, pick one under *Prefill from a template*: the fields it
sets are filled in, every other field goes back to its default, and the Instance ID you
typed stays. **Save as template** in the create or edit dialog saves the dialog's current
settings as a new template (a Name that is just the Instance ID is left out), and the
**Templates** drawer on the instance list creates, edits and deletes templates, or opens
Create Instance from one. Clearing the choice in *Prefill from a template* resets those
fields to the defaults.

Applying a template copies its values: changing or deleting a template later leaves the
instances created from it alone. Template names are unique, ignoring case.

Templates live in `config/templates.json`. On first launch (no such file yet) squash
writes two: **RWR dedicated server** (`./rwr_server`, stop command `quit` plus an empty
line, keep running) and **SteamCMD** (`./steamcmd`, stop command `quit`, no restart).
Delete them like any other template and they do not come back. squash
refuses to start if the file is not valid (bad JSON, not a list of `{ id, name, values }`,
a repeated id) and leaves it untouched — fix or delete it.

### rwr_server.log viewer

`rwr_server` writes its own log, `rwr_server.log`, in its working directory and empties
it every time it starts. The file-icon button on an instance (and **Log** on the
terminal page) opens it at `/server-log/<instance-id>`:

- **Any size.** The server indexes the file by line and the page fetches only the
  lines in view, so logs of millions of lines scroll smoothly. Lines longer than
  16 KiB are cut and marked.
- **Follows new lines** while you are at the end (checked every 2 seconds); scroll up
  and it stays put. The **Follow** switch and **End** button bring it back.
- **Ctrl+F** (**⌘F** on macOS) or the search button opens a find bar that searches the
  whole file on the server (the browser's own find only sees the rows on screen): plain
  text, case-insensitive unless **Aa** is on. **Search** (or Enter) finds the first match
  from where you are; then Enter / F3 / ↓ go to the next match,
  Shift+Enter / Shift+F3 to the previous one, Esc closes. Only the first 10,000 matches
  are listed ("10,000+"): past them the bar says so — make the search more specific.
  When new lines arrive, **Search again** includes them. A match beyond the first
  16 KiB of a cut line is found, but the cut part is not shown.
- When `rwr_server` starts again and empties the file, the page says so and shows
  the new file. A missing file (the server has not run yet) is shown as such.

The path is always `<working directory>/rwr_server.log`; the viewer only reads it.

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
   Ctrl+C or by closing the window: squash first stops every running instance (see
   [Stopping](#stopping)). With the default `admin/admin` login it listens on `127.0.0.1` only. Open
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

**Upgrading:** your data lives in `config/` (instance definitions and templates), `logs/` (instance
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
| POST | `/api/instances/:id/stop` | yes | Stop instance; optional body `{"force": true}` kills an instance that is already `stopping` (see [Stopping](#stopping)) |
| POST | `/api/instances/:id/restart` | yes | Restart instance: waits for the old process to exit, then starts it again |
| POST | `/api/instances/:id/command` | yes | Send a command to the instance's stdin |
| GET | `/api/instances/:id/logs/tail` | yes | Tail instance logs |
| GET | `/api/audit` | yes | Recent audit-log entries (`?limit=`) |
| GET | `/api/templates` | yes | List instance templates |
| POST | `/api/templates` | yes | Create a template: `{ name, values }` (409 if the name is taken, ignoring case) |
| PUT | `/api/templates/:id` | yes | Replace a template: `{ name, values }` (409 if renamed to a taken name, 404 if unknown) |
| DELETE | `/api/templates/:id` | yes | Delete a template (404 if unknown) |
| GET | `/api/instances/:id/server-log` | yes | The instance's `rwr_server.log`: `{ exists, size, lineCount, generation, modifiedAt, path }` (`generation` changes when the file is emptied or replaced) |
| GET | `/api/instances/:id/server-log/lines` | yes | Lines `?from=` (0-based) `&count=` (1–1000, default 200), with the same snapshot fields |
| GET | `/api/instances/:id/server-log/search` | yes | Matching line numbers for `?q=` (1–256 characters, no line breaks) `&caseSensitive=true\|false`; at most 10,000 (`truncated` when there are more) |

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

You can also always recover manually, regardless of dialog type: **Stop** or
**Restart** ends the hung process with the same `taskkill /T /F` — at once for an
instance without a stop command, after its stop timeout otherwise — and **Force stop**
(Stop while the instance is `stopping`) does so immediately.

## Stopping

A stop — the **Stop** button, a **Restart**, or squash
itself shutting down — always ends with the process gone and the instance `stopped`:

1. squash asks the server to exit: it types the instance's **stop command** into the
   console, or, without one, uses the platform default — SIGHUP on Linux/macOS, an
   immediate `taskkill /T /F` on Windows (there is no gentler signal there).
2. If the process is still running after the **stop timeout**, squash force-kills it and
   everything it started (SIGKILL to its process group; `taskkill /T /F` on Windows) and
   writes `[squash] stop timed out after <n>ms; force-killing` to the instance log.

Per-instance settings (in the instance form, or the create/update API):

| Field | Default | Meaning |
|-------|---------|---------|
| `stopCommand` | none | Console command(s) that shut the server down, one per line, sent about a second apart, each followed by Enter; an empty line (after the first command) sends just Enter. Blank = the platform default above. |
| `stopTimeoutMs` | `15000` | How long to wait for the process to exit before force-killing it (1000–600000), counted from the first command line. |

**For `rwr_server`, set `stopCommand` to `quit` followed by an empty line** — on Windows
too. `rwr_server` answers `quit` with `Exit requested` and only exits after one more
Enter, which the empty line provides; with `quit` alone it waits until the stop timeout
force-kills it. Without any stop command a Windows stop kills the server at once, which
may lose player progress saved since the last `save_profiles` — to save first, use
`save_profiles`, `quit`, then an empty line.

The lines go out on a fixed schedule, one second apart, not when the server has answered
the previous one, and the stop timeout starts with the first line: leave it well above a
second per extra line (squash logs a warning when it isn't). The form shows below the
field what will be sent, including the Enter of a trailing empty line.

- **Force stop**: while an instance is `stopping`, its Stop button turns into **Force
  stop** (after a confirmation) and kills the process at once. Over the API that is
  `POST /api/instances/:id/stop` with `{"force": true}`; a plain Stop while stopping
  changes nothing, so a double click or a stale page can't cut a graceful shutdown short.
- **Restart** runs the same stop and starts the new process only once the old one has
  exited, so two copies never run side by side. It is disabled while the instance is
  `stopping`; a Stop while a restart waits cancels the restart.
- **Shutting squash down** (Ctrl+C, closing its window or terminal, `docker stop`,
  SIGTERM) stops every running instance the same way, in parallel, and then exits with
  code 0. It takes at most the longest `stopTimeoutMs` plus 2s. A second Ctrl+C a second
  or more after the first force-kills what is left and exits at once. On Windows, closing
  the console window gives squash only about 5 seconds before Windows ends it; the
  instances then go down with the console.
- Behind a reverse proxy, a **Restart** request stays open until the old process has
  exited — up to its `stopTimeoutMs` plus 5s. Set the proxy's read timeout above that
  (nginx's `proxy_read_timeout` defaults to 60s); otherwise the page may report the
  restart as failed while it still completes on the server.
- `nohup ./start.sh` does not keep squash running after an SSH session ends — squash
  treats the hangup as a request to shut down. Use `tmux`/`screen` or a service manager.
  A systemd unit needs `KillMode=mixed` (the default `control-group` also sends SIGTERM
  straight to the instances) and `TimeoutStopSec=` of at least the longest stop timeout
  plus 5s.

## Auto-restart

Choose a per-instance `restartPolicy`:

- `never`: leave the instance stopped after any exit.
- `on-failure`: restart after a non-zero exit code or signal.
- `always`: keep running after any unsolicited exit, including exit code 0.
  Recommended for RWR, whose error handler may exit with code 0.

New instances created in the UI default to `always`. Existing configurations
and API clients that omit the policy retain the legacy behavior: `autoRestart:
true` means `on-failure`, false/unset means `never` (the API defaults it to true).
An explicit policy takes precedence over `autoRestart`.

Retries use exponential backoff (`restartDelayMs * 2^n`, default base 3000ms,
capped at 60s), up to 5 consecutive attempts, then pause. Running for 60s resets
the counter. The list and terminal show the next restart time, exit code/signal,
or why recovery is paused. Stop cancels recovery, even while waiting; edit,
delete and manager shutdown cancel it too. Manual Start/Restart resets the
counter and cancels the old timer. A spawn/configuration error requires a manual
retry. Windows crash-dialog recovery is enabled for both restart-enabled policies.

To run the isolated HTTP/WebSocket/PTY regression with Node >=24:

```sh
npm run build:server
npm --prefix frontend run build
npm run smoke:restart-policy
```

CI runs this after packaging on all three platforms, before artifact upload.

The restart-policy smoke uses fake children and temporary config under `.cache/`,
including 60 seconds of real stable uptime. On Windows it tests simulated
crashdump recovery and invokes the real manager shutdown handler through IPC;
it does not reproduce an RWR engine crash or test OS signal delivery/browser interaction.

The instance form browser regression uses a headless Chromium browser and an
isolated API fixture (no game server or user configuration):

```sh
npm run smoke:instance-form
```

Build the server and frontend first, with `VITE_API_URL` unset in frontend env
files or overridden to an empty value at build time so the UI uses the fixture's
same-origin API. Set `SQUASH_BROWSER_PATH` if Chromium is not detected automatically.
This browser check is a local command and is not part of CI.
The fixture blocks browser connections to other origins, so a build with an
external API address fails without sending requests to that service.

The Windows adapter pins node-pty to 1.2.0-beta.12 and checks its version and
exact Windows implementation fingerprints before creating a PTY. After the real
PTY exit it closes the input socket (preserving output flushing) and terminates
node-pty's conout worker thread, which its natural-exit path never disposes.
The remaining per-exit residue — a conhost process handle and ~2 pipe handles
inside the unclosed pseudoconsole — cannot be released from JS: node-pty's
exit watcher removes its internal pty record before any JS exit callback runs,
so a post-exit native kill is a no-op. Revalidate this compatibility code
before updating node-pty.
`npm run smoke:pty-cleanup` (Windows, Node >=24, build server first) checks real
normal/failed/forced exits, repeated operations and injected error boundaries.
It uses isolated fixtures; an active-session input error still fails the host.

On Windows, `npm run smoke:pty-lifecycle` (Node >=24, build server first) runs
eight sequential lifecycles per control/pressure worker with weak references, GC,
input queue snapshots and independent Windows handle counts. It uses isolated
fixtures and leaves real instances/config untouched. Exit 0 means no active input
sockets or queued bytes at the final bounded observation; 2 reports retained
resources; 1 reports a check or cleanup failure. This is a local investigation,
not a CI gate or proof that RWR's bad allocation cause has been resolved.

On Windows, investigate writes between child disappearance and ConPTY's delayed
exit notification with `npm run smoke:pty-exit-window` (Node >=24, build server
first). It runs isolated fake children through the compiled supervisor, requires
actual socket writes in the observed window, and leaves production code/config
unchanged. A passing bounded probe does not rule out every pipe/engine failure.
Exit code 2 means the input queue did not drain in the bounded observation;
those cases are inconclusive and are not counted as safe passes. Exit 1 indicates
an exception, invalid coverage, or cleanup failure. This probe is not in CI.

On Windows, `npm run smoke:pty-handles [-- --mode M]` (Node >=24; build the
server first for `--mode supervisor`) attributes per-exit OS handle growth by
object type. It compares pure node-pty rounds (`dependency`), the same rounds
with the adapter's conin destroy (`conin-destroy`), and rounds driven by the
compiled supervisor (`supervisor`), censusing the worker's handles between
rounds with an independent NtQuerySystemInformation helper. On node-pty
1.2.0-beta.12 the raw dependency paths (`dependency`, `conin-destroy`) retain
~13-15 handles per natural exit (unchanged: they bypass the adapter); the
supervisor path — whose adapter destroys
conin AND terminates the conout worker — retains ~5 per round (a conhost
process handle and pipe handles inside the unclosed pseudoconsole, which only
an upstream change to node-pty's exit watcher can release). Thread, Event,
Semaphore and IO-completion growth is gone on the supervisor path. Exit 2
reports the retained handles as a diagnostic; it is not a CI gate.

## Known Issues

- **macOS `posix_spawnp failed`**: node-pty spawn-helper binary may lack execute bit on macOS. Fix: `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` (in a source checkout using pnpm: `node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`). Linux is unaffected.
- **macOS: a bundle downloaded with a browser may fail to load its native modules** —
  Gatekeeper can quarantine the ad-hoc-signed `pty.node` / `spawn-helper`. Clear the flag on
  the unpacked folder: `xattr -dr com.apple.quarantine <squash-folder>`.
- **Windows stops without a `stopCommand` are immediate kills**: there is no signal to ask a
  console program to exit, so the process tree is ended at once and unsaved state may be
  lost. Configure a stop command (`quit` plus an empty line for `rwr_server`, see [Stopping](#stopping)).
- **Bundles are not code-signed**: Windows SmartScreen may warn on first launch of `start.bat`.
- **Real `rwr_server` runtime validation** has been done by hand on Windows Server only; Linux hasn't been validated with an actual game server binary yet.

## Roadmap

- [ ] Real game server runtime validation (Linux)
- [x] Auto-restart strategy on crash
- [ ] Health probing via `status` output parsing
- [ ] Log rotation
- [ ] SQLite config storage (planned)

## License

MIT License. See [LICENSE](LICENSE) for details.
