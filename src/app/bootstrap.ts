import { mkdir } from 'node:fs/promises';
import { appPaths } from './paths.js';

const ensureDir = (target: string) => mkdir(target, { recursive: true });

export const bootstrapApp = async () => {
  await Promise.all([
    ensureDir(appPaths.configDir),
    ensureDir(appPaths.logDir)
  ]);

  return {
    paths: appPaths
  };
};
