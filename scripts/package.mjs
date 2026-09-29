// Assembles a portable, self-contained distribution of squash for the CURRENT
// platform/arch and zips it. The bundle carries its own pinned Node.js runtime
// (runtime/, see scripts/node-runtime.mjs), so the target machine needs no Node
// install. node-pty is a native module, so packaging still runs on each target OS
// (locally or via the GitHub Actions matrix in .github/workflows/release.yml).
//
// Prereq: `npm run build` has produced dist/ and frontend/dist/.
// Output:  release/squash-<version>-<platform>-<arch>(.zip|.tar.gz)

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { installNodeRuntime, readNodeVersion, tarCommand } from './node-runtime.mjs';

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

// Vite bakes frontend/.env* values into the bundle — .env.local included, even
// in production mode. A dev override such as VITE_API_URL=http://localhost:4747
// would make every shipped copy call the builder's machine, and VITE_AUTH_TOKEN
// would ship a secret. Release bundles must talk to their own origin.
//
// Mirror Vite's precedence to find each key's effective value: later files win
// (.env < .env.local < .env.production < .env.production.local) and a variable
// already in the environment beats every file — even an empty one, so
// `VITE_API_URL= npm run package` neutralizes a dev .env.local without touching
// it. Empty is only safe where the frontend treats '' like unset: VITE_WS_URL is
// read with `??`, so an empty value would break the same-origin WebSocket.
const BAKED_KEYS = ['VITE_API_URL', 'VITE_WS_URL', 'VITE_AUTH_TOKEN'];
const effective = new Map();
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const full = path.join(rootDir, 'frontend', file);
  if (!fs.existsSync(full)) continue;
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && BAKED_KEYS.includes(match[1])) {
      effective.set(match[1], { value: match[2].trim(), source: `frontend/${file}` });
    }
  }
}
for (const key of BAKED_KEYS) {
  if (process.env[key] !== undefined) effective.set(key, { value: process.env[key], source: 'environment' });
}
const bakedOverrides = [...effective]
  .filter(([key, { value }]) => value !== '' || key === 'VITE_WS_URL')
  .map(([key, { source }]) => `${source}: ${key}`);
if (bakedOverrides.length > 0 && process.env.SQUASH_ALLOW_FRONTEND_ENV !== '1') {
  console.error(
    `[package] the frontend build would embed dev-only settings:\n  ${bakedOverrides.join('\n  ')}\n` +
      '[package] Unset them for the release build — e.g. `VITE_API_URL= npm run package` overrides a\n' +
      '[package] dev frontend/.env.local (VITE_WS_URL must be removed from the file instead).\n' +
      '[package] Set SQUASH_ALLOW_FRONTEND_ENV=1 only if the bundle really must call a fixed API origin.'
  );
  process.exit(1);
}

let pinnedNode;
try {
  pinnedNode = readNodeVersion(rootDir);
} catch (err) {
  console.error(`[package] ${err.message}`);
  process.exit(1);
}
if (process.version !== `v${pinnedNode}`) {
  // Only npm ci runs on the build Node (node-pty ships N-API prebuilds), but a
  // source build fallback would compile against it — CI pins it to match.
  log(`warning: building with Node ${process.version}; the bundled runtime is v${pinnedNode} (.node-version)`);
}

// --- Clean & stage -----------------------------------------------------------
// Drop any archive from a previous run first, so a failed run can't leave a
// stale file that looks like fresh output.
for (const ext of ['zip', 'tar.gz']) fs.rmSync(path.join(releaseDir, `${name}.${ext}`), { force: true });
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

log('copying compiled server and frontend');
fs.cpSync(path.join(rootDir, 'dist'), path.join(stageDir, 'dist'), { recursive: true });
fs.cpSync(path.join(rootDir, 'frontend', 'dist'), path.join(stageDir, 'frontend', 'dist'), { recursive: true });
fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(stageDir, 'package.json'));
fs.copyFileSync(path.join(rootDir, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));
// Ship the project READMEs (single source of truth for setup/config) and the
// env template. .env itself (real secrets) is intentionally NOT included.
fs.copyFileSync(path.join(rootDir, 'README.md'), path.join(stageDir, 'README.md'));
fs.copyFileSync(path.join(rootDir, 'README.zh-CN.md'), path.join(stageDir, 'README.zh-CN.md'));
fs.copyFileSync(path.join(rootDir, '.env.example'), path.join(stageDir, '.env.example'));
fs.copyFileSync(path.join(rootDir, 'LICENSE'), path.join(stageDir, 'LICENSE'));

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

// --- Bundled Node runtime ---------------------------------------------------
log('installing the bundled Node runtime');
let runtime;
try {
  runtime = await installNodeRuntime({ rootDir, platform, arch, destDir: path.join(stageDir, 'runtime'), log });
} catch (err) {
  console.error(`[package] ${err.message}`);
  process.exit(1);
}

