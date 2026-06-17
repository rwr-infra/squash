import { readFile, writeFile } from 'node:fs/promises';
import { appPaths } from '../../app/paths.js';
import type { InstanceConfig } from '../instance/instance-types.js';

export type InstanceConfigStore = {
  list: () => Promise<InstanceConfig[]>;
  save: (config: InstanceConfig) => Promise<void>;
  delete: (id: string) => Promise<boolean>;
};

const readConfigsFromDisk = async (filePath: string): Promise<InstanceConfig[]> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InstanceConfig[]) : [];
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
