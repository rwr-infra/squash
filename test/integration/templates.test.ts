// Instance templates: the file store and the /api/templates routes, driven
// through the real createHttpServer (auth hook included) with fastify.inject —
// no port is opened.
//   - a missing templates file is seeded with the RWR and SteamCMD templates
//     and written; reopening keeps it (same id); a list emptied by the user
//     stays empty
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
//   - the routes need a valid token; create/update/delete work and persist;
//     names are trimmed and unique ignoring case (409); unknown fields, bad
//     values and missing bodies are 400; unknown ids are 404
// Uses a temp directory only; never touches config/.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplateStore } from '../../src/core/config/template-store.js';
import { TemplateValuesSchema } from '../../src/api/http/schemas/template-schemas.js';
import { CreateInstanceSchema } from '../../src/api/http/schemas/instance-schemas.js';
import { TemplateService, TemplateNameTakenError } from '../../src/services/template-service.js';
import type { InstanceTemplate } from '../../src/core/template/template-types.js';
import { createApiServer, login, type ApiServer } from '../helpers/api-server.js';
import { useTempDir } from '../helpers/temp-dir.js';

const workRoot = useTempDir('squash-templates-test-');
const file = (name: string) => path.join(workRoot(), name);
const readJson = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as InstanceTemplate[];

describe('store', () => {
  describe('seeding', () => {
    const seededFile = () => file('seeded.json');
    let store: Awaited<ReturnType<typeof createTemplateStore>>;
    let seed: InstanceTemplate | undefined;
    let steamcmd: InstanceTemplate | undefined;
    let rest: InstanceTemplate[] = [];
    beforeAll(async () => {
      store = await createTemplateStore(seededFile());
      [seed, steamcmd, ...rest] = store.list();
    });

    it('missing file is seeded with the two templates', () => {
      expect(rest).toEqual([]);
      expect(seed?.name).toBe('RWR dedicated server');
      expect(steamcmd?.name).toBe('SteamCMD');
    });
    it('seed is written to disk', () => {
      expect(JSON.stringify(readJson(seededFile()))).toBe(JSON.stringify(store.list()));
    });
    it('seed values are the rwr_server defaults', () => {
      expect(seed?.values).toMatchObject({ executable: './rwr_server', stopCommand: 'quit\n', restartPolicy: 'always', stopTimeoutMs: 15000 });
      expect(seed?.values.cwd).toBeUndefined();
    });
    it('SteamCMD seed values: ./steamcmd, no restart, quit without an extra Enter', () => {
      expect(JSON.stringify(steamcmd?.values)).toBe(JSON.stringify({ executable: './steamcmd', restartPolicy: 'never', stopCommand: 'quit' }));
    });
    it('seed values pass the template schema', () => {
      for (const template of [seed, steamcmd]) {
        expect(TemplateValuesSchema.safeParse(template?.values).error).toBeUndefined();
      }
    });
    it('instances from the seeds pass CreateInstanceSchema', () => {
      for (const template of [seed, steamcmd]) {
        expect(CreateInstanceSchema.safeParse({ cwd: '.', ...template?.values, id: 'from-seed', name: 'from-seed' }).error).toBeUndefined();
      }
    });
    it('reopening keeps the seeds (same ids, no second seeding)', async () => {
      const reopened = await createTemplateStore(seededFile());
      expect(reopened.list().map(t => t.id)).toEqual([seed?.id, steamcmd?.id]);
    });
    it('a deleted seed does not come back', async () => {
      await (await createTemplateStore(seededFile())).update(templates => templates.delete(seed!.id));
      expect((await createTemplateStore(seededFile())).list().map(t => t.name)).toEqual(['SteamCMD']);
    });
    it('deleting both seeds writes an empty list', async () => {
      await (await createTemplateStore(seededFile())).update(templates => templates.delete(steamcmd!.id));
      expect(fs.readFileSync(seededFile(), 'utf8').trim()).toBe('[]');
    });
    it('an emptied list is not seeded again', async () => {
      expect((await createTemplateStore(seededFile())).list()).toEqual([]);
    });
  });

  describe('bad files', () => {
    const cases: Array<[string, string]> = [
      ['corrupt JSON', '[{"id": "a", '],
      ['non-array JSON', '{"id": "a", "name": "x", "values": {}}'],
      ['entry without id', '[{"name": "x", "values": {}}]'],
      ['entry with array values', '[{"id": "a", "name": "x", "values": []}]'],
      ['duplicate ids', '[{"id": "a", "name": "x", "values": {}}, {"id": "a", "name": "y", "values": {}}]']
    ];
    for (const [label, content] of cases) {
      const badFile = () => file(`bad-${label.replace(/\W+/g, '-')}.json`);
      it(`${label} fails to load`, async () => {
        fs.writeFileSync(badFile(), content);
        await expect(createTemplateStore(badFile())).rejects.toThrow(badFile());
      });
      it(`${label} is left untouched`, () => {
        expect(fs.readFileSync(badFile(), 'utf8')).toBe(content);
      });
    }

    it('a file with a UTF-8 byte order mark loads', async () => {
      const bomFile = file('bom.json');
      fs.writeFileSync(bomFile, '\uFEFF[{"id": "a", "name": "With BOM", "values": {}}]');
      await expect(createTemplateStore(bomFile)).resolves.toBeDefined();
    });
  });

  it('concurrent changes leave a valid file with every template', async () => {
    const concurrentFile = file('concurrent.json');
    fs.writeFileSync(concurrentFile, '[]');
    const store = await createTemplateStore(concurrentFile);
    const templates = Array.from({ length: 20 }, (_, i): InstanceTemplate => ({
      id: `t${i}`,
      name: `Template ${i}`,
      values: { args: Array.from({ length: 200 }, (_, j) => `arg-${i}-${j}`) }
    }));
    await Promise.all(templates.map(template => store.update(all => all.set(template.id, template))));
    const onDisk = readJson(concurrentFile);
    expect(onDisk.map(t => t.id).sort()).toEqual(templates.map(t => t.id).sort());
  });

  describe('clashing names', () => {
    let service: TemplateService;
    beforeAll(async () => {
      const clashFile = file('clash.json');
      fs.writeFileSync(clashFile, JSON.stringify([
        { id: 'a', name: 'Foo', values: {} },
        { id: 'b', name: 'foo', values: {} }
      ]));
      service = new TemplateService(await createTemplateStore(clashFile));
    });

    it('a hand-edited clash can keep its own name (any case)', async () => {
      await expect(service.updateTemplate('a', { name: 'FOO', values: { cwd: '/x' } })).resolves.toBeDefined();
    });
    it('renaming onto another name is still refused', async () => {
      await service.updateTemplate('a', { name: 'Bar', values: {} });
      await expect(service.updateTemplate('b', { name: 'bar', values: {} })).rejects.toBeInstanceOf(TemplateNameTakenError);
    });
  });
});

