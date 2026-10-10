// The instance config store with configs saved before serverLogFile existed:
//   - loading infers the field (rwr_server.log for an rwr_server executable,
//     none otherwise) and keeps an explicit value, an empty one included
//   - loading leaves the file byte-for-byte as it was; the next save writes
//     the inferred values out
// appPaths is mocked to a temp directory; never touches config/.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTempDir } from '../helpers/temp-dir.js';

const paths = vi.hoisted(() => ({ instanceConfigFile: '' }));
vi.mock('../../src/app/paths.js', () => ({ appPaths: paths }));

const { createInstanceConfigStore } = await import('../../src/core/config/instance-config-store.js');

const workRoot = useTempDir('squash-instance-config-test-');

const legacy = [
  { id: 'rwr', name: 'rwr', cwd: '.', executable: './rwr_server', args: [], env: {}, logDir: 'logs' },
  { id: 'rwr-win', name: 'rwr-win', cwd: '.', executable: 'C:\\rwr\\rwr_server.exe', args: [], env: {}, logDir: 'logs' },
  { id: 'steamcmd', name: 'steamcmd', cwd: '.', executable: './steamcmd', args: [], env: {}, logDir: 'logs' },
  { id: 'rwr-off', name: 'rwr-off', cwd: '.', executable: './rwr_server', args: [], env: {}, logDir: 'logs', serverLogFile: '' },
  { id: 'custom', name: 'custom', cwd: '.', executable: './steamcmd', args: [], env: {}, logDir: 'logs', serverLogFile: 'logs/x.log' }
];
const expected = { rwr: 'rwr_server.log', 'rwr-win': 'rwr_server.log', steamcmd: '', 'rwr-off': '', custom: 'logs/x.log' };

describe('configs without serverLogFile', () => {
  let raw = '';
  let store: Awaited<ReturnType<typeof createInstanceConfigStore>>;
  beforeAll(async () => {
    paths.instanceConfigFile = path.join(workRoot(), 'instances.json');
    raw = JSON.stringify(legacy, null, 2);
    fs.writeFileSync(paths.instanceConfigFile, raw);
    store = await createInstanceConfigStore();
  });

  it('loading infers the field and keeps explicit values', async () => {
    const loaded = Object.fromEntries((await store.list()).map(config => [config.id, config.serverLogFile]));
    expect(loaded).toEqual(expected);
  });
  it('loading leaves the file as it was', () => {
    expect(fs.readFileSync(paths.instanceConfigFile, 'utf8')).toBe(raw);
  });
  it('the next save writes the inferred values', async () => {
    await store.save({ ...legacy[0]!, name: 'renamed', serverLogFile: 'rwr_server.log' });
    const disk = JSON.parse(fs.readFileSync(paths.instanceConfigFile, 'utf8')) as Array<{ id: string; serverLogFile?: string }>;
    expect(Object.fromEntries(disk.map(config => [config.id, config.serverLogFile]))).toEqual(expected);
  });
});
