// Smoke for instance templates: the file store and the /api/templates routes,
// driven through the real createHttpServer (auth hook included) with
// fastify.inject — no port is opened. Checks:
//   - a missing templates file is seeded with the RWR and SteamCMD templates
//     and written;
//     reopening keeps it (same id); a list emptied by the user stays empty
//   - a corrupt or malformed file (duplicate ids included) fails loudly and is
//     left byte-for-byte as is; a UTF-8 byte order mark is accepted
//   - concurrent changes leave a valid file holding every template
//   - a failed write changes nothing: not the list, not the file, and a
//     retry under the same name succeeds; two concurrent creates under one
//     name give one 201 and one 409
//   - templates in a hand-edited file whose names clash can keep their own
//     names
//   - the seeded templates' values pass the API schema, and instances
//     created from them pass CreateInstanceSchema
//   - the routes need a valid token; create/update/delete work and persist; names
//     are trimmed and unique ignoring case (409); unknown fields, bad values
//     and missing bodies are 400; unknown ids are 404
// Uses a temp directory only; never touches config/.
//
// Usage: npm run smoke:templates

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemplateStore } from '../src/core/config/template-store.js';
import { TemplateValuesSchema } from '../src/api/http/schemas/template-schemas.js';
import { CreateInstanceSchema } from '../src/api/http/schemas/instance-schemas.js';
import { TemplateService, TemplateNameTakenError } from '../src/services/template-service.js';
import type { InstanceTemplate } from '../src/core/template/template-types.js';

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
};

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-templates-smoke-'));
process.on('exit', () => fs.rmSync(workRoot, { recursive: true, force: true }));
const file = (name: string) => path.join(workRoot, name);
const readJson = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as InstanceTemplate[];

const rejects = async (promise: Promise<unknown>): Promise<Error | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err as Error;
  }
};

// --- Store -------------------------------------------------------------------

const checkSeeding = async () => {
  const seededFile = file('seeded.json');
  const store = await createTemplateStore(seededFile);
  const [seed, steamcmd, ...rest] = store.list();
  check('missing file is seeded with the two templates', rest.length === 0 && seed?.name === 'RWR dedicated server' && steamcmd?.name === 'SteamCMD');
  check('seed is written to disk', fs.existsSync(seededFile) && JSON.stringify(readJson(seededFile)) === JSON.stringify(store.list()));
  check(
    'seed values are the rwr_server defaults',
    seed?.values.executable === './rwr_server' && seed.values.stopCommand === 'quit\n' &&
      seed.values.restartPolicy === 'always' && seed.values.stopTimeoutMs === 15000 && seed.values.cwd === undefined,
    JSON.stringify(seed?.values)
  );
  check(
    'SteamCMD seed values: ./steamcmd, no restart, quit without an extra Enter',
    JSON.stringify(steamcmd?.values) === JSON.stringify({ executable: './steamcmd', restartPolicy: 'never', stopCommand: 'quit' }),
    JSON.stringify(steamcmd?.values)
  );
  check('seed values pass the template schema', [seed, steamcmd].every(template => TemplateValuesSchema.safeParse(template?.values).success));
  check(
    'instances from the seeds pass CreateInstanceSchema',
    [seed, steamcmd].every(template => CreateInstanceSchema.safeParse({ cwd: '.', ...template?.values, id: 'from-seed', name: 'from-seed' }).success)
  );

  const reopened = await createTemplateStore(seededFile);
  check('reopening keeps the seeds (same ids, no second seeding)', reopened.list().map(t => t.id).join() === [seed?.id, steamcmd?.id].join());

  await reopened.update(templates => templates.delete(seed!.id));
  const oneLeft = await createTemplateStore(seededFile);
  check('a deleted seed does not come back', oneLeft.list().map(t => t.name).join() === 'SteamCMD');
  await oneLeft.update(templates => templates.delete(steamcmd!.id));
  check('deleting both seeds writes an empty list', fs.readFileSync(seededFile, 'utf8').trim() === '[]');
  const emptied = await createTemplateStore(seededFile);
  check('an emptied list is not seeded again', emptied.list().length === 0);
};

