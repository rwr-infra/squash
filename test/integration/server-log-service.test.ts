// ServerLogService's indexes of server log backups, watched through the
// real line index and backup lookup (spied on, on real files):
//   - a backup read again reuses its index while it is among the
//     MAX_ARCHIVE_INDEXES read last; reading more drops the least recently
//     read first; a dropped backup read again gets a new index with the
//     same generation (the file did not change)
//   - a backup deleted after it was looked up but before it was read is
//     ServerLogArchiveNotFoundError, not an empty file, and is dropped
//   - a backup's info names the file as the instance's config spells it,
//     also when its index was made for another spelling of the same path
// Uses a temp directory only.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineIndex } from '../../src/core/log/line-index.js';
import { archiveName, historyDirOf, resolveServerLogArchive } from '../../src/core/log/server-log-history.js';
import { MAX_ARCHIVE_INDEXES, ServerLogArchiveNotFoundError, ServerLogService } from '../../src/services/server-log-service.js';
import { useTempDir } from '../helpers/temp-dir.js';

vi.mock('../../src/core/log/line-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/log/line-index.js')>();
  return { ...actual, createLineIndex: vi.fn(actual.createLineIndex) };
});
vi.mock('../../src/core/log/server-log-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/log/server-log-history.js')>();
  return { ...actual, resolveServerLogArchive: vi.fn(actual.resolveServerLogArchive) };
});

const root = useTempDir('squash-server-log-service-test-');
const DAY = 24 * 60 * 60 * 1000;

let logFile = 'rwr_server.log';
let cwd = '';
const registry = {
  getConfig: (id: string) => (id === 'a' ? { id: 'a', name: 'a', cwd, executable: './rwr_server', args: [], env: {}, logDir: 'logs', serverLogFile: logFile } : undefined)
};
let service: ServerLogService;
// Backups, newest first, each holding its own name.
const backups: string[] = [];

beforeAll(() => {
  cwd = root();
  const dir = historyDirOf(path.join(cwd, 'rwr_server.log'));
  fs.mkdirSync(dir);
  const now = Date.now();
  for (let i = 0; i < 2 * MAX_ARCHIVE_INDEXES + 2; i++) {
    const name = archiveName('rwr_server.log', new Date(now - DAY - i * 1000));
    fs.writeFileSync(path.join(dir, name), `${name}\n`);
    backups.push(name);
  }
});

beforeEach(() => {
  logFile = 'rwr_server.log';
  service = new ServerLogService(registry as unknown as ConstructorParameters<typeof ServerLogService>[0]);
  vi.mocked(createLineIndex).mockClear();
});

const indexesMade = () => vi.mocked(createLineIndex).mock.calls.length;
const read = async (name: string) => (await service.readLines('a', 0, 10, name))?.lines;

describe('backup indexes', () => {
  it('a backup read again reuses its index', async () => {
    expect(await read(backups[0]!)).toEqual([backups[0]]);
    expect(await read(backups[0]!)).toEqual([backups[0]]);
    expect(indexesMade()).toBe(1);
  });

  it(`kept while among the ${MAX_ARCHIVE_INDEXES} read last`, async () => {
    for (const name of backups.slice(0, MAX_ARCHIVE_INDEXES)) await read(name);
    await read(backups[0]!);
    expect(indexesMade()).toBe(MAX_ARCHIVE_INDEXES);
  });

  it('the least recently read is dropped first', async () => {
    // Read 0..7, then 0 again: 1 is now the least recently read.
    for (const name of backups.slice(0, MAX_ARCHIVE_INDEXES)) await read(name);
    await read(backups[0]!);
    await read(backups[MAX_ARCHIVE_INDEXES]!);
    const before = indexesMade();
    await read(backups[0]!);
    expect(indexesMade()).toBe(before);
    await read(backups[1]!);
    expect(indexesMade()).toBe(before + 1);
  });

  it('a dropped backup gets a new index with the same generation', async () => {
    const first = await service.getInfo('a', backups[0]);
    for (const name of backups.slice(1, MAX_ARCHIVE_INDEXES + 1)) await read(name);
    const before = indexesMade();
    const again = await service.getInfo('a', backups[0]);
    expect(indexesMade()).toBe(before + 1);
    expect(again?.generation).toBe(first?.generation);
  });

  it('the live log is no backup: its own index, beside them', async () => {
    fs.writeFileSync(path.join(cwd, 'rwr_server.log'), 'live\n');
    expect((await service.readLines('a', 0, 10))?.lines).toEqual(['live']);
    expect(await read(backups[0]!)).toEqual([backups[0]]);
    expect(indexesMade()).toBe(2);
  });
});

describe('a backup deleted between lookup and read', () => {
  // Looked up as if it were there; gone when the index opens it.
  const gone = archiveName('rwr_server.log', new Date(2020, 0, 1));
  const lookUpAsIfThere = () =>
    vi.mocked(resolveServerLogArchive).mockImplementationOnce(async (logPath, name) => path.join(historyDirOf(logPath), name));

  it('info: ServerLogArchiveNotFoundError', async () => {
    lookUpAsIfThere();
    await expect(service.getInfo('a', gone)).rejects.toBeInstanceOf(ServerLogArchiveNotFoundError);
  });
  it('lines and search: the same', async () => {
    lookUpAsIfThere();
    await expect(service.readLines('a', 0, 10, gone)).rejects.toBeInstanceOf(ServerLogArchiveNotFoundError);
    lookUpAsIfThere();
    await expect(service.search('a', 'x', false, 10, undefined, gone)).rejects.toBeInstanceOf(ServerLogArchiveNotFoundError);
  });
  it('and its index is dropped: a later read starts afresh', async () => {
    lookUpAsIfThere();
    await expect(service.getInfo('a', gone)).rejects.toThrow();
    lookUpAsIfThere();
    await expect(service.getInfo('a', gone)).rejects.toThrow();
    expect(indexesMade()).toBe(2);
  });
});

describe('the file in a backup’s info', () => {
  it('as the config spells it now', async () => {
    expect((await service.getInfo('a', backups[0]))?.file).toBe('rwr_server.log');
    logFile = './rwr_server.log';
    expect((await service.getInfo('a', backups[0]))?.file).toBe('./rwr_server.log');
    expect(indexesMade()).toBe(1);
  });
});
