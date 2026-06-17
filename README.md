# squash

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
- **Windows crash-dialog recovery** — a WerFault watchdog force-kills a hung crashed process (plus a registry script to suppress the dialog at the source)
- **Timestamped logging** — per-instance log files with line-buffered output

## Tech Stack

**Backend**: Node.js 20 + TypeScript + Fastify + node-pty + Zod + Pino
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

# Run container (with auth token)
docker run -d \
  --name squash \
  -p 3000:3000 \
  -e AUTH_TOKEN=your-secret-token \
  -v squash-data:/app/config \
  -v squash-logs:/app/logs \
  rwr-infra/squash
```

Then open `http://localhost:3000`.

### Docker Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Pino log level |
| `SQUASH_STATIC_DIR` | `/app/frontend/dist` | Frontend static files path |
| `AUTH_TOKEN` | _(none)_ | Bearer token for API authentication |

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
AUTH_TOKEN=your-secret-token npm start   # node dist/index.js
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Pino log level |
| `SQUASH_STATIC_DIR` | _(next to the app)_ | Frontend static files path (auto-derived; override only if you relocate `frontend/dist`) |
| `AUTH_TOKEN` | _(none)_ | Bearer token for API authentication |

### Portable distribution (Windows without Docker)

`npm run package` produces a self-contained bundle for the **current OS/arch** under
`release/` (a `.zip` on Windows, `.tar.gz` elsewhere) containing the compiled server,
the built frontend, production `node_modules`, and `start.bat` / `start.sh` launchers.

```bash
npm run package
```

On the target machine (which only needs **Node.js >= 24** installed — no build tools):

1. Unzip the bundle.
2. Edit `start.bat` (Windows) / `start.sh` (Linux/macOS) to set `AUTH_TOKEN`.
3. Run `start.bat` / `./start.sh`. Open `http://localhost:3000`.

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

# Configure backend URL and auth token (match backend settings above)
echo "VITE_API_URL=http://localhost:3000" > .env.local
echo "VITE_WS_URL=ws://localhost:3000" >> .env.local
echo "VITE_AUTH_TOKEN=your-secret-token" >> .env.local

npm run dev
```

Frontend dev server runs at `http://localhost:5173`.

### Quick Test

```bash
# Health check
curl http://localhost:3000/health

# Create a test instance
curl -X POST http://localhost:3000/instances \
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
curl -X POST http://localhost:3000/instances/test-1/start

# List instances
curl http://localhost:3000/instances
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/instances` | List all instances |
| POST | `/instances` | Create instance |
| GET | `/instances/:id` | Get instance details |
| DELETE | `/instances/:id` | Delete instance |
| POST | `/instances/:id/start` | Start instance |
| POST | `/instances/:id/stop` | Stop instance |
| POST | `/instances/:id/restart` | Restart instance |
| POST | `/instances/:id/command` | Send a command to the instance's stdin |
| GET | `/instances/:id/logs/tail` | Tail instance logs |

### Sending commands

`POST /instances/:id/command` forwards a command to the running instance's stdin
(the same channel as the interactive terminal). Useful for issuing in-game console
commands such as `status` programmatically.

```bash
# Fire-and-forget (a trailing \r is appended by default)
curl -X POST http://localhost:3000/instances/test-1/command \
  -H "Content-Type: application/json" \
  -d '{ "command": "status" }'

# Capture output produced within a time window (ms) and return it
curl -X POST http://localhost:3000/instances/test-1/command \
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

WebSocket: `ws://localhost:3000/terminal/:instanceId`

## Windows deployment

When `rwr_server.exe` crashes on Windows, Windows Error Reporting (WER) shows a
"has stopped working" dialog and the process **hangs** waiting for it to be
dismissed — so the process never truly exits and auto-restart cannot trigger.
squash handles this in two layers:

1. **Root cause (recommended):** run the bundled script as Administrator to stop
   WER from showing a dialog for `rwr_server.exe`. The process then exits
   immediately on crash and auto-restart works normally.

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows-disable-wer.ps1
   ```

2. **Fallback (always on):** for instances with `autoRestart` enabled, squash
   runs an in-app watchdog that detects a `WerFault.exe` process for the instance
   and force-kills the whole process tree (`taskkill /T /F`), which lets the
   crash propagate and auto-restart kick in — even without the registry change.

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