const checkBadFiles = async () => {
  const cases: Array<[string, string]> = [
    ['corrupt JSON', '[{"id": "a", '],
    ['non-array JSON', '{"id": "a", "name": "x", "values": {}}'],
    ['entry without id', '[{"name": "x", "values": {}}]'],
    ['entry with array values', '[{"id": "a", "name": "x", "values": []}]'],
    ['duplicate ids', '[{"id": "a", "name": "x", "values": {}}, {"id": "a", "name": "y", "values": {}}]']
  ];
  for (const [label, content] of cases) {
    const badFile = file(`bad-${label.replace(/\W+/g, '-')}.json`);
    fs.writeFileSync(badFile, content);
    const err = await rejects(createTemplateStore(badFile));
    check(`${label} fails to load`, !!err && err.message.includes(badFile), err?.message ?? 'loaded');
    check(`${label} is left untouched`, fs.readFileSync(badFile, 'utf8') === content);
  }

  const bomFile = file('bom.json');
  fs.writeFileSync(bomFile, '\uFEFF[{"id": "a", "name": "With BOM", "values": {}}]');
  const bomErr = await rejects(createTemplateStore(bomFile));
  check('a file with a UTF-8 byte order mark loads', !bomErr, bomErr?.message);
};

const checkConcurrentSaves = async () => {
  const concurrentFile = file('concurrent.json');
  fs.writeFileSync(concurrentFile, '[]');
  const store = await createTemplateStore(concurrentFile);
  const templates = Array.from({ length: 20 }, (_, i): InstanceTemplate => ({
    id: `t${i}`,
    name: `Template ${i}`,
    values: { args: Array.from({ length: 200 }, (_, j) => `arg-${i}-${j}`) }
  }));
  await Promise.all(templates.map(template => store.update(all => all.set(template.id, template))));
  let onDisk: InstanceTemplate[] = [];
  try {
    onDisk = readJson(concurrentFile);
  } catch {
    // Reported below.
  }
  check('concurrent changes leave a valid file with every template', onDisk.length === 20 && templates.every(t => onDisk.some(d => d.id === t.id)));
};

const checkClashingNames = async () => {
  const clashFile = file('clash.json');
  fs.writeFileSync(clashFile, JSON.stringify([
    { id: 'a', name: 'Foo', values: {} },
    { id: 'b', name: 'foo', values: {} }
  ]));
  const service = new TemplateService(await createTemplateStore(clashFile));
  const keepOwn = await rejects(service.updateTemplate('a', { name: 'FOO', values: { cwd: '/x' } }));
  check('a hand-edited clash can keep its own name (any case)', !keepOwn, keepOwn?.message);
  const takeOther = await rejects(service.updateTemplate('a', { name: 'Bar', values: {} }).then(() => service.updateTemplate('b', { name: 'bar', values: {} })));
  check('renaming onto another name is still refused', takeOther instanceof TemplateNameTakenError, takeOther?.message ?? 'accepted');
};

// --- Routes ------------------------------------------------------------------

