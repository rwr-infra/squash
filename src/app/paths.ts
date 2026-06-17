import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFilePath = fileURLToPath(import.meta.url);
const srcDir = path.dirname(path.dirname(currentFilePath));
const rootDir = path.dirname(srcDir);

export const appPaths = {
  rootDir,
  srcDir,
  configDir: path.join(rootDir, 'config'),
  logDir: path.join(rootDir, 'logs'),
  instanceConfigFile: path.join(rootDir, 'config', 'instances.json'),
  // Derived from this file's location (src/ in dev, dist/ when compiled), so it
  // resolves correctly regardless of cwd — both `tsx src/index.ts` and a packaged
  // `node dist/index.js` find the bundled frontend next to the app root.
  staticDir: path.join(rootDir, 'frontend', 'dist')
} as const;
