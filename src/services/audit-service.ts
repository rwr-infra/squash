import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { appPaths } from '../app/paths.js';

export type AuditAction =
  | 'login'
  | 'logout'
  | 'create'
  | 'start'
  | 'stop'
  | 'restart'
  | 'delete'
  | 'command';

export type AuditEntry = {
  readonly time: string;
  readonly user: string;
  readonly action: AuditAction;
  readonly instanceId?: string;
  readonly detail?: string;
};

const MAX_IN_MEMORY = 500;

export class AuditService {
  private readonly filePath = path.join(appPaths.logDir, 'audit.log');
  private recent: AuditEntry[] = [];
  private loaded = false;

  /** Lazily load the tail of the audit log into memory on first query. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const content = await readFile(this.filePath, 'utf8');
      const entries = content
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditEntry);
      this.recent = entries.slice(-MAX_IN_MEMORY);
    } catch {
      this.recent = [];
    }
  }

  async record(action: AuditAction, user: string, instanceId?: string, detail?: string): Promise<void> {
    await this.ensureLoaded();
    const entry: AuditEntry = {
      time: new Date().toISOString(),
      user,
      action,
      ...(instanceId ? { instanceId } : {}),
      ...(detail ? { detail } : {})
    };
    this.recent.push(entry);
    if (this.recent.length > MAX_IN_MEMORY) {
      this.recent = this.recent.slice(-MAX_IN_MEMORY);
    }
    try {
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Persistence is best-effort; the in-memory ring still serves queries.
    }
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    await this.ensureLoaded();
    const capped = Math.min(Math.max(limit, 1), MAX_IN_MEMORY);
    return this.recent.slice(-capped).reverse();
  }
}
