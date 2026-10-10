import { readFile, writeFile } from 'node:fs/promises';
import { appPaths } from '../../app/paths.js';
import type { InstanceConfig } from '../instance/instance-types.js';
import { serverLogFileOf } from '../log/server-log-file.js';

export type InstanceConfigStore = {
  list: () => Promise<InstanceConfig[]>;
  save: (config: InstanceConfig) => Promise<void>;
  delete: (id: string) => Promise<boolean>;
};

const readConfigsFromDisk = async (filePath: string): Promise<InstanceConfig[]> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // A config saved before serverLogFile existed gets the inferred value in
    // memory; the file keeps it only from the next save on.
    return Array.isArray(parsed)
      ? (parsed as InstanceConfig[]).map(config =>
          typeof config === 'object' && config !== null ? { ...config, serverLogFile: serverLogFileOf(config) } : config
        )
      : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
};

export const createInstanceConfigStore = async (): Promise<InstanceConfigStore> => {
  const filePath = appPaths.instanceConfigFile;
  const initial = await readConfigsFromDisk(filePath);
  const configs = new Map<string, InstanceConfig>(initial.map(config => [config.id, config]));

  const persist = async () => {
    const payload = JSON.stringify(Array.from(configs.values()), null, 2);
    await writeFile(filePath, payload, 'utf8');
  };

  return {
    async list() {
      return Array.from(configs.values());
    },
    async save(config) {
      configs.set(config.id, { ...config });
      await persist();
    },
    async delete(id) {
      const existed = configs.delete(id);
      if (existed) {
        await persist();
      }
      return existed;
    }
  };
};
