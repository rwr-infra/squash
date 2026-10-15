import fs from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ServerLogHistory } from '../instance/instance-types.js';

// Keeping the previous runs' server logs (InstanceConfig.serverLogHistory).
// rwr_server empties its log whenever it starts, so before every start the
// supervisor moves the old one into a directory of its own next to it —
// <cwd>/rwr_server.log.history/ — named after its last write:
// rwr_server.2026-10-15_10-30-00.log. Then the backups past either limit go.
//
// Only what squash named is ever deleted: regular files directly in that
// directory whose names have exactly this log's backup format. Anything else
// there — other files, directories, symlinks — is left alone.

export const SERVER_LOG_HISTORY_LIMITS = {
  keepDays: { min: 1, max: 3650 },
  keepFiles: { min: 1, max: 1000 }
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
// Backups last written within the same second get -1, -2, … after the time.
const MAX_SUFFIX = 9999;

const inRange = (value: unknown, limits: { readonly min: number; readonly max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= limits.min && value <= limits.max;

// The config's setting; undefined = off (missing, or a hand-edited value the
// API would refuse).
export const serverLogHistoryOf = (config: { readonly serverLogHistory?: unknown }): ServerLogHistory | undefined => {
  const value = config.serverLogHistory;
  if (typeof value !== 'object' || value === null) return undefined;
  const { keepDays, keepFiles } = value as Record<string, unknown>;
  return inRange(keepDays, SERVER_LOG_HISTORY_LIMITS.keepDays) && inRange(keepFiles, SERVER_LOG_HISTORY_LIMITS.keepFiles)
    ? { keepDays, keepFiles }
    : undefined;
};

// <cwd>/rwr_server.log → <cwd>/rwr_server.log.history
export const historyDirOf = (logPath: string): string => path.join(path.dirname(logPath), `${path.basename(logPath)}.history`);

// rwr_server.log → rwr_server + .log
const splitName = (logName: string) => {
  const ext = path.extname(logName);
  return { stem: logName.slice(0, logName.length - ext.length), ext };
};

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

// The server's local time, without the `:` Windows forbids in a file name:
// 2026-10-15_10-30-00.
export const archiveStamp = (date: Date): string =>
  `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

// rwr_server.log, last written at 10:30:00 → rwr_server.2026-10-15_10-30-00.log
// (suffix 1 → rwr_server.2026-10-15_10-30-00-1.log).
export const archiveName = (logName: string, lastWritten: Date, suffix = 0): string => {
  const { stem, ext } = splitName(logName);
  return `${stem}.${archiveStamp(lastWritten)}${suffix > 0 ? `-${suffix}` : ''}${ext}`;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Case-sensitive: a name squash did not write the way it writes them is not
// one of its backups (so after the log file is renamed, case included, the
// old backups are left alone). Compared in NFC: HFS+ lists names in NFD.
const archiveMatcher = (logName: string): ((name: string) => { readonly stamp: string; readonly suffix: number } | undefined) => {
  const { stem, ext } = splitName(logName.normalize('NFC'));
  const pattern = new RegExp(`^${escapeRegExp(stem)}\\.(\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})(?:-([1-9]\\d{0,3}))?${escapeRegExp(ext)}$`);
  return name => {
    const match = pattern.exec(name.normalize('NFC'));
    return match ? { stamp: match[1]!, suffix: match[2] === undefined ? 0 : Number(match[2]) } : undefined;
  };
};

// Whether `name` has the format of a backup of the log named `logName`.
export const isArchiveName = (logName: string, name: string): boolean => archiveMatcher(logName)(name) !== undefined;

// Nothing at all at `target` — not even a dangling symlink.
const isFree = (target: string): boolean => {
  try {
    fs.lstatSync(target);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
};

// The history directory itself, never a symlink (or junction) to one
// elsewhere: backups are moved into it and deleted from it.
const isRealDirectory = (dir: string): boolean => fs.lstatSync(dir).isDirectory();

// Moves the log into its history directory; returns the backup's name, or
// undefined when there is nothing to keep: no log, an empty one, or not a
// regular file (a symlink or a directory is the user's own arrangement).
// Never replaces a file — unless another process creates one under the same
// name between the check and the rename; squash itself runs this
// synchronously. Synchronous on purpose: the supervisor calls it right before
// the spawn, with no await in between for a stop to slip into; a rename on
// one volume takes no time, however large the file. Throws when it can't (the
// directory's name taken by a file or a symlink, permissions, a mount point
// in between): the caller logs that and starts anyway.
export const archiveServerLog = (logPath: string): string | undefined => {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!info.isFile() || info.size === 0) return undefined;
  const dir = historyDirOf(logPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!isRealDirectory(dir)) throw new Error(`${path.basename(dir)} is not a directory (a symlink?)`);
  const logName = path.basename(logPath);
  const stamp = archiveStamp(info.mtime);
  const keyOf = archiveMatcher(logName);
  // From one past the highest suffix in use for this time, not the first
  // free one: a name the limits freed is not given to a later run, so the
  // names there keep the order their backups were made in (mtimes may be
  // whole seconds). Past the last suffix (names put there by hand), round
  // to the first free one.
  const next = fs.readdirSync(dir).reduce((highest, name) => {
    const key = keyOf(name);
    return key?.stamp === stamp ? Math.max(highest, key.suffix) : highest;
  }, -1) + 1;
  for (let step = 0; step <= MAX_SUFFIX; step++) {
    const name = archiveName(logName, info.mtime, (next + step) % (MAX_SUFFIX + 1));
    const target = path.join(dir, name);
    if (isFree(target)) {
      fs.renameSync(logPath, target);
      return name;
    }
  }
  throw new Error(`${MAX_SUFFIX + 1} backups were already last written at ${archiveStamp(info.mtime)}`);
};

export type ServerLogArchive = {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
};

// The log's backups, newest first: by last write, then by the time and
// suffix in their names. None when the history directory is missing, or is
// a file or a symlink. An entry that can't be looked at is left out.
export const listServerLogArchives = async (logPath: string): Promise<ServerLogArchive[]> => {
  const dir = historyDirOf(logPath);
  const keyOf = archiveMatcher(path.basename(logPath));
  let names: string[];
  try {
    if (!(await lstat(dir)).isDirectory()) return [];
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const archives: Array<ServerLogArchive & { readonly key: { readonly stamp: string; readonly suffix: number } }> = [];
  for (const name of names) {
    const key = keyOf(name);
    if (!key) continue;
    let info: fs.Stats;
    try {
      info = await lstat(path.join(dir, name));
    } catch {
      // Gone since the listing, or locked (Windows: pending deletion).
      continue;
    }
    if (!info.isFile()) continue;
    archives.push({ name, size: info.size, mtimeMs: info.mtimeMs, key });
  }
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.key.stamp === b.key.stamp ? b.key.suffix - a.key.suffix : a.key.stamp < b.key.stamp ? 1 : -1));
  return archives.map(({ name, size, mtimeMs }) => ({ name, size, mtimeMs }));
};

// One backup to read, by name: its path, or undefined unless the name has
// the log's backup format and is a regular file in the history directory
// (itself no symlink) — as listServerLogArchives would list it. The name
// has no separator, so the path stays in the history directory. The checks
// are as of now: whoever can write there can swap in a link before the
// file is opened (as with the log itself, which may be a link).
export const resolveServerLogArchive = async (logPath: string, name: string): Promise<string | undefined> => {
  if (!isArchiveName(path.basename(logPath), name)) return undefined;
  const dir = historyDirOf(logPath);
  const archivePath = path.join(dir, name);
  try {
    return (await lstat(dir)).isDirectory() && (await lstat(archivePath)).isFile() ? archivePath : undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
};

// The backups the limits remove, from a newest-first list: the ones last
// written more than keepDays ago, and all past the newest keepFiles. Never
// the newest: the log of a run that ended long ago must survive its own
// backup. `newest` names the backup just made, which counts as the newest
// whatever the clock or a reused suffix says.
export const selectExpiredArchives = (archives: readonly ServerLogArchive[], keep: ServerLogHistory, nowMs: number, newest?: string): string[] => {
  const cutoff = nowMs - keep.keepDays * DAY_MS;
  const ordered = newest === undefined ? archives : [...archives.filter(a => a.name === newest), ...archives.filter(a => a.name !== newest)];
  return ordered.filter((archive, index) => index > 0 && (index >= keep.keepFiles || archive.mtimeMs < cutoff)).map(archive => archive.name);
};

export type PruneResult = {
  readonly deleted: readonly string[];
  // `name (CODE)` of each backup that could not be deleted.
  readonly failed: readonly string[];
};

// Deletes the log's backups past the limits (`newest`: the backup just
// made, see selectExpiredArchives). One that is gone already is no failure;
// one that can't be deleted does not stop the others.
export const pruneServerLogArchives = async (
  logPath: string,
  keep: ServerLogHistory,
  { nowMs = Date.now(), newest }: { readonly nowMs?: number; readonly newest?: string } = {}
): Promise<PruneResult> => {
  const dir = historyDirOf(logPath);
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const name of selectExpiredArchives(await listServerLogArchives(logPath), keep, nowMs, newest)) {
    try {
      // unlink removes the entry itself: were it swapped for a symlink since
      // the listing, the link would go, never its target.
      await unlink(path.join(dir, name));
      deleted.push(name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') failed.push(`${name} (${code ?? (err as Error).message})`);
    }
  }
  return { deleted, failed };
};
