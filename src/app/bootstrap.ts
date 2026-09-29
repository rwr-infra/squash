import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appPaths } from './paths.js';

// config/ and logs/ live inside the app folder, so a bundle unpacked somewhere
// read-only fails here with a readable message instead of on the first save.
// Probe with a real write: mkdir succeeds on an existing read-only directory,
// and fs.access(W_OK) always passes for directories on Windows (no ACL check).
const ensureWritableDir = async (target: string) => {
  const probe = path.join(target, `.write-test-${process.pid}`);
  try {
    await mkdir(target, { recursive: true });
    await writeFile(probe, '');
    await rm(probe, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new Error(
      `Cannot write to ${target} (${code}). squash keeps config/ and logs/ inside its own folder — run it from a location the current user can write to, or fix that folder's permissions (for Docker, the mounted volume must be writable by the container user).`,
      { cause: err }
    );
  }
};

export const bootstrapApp = async () => {
  await Promise.all([
    ensureWritableDir(appPaths.configDir),
    ensureWritableDir(appPaths.logDir)
  ]);

  return {
    paths: appPaths
  };
};
