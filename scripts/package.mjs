// Assembles a portable, self-contained distribution of squash for the CURRENT
// platform/arch and zips it. node-pty is a native module, so its prebuilt binary
// is platform-specific — that's why packaging must run on each target OS (locally
// or via the GitHub Actions matrix in .github/workflows/release.yml).
//
// Prereq: `npm run build` has produced dist/ and frontend/dist/.
// Output:  release/squash-<version>-<platform>-<arch>(.zip|.tar.gz)

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);
const releaseDir = path.join(rootDir, 'release');

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const { platform, arch } = process;
const name = `squash-${pkg.version}-${platform}-${arch}`;
const stageDir = path.join(releaseDir, name);

const log = (msg) => console.log(`[package] ${msg}`);

// --- Preflight ---------------------------------------------------------------
for (const required of ['dist', path.join('frontend', 'dist')]) {
  if (!fs.existsSync(path.join(rootDir, required))) {
    console.error(`[package] missing ${required}/ — run \`npm run build\` first.`);
    process.exit(1);
  }
}

// --- Clean & stage -----------------------------------------------------------
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

log('copying compiled server and frontend');
fs.cpSync(path.join(rootDir, 'dist'), path.join(stageDir, 'dist'), { recursive: true });
fs.cpSync(path.join(rootDir, 'frontend', 'dist'), path.join(stageDir, 'frontend', 'dist'), { recursive: true });
fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(stageDir, 'package.json'));
fs.copyFileSync(path.join(rootDir, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));

// --- Install production dependencies (pulls node-pty's platform binary) ------
log('installing production dependencies (this resolves node-pty for this platform)');
// shell:true is REQUIRED on Windows: Node refuses to spawn npm.cmd directly
// (EINVAL since the CVE-2024-27980 fix). Args are hardcoded constants, so the
// shell-injection caveat behind the DEP0190 warning doesn't apply here.
const npm = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: stageDir,
  stdio: 'inherit',
  shell: true
});
if (npm.error) {
  console.error(`[package] failed to launch npm: ${npm.error.message}`);
  process.exit(1);
}
if (npm.status !== 0) {
  console.error('[package] npm ci failed');
  process.exit(npm.status ?? 1);
}

// --- Launchers ---------------------------------------------------------------
log('writing launchers');
const startBat = `@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3000
rem Set an auth token before exposing the server publicly:
rem set AUTH_TOKEN=your-secret-token
node dist\\index.js
`;
fs.writeFileSync(path.join(stageDir, 'start.bat'), startBat);

const startSh = `#!/usr/bin/env bash
cd "$(dirname "$0")"
export PORT="\${PORT:-3000}"
# export AUTH_TOKEN=your-secret-token
exec node dist/index.js
`;
fs.writeFileSync(path.join(stageDir, 'start.sh'), startSh, { mode: 0o755 });

const deploy = `# squash — portable distribution (${platform}/${arch})

Self-contained build of squash. **Requires Node.js >= 24 on the target machine.**

## Run

- Windows: double-click \`start.bat\` (or run it from a terminal)
- Linux/macOS: \`./start.sh\`

The server listens on port 3000 by default. Open http://localhost:3000.

## Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | HTTP port |
| HOST | 0.0.0.0 | Bind address |
| AUTH_TOKEN | (none) | Bearer token required for the API/UI when set |
| LOG_LEVEL | info | Log verbosity |

Edit \`start.bat\` / \`start.sh\` to set \`AUTH_TOKEN\` before exposing the server.

## Data

\`config/\` (instance definitions) and \`logs/\` (per-instance logs) are created
next to this folder on first run.

## Windows: stop crash dialogs hanging the server

If a game server crashes on Windows, a Windows Error Reporting dialog can hang the
process. squash auto-recovers via a built-in watchdog, but for a clean fix run the
bundled \`windows-disable-wer.ps1\` (in the repo's scripts/) as Administrator.
`;
fs.writeFileSync(path.join(stageDir, 'DEPLOY.md'), deploy);

// --- Compress ----------------------------------------------------------------
let artifact;
try {
  if (platform === 'win32') {
    artifact = path.join(releaseDir, `${name}.zip`);
    fs.rmSync(artifact, { force: true });
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path "${stageDir}/*" -DestinationPath "${artifact}" -Force`],
      { stdio: 'inherit' }
    );
  } else {
    // tar is present on modern Windows too, but zip is friendlier on Unix.
    artifact = path.join(releaseDir, `${name}.tar.gz`);
    fs.rmSync(artifact, { force: true });
    execFileSync('tar', ['-czf', artifact, '-C', releaseDir, name], { stdio: 'inherit' });
  }
  log(`created ${path.relative(rootDir, artifact)}`);
} catch (err) {
  log(`compression failed (${err.message}); the staged folder is ready at ${path.relative(rootDir, stageDir)}`);
}

log('done');
