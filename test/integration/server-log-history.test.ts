// Keeping previous server logs, on real files (a temp directory):
//   - archiving moves a non-empty log into <name>.history/ under the time of
//     its last write, contents and mtime unchanged, and leaves no log behind;
//     no log, an empty one, or not a regular file (a symlink, a directory):
//     nothing, not even the directory
//   - a second backup last written in the same second gets -1, the next one
//     past the highest in use (a name the clean-up freed is not reused);
//     nothing is ever replaced, not even a dangling symlink
//   - when it can't — the directory's name is a file, or a symlink/junction
//     to a directory elsewhere — it throws and leaves everything as it was
//   - listing: this log's backups only (regular files with exactly its
//     format), newest first by last write; no directory, a file or a symlink
//     in its place: none
//   - pruning deletes only listed backups past the limits, never the newest
//     nor the one just made; other files, directories and symlinks there (and
//     their targets) stay; each backup that can't be deleted is reported
// Symlink cases run wherever this process can create symlinks (Windows: with
// the privilege, or developer mode); directory links are junctions, which
// Windows allows anyone.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveName,
  archiveServerLog,
  historyDirOf,
  listServerLogArchives,
  pruneServerLogArchives
} from '../../src/core/log/server-log-history.js';
import { useTempDir } from '../helpers/temp-dir.js';

const DAY = 24 * 60 * 60 * 1000;

const root = useTempDir('squash-server-log-history-test-');
let canSymlink = false;
beforeAll(() => {
  const target = path.join(root(), 'probe-target');
  fs.writeFileSync(target, '');
  try {
    fs.symlinkSync(target, path.join(root(), 'probe-link'));
    canSymlink = true;
  } catch {
    canSymlink = false;
  }
});

let cwd = '';
let logPath = '';
let historyDir = '';
let caseNumber = 0;

// A fresh working directory per test.
beforeEach(() => {
  cwd = path.join(root(), `case-${++caseNumber}`);
  fs.mkdirSync(cwd);
  logPath = path.join(cwd, 'rwr_server.log');
  historyDir = historyDirOf(logPath);
});

const writeAt = (filePath: string, content: string, mtime: Date) => {
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, mtime, mtime);
};
const dirListing = (dir: string) => fs.readdirSync(dir).sort();
// A directory link: a junction on Windows (no privilege needed), a symlink elsewhere.
const linkDirectory = (target: string, link: string) => fs.symlinkSync(target, link, 'junction');

