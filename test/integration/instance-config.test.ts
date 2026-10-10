// Instance configs and serverLogFile, through the config store and the
// /api/instances routes (the real createHttpServer, InstanceService and
// registry; supervisors are created, never started):
//   - loading configs saved before the field existed infers it (rwr_server.log
//     for an rwr_server executable, none otherwise) and keeps an explicit
//     value, an empty one included; GET /api/instances shows the result
//   - loading leaves the file byte-for-byte as it was; the next save writes
//     the inferred values out
//   - create/update without the field infer it, '' and a path are kept;
//     a path outside the working directory is 400 and never reaches disk
// appPaths is mocked to a temp directory; never touches config/ or logs/.
//
// Tests run in order and share state: run the whole file.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTempDir } from '../helpers/temp-dir.js';
import { createApiServer, login, type ApiServer } from '../helpers/api-server.js';

const paths = vi.hoisted(() => ({ instanceConfigFile: '' }));
vi.mock('../../src/app/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/paths.js')>();
  return { appPaths: new Proxy(actual.appPaths, { get: (target, key) => (key === 'instanceConfigFile' ? paths.instanceConfigFile : Reflect.get(target, key)) }) };
});

const { createInstanceConfigStore } = await import('../../src/core/config/instance-config-store.js');
const { createInstanceRegistry } = await import('../../src/core/instance/instance-registry.js');
const { InstanceService } = await import('../../src/services/instance-service.js');

const workRoot = useTempDir('squash-instance-config-test-');

type Row = { id: string; serverLogFile?: string };
const byId = (rows: readonly Row[]) => Object.fromEntries(rows.map(row => [row.id, row.serverLogFile]));
const readDisk = () => JSON.parse(fs.readFileSync(paths.instanceConfigFile, 'utf8')) as Row[];

const legacyConfig = (id: string, executable: string, extra: object = {}) =>
  ({ id, name: id, cwd: '.', executable, args: [], env: {}, logDir: path.join(workRoot(), 'logs'), ...extra });
const expected = { rwr: 'rwr_server.log', 'rwr-win': 'rwr_server.log', steamcmd: '', 'rwr-off': '', custom: 'logs/x.log' };

describe('configs without serverLogFile', () => {
  const PASSWORD = 'instance-config-password';
  let raw = '';
  let server: ApiServer;
  let registry: Awaited<ReturnType<typeof createInstanceRegistry>>;
  let token = '';
  beforeAll(async () => {
    paths.instanceConfigFile = path.join(workRoot(), 'instances.json');
    raw = JSON.stringify([
      legacyConfig('rwr', './rwr_server'),
      legacyConfig('rwr-win', 'C:\\rwr\\rwr_server.exe'),
      legacyConfig('steamcmd', './steamcmd'),
      legacyConfig('rwr-off', './rwr_server', { serverLogFile: '' }),
      legacyConfig('custom', './steamcmd', { serverLogFile: 'logs/x.log' })
    ], null, 2);
    fs.writeFileSync(paths.instanceConfigFile, raw);
    const store = await createInstanceConfigStore();
    registry = await createInstanceRegistry();
    await registry.loadFromStore(store);
    const instanceService = new InstanceService(registry, store);
    server = await createApiServer({ password: PASSWORD, staticDir: path.join(workRoot(), 'static'), deps: { instanceService } });
    token = await login(server, PASSWORD);
  });
  afterAll(async () => {
    await server?.close();
    await Promise.allSettled((registry?.listSupervisors() ?? []).map(supervisor => supervisor.dispose()));
  });

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    server.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

  it('loading infers the field and keeps explicit values; GET /api/instances shows them', async () => {
    const res = await call('GET', '/api/instances');
    expect(byId((res.json() as { data: Array<{ config: Row }> }).data.map(item => item.config))).toEqual(expected);
  });
  it('loading leaves the file as it was', () => {
    expect(fs.readFileSync(paths.instanceConfigFile, 'utf8')).toBe(raw);
  });

  const body = (id: string, executable: string, extra: object = {}) =>
    ({ id, name: id, cwd: '.', executable, logDir: path.join(workRoot(), 'logs'), ...extra });
  it.each([
    ['../x.log'],
    ['/etc/passwd'],
    ['C:\\x.log'],
    ['logs/'],
    ['.. /x.log']
  ])('POST and PUT with serverLogFile %j are 400 and never reach disk', async serverLogFile => {
    const before = fs.readFileSync(paths.instanceConfigFile, 'utf8');
    const created = await call('POST', '/api/instances', body('bad', './rwr_server', { serverLogFile }));
    const updated = await call('PUT', '/api/instances/rwr', body('rwr', './rwr_server', { serverLogFile }));
    expect([created.statusCode, updated.statusCode]).toEqual([400, 400]);
    expect(fs.readFileSync(paths.instanceConfigFile, 'utf8')).toBe(before);
  });

  it('the next save writes the inferred values', async () => {
    expect((await call('PUT', '/api/instances/steamcmd', body('steamcmd', './steamcmd', { name: 'renamed', serverLogFile: '' }))).statusCode).toBe(200);
    expect(byId(readDisk())).toEqual(expected);
  });
  it('create without the field infers it from the executable', async () => {
    expect((await call('POST', '/api/instances', body('new-rwr', '/opt/rwr/rwr_server'))).statusCode).toBe(201);
    expect((await call('POST', '/api/instances', body('new-steamcmd', './steamcmd'))).statusCode).toBe(201);
    expect(byId(readDisk())).toMatchObject({ 'new-rwr': 'rwr_server.log', 'new-steamcmd': '' });
  });
  it('update keeps an explicit value: blank, or a path for a non-rwr executable', async () => {
    expect((await call('PUT', '/api/instances/new-rwr', body('new-rwr', '/opt/rwr/rwr_server', { serverLogFile: '' }))).statusCode).toBe(200);
    expect((await call('PUT', '/api/instances/new-steamcmd', body('new-steamcmd', './steamcmd', { serverLogFile: 'logs\\console.log' }))).statusCode).toBe(200);
    expect(byId(readDisk())).toMatchObject({ 'new-rwr': '', 'new-steamcmd': 'logs\\console.log' });
  });
});
