// Keeping previous server logs (InstanceConfig.serverLogHistory), the parts
// that touch no file:
//   - the setting: both limits required, whole numbers in range, in the
//     instance and the template schemas alike; a hand-edited value outside
//     them means off
//   - backup names: the log's name with the local time of its last write
//     (and a suffix) before the extension; only exactly that format counts
//     as a backup — nothing else in the directory is ever deleted; local
//     time, in either Unicode normal form
//   - which backups the limits remove: older than keepDays, past the newest
//     keepFiles, never the newest — the one just made, when given
//   - the log file's path is resolved inside the working directory or not at all
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveName,
  archiveStamp,
  historyDirOf,
  isArchiveName,
  selectExpiredArchives,
  serverLogHistoryOf,
  type ServerLogArchive
} from '../../src/core/log/server-log-history.js';
import { resolveServerLogPath } from '../../src/core/log/server-log-file.js';
import { CreateInstanceSchema } from '../../src/api/http/schemas/instance-schemas.js';
import { TemplateValuesSchema } from '../../src/api/http/schemas/template-schemas.js';

const DAY = 24 * 60 * 60 * 1000;

describe('the setting', () => {
  const instance = (serverLogHistory: unknown) =>
    CreateInstanceSchema.safeParse({ id: 'a', name: 'a', cwd: '.', executable: './rwr_server', serverLogHistory });
  const template = (serverLogHistory: unknown) => TemplateValuesSchema.safeParse({ serverLogHistory });

  it.each([
    [{ keepDays: 7, keepFiles: 50 }],
    [{ keepDays: 1, keepFiles: 1 }],
    [{ keepDays: 3650, keepFiles: 1000 }]
  ])('accepts %j (instance and template)', value => {
    expect(instance(value).data?.serverLogHistory).toEqual(value);
    expect(template(value).data?.serverLogHistory).toEqual(value);
    expect(serverLogHistoryOf({ serverLogHistory: value })).toEqual(value);
  });

  it.each([
    [{ keepDays: 0, keepFiles: 50 }],
    [{ keepDays: 3651, keepFiles: 50 }],
    [{ keepDays: 7, keepFiles: 0 }],
    [{ keepDays: 7, keepFiles: 1001 }],
    [{ keepDays: 1.5, keepFiles: 50 }],
    [{ keepDays: '7', keepFiles: 50 }],
    [{ keepDays: 7 }],
    [{ keepFiles: 50 }],
    [{ keepDays: 7, keepFiles: 50, extra: 1 }],
    [null],
    [true],
    [7]
  ])('refuses %j (instance and template); as a hand-edited value it means off', value => {
    expect(instance(value).success).toBe(false);
    expect(template(value).success).toBe(false);
    if (!(typeof value === 'object' && value !== null && 'extra' in value)) {
      expect(serverLogHistoryOf({ serverLogHistory: value })).toBeUndefined();
    }
  });

  it('a hand-edited value with an extra key: the limits, the rest ignored', () => {
    expect(serverLogHistoryOf({ serverLogHistory: { keepDays: 7, keepFiles: 50, extra: 1 } })).toEqual({ keepDays: 7, keepFiles: 50 });
  });

  it('left out: off, for an rwr_server instance too (no inference)', () => {
    expect(instance(undefined).data?.serverLogHistory).toBeUndefined();
    expect(serverLogHistoryOf({})).toBeUndefined();
  });
});

