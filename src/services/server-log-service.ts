import path from 'node:path';
import type { InstanceRegistry } from '../core/instance/instance-registry.js';
import { createLineIndex, StaleIndexError } from '../core/log/line-index.js';
import type { LineIndex, LineIndexSnapshot, LineRange, SearchResult } from '../core/log/line-index.js';

// rwr_server writes its own log next to itself — in its working directory,
// like rwr_crashdump.dmp — and empties it whenever it starts. The name is
// fixed: nothing a request sends ends up in the path.
export const SERVER_LOG_FILENAME = 'rwr_server.log';

// Reads that found the file rewritten since the refresh before them are
// retried this many times (after another refresh) before giving up.
const STALE_RETRIES = 2;

export type ServerLogInfo = LineIndexSnapshot & {
  readonly path: string;
};

type Entry = { readonly path: string; readonly index: LineIndex };

export class ServerLogService {
  // One index per instance, kept while its path stays the same (an edit may
  // change the working directory). The index is what keeps the generation.
  private readonly indexes = new Map<string, Entry>();

  constructor(private readonly registry: InstanceRegistry) {}

  // undefined = no such instance.
  private entryFor(instanceId: string): Entry | undefined {
    for (const id of this.indexes.keys()) {
      if (!this.registry.getConfig(id)) this.indexes.delete(id);
    }
    const config = this.registry.getConfig(instanceId);
    if (!config) return undefined;
    const filePath = path.resolve(config.cwd, SERVER_LOG_FILENAME);
    const existing = this.indexes.get(instanceId);
    if (existing?.path === filePath) return existing;
    const entry = { path: filePath, index: createLineIndex(filePath) };
    this.indexes.set(instanceId, entry);
    return entry;
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
    return { ...(await entry.index.refresh()), path: entry.path };
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