// Steps share the server and the templates created along the way, in order:
// run the whole file: a step run on its own (-t) lacks them, and may fail or,
// worse, pass for the wrong reason.
describe('routes', () => {
  const PASSWORD = 'smoke-password';
  const routesFile = () => file('routes.json');
  let server: ApiServer;
  beforeAll(async () => {
    const templateService = new TemplateService(await createTemplateStore(routesFile()));
    server = await createApiServer({ password: PASSWORD, staticDir: file('static'), deps: { templateService } });
  });
  afterAll(async () => {
    await server?.close();
  });

  let token = '';
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    server.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const data = <T = InstanceTemplate>(res: { json: () => unknown }) => (res.json() as { data: T }).data;
  let castling: InstanceTemplate;
  let bareTemplate: InstanceTemplate;

  it('every template route needs a token', async () => {
    const unauthorized = await Promise.all([
      server.inject({ method: 'GET', url: '/api/templates' }),
      server.inject({ method: 'POST', url: '/api/templates', payload: { name: 'x' } }),
      server.inject({ method: 'PUT', url: '/api/templates/x', payload: { name: 'x' } }),
      server.inject({ method: 'DELETE', url: '/api/templates/x' })
    ]);
    expect(unauthorized.map(res => res.statusCode)).toEqual([401, 401, 401, 401]);
  });
  it('a wrong token is refused', async () => {
    const wrongToken = await server.inject({ method: 'GET', url: '/api/templates', headers: { authorization: 'Bearer not-a-session' } });
    expect(wrongToken.statusCode).toBe(401);
  });
  it('login', async () => {
    token = await login(server, PASSWORD);
    expect(token).not.toBe('');
  });

  it('GET lists the seeds', async () => {
    const listed = await call('GET', '/api/templates');
    expect(listed.statusCode).toBe(200);
    expect(data<InstanceTemplate[]>(listed).map(t => t.name)).toEqual(['RWR dedicated server', 'SteamCMD']);
  });
  it('POST creates (trimmed name, server-side id)', async () => {
    const created = await call('POST', '/api/templates', { name: '  Castling  ', values: { cwd: '/srv/rwr', args: ['--a', '--b'], autoStart: true } });
    expect(created.statusCode).toBe(201);
    castling = data(created);
    expect(castling.name).toBe('Castling');
    expect(castling.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(castling.values)).toBe(JSON.stringify({ cwd: '/srv/rwr', args: ['--a', '--b'], autoStart: true }));
  });
  it('POST without values stores an empty values object', async () => {
    const bare = await call('POST', '/api/templates', { name: 'Bare' });
    expect(bare.statusCode).toBe(201);
    bareTemplate = data(bare);
    expect(JSON.stringify(bareTemplate.values)).toBe('{}');
  });
  it('POST with a name taken (ignoring case) is 409', async () => {
    const duplicate = await call('POST', '/api/templates', { name: 'castling' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error?.code).toBe('TEMPLATE_NAME_TAKEN');
  });

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
    it(`POST with ${label} is 400`, async () => {
      expect((await call('POST', '/api/templates', payload)).statusCode).toBe(400);
    });
  }
  it('POST without a body is 400', async () => {
    expect((await call('POST', '/api/templates')).statusCode).toBe(400);
  });

  it('PUT may change the case of its own name and replaces values', async () => {
    const renamedSelf = await call('PUT', `/api/templates/${castling.id}`, { name: 'CASTLING', values: { cwd: '/srv/rwr2' } });
    expect(renamedSelf.statusCode).toBe(200);
    expect(data(renamedSelf).name).toBe('CASTLING');
    expect(JSON.stringify(data(renamedSelf).values)).toBe(JSON.stringify({ cwd: '/srv/rwr2' }));
  });
  it('PUT to another template\'s name is 409', async () => {
    expect((await call('PUT', `/api/templates/${bareTemplate.id}`, { name: 'castling' })).statusCode).toBe(409);
  });
  it('PUT on an unknown id is 404', async () => {
    const putMissing = await call('PUT', '/api/templates/no-such-id', { name: 'Ghost' });
    expect(putMissing.statusCode).toBe(404);
    expect(putMissing.json().error?.code).toBe('TEMPLATE_NOT_FOUND');
  });
  it('PUT with an invalid body is 400', async () => {
    expect((await call('PUT', `/api/templates/${bareTemplate.id}`, { name: 'Bare', values: { args: 'not-an-array' } })).statusCode).toBe(400);
  });

  it('DELETE removes', async () => {
    expect((await call('DELETE', `/api/templates/${bareTemplate.id}`)).statusCode).toBe(200);
  });
  it('DELETE again is 404', async () => {
    expect((await call('DELETE', `/api/templates/${bareTemplate.id}`)).statusCode).toBe(404);
  });

  it('two concurrent creates under one name: one 201, one 409', async () => {
    const racing = await Promise.all([
      call('POST', '/api/templates', { name: 'Racer', values: { cwd: '/one' } }),
      call('POST', '/api/templates', { name: 'racer', values: { cwd: '/two' } })
    ]);
    const racer = racing.map(res => res.json() as { data?: InstanceTemplate }).find(body => body.data)?.data;
    if (racer) await call('DELETE', `/api/templates/${racer.id}`);
    expect(racing.map(res => res.statusCode).sort()).toEqual([201, 409]);
  });

  describe('a failed write', () => {
    // A directory where the temp file goes makes every write fail.
    const blocker = () => `${routesFile()}.tmp`;
    let fileBefore = '';
    let listBefore = '';
    beforeAll(async () => {
      fileBefore = fs.readFileSync(routesFile(), 'utf8');
      listBefore = (await call('GET', '/api/templates')).body;
      fs.mkdirSync(blocker());
    });

    it('failed writes answer 500', async () => {
      const failed = [
        await call('POST', '/api/templates', { name: 'Doomed' }),
        await call('PUT', `/api/templates/${castling.id}`, { name: 'Renamed', values: {} }),
        await call('DELETE', `/api/templates/${castling.id}`)
      ];
      expect(failed.map(res => res.statusCode)).toEqual([500, 500, 500]);
    });
    it('failed writes change neither the list nor the file', async () => {
      expect((await call('GET', '/api/templates')).body).toBe(listBefore);
      expect(fs.readFileSync(routesFile(), 'utf8')).toBe(fileBefore);
    });
    it('a create retried after a failed write succeeds (no 409)', async () => {
      fs.rmdirSync(blocker());
      const retry = await call('POST', '/api/templates', { name: 'Doomed' });
      expect(retry.statusCode).toBe(201);
      await call('DELETE', `/api/templates/${data(retry).id}`);
    });
  });

  it('the file matches what GET returns', async () => {
    expect(JSON.stringify(readJson(routesFile()))).toBe(JSON.stringify(data<InstanceTemplate[]>(await call('GET', '/api/templates'))));
  });
  it('list order is creation order, failed requests left no trace', async () => {
    expect(data<InstanceTemplate[]>(await call('GET', '/api/templates')).map(t => t.name)).toEqual(['RWR dedicated server', 'SteamCMD', 'CASTLING']);
  });
});