// --- Build info --------------------------------------------------------------
// Ties the archive back to its source and toolchain for support/debugging.
const git = (...args) =>
  execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const sourceInfo = () => {
  try {
    return {
      commit: git('rev-parse', 'HEAD'),
      // Uncommitted tracked changes mean the commit alone can't reproduce this
      // build. package.json is excluded: CI stamps the tag version into it.
      dirty: git('status', '--porcelain', '--untracked-files=no', '--', '.', ':!package.json') !== ''
    };
  } catch {
    return { commit: process.env.GITHUB_SHA ?? 'unknown', dirty: null };
  }
};
const nodePtyVersion = JSON.parse(
  fs.readFileSync(path.join(stageDir, 'node_modules', 'node-pty', 'package.json'), 'utf8')
).version;
const buildInfo = {
  name: 'squash',
  version: pkg.version,
  ...sourceInfo(),
  platform,
  arch,
  node: runtime.version,
  nodeArchive: runtime.archive,
  nodeArchiveSha256: runtime.sha256,
  nodePty: nodePtyVersion,
  buildNode: process.version,
  builtAt: new Date().toISOString()
};
fs.writeFileSync(path.join(stageDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);

// --- Launchers ---------------------------------------------------------------
// Both launchers run the BUNDLED runtime only (never a system `node`) from the
// bundle root, so .env, config/ and logs/ resolve next to the launcher.
log('writing launchers');

// %~dp0 is captured once, first: after a cd it can re-resolve against the new
// cwd when the script was started via a quoted relative path. No expansions
// inside parenthesized blocks: a `)` in the install path (e.g. "Program Files
// (x86)") would end the block early. pushd (unlike cd /d) also works from a UNC
// path. Pause on failure so a double-clicked window doesn't vanish before the
// error can be read (SQUASH_NO_PAUSE=1 skips it for scripted runs); Ctrl+C
// (0xC000013A) is a normal stop, not a failure. CRLF line endings: cmd.exe
// mis-parses labels in LF-only batch files.
const startBat = `@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "SQUASH_HOME=%~dp0"
set "SQUASH_NODE=%SQUASH_HOME%runtime\\node.exe"
pushd "%SQUASH_HOME%" || goto nodir
if exist "%SQUASH_NODE%" goto run
echo [squash] Bundled Node runtime not found: "%SQUASH_NODE%"
echo [squash] Re-extract the release archive and keep the runtime\\ folder next to start.bat.
set SQUASH_EXIT=1
goto end
:nodir
echo [squash] Cannot change to the squash folder: "%SQUASH_HOME%"
set SQUASH_EXIT=1
goto end
:run
rem Configure PORT / HOST / AUTH_USERNAME / AUTH_PASSWORD in .env (copy .env.example).
"%SQUASH_NODE%" "%SQUASH_HOME%dist\\index.js" %*
set SQUASH_EXIT=%errorlevel%
:end
if "%SQUASH_EXIT%"=="0" goto done
if "%SQUASH_EXIT%"=="-1073741510" goto done
if defined SQUASH_NO_PAUSE goto done
echo.
echo [squash] Exited with code %SQUASH_EXIT%. See the messages above.
pause
:done
exit /b %SQUASH_EXIT%
`.replace(/\n/g, '\r\n');
fs.writeFileSync(path.join(stageDir, 'start.bat'), startBat);

const startSh = `#!/bin/sh
# Runs squash with the bundled Node runtime; no system Node is needed.
# Configure PORT / HOST / AUTH_USERNAME / AUTH_PASSWORD in .env (copy .env.example).
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$APP_DIR" || exit 1
NODE="$APP_DIR/runtime/node"
if [ ! -x "$NODE" ]; then
  echo "[squash] Bundled Node runtime not found or not executable: $NODE" >&2
  echo "[squash] Re-extract the release archive (keep runtime/), or run: chmod +x runtime/node" >&2
  exit 1
fi
exec "$NODE" "$APP_DIR/dist/index.js" "$@"
`;
fs.writeFileSync(path.join(stageDir, 'start.sh'), startSh, { mode: 0o755 });

// --- Compress ----------------------------------------------------------------
// Compress with `tar` on every platform. We used to call PowerShell's
// `Compress-Archive` on Windows, but that cmdlet lives in the
// `Microsoft.PowerShell.Archive` module, which fails to autoload on some
// Windows installs ("CouldNotAutoloadMatchingModule"). Windows 10 1803+
// ships `tar.exe` (bsdtar), which `-a` lets us emit a real .zip from — so we
// keep the Windows-friendly .zip output without depending on PowerShell at all.
//
// We list the staged dir's top-level entries explicitly and pass them to tar
// with `-C stageDir`. Two reasons vs the simpler `-C stageDir .`:
//   1. No wrapping directory — entries sit at the archive root, so unzipping
//      drops files in place instead of into a `squash-<ver>-<plat>-<arch>/`
//      subfolder.
//   2. No `./` prefix on entries (bsdtar emits `./foo` for `-C dir .`), which
//      some picky unpackers handle poorly.
// tar recurses into directories automatically, so `node_modules` (created by
// `npm ci` above) is included without being named explicitly.
const entries = fs.readdirSync(stageDir);
let artifact;
try {
  if (platform === 'win32') {
    artifact = path.join(releaseDir, `${name}.zip`);
    fs.rmSync(artifact, { force: true });
    execFileSync(tarCommand(), ['-a', '-cf', artifact, '-C', stageDir, ...entries], { stdio: 'inherit' });
  } else {
    artifact = path.join(releaseDir, `${name}.tar.gz`);
    fs.rmSync(artifact, { force: true });
    execFileSync(tarCommand(), ['-czf', artifact, '-C', stageDir, ...entries], { stdio: 'inherit' });
  }
  log(`created ${path.relative(rootDir, artifact)}`);
} catch (err) {
  // Fail the build: CI must not report success without an archive to publish.
  console.error(`[package] compression failed (${err.message}); the staged folder is at ${path.relative(rootDir, stageDir)}`);
  process.exit(1);
}

log('done');