const checkRoutes = async () => {
  // auth.ts reads these when it is first imported.
  process.env.AUTH_USERNAME = 'smoke';
  process.env.AUTH_PASSWORD = 'smoke-password';
  delete process.env.AUTH_TOKEN;
  const staticDir = file('static');
  fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>');
  process.env.SQUASH_STATIC_DIR = staticDir;

  const { createHttpServer } = await import('../src/api/http/http-server.js');
  const { TemplateService } = await import('../src/services/template-service.js');
  type ApiDeps = Parameters<typeof createHttpServer>[0];

  const routesFile = file('routes.json');
  const templateService = new TemplateService(await createTemplateStore(routesFile));
  // Only the template routes and login run here; audit must not write to logs/.
  const server = await createHttpServer({
    instanceService: {} as ApiDeps['instanceService'],
    logService: {} as ApiDeps['logService'],
    terminalService: {} as ApiDeps['terminalService'],
    terminalGateway: {} as ApiDeps['terminalGateway'],
    auditService: { record: async () => {} } as unknown as ApiDeps['auditService'],
    serverLogService: {} as ApiDeps['serverLogService'],
    templateService
  });

  try {
    const unauthorized = await Promise.all([
      server.inject({ method: 'GET', url: '/api/templates' }),
      server.inject({ method: 'POST', url: '/api/templates', payload: { name: 'x' } }),
      server.inject({ method: 'PUT', url: '/api/templates/x', payload: { name: 'x' } }),
      server.inject({ method: 'DELETE', url: '/api/templates/x' })
    ]);
    check('every template route needs a token', unauthorized.every(res => res.statusCode === 401), unauthorized.map(res => res.statusCode).join(','));
    const wrongToken = await server.inject({ method: 'GET', url: '/api/templates', headers: { authorization: 'Bearer not-a-session' } });
    check('a wrong token is refused', wrongToken.statusCode === 401, `${wrongToken.statusCode}`);

    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'smoke', password: 'smoke-password' } });
    const token = (login.json() as { data?: { token?: string } }).data?.token;
    if (!check('login', !!token)) return;
    const headers = { authorization: `Bearer ${token}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      server.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

    const listed = await call('GET', '/api/templates');
    const seed = (listed.json() as { data: InstanceTemplate[] }).data;
    check('GET lists the seeds', listed.statusCode === 200 && seed.map(t => t.name).join('|') === 'RWR dedicated server|SteamCMD');

    const created = await call('POST', '/api/templates', { name: '  Castling  ', values: { cwd: '/srv/rwr', args: ['--a', '--b'], autoStart: true } });
    const castling = (created.json() as { data: InstanceTemplate }).data;
    check(
      'POST creates (trimmed name, server-side id)',
      created.statusCode === 201 && castling.name === 'Castling' && /^[0-9a-f-]{36}$/.test(castling.id) &&
        JSON.stringify(castling.values) === JSON.stringify({ cwd: '/srv/rwr', args: ['--a', '--b'], autoStart: true }),
      created.body
    );

    const bare = await call('POST', '/api/templates', { name: 'Bare' });
    const bareTemplate = (bare.json() as { data: InstanceTemplate }).data;
    check('POST without values stores an empty values object', bare.statusCode === 201 && JSON.stringify(bareTemplate.values) === '{}', bare.body);

    const duplicate = await call('POST', '/api/templates', { name: 'castling' });
    check('POST with a name taken (ignoring case) is 409', duplicate.statusCode === 409 && duplicate.json().error?.code === 'TEMPLATE_NAME_TAKEN', duplicate.body);

    const invalidBodies: Array<[string, unknown]> = [
      ['unknown top-level field', { name: 'X1', id: 'mine' }],
      ['unknown values field', { name: 'X2', values: { env: { A: '1' } } }],
      ['instance ID in values', { name: 'X3', values: { id: 'abc' } }],
      ['blank name', { name: '   ' }],
      ['name over 128 chars', { name: 'n'.repeat(129) }],
      ['stopTimeoutMs below 1000', { name: 'X4', values: { stopTimeoutMs: 500 } }],
      ['unknown restartPolicy', { name: 'X5', values: { restartPolicy: 'sometimes' } }],
      ['empty executable', { name: 'X6', values: { executable: '' } }]
    ];
    for (const [label, payload] of invalidBodies) {
      const res = await call('POST', '/api/templates', payload);
      check(`POST with ${label} is 400`, res.statusCode === 400, `${res.statusCode}`);
    }
    const noBody = await call('POST', '/api/templates');
    check('POST without a body is 400', noBody.statusCode === 400, `${noBody.statusCode}`);

    const renamedSelf = await call('PUT', `/api/templates/${castling.id}`, { name: 'CASTLING', values: { cwd: '/srv/rwr2' } });
    check(
      'PUT may change the case of its own name and replaces values',
      renamedSelf.statusCode === 200 && (renamedSelf.json() as { data: InstanceTemplate }).data.name === 'CASTLING' &&
        JSON.stringify((renamedSelf.json() as { data: InstanceTemplate }).data.values) === JSON.stringify({ cwd: '/srv/rwr2' }),
      renamedSelf.body
    );
    const stealName = await call('PUT', `/api/templates/${bareTemplate.id}`, { name: 'castling' });
    check('PUT to another template\'s name is 409', stealName.statusCode === 409, `${stealName.statusCode}`);
    const putMissing = await call('PUT', '/api/templates/no-such-id', { name: 'Ghost' });
    check('PUT on an unknown id is 404', putMissing.statusCode === 404 && putMissing.json().error?.code === 'TEMPLATE_NOT_FOUND', `${putMissing.statusCode}`);
    const putInvalid = await call('PUT', `/api/templates/${bareTemplate.id}`, { name: 'Bare', values: { args: 'not-an-array' } });
    check('PUT with an invalid body is 400', putInvalid.statusCode === 400, `${putInvalid.statusCode}`);

    const deleted = await call('DELETE', `/api/templates/${bareTemplate.id}`);
    check('DELETE removes', deleted.statusCode === 200);
    const deletedAgain = await call('DELETE', `/api/templates/${bareTemplate.id}`);
    check('DELETE again is 404', deletedAgain.statusCode === 404);

    const racing = await Promise.all([
      call('POST', '/api/templates', { name: 'Racer', values: { cwd: '/one' } }),
      call('POST', '/api/templates', { name: 'racer', values: { cwd: '/two' } })
    ]);
    check(
      'two concurrent creates under one name: one 201, one 409',
      racing.map(res => res.statusCode).sort().join(',') === '201,409',
      racing.map(res => res.statusCode).join(',')
    );
    const racer = racing.map(res => res.json() as { data?: InstanceTemplate }).find(body => body.data)?.data;
    if (racer) await call('DELETE', `/api/templates/${racer.id}`);

    // A directory where the temp file goes makes every write fail.
    const blocker = `${routesFile}.tmp`;
    const fileBefore = fs.readFileSync(routesFile, 'utf8');
    const listBefore = (await call('GET', '/api/templates')).body;
    fs.mkdirSync(blocker);
    const failedCreate = await call('POST', '/api/templates', { name: 'Doomed' });
    const failedUpdate = await call('PUT', `/api/templates/${castling.id}`, { name: 'Renamed', values: {} });
    const failedDelete = await call('DELETE', `/api/templates/${castling.id}`);
    check(
      'failed writes answer 500',
      [failedCreate, failedUpdate, failedDelete].every(res => res.statusCode === 500),
      [failedCreate, failedUpdate, failedDelete].map(res => res.statusCode).join(',')
    );
    check('failed writes change neither the list nor the file', (await call('GET', '/api/templates')).body === listBefore && fs.readFileSync(routesFile, 'utf8') === fileBefore);
    fs.rmdirSync(blocker);
    const retry = await call('POST', '/api/templates', { name: 'Doomed' });
    check('a create retried after a failed write succeeds (no 409)', retry.statusCode === 201, `${retry.statusCode}`);
    await call('DELETE', `/api/templates/${(retry.json() as { data: InstanceTemplate }).data.id}`);

    const finalList = (await call('GET', '/api/templates')).json() as { data: InstanceTemplate[] };
    check('the file matches what GET returns', JSON.stringify(readJson(routesFile)) === JSON.stringify(finalList.data));
    check(
      'list order is creation order, failed requests left no trace',
      finalList.data.map(t => t.name).join('|') === 'RWR dedicated server|SteamCMD|CASTLING',
      finalList.data.map(t => t.name).join('|')
    );
  } finally {
    await server.close();
  }
};

await checkSeeding();
await checkBadFiles();
await checkConcurrentSaves();
await checkClashingNames();
await checkRoutes();

if (failures.length > 0) {
  console.log(`[smoke] ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[smoke] all template checks passed');
