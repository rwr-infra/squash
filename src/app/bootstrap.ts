import { mkdir } from 'node:fs/promises';
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appPaths } from './paths.js';

const isPkg = Boolean((process as unknown as { pkg?: unknown }).pkg);

const ensureDir = (target: string) => mkdir(target, { recursive: true });

// Recursive copy using only readFileSync/writeFileSync — pkg's snapshot FS does
// not support the libuv fast path that copyFileSync/cpSync take, but plain
// read/write are intercepted correctly.
const copyDirSync = (src: string, dest: string): void => {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    if (statSync(from).isDirectory()) {
      copyDirSync(from, to);
    } else {
      writeFileSync(to, readFileSync(from));
    }
  }
};

// In a @yao-pkg/pkg single-file build the frontend is embedded in the read-only
// virtual snapshot, which @fastify/static cannot serve from. Materialize it to a
// real temp dir once at startup and steer the static server there. A user-set
// SQUASH_STATIC_DIR always wins.
const extractStaticIfPkg = (): void => {
  if (!isPkg || process.env.SQUASH_STATIC_DIR) return;
  const dest = path.join(os.tmpdir(), 'squash-web');
  rmSync(dest, { recursive: true, force: true });
  copyDirSync(appPaths.staticDir, dest);
  process.env.SQUASH_STATIC_DIR = dest;
};

export const bootstrapApp = async () => {
  extractStaticIfPkg();

  await Promise.all([
    ensureDir(appPaths.configDir),
    ensureDir(appPaths.logDir)
  ]);

  return {
    paths: appPaths
  };
};
