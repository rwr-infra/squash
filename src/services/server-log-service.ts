import path from 'node:path';
import type { InstanceRegistry } from '../core/instance/instance-registry.js';
import type { ServerLogHistory } from '../core/instance/instance-types.js';
import { createLineIndex, StaleIndexError } from '../core/log/line-index.js';
import type { LineIndex, LineIndexSnapshot, LineRange, SearchResult } from '../core/log/line-index.js';
import { resolveServerLogPath, serverLogFileOf } from '../core/log/server-log-file.js';
import { isArchiveName, listServerLogArchives, resolveServerLogArchive, serverLogHistoryOf } from '../core/log/server-log-history.js';

// Reads that found the file rewritten since the refresh before them are
// retried this many times (after another refresh) before giving up.
const STALE_RETRIES = 2;
// Indexes of backups kept for the next read, across instances; the least
// recently read goes first. A backup no longer changes: its index stays
// right as long as it is kept, and a new one keeps its generation.
export const MAX_ARCHIVE_INDEXES = 8;

export type ServerLogInfo = LineIndexSnapshot & {
  readonly path: string;
  // As configured: relative to the working directory.
  readonly file: string;
  // The backup read instead of the log (a name in its history), if one was.
  readonly archive?: string;
};

export type ServerLogArchiveInfo = {
  readonly name: string;
  readonly size: number;
  // When the run it holds last wrote to it.
  readonly modifiedAt: string;
};

export type ServerLogHistoryInfo = {
  readonly file: string;
  // The instance's setting; null = off. Backups made while it was on are
  // listed all the same.
  readonly keep: ServerLogHistory | null;
  // Newest first.
  readonly archives: readonly ServerLogArchiveInfo[];
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

// The name asked for is not one a backup of this instance's log can have.
export class InvalidServerLogArchiveError extends Error {
  constructor(name: string) {
    super(`${JSON.stringify(name)} is not the name of a server log backup`);
    this.name = 'InvalidServerLogArchiveError';
  }
}

// No such backup (any more): never made, or deleted by the limits.
export class ServerLogArchiveNotFoundError extends Error {
  constructor(instanceId: string, name: string) {
    super(`Instance ${instanceId} has no server log backup ${name}`);
    this.name = 'ServerLogArchiveNotFoundError';
  }
}

type Entry = { readonly file: string; readonly path: string; readonly index: LineIndex; readonly archive?: string };

export class ServerLogService {
  // One index per instance, kept while its file stays the same (an edit may
  // change the working directory or the file). The index is what keeps the
  // generation.
  private readonly indexes = new Map<string, Entry>();
  // Backups' indexes by path, least recently read first.
  private readonly archiveIndexes = new Map<string, Entry>();

  constructor(private readonly registry: InstanceRegistry) {}

  // The instance's log file; undefined = no such instance. Throws
  // ServerLogDisabledError when it has none to show.
  private logFileOf(instanceId: string): { readonly file: string; readonly path: string; readonly keep: ServerLogHistory | undefined } | undefined {
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
    return { file, path: filePath, keep: serverLogHistoryOf(config) };
  }

  // The live log's index, or with `archive` a backup's. undefined = no such
  // instance. Throws ServerLogDisabledError (no log file),
  // InvalidServerLogArchiveError (not a backup's name) or
  // ServerLogArchiveNotFoundError (no such backup).
  private async entryFor(instanceId: string, archive?: string): Promise<Entry | undefined> {
    const log = this.logFileOf(instanceId);
    if (!log) return undefined;
    if (archive === undefined) {
      const existing = this.indexes.get(instanceId);
      if (existing?.path === log.path && existing.file === log.file) return existing;
      const entry = { file: log.file, path: log.path, index: createLineIndex(log.path) };
      this.indexes.set(instanceId, entry);
      return entry;
    }
    if (!isArchiveName(path.basename(log.path), archive)) throw new InvalidServerLogArchiveError(archive);
    // Looked up on every read: the limits may have deleted it since.
    const archivePath = await resolveServerLogArchive(log.path, archive);
    if (archivePath === undefined) throw new ServerLogArchiveNotFoundError(instanceId, archive);
    const entry = this.archiveIndexes.get(archivePath) ?? { file: log.file, path: archivePath, index: createLineIndex(archivePath, { stableGeneration: true }), archive };
    this.archiveIndexes.delete(archivePath);
    this.archiveIndexes.set(archivePath, entry);
    for (const oldest of this.archiveIndexes.keys()) {
      if (this.archiveIndexes.size <= MAX_ARCHIVE_INDEXES) break;
      this.archiveIndexes.delete(oldest);
    }
    // As this instance's config spells the file (another may share the path).
    return entry.file === log.file ? entry : { ...entry, file: log.file };
  }

  // Brings the index up to date. A backup found gone (deleted since it was
  // looked up) is no backup: dropped, and an error, not an empty file.
  private async refresh(instanceId: string, entry: Entry): Promise<LineIndexSnapshot> {
    const snapshot = await entry.index.refresh();
    if (entry.archive !== undefined && !snapshot.exists) {
      this.archiveIndexes.delete(entry.path);
      throw new ServerLogArchiveNotFoundError(instanceId, entry.archive);
    }
    return snapshot;
  }

  // The configured file (or the backup), for messages; undefined = no such
  // instance.
  fileOf(instanceId: string, archive?: string): string | undefined {
    const config = this.registry.getConfig(instanceId);
    if (!config) return undefined;
    return archive === undefined ? serverLogFileOf(config) : `${serverLogFileOf(config)}.history/${archive}`;
  }

  // The instance's backups, newest first. undefined = no such instance;
  // throws ServerLogDisabledError when it has no log file.
  async listArchives(instanceId: string): Promise<ServerLogHistoryInfo | undefined> {
    const log = this.logFileOf(instanceId);
    if (!log) return undefined;
    const archives = await listServerLogArchives(log.path);
    return {
      file: log.file,
      keep: log.keep ?? null,
      // Rounded like fs.Stats' dates: an mtime set to a whole millisecond can
      // come back a hair below it.
      archives: archives.map(archive => ({ name: archive.name, size: archive.size, modifiedAt: new Date(Math.round(archive.mtimeMs)).toISOString() }))
    };
  }

  // Refreshes, then runs `read` on the up-to-date index; refreshes again
  // when the file changed in between.
  private async fresh<T>(instanceId: string, entry: Entry, read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.refresh(instanceId, entry);
      try {
        return await read();
      } catch (err) {
        if (!(err instanceof StaleIndexError) || attempt >= STALE_RETRIES) throw err;
      }
    }
  }

  // `archive` (here and below): read that backup instead of the log.
  async getInfo(instanceId: string, archive?: string): Promise<ServerLogInfo | undefined> {
    const entry = await this.entryFor(instanceId, archive);
    if (!entry) return undefined;
    const info = { ...(await this.refresh(instanceId, entry)), path: entry.path, file: entry.file };
    return entry.archive === undefined ? info : { ...info, archive: entry.archive };
  }

  async readLines(instanceId: string, from: number, count: number, archive?: string): Promise<LineRange | undefined> {
    const entry = await this.entryFor(instanceId, archive);
    if (!entry) return undefined;
    return this.fresh(instanceId, entry, () => entry.index.readLines(from, count));
  }

  async search(instanceId: string, query: string, caseSensitive: boolean, limit: number, signal?: AbortSignal, archive?: string): Promise<SearchResult | undefined> {
    const entry = await this.entryFor(instanceId, archive);
    if (!entry) return undefined;
    return this.fresh(instanceId, entry, () => entry.index.search(query, { caseSensitive, limit, signal }));
  }
}
