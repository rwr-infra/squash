import type { InstanceConfig, InstanceRuntime, InstanceSupervisor } from './instance-types.js';
import { createInstanceSupervisor } from './instance-supervisor.js';
import type { InstanceConfigStore } from '../config/instance-config-store.js';

export type InstanceRegistry = {
  getConfig: (id: string) => InstanceConfig | undefined;
  getRuntime: (id: string) => InstanceRuntime | undefined;
  getSupervisor: (id: string) => InstanceSupervisor | undefined;
  listConfigs: () => readonly InstanceConfig[];
  listRuntimes: () => readonly InstanceRuntime[];
  listSupervisors: () => readonly InstanceSupervisor[];
  register: (config: InstanceConfig, supervisor: InstanceSupervisor) => Promise<void>;
  unregister: (id: string) => Promise<boolean>;
  loadFromStore: (store: InstanceConfigStore) => Promise<void>;
};

export const createInstanceRegistry = async (): Promise<InstanceRegistry> => {
  const configs = new Map<string, InstanceConfig>();
  const supervisors = new Map<string, InstanceSupervisor>();

  return {
    getConfig(id) {
      return configs.get(id);
    },
    // Derived live from the supervisor — the runtime object is recreated on every
    // state change, so caching a snapshot here would go stale immediately.
    getRuntime(id) {
      return supervisors.get(id)?.getRuntime();
    },
    getSupervisor(id) {
      return supervisors.get(id);
    },
    listConfigs() {
      return Array.from(configs.values());
    },
    listRuntimes() {
      return Array.from(supervisors.values(), supervisor => supervisor.getRuntime());
    },
    listSupervisors() {
      return Array.from(supervisors.values());
    },
    async register(config, supervisor) {
      configs.set(config.id, { ...config });
      supervisors.set(config.id, supervisor);
    },
    async unregister(id) {
      const exists = configs.has(id);
      if (exists) {
        configs.delete(id);
        supervisors.delete(id);
      }
      return exists;
    },
    async loadFromStore(store) {
      const allConfigs = await store.list();
      for (const config of allConfigs) {
        configs.set(config.id, { ...config });
        const supervisor = await createInstanceSupervisor(config);
        supervisors.set(config.id, supervisor);
      }
    }
  };
};