describe('archiving', () => {
  it('moves the log into the history directory, named after its last write', () => {
    const lastWritten = new Date(2026, 9, 15, 10, 30, 0);
    writeAt(logPath, 'run 1\n', lastWritten);
    const name = archiveServerLog(logPath);
    expect(name).toBe('rwr_server.2026-10-15_10-30-00.log');
    expect(fs.existsSync(logPath)).toBe(false);
    const backup = path.join(historyDir, name!);
    expect(fs.readFileSync(backup, 'utf8')).toBe('run 1\n');
    expect(Math.round(fs.statSync(backup).mtimeMs / 1000)).toBe(lastWritten.getTime() / 1000);
    expect(dirListing(cwd)).toEqual(['rwr_server.log.history']);
  });

  it('no log: nothing, no directory', () => {
    expect(archiveServerLog(logPath)).toBeUndefined();
    expect(dirListing(cwd)).toEqual([]);
  });

  it('an empty log: left where it is, no directory', () => {
    fs.writeFileSync(logPath, '');
    expect(archiveServerLog(logPath)).toBeUndefined();
    expect(dirListing(cwd)).toEqual(['rwr_server.log']);
  });

  it('the same second again: -1, then -2; earlier backups untouched', () => {
    const lastWritten = new Date(2026, 9, 15, 10, 30, 0);
    const names = ['first', 'second', 'third'].map(content => {
      writeAt(logPath, content, lastWritten);
      return archiveServerLog(logPath);
    });
    expect(names).toEqual(['rwr_server.2026-10-15_10-30-00.log', 'rwr_server.2026-10-15_10-30-00-1.log', 'rwr_server.2026-10-15_10-30-00-2.log']);
    expect(names.map(name => fs.readFileSync(path.join(historyDir, name!), 'utf8'))).toEqual(['first', 'second', 'third']);
    // A name freed by the clean-up is not reused: the next is -3.
    fs.rmSync(path.join(historyDir, names[0]!));
    writeAt(logPath, 'fourth', lastWritten);
    expect(archiveServerLog(logPath)).toBe('rwr_server.2026-10-15_10-30-00-3.log');
    expect(names.slice(1).map(name => fs.readFileSync(path.join(historyDir, name!), 'utf8'))).toEqual(['second', 'third']);
  });

  it('past the last suffix (a name put there by hand): the first free one, nothing replaced', () => {
    const lastWritten = new Date(2026, 9, 15, 10, 30, 0);
    fs.mkdirSync(historyDir);
    const last = path.join(historyDir, archiveName('rwr_server.log', lastWritten, 9999));
    fs.writeFileSync(last, 'mine');
    writeAt(logPath, 'run', lastWritten);
    expect(archiveServerLog(logPath)).toBe('rwr_server.2026-10-15_10-30-00.log');
    writeAt(logPath, 'run 2', lastWritten);
    expect(archiveServerLog(logPath)).toBe('rwr_server.2026-10-15_10-30-00-1.log');
    expect(fs.readFileSync(last, 'utf8')).toBe('mine');
  });

  it('a dangling symlink under the backup name is not replaced', ctx => {
    if (!canSymlink) return ctx.skip();
    const lastWritten = new Date(2026, 9, 15, 10, 30, 0);
    fs.mkdirSync(historyDir);
    fs.symlinkSync(path.join(cwd, 'nowhere'), path.join(historyDir, archiveName('rwr_server.log', lastWritten)));
    writeAt(logPath, 'run', lastWritten);
    expect(archiveServerLog(logPath)).toBe('rwr_server.2026-10-15_10-30-00-1.log');
    expect(fs.lstatSync(path.join(historyDir, 'rwr_server.2026-10-15_10-30-00.log')).isSymbolicLink()).toBe(true);
  });

  it('the directory name taken by a file: throws, log and file unchanged', () => {
    fs.writeFileSync(historyDir, 'mine');
    fs.writeFileSync(logPath, 'run');
    expect(() => archiveServerLog(logPath)).toThrow(/EEXIST|ENOTDIR/);
    expect(fs.readFileSync(logPath, 'utf8')).toBe('run');
    expect(fs.readFileSync(historyDir, 'utf8')).toBe('mine');
  });

  it('the directory is a link to one elsewhere: throws, nothing moved there', () => {
    const elsewhere = path.join(cwd, 'elsewhere');
    fs.mkdirSync(elsewhere);
    linkDirectory(elsewhere, historyDir);
    fs.writeFileSync(logPath, 'run');
    expect(() => archiveServerLog(logPath)).toThrow('rwr_server.log.history is not a directory');
    expect(fs.readFileSync(logPath, 'utf8')).toBe('run');
    expect(dirListing(elsewhere)).toEqual([]);
  });

  it('the log is a symlink: nothing, link and target unchanged, no directory', ctx => {
    if (!canSymlink) return ctx.skip();
    const target = path.join(cwd, 'elsewhere.log');
    fs.writeFileSync(target, 'theirs');
    fs.symlinkSync(target, logPath);
    expect(archiveServerLog(logPath)).toBeUndefined();
    expect(fs.lstatSync(logPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('theirs');
    expect(fs.existsSync(historyDir)).toBe(false);
  });

  it('the log is a directory: nothing, unchanged, no directory', () => {
    fs.mkdirSync(logPath);
    fs.writeFileSync(path.join(logPath, 'inside'), 'x');
    expect(archiveServerLog(logPath)).toBeUndefined();
    expect(dirListing(logPath)).toEqual(['inside']);
    expect(fs.existsSync(historyDir)).toBe(false);
  });

  it('a log in a subdirectory gets its history next to it', () => {
    const nested = path.join(cwd, 'logs', 'console.txt');
    fs.mkdirSync(path.dirname(nested));
    writeAt(nested, 'x', new Date(2026, 0, 2, 3, 4, 5));
    expect(archiveServerLog(nested)).toBe('console.2026-01-02_03-04-05.txt');
    expect(dirListing(path.join(cwd, 'logs'))).toEqual(['console.txt.history']);
  });
});

describe('listing and pruning', () => {
  const now = Date.now();
  const backup = (ageMs: number, suffix = 0) => {
    const mtime = new Date(now - ageMs);
    const name = archiveName('rwr_server.log', mtime, suffix);
    writeAt(path.join(historyDir, name), name, mtime);
    return name;
  };

  it('no history directory, or a file in its place: no backups, nothing deleted', async () => {
    expect(await listServerLogArchives(logPath)).toEqual([]);
    fs.writeFileSync(historyDir, 'mine');
    expect(await listServerLogArchives(logPath)).toEqual([]);
    expect(await pruneServerLogArchives(logPath, { keepDays: 1, keepFiles: 1 })).toEqual({ deleted: [], failed: [] });
    expect(fs.readFileSync(historyDir, 'utf8')).toBe('mine');
  });

  it('the directory is a link to one elsewhere: no backups, nothing deleted there', async () => {
    const elsewhere = path.join(cwd, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const names = [0, 30 * DAY, 31 * DAY].map(age => {
      const name = archiveName('rwr_server.log', new Date(now - age));
      writeAt(path.join(elsewhere, name), 'theirs', new Date(now - age));
      return name;
    });
    linkDirectory(elsewhere, historyDir);
    expect(await listServerLogArchives(logPath)).toEqual([]);
    expect(await pruneServerLogArchives(logPath, { keepDays: 7, keepFiles: 1 }, { nowMs: now })).toEqual({ deleted: [], failed: [] });
    expect(dirListing(elsewhere)).toEqual(names.sort());
  });

  it('newest first, by last write, then by suffix; size and mtime as on disk', async () => {
    fs.mkdirSync(historyDir);
    const old = backup(3 * DAY);
    const newest = backup(1000);
    const sameSecond = backup(1000, 1);
    const sameSecond10 = backup(1000, 10);
    const sameSecond9 = backup(1000, 9);
    const listed = await listServerLogArchives(logPath);
    expect(listed.map(archive => archive.name)).toEqual([sameSecond10, sameSecond9, sameSecond, newest, old]);
    expect(listed[0]).toEqual({ name: sameSecond10, size: sameSecond10.length, mtimeMs: fs.statSync(path.join(historyDir, sameSecond10)).mtimeMs });
  });

  it('the last write decides, not the time in the name', async () => {
    fs.mkdirSync(historyDir);
    // Named as if older, written last — and the other way round.
    const namedOld = archiveName('rwr_server.log', new Date(now - 5 * DAY));
    const namedNew = archiveName('rwr_server.log', new Date(now - DAY));
    writeAt(path.join(historyDir, namedOld), 'a', new Date(now - 1000));
    writeAt(path.join(historyDir, namedNew), 'b', new Date(now - 10 * DAY));
    expect((await listServerLogArchives(logPath)).map(archive => archive.name)).toEqual([namedOld, namedNew]);
    expect(await pruneServerLogArchives(logPath, { keepDays: 7, keepFiles: 50 }, { nowMs: now })).toEqual({ deleted: [namedNew], failed: [] });
  });

  it('only this log’s backups count; pruning deletes past the limits, never the newest, and nothing else', async () => {
    fs.mkdirSync(historyDir);
    const keep = [backup(0), backup(DAY), backup(2 * DAY)];
    const tooOld = [backup(8 * DAY), backup(30 * DAY)];
    // Not backups of this log: never listed, never deleted.
    const others = ['notes.txt', 'rwr_server.log', 'rwr_server.2026-10-05_07-03-09.log.bak', 'RWR_SERVER.2026-10-05_07-03-09.LOG', 'console.2026-10-05_07-03-09.log'];
    for (const name of others) writeAt(path.join(historyDir, name), 'other', new Date(now - 100 * DAY));
    // Backup-shaped, but a directory (with a file inside).
    const dirLike = archiveName('rwr_server.log', new Date(now - 90 * DAY));
    fs.mkdirSync(path.join(historyDir, dirLike));
    fs.writeFileSync(path.join(historyDir, dirLike, 'inside.log'), 'inside');
    // Backup-shaped links to a file and to a directory outside: neither the
    // links nor their targets go.
    const outside = path.join(cwd, 'precious.log');
    fs.writeFileSync(outside, 'precious');
    const outsideDir = path.join(cwd, 'precious');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'inside.log'), 'precious');
    const fileLinkLike = archiveName('rwr_server.log', new Date(now - 80 * DAY));
    const dirLinkLike = archiveName('rwr_server.log', new Date(now - 70 * DAY));
    if (canSymlink) fs.symlinkSync(outside, path.join(historyDir, fileLinkLike));
    linkDirectory(outsideDir, path.join(historyDir, dirLinkLike));

    expect((await listServerLogArchives(logPath)).map(archive => archive.name)).toEqual([...keep, ...tooOld]);
    const result = await pruneServerLogArchives(logPath, { keepDays: 7, keepFiles: 50 }, { nowMs: now });
    expect(result).toEqual({ deleted: tooOld, failed: [] });
    expect(dirListing(historyDir)).toEqual([...keep, ...others, dirLike, dirLinkLike, ...(canSymlink ? [fileLinkLike] : [])].sort());
    expect(fs.readFileSync(path.join(historyDir, dirLike, 'inside.log'), 'utf8')).toBe('inside');
    expect(fs.readFileSync(path.join(outsideDir, 'inside.log'), 'utf8')).toBe('precious');
    if (canSymlink) {
      expect(fs.readFileSync(outside, 'utf8')).toBe('precious');
      expect(fs.lstatSync(path.join(historyDir, fileLinkLike)).isSymbolicLink()).toBe(true);
    }
  });

  it('keepFiles: the newest ones stay', async () => {
    fs.mkdirSync(historyDir);
    const names = [backup(0), backup(1000), backup(2000), backup(3000)];
    expect(await pruneServerLogArchives(logPath, { keepDays: 7, keepFiles: 2 }, { nowMs: now })).toEqual({ deleted: names.slice(2), failed: [] });
    expect(dirListing(historyDir)).toEqual(names.slice(0, 2).sort());
  });

  it('the newest survives however old it is', async () => {
    fs.mkdirSync(historyDir);
    const names = [backup(40 * DAY), backup(41 * DAY)];
    expect(await pruneServerLogArchives(logPath, { keepDays: 7, keepFiles: 50 }, { nowMs: now })).toEqual({ deleted: [names[1]], failed: [] });
    expect(dirListing(historyDir)).toEqual([names[0]]);
  });

  it('the backup just made survives, whatever the other mtimes say', async () => {
    fs.mkdirSync(historyDir);
    // A clock set back: an older backup looks newer than the one just made.
    const future = backup(-DAY);
    const justMade = backup(40 * DAY);
    expect(await pruneServerLogArchives(logPath, { keepDays: 7, keepFiles: 1 }, { nowMs: now, newest: justMade })).toEqual({ deleted: [future], failed: [] });
    expect(dirListing(historyDir)).toEqual([justMade]);
  });

  it('the live log next to the directory is never touched', async () => {
    fs.mkdirSync(historyDir);
    backup(0);
    backup(9 * DAY);
    fs.writeFileSync(logPath, 'live');
    await pruneServerLogArchives(logPath, { keepDays: 1, keepFiles: 1 }, { nowMs: now });
    expect(fs.readFileSync(logPath, 'utf8')).toBe('live');
  });

  // A directory without write permission refuses deletes, except to root.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('backups that cannot be deleted are reported, each one tried', async () => {
    fs.mkdirSync(historyDir);
    const names = [backup(0), backup(8 * DAY), backup(9 * DAY)];
    fs.chmodSync(historyDir, 0o555);
    try {
      const result = await pruneServerLogArchives(logPath, { keepDays: 7, keepFiles: 50 }, { nowMs: now });
      expect(result.deleted).toEqual([]);
      expect(result.failed).toEqual([`${names[1]} (EACCES)`, `${names[2]} (EACCES)`]);
    } finally {
      fs.chmodSync(historyDir, 0o755);
    }
    expect(dirListing(historyDir)).toEqual([...names].sort());
  });
});
