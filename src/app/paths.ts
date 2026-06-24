import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `process.pkg` is injected by @yao-pkg/pkg inside a single-file executable.
const isPkg = Boolean((process as unknown as { pkg?: unknown }).pkg);

const currentFilePath = fileURLToPath(import.meta.url);

// Writable data (config/, logs/) and read-only frontend assets resolve
// differently across the three ways squash runs:
//   - dev:      src/app/paths.ts via tsx
//   - compiled: dist/app/paths.js via `node dist/index.js` (npm start / Docker)
//   - pkg:      bundled into <snapshot>/dist-bin/server.cjs, frontend assets at
//               <snapshot>/frontend/dist — but the snapshot is READ-ONLY, so
//               config/ and logs/ must live next to the real executable instead.
const resolveDirs = (): { rootDir: string; staticDir: string } => {
  if (isPkg) {
    const snapshotRoot = path.dirname(path.dirname(currentFilePath));
    return {
      rootDir: path.dirname(process.execPath),
      staticDir: path.join(snapshotRoot, 'frontend', 'dist')
    };
  }
  const srcDir = path.dirname(path.dirname(currentFilePath));
  const rootDir = path.dirname(srcDir);
  return { rootDir, staticDir: path.join(rootDir, 'frontend', 'dist') };
};

const { rootDir, staticDir } = resolveDirs();

export const appPaths = {
  rootDir,
  configDir: path.join(rootDir, 'config'),
  logDir: path.join(rootDir, 'logs'),
  instanceConfigFile: path.join(rootDir, 'config', 'instances.json'),
  staticDir
} as const;
