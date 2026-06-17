import type { InstanceConfig, InstanceRuntime } from '../core/instance/instance-types.js';
import type { InstanceRegistry } from '../core/instance/instance-registry.js';
import type { InstanceConfigStore } from '../core/config/instance-config-store.js';
import { createInstanceSupervisor } from '../core/instance/instance-supervisor.js';

export class InstanceService {
  constructor(
    private readonly registry: InstanceRegistry,
    private readonly configStore: InstanceConfigStore
  ) {}

  async createInstance(config: InstanceConfig): Promise<InstanceConfig> {
    const existing = this.registry.getConfig(config.id);
    if (existing) {
      throw new Error(`Instance with id ${config.id} already exists`);
    }

    const supervisor = await createInstanceSupervisor(config);
    await this.configStore.save(config);
    await this.registry.register(config, supervisor);
    return { ...config };
  }

  async updateInstance(config: InstanceConfig): Promise<InstanceConfig | undefined> {
    const existing = this.registry.getConfig(config.id);
    if (!existing) {
      return undefined;
    }

    const runtime = this.registry.getRuntime(config.id);
    if (runtime && runtime.status !== 'stopped' && runtime.status !== 'crashed') {
      throw new Error(`Cannot edit instance ${config.id} while it is ${runtime.status}`);
    }

    // Rebuild the supervisor: it captures config (executable/cwd/args/logDir) at
    // construction, so the only correct way to apply changes is a fresh one.
    this.registry.getSupervisor(config.id)?.dispose();
    const supervisor = await createInstanceSupervisor(config);
    await this.configStore.save(config);
    await this.registry.register(config, supervisor);
    return { ...config };
  }

  async listInstances(): Promise<Array<{ config: InstanceConfig; runtime: InstanceRuntime }>> {
    return this.registry.listConfigs().map(config => ({
      config,
      runtime: this.registry.getRuntime(config.id)!
    }));
  }

  async getInstance(id: string): Promise<{ config: InstanceConfig; runtime: InstanceRuntime } | undefined> {
    const config = this.registry.getConfig(id);
    if (!config) {
      return undefined;
    }

    const runtime = this.registry.getRuntime(id)!;
    return { config, runtime };
  }

  async startInstance(id: string): Promise<InstanceRuntime | undefined> {
    const supervisor = this.registry.getSupervisor(id);
    if (!supervisor) {
      return undefined;
    }

    await supervisor.start();
    return supervisor.getRuntime();
  }

  async stopInstance(id: string): Promise<InstanceRuntime | undefined> {
    const supervisor = this.registry.getSupervisor(id);
    if (!supervisor) {
      return undefined;
    }

    supervisor.stop();
    return supervisor.getRuntime();
  }

  async restartInstance(id: string): Promise<InstanceRuntime | undefined> {
    const supervisor = this.registry.getSupervisor(id);
    if (!supervisor) {
      return undefined;
    }

    await supervisor.restart();
    return supervisor.getRuntime();
  }

  async deleteInstance(id: string): Promise<boolean> {
    const runtime = this.registry.getRuntime(id);
    if (runtime && runtime.status !== 'stopped' && runtime.status !== 'crashed') {
      throw new Error(`Cannot delete running instance ${id}`);
    }

    this.registry.getSupervisor(id)?.dispose();
    const deleted = await this.configStore.delete(id);
    if (deleted) {
      await this.registry.unregister(id);
    }
    return deleted;
  }
}