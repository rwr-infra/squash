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
  instanceConfigFile: path.join(rootDir, 'config', 'instances.json')
} as const;
