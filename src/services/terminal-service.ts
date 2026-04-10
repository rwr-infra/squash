import type { InstanceRegistry } from '../core/instance/instance-registry.js';

export class TerminalService {
  constructor(private readonly registry: InstanceRegistry) {}

  sendCommand(instanceId: string, command: string): void {
    const supervisor = this.registry.getSupervisor(instanceId);
    if (!supervisor) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    supervisor.sendCommand(command);
  }

  sendRawInput(instanceId: string, data: string): void {
    const supervisor = this.registry.getSupervisor(instanceId);
    if (!supervisor) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    supervisor.sendRawInput(data);
  }

  resize(instanceId: string, cols: number, rows: number): void {
    const supervisor = this.registry.getSupervisor(instanceId);
    if (!supervisor) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    supervisor.resize(cols, rows);
  }
}