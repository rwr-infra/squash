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
├── frontend/              # Frontend (React)
└── config/                # Instance configs (instances.json)
```

## Getting Started

### Prerequisites

- Node.js >= 20
- Linux (PTY behavior validated on Linux; macOS has known node-pty permission quirks)

### Backend

```bash
npm install
npx tsx src/index.ts
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Pino log level |

### Frontend

```bash
cd frontend
npm install

# Configure backend URL (match PORT above)
echo "VITE_API_URL=http://localhost:3000" > .env.local
echo "VITE_WS_URL=ws://localhost:3000" >> .env.local

npm run dev
```

Frontend runs at `http://localhost:5173` by default.

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
| GET | `/instances/:id/logs/tail` | Tail instance logs |

WebSocket: `ws://localhost:3000/terminal/:instanceId`

## Known Issues

- **macOS `posix_spawnp failed`**: node-pty spawn-helper binary may lack execute bit on macOS. Fix: `chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`. Linux is unaffected.
- **Real `rwr_server` runtime validation** has not been performed on an actual game server binary yet.
- **No authentication** — API is unprotected.

## Roadmap

- [ ] Real game server runtime validation (Linux)
- [ ] Auto-restart strategy on crash
- [ ] Log rotation
- [ ] Authentication / API key
- [ ] SQLite config storage (planned)

## License

MIT License. See [LICENSE](LICENSE) for details.