describe('backup names', () => {
  const lastWritten = new Date(2026, 9, 5, 7, 3, 9);

  it('local time, zero-padded, no colon', () => {
    expect(archiveStamp(lastWritten)).toBe('2026-10-05_07-03-09');
  });
  it('the server’s time zone, not UTC', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      expect(archiveStamp(new Date(Date.UTC(2026, 9, 15, 18, 30, 0)))).toBe('2026-10-16_02-30-00');
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
  it('rwr_server.log → rwr_server.<time>.log, suffix before the extension', () => {
    expect(archiveName('rwr_server.log', lastWritten)).toBe('rwr_server.2026-10-05_07-03-09.log');
    expect(archiveName('rwr_server.log', lastWritten, 1)).toBe('rwr_server.2026-10-05_07-03-09-1.log');
    expect(archiveName('rwr_server.log', lastWritten, 9999)).toBe('rwr_server.2026-10-05_07-03-09-9999.log');
  });
  it('other names: last extension only; none; a leading dot', () => {
    expect(archiveName('console.log.txt', lastWritten)).toBe('console.log.2026-10-05_07-03-09.txt');
    expect(archiveName('server', lastWritten)).toBe('server.2026-10-05_07-03-09');
    expect(archiveName('.log', lastWritten)).toBe('.log.2026-10-05_07-03-09');
  });
  it('the history directory sits next to the log', () => {
    expect(historyDirOf(path.join('srv', 'logs', 'rwr_server.log'))).toBe(path.join('srv', 'logs', 'rwr_server.log.history'));
  });

  it.each([
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09-1.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09-9999.log'],
    ['server', 'server.2026-10-05_07-03-09'],
    ['a+b(1).log', 'a+b(1).2026-10-05_07-03-09.log']
  ])('%s: %s is a backup', (logName, name) => {
    expect(isArchiveName(logName, name)).toBe(true);
  });

  it('non-ASCII names match in either Unicode normal form (HFS+ lists NFD)', () => {
    const logName = 'serveur_journal_\u00e9t\u00e9.log';
    const listed = archiveName(logName, lastWritten).normalize('NFD');
    expect(listed).not.toBe(archiveName(logName, lastWritten));
    expect(isArchiveName(logName, listed)).toBe(true);
    expect(isArchiveName(logName.normalize('NFD'), archiveName(logName, lastWritten))).toBe(true);
  });

  it.each([
    ['rwr_server.log', 'rwr_server.log'],
    ['rwr_server.log', 'rwr_server.log.history'],
    ['rwr_server.log', 'notes.txt'],
    ['rwr_server.log', ''],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09.log.bak'],
    ['rwr_server.log', 'x-rwr_server.2026-10-05_07-03-09.log'],
    ['rwr_server.log', 'RWR_SERVER.2026-10-05_07-03-09.LOG'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09.txt'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-9.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05 07-03-09.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09-0.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09-01.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09-10000.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09-.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09.log/x'],
    ['rwr_server.log', '../rwr_server.2026-10-05_07-03-09.log'],
    ['rwr_server.log', 'a/rwr_server.2026-10-05_07-03-09.log'],
    ['rwr_server.log', 'a\\rwr_server.2026-10-05_07-03-09.log'],
    ['rwr_server.log', 'rwr_server.2026-10-05_07-03-09.log\n'],
    ['rwr_server.log', 'rwrXserver.2026-10-05_07-03-09.log'],
    ['a+b(1).log', 'aab(1).2026-10-05_07-03-09.log'],
    ['console.log', 'rwr_server.2026-10-05_07-03-09.log']
  ])('%s: %j is not a backup', (logName, name) => {
    expect(isArchiveName(logName, name)).toBe(false);
  });
});

describe('which backups the limits remove', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  // Newest first, as listServerLogArchives returns them.
  const archives = (...ages: number[]): ServerLogArchive[] => ages.map((age, i) => ({ name: `b${i}`, size: 1, mtimeMs: now - age }));

  it('none while within both limits', () => {
    expect(selectExpiredArchives(archives(0, DAY, 6 * DAY), { keepDays: 7, keepFiles: 3 }, now)).toEqual([]);
  });
  it('older than keepDays', () => {
    expect(selectExpiredArchives(archives(0, 6 * DAY, 7 * DAY + 1, 30 * DAY), { keepDays: 7, keepFiles: 50 }, now)).toEqual(['b2', 'b3']);
  });
  it('exactly keepDays old stays', () => {
    expect(selectExpiredArchives(archives(0, 7 * DAY), { keepDays: 7, keepFiles: 50 }, now)).toEqual([]);
  });
  it('past the newest keepFiles', () => {
    expect(selectExpiredArchives(archives(0, 1, 2, 3, 4), { keepDays: 7, keepFiles: 2 }, now)).toEqual(['b2', 'b3', 'b4']);
  });
  it('both limits at once', () => {
    expect(selectExpiredArchives(archives(0, 8 * DAY, 9 * DAY, 1, 2), { keepDays: 7, keepFiles: 4 }, now)).toEqual(['b1', 'b2', 'b4']);
  });
  it('the newest is kept, however old', () => {
    expect(selectExpiredArchives(archives(100 * DAY, 101 * DAY), { keepDays: 7, keepFiles: 50 }, now)).toEqual(['b1']);
    expect(selectExpiredArchives(archives(100 * DAY), { keepDays: 1, keepFiles: 1 }, now)).toEqual([]);
  });
  it('keepFiles 1: only the newest', () => {
    expect(selectExpiredArchives(archives(0, 1, 2), { keepDays: 7, keepFiles: 1 }, now)).toEqual(['b1', 'b2']);
  });
  it('no backups: nothing', () => {
    expect(selectExpiredArchives([], { keepDays: 7, keepFiles: 50 }, now)).toEqual([]);
  });
  it('the backup just made counts as the newest, wherever its mtime sorts it', () => {
    // b0 last written in the future (a clock set back), b1 just made, long ago.
    const list = archives(-DAY, 40 * DAY, 2 * DAY);
    expect(selectExpiredArchives(list, { keepDays: 7, keepFiles: 1 }, now, 'b1')).toEqual(['b0', 'b2']);
    expect(selectExpiredArchives(list, { keepDays: 7, keepFiles: 50 }, now, 'b1')).toEqual([]);
    // Without it the future one is the newest, and the old one goes by age.
    expect(selectExpiredArchives(list, { keepDays: 7, keepFiles: 50 }, now)).toEqual(['b1']);
  });
  it('a `newest` not in the list changes nothing', () => {
    expect(selectExpiredArchives(archives(0, 8 * DAY), { keepDays: 7, keepFiles: 50 }, now, 'gone')).toEqual(['b1']);
  });
});

describe('the log file path', () => {
  const cwd = path.resolve('srv');

  it('inside the working directory, either separator', () => {
    expect(resolveServerLogPath({ cwd, serverLogFile: 'rwr_server.log' })).toBe(path.join(cwd, 'rwr_server.log'));
    expect(resolveServerLogPath({ cwd, serverLogFile: 'logs\\a.log' })).toBe(path.join(cwd, 'logs', 'a.log'));
  });
  it('inferred from the executable when the field is missing', () => {
    expect(resolveServerLogPath({ cwd, executable: './rwr_server' })).toBe(path.join(cwd, 'rwr_server.log'));
    expect(resolveServerLogPath({ cwd, executable: './steamcmd' })).toBeUndefined();
  });
  it.each([[''], ['../x.log'], ['/etc/passwd'], ['a/../../x.log'], ['.'], [5]])('none for %j', serverLogFile => {
    expect(resolveServerLogPath({ cwd, serverLogFile })).toBeUndefined();
  });
});
