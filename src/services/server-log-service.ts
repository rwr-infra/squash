import type { InstanceRegistry } from '../core/instance/instance-registry.js';
import { createLineIndex, StaleIndexError } from '../core/log/line-index.js';
import type { LineIndex, LineIndexSnapshot, LineRange, SearchResult } from '../core/log/line-index.js';
import { resolveServerLogPath, serverLogFileOf } from '../core/log/server-log-file.js';

// Reads that found the file rewritten since the refresh before them are
// retried this many times (after another refresh) before giving up.
const STALE_RETRIES = 2;

export type ServerLogInfo = LineIndexSnapshot & {
  readonly path: string;
  // As configured: relative to the working directory.
  readonly file: string;
};

// The instance has no log file to show: none configured, or (hand-edited
// config) one outside its working directory.
export class ServerLogDisabledError extends Error {
  constructor(instanceId: string, file: string) {
    super(
      file === ''
        ? `Instance ${instanceId} has no server log file`
        : `Instance ${instanceId}'s server log file ${JSON.stringify(file)} is not a path inside its working directory`
    );
    this.name = 'ServerLogDisabledError';
  }
}

type Entry = { readonly file: string; readonly path: string; readonly index: LineIndex };

export class ServerLogService {
  // One index per instance, kept while its file stays the same (an edit may
  // change the working directory or the file). The index is what keeps the
  // generation.
  private readonly indexes = new Map<string, Entry>();

  constructor(private readonly registry: InstanceRegistry) {}

  // undefined = no such instance. Throws ServerLogDisabledError when it has
  // no log file to show.
  private entryFor(instanceId: string): Entry | undefined {
    for (const id of this.indexes.keys()) {
      if (!this.registry.getConfig(id)) this.indexes.delete(id);
    }
    const config = this.registry.getConfig(instanceId);
    if (!config) return undefined;
    const file = serverLogFileOf(config);
    const filePath = resolveServerLogPath(config);
    if (filePath === undefined) {
      this.indexes.delete(instanceId);
      throw new ServerLogDisabledError(instanceId, file);
    }
    const existing = this.indexes.get(instanceId);
    if (existing?.path === filePath && existing.file === file) return existing;
    const entry = { file, path: filePath, index: createLineIndex(filePath) };
    this.indexes.set(instanceId, entry);
    return entry;
  }

  // The configured file, for messages; undefined = no such instance.
  fileOf(instanceId: string): string | undefined {
    const config = this.registry.getConfig(instanceId);
    return config ? serverLogFileOf(config) : undefined;
  }

  // Refreshes, then runs `read` on the up-to-date index; refreshes again
  // when the file changed in between.
  private async fresh<T>(entry: Entry, read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await entry.index.refresh();
      try {
        return await read();
      } catch (err) {
        if (!(err instanceof StaleIndexError) || attempt >= STALE_RETRIES) throw err;
      }
    }
  }

  async getInfo(instanceId: string): Promise<ServerLogInfo | undefined> {
    const entry = this.entryFor(instanceId);
    if (!entry) return undefined;
    return { ...(await entry.index.refresh()), path: entry.path, file: entry.file };
  }

  async readLines(instanceId: string, from: number, count: number): Promise<LineRange | undefined> {
    const entry = this.entryFor(instanceId);
    if (!entry) return undefined;
    return this.fresh(entry, () => entry.index.readLines(from, count));
  }

  async search(instanceId: string, query: string, caseSensitive: boolean, limit: number, signal?: AbortSignal): Promise<SearchResult | undefined> {
    const entry = this.entryFor(instanceId);
    if (!entry) return undefined;
    return this.fresh(entry, () => entry.index.search(query, { caseSensitive, limit, signal }));
  }
}
