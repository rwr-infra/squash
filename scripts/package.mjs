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
// Stage a trimmed package.json WITHOUT scripts: the staged `npm ci --omit=dev`
// below must not fire lifecycle hooks (e.g. postinstall: patch-package, whose
// binary is a devDependency absent from this production-only install).
const stagedPkg = { ...pkg };
delete stagedPkg.scripts;
fs.writeFileSync(path.join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);
fs.copyFileSync(path.join(rootDir, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));
// Ship the project READMEs (single source of truth for setup/config) and the
// env template. .env itself (real secrets) is intentionally NOT included.
fs.copyFileSync(path.join(rootDir, 'README.md'), path.join(stageDir, 'README.md'));
fs.copyFileSync(path.join(rootDir, 'README.zh-CN.md'), path.join(stageDir, 'README.zh-CN.md'));
fs.copyFileSync(path.join(rootDir, '.env.example'), path.join(stageDir, '.env.example'));

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
    execFileSync('tar', ['-a', '-cf', artifact, '-C', stageDir, ...entries], { stdio: 'inherit' });
  } else {
    artifact = path.join(releaseDir, `${name}.tar.gz`);
    fs.rmSync(artifact, { force: true });
    execFileSync('tar', ['-czf', artifact, '-C', stageDir, ...entries], { stdio: 'inherit' });
  }
  log(`created ${path.relative(rootDir, artifact)}`);
} catch (err) {
  log(`compression failed (${err.message}); the staged folder is ready at ${path.relative(rootDir, stageDir)}`);
}

log('done');
