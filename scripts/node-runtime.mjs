// Fetches the official Node.js runtime that ships inside a squash bundle, so the
// target machine needs no Node install. The version comes from .node-version (the
// same file CI's setup-node reads) and every archive is checked against the
// SHA-256 pinned in scripts/node-runtime.sha256 — never against a checksum fetched
// alongside the download, and never by copying whatever `node` the build machine
// happens to have on PATH.
//
// Downloads are cached in .cache/node-runtime/ and re-verified on every use.
// SQUASH_NODE_MIRROR overrides the download origin (default
// https://nodejs.org/dist); the pinned checksums still apply, so a mirror can't
// substitute a different binary.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MIRROR = 'https://nodejs.org/dist';

// On Windows always use the system bsdtar (reads/writes .zip, understands C:\
// paths). From Git Bash/MSYS2, a bare `tar` resolves to GNU tar, which treats
// "C:" as a remote host and can't handle zip at all.
export const tarCommand = () =>
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

// Node's dist naming: win32 → "win"; darwin/linux keep process.platform.
const distPlatform = (platform) => (platform === 'win32' ? 'win' : platform);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const readPinnedChecksums = (rootDir) => {
  const file = path.join(rootDir, 'scripts', 'node-runtime.sha256');
  const pins = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [hash, name] = trimmed.split(/\s+/);
    pins.set(name, hash.toLowerCase());
  }
  return pins;
};

export const readNodeVersion = (rootDir) => {
  const version = fs.readFileSync(path.join(rootDir, '.node-version'), 'utf8').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`.node-version must hold an exact version like 24.21.0 (got "${version}")`);
  }
  return version;
};

const download = async (url, dest) => {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // fetch() only says "fetch failed"; the actionable part is in err.cause.
    const detail = [err.cause?.code, err.cause?.message].filter(Boolean).join(' ');
    const cause = detail ? ` (${detail})` : '';
    throw new Error(
      `download failed: ${url}${cause}. Behind a proxy, set NODE_USE_ENV_PROXY=1 (with HTTPS_PROXY), ` +
        `or point SQUASH_NODE_MIRROR at a reachable mirror (e.g. https://npmmirror.com/mirrors/node).`
    );
  }
  if (!res.ok) throw new Error(`download failed: ${url} → HTTP ${res.status}`);
  const tmp = `${dest}.partial`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
};

/**
 * Places the pinned Node runtime for platform/arch into destDir:
 *   destDir/node (or node.exe on Windows) + destDir/LICENSE
 * Returns { version, archive, sha256 }.
 */
export const installNodeRuntime = async ({ rootDir, platform, arch, destDir, log }) => {
  const version = readNodeVersion(rootDir);
  const base = `node-v${version}-${distPlatform(platform)}-${arch}`;
  const archive = `${base}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;

  const expected = readPinnedChecksums(rootDir).get(archive);
  if (!expected) {
    throw new Error(
      `no pinned checksum for ${archive} in scripts/node-runtime.sha256 — ` +
        `update it from ${DEFAULT_MIRROR}/v${version}/SHASUMS256.txt (see the file header)`
    );
  }

  const cacheDir = path.join(rootDir, '.cache', 'node-runtime');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, archive);

  if (fs.existsSync(cached) && sha256(cached) === expected) {
    log(`using cached ${archive}`);
  } else {
    const mirror = (process.env.SQUASH_NODE_MIRROR || DEFAULT_MIRROR).replace(/\/+$/, '');
    const url = `${mirror}/v${version}/${archive}`;
    log(`downloading ${url}`);
    await download(url, cached);
    const actual = sha256(cached);
    if (actual !== expected) {
      fs.rmSync(cached, { force: true });
      throw new Error(`checksum mismatch for ${archive}: expected ${expected}, got ${actual}`);
    }
  }
  log(`verified ${archive} (sha256 ${expected})`);

  // Extract only the two members we ship. bsdtar (macOS, Windows 10+) reads both
  // .tar.gz and .zip; GNU tar (Linux) auto-detects gzip. Windows archives keep
  // node.exe at the top level, the others under bin/.
  const binMember = platform === 'win32' ? `${base}/node.exe` : `${base}/bin/node`;
  const licenseMember = `${base}/LICENSE`;
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-node-'));
  try {
    execFileSync(tarCommand(), ['-xf', cached, '-C', extractDir, binMember, licenseMember], { stdio: 'inherit' });
    fs.mkdirSync(destDir, { recursive: true });
    const binName = platform === 'win32' ? 'node.exe' : 'node';
    fs.copyFileSync(path.join(extractDir, binMember), path.join(destDir, binName));
    fs.copyFileSync(path.join(extractDir, licenseMember), path.join(destDir, 'LICENSE'));
    if (platform !== 'win32') fs.chmodSync(path.join(destDir, binName), 0o755);
  } finally {
    // Best effort: on Windows an AV scan of the fresh node.exe can briefly lock
    // it, and a cleanup error must not turn a successful install into a failure.
    try {
      fs.rmSync(extractDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      log(`could not remove temp dir ${extractDir}`);
    }
  }

  return { version, archive, sha256: expected };
};
