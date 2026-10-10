// The /api auth hook: every protected route refuses a request without a valid
// token however its path is written, and its handler never runs. Through the
// real createHttpServer, with every service a stub that counts its calls.
//   - the routes the server registers under /api are exactly the protected
//     ones listed here plus the public ones (a new route must be added to one
//     list or the other, and a new public one is a conscious decision)
//   - for each protected route and method (HEAD included): plain, escapes in
//     "api" and in the next segment (lower-, upper- and mixed-case hex), and
//     an absolute-form request line ("GET http://host/api/... HTTP/1.1", over
//     a raw socket) all get 401 with no handler call; so does a wrong token,
//     and a WebSocket upgrade to a protected route
//   - the terminal WebSocket checks its own ?token=: none or a wrong one never
//     reaches the gateway, a valid one does; it has no HEAD route
//   - the public routes (health, auth status, login) and the SPA answer
//     without a token, an unknown /api path is 404, and a valid token gets
//     through (positive control)
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer, login, type ApiDeps, type ApiServer } from '../helpers/api-server.js';
import { useTempDir } from '../helpers/temp-dir.js';

// A strong password, so the hook is what stands between the network and the
// handlers.
const PASSWORD = 'a-long-unguessable-smoke-password';
const workRoot = useTempDir('squash-auth-test-');

// Every service method records its call and returns nothing useful.
const calls: string[] = [];
const stub = (name: string) =>
  new Proxy({}, {
    get: (_target, method) => (method === 'then' ? undefined : async () => {
      calls.push(`${name}.${String(method)}`);
      return undefined;
    })
  });
const deps = {
  instanceService: stub('instanceService'),
  logService: stub('logService'),
  terminalService: stub('terminalService'),
  terminalGateway: stub('terminalGateway'),
  auditService: stub('auditService'),
  templateService: stub('templateService'),
  serverLogService: stub('serverLogService')
} as unknown as ApiDeps;

let server: ApiServer;
beforeAll(async () => {
  server = await createApiServer({ password: PASSWORD, staticDir: path.join(workRoot(), 'static'), deps });
  await server.ready();
});
afterAll(async () => {
  await server?.close();
});

// Protected routes as [method, route pattern, body]; every GET also has an
// automatic HEAD route, checked too.
const PROTECTED_ROUTES: ReadonlyArray<readonly [string, string, unknown?]> = [
  ['GET', '/api/instances'],
  ['POST', '/api/instances', { id: 'x', name: 'x', cwd: '.', executable: 'x' }],
  ['GET', '/api/instances/:id'],
  ['PUT', '/api/instances/:id', { name: 'x', cwd: '.', executable: 'x' }],
  ['DELETE', '/api/instances/:id'],
  ['POST', '/api/instances/:id/start'],
  ['POST', '/api/instances/:id/stop'],
  ['POST', '/api/instances/:id/restart'],
  ['POST', '/api/instances/:id/command', { command: 'quit' }],
  ['GET', '/api/instances/:id/logs/tail'],
  ['GET', '/api/instances/:id/server-log'],
  ['GET', '/api/instances/:id/server-log/lines'],
  ['GET', '/api/instances/:id/server-log/search'],
  ['GET', '/api/audit'],
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/logout'],
  ['GET', '/api/templates'],
  ['POST', '/api/templates', { name: 'x' }],
  ['PUT', '/api/templates/:id', { name: 'x' }],
  ['DELETE', '/api/templates/:id']
];
const PUBLIC_ROUTES = ['GET /api/health', 'HEAD /api/health', 'GET /api/auth/status', 'HEAD /api/auth/status', 'POST /api/auth/login', 'GET /api/terminal/:instanceId'];
const PROTECTED: ReadonlyArray<readonly [string, string, string, unknown?]> = PROTECTED_ROUTES.flatMap(([method, route, body]) => {
  const url = route.replace(':id', 'x');
  return method === 'GET' ? [[method, route, url, body], ['HEAD', route, url, body]] as const : [[method, route, url, body]] as const;
});

// "METHOD /full/route" for every route in Fastify's printRoutes tree.
const registeredRoutes = (tree: string): Set<string> => {
  const parents: string[] = [];
  const routes = new Set<string>();
  for (const line of tree.split('\n')) {
    const match = /^((?:│ {3}| {4})*)(?:├── |└── )(\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    const full = `${depth > 0 ? parents[depth - 1] : ''}${match[2]}`;
    parents[depth] = full;
    parents.length = depth + 1;
    for (const method of match[3]?.split(', ') ?? []) routes.add(`${method} ${full}`);
  }
  return routes;
};

// Spellings of one path that the router may still match: escapes in
// "api" and in the segment after it, lower- and upper-case hex.
const escape = (text: string, upper: boolean) =>
  [...text].map((char) => `%${char.charCodeAt(0).toString(16)}`).map((hex) => (upper ? hex.toUpperCase() : hex)).join('');
const spellings = (url: string) => {
  const [first, ...rest] = url.slice('/api/'.length).split('/');
  const tail = rest.length > 0 ? `/${rest.join('/')}` : '';
  const mixed = [...first!].map((char, i) => escape(char, i % 2 === 0)).join('');
  return [
    url,
    `/%61pi/${first}${tail}`,
    `/${escape('api', false)}/${first}${tail}`,
    `/api/${escape(first!, false)}${tail}`,
    `/api/${escape(first!, true)}${tail}`,
    `/api/${mixed}${tail}`
  ];
};

// Sends one request over a raw socket (for request lines inject normalizes)
// and returns the status code.
const rawStatus = (port: number, method: string, target: string, body?: unknown, extraHeaders: readonly string[] = []) =>
  new Promise<number>((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = [`${method} ${target} HTTP/1.1`, 'Host: smoke', ...(extraHeaders.length > 0 ? extraHeaders : ['Connection: close'])];
    if (payload) headers.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload)}`);
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${headers.join('\r\n')}\r\n\r\n${payload}`));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
  });

// Opens a WebSocket and resolves with its first message (or close).
const wsFirstMessage = (url: string) =>
  new Promise<string>((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); resolve('timeout'); }, 3000);
    ws.onmessage = (event) => { clearTimeout(timer); ws.close(); resolve(String(event.data)); };
    ws.onclose = () => { clearTimeout(timer); resolve('closed'); };
    ws.onerror = () => { clearTimeout(timer); resolve('error'); };
  });

// Handler calls made while `run` was under way.
const callsDuring = async <T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly calls: readonly string[] }> => {
  const before = calls.length;
  const result = await run();
  return { result, calls: calls.slice(before) };
};

const withBody = (body: unknown) => (body === undefined ? {} : { payload: body as object });

it('the /api routes are exactly the listed protected and public ones', () => {
  const registered = [...registeredRoutes(server.printRoutes({ commonPrefix: false }))].filter((route) => route.split(' ')[1]!.startsWith('/api'));
  const expected = [...PROTECTED.map(([method, route]) => `${method} ${route}`), ...PUBLIC_ROUTES];
  expect(registered.sort()).toEqual(expected.sort());
});

describe('through inject', () => {
  for (const [method, , url, body] of PROTECTED) {
    for (const spelled of spellings(url)) {
      it(`no token: ${method} ${spelled}`, async () => {
        const { result, calls } = await callsDuring(() => server.inject({ method: method as 'GET', url: spelled, ...withBody(body) }));
        expect(result.statusCode).toBe(401);
        expect(calls).toEqual([]);
      });
    }
    it(`wrong token: ${method} ${url}`, async () => {
      const { result, calls } = await callsDuring(() =>
        server.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer not-a-session' }, ...withBody(body) })
      );
      expect(result.statusCode).toBe(401);
      expect(calls).toEqual([]);
    });
  }

  // The %61pi spelling reaches the route: it must meet the hook, not miss it.
  it('an encoded path still meets the hook (401 UNAUTHORIZED)', async () => {
    const encoded = await server.inject({ method: 'GET', url: '/%61pi/instances' });
    expect(encoded.statusCode).toBe(401);
    expect(encoded.json().error?.code).toBe('UNAUTHORIZED');
  });
});

describe('over a socket', () => {
  let port = 0;
  beforeAll(async () => {
    await server.listen({ port: 0, host: '127.0.0.1' });
    port = (server.server.address() as net.AddressInfo).port;
  });

  for (const [method, , url, body] of PROTECTED) {
    for (const target of [`http://smoke${url}`, `http://smoke${url.replace('/api/', '/%61pi/')}`]) {
      it(`no token, absolute-form: ${method} ${target}`, async () => {
        const { result, calls } = await callsDuring(() => rawStatus(port, method, target, body));
        expect(result).toBe(401);
        expect(calls).toEqual([]);
      });
    }
  }

  // A WebSocket upgrade to a protected route meets the hook too.
  const upgrade = ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='];
  for (const target of ['/api/instances', '/%61pi/instances', `http://smoke/api/audit`]) {
    it(`no token, WebSocket upgrade: ${target}`, async () => {
      const { result, calls } = await callsDuring(() => rawStatus(port, 'GET', target, undefined, upgrade));
      expect(result).toBe(401);
      expect(calls).toEqual([]);
    });
  }

  // The terminal WebSocket checks its own ?token=.
  for (const [label, query, prefix] of [['no token', '', 'api'], ['a wrong token', '?token=not-a-session', 'api'], ['an encoded path, no token', '', '%61pi']] as const) {
    it(`terminal WebSocket with ${label} is refused`, async () => {
      const { result, calls } = await callsDuring(() => wsFirstMessage(`ws://127.0.0.1:${port}/${prefix}/terminal/x${query}`));
      expect(result).toContain('Unauthorized');
      expect(calls).not.toContain('terminalGateway.handleConnection');
    });
  }
  it('the terminal route has no HEAD route', async () => {
    expect((await server.inject({ method: 'HEAD', url: '/api/terminal/x' })).statusCode).toBe(404);
  });

  describe('still public', () => {
    it('health is public', async () => {
      expect((await server.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    });
    it('auth status is public', async () => {
      expect((await server.inject({ method: 'GET', url: '/api/auth/status' })).statusCode).toBe(200);
    });
    it('login is reachable without a token (wrong password: its own 401)', async () => {
      const badLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'smoke', password: 'wrong' } });
      expect(badLogin.statusCode).toBe(401);
      expect(badLogin.json().error?.code).toBe('INVALID_CREDENTIALS');
    });
    it('the SPA needs no token', async () => {
      const spa = await server.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain('spa');
    });
    it('an unknown /api path is 404', async () => {
      expect((await server.inject({ method: 'GET', url: '/api/no-such-route' })).statusCode).toBe(404);
    });
  });

  // Positive control: a valid token gets through to the handler.
  describe('with a valid token', () => {
    let token = '';
    beforeAll(async () => {
      token = await login(server, PASSWORD);
    });

    it('a valid token reaches the handler', async () => {
      const { result, calls } = await callsDuring(() => server.inject({ method: 'GET', url: '/api/instances', headers: { authorization: `Bearer ${token}` } }));
      expect(result.statusCode).toBe(200);
      expect(calls).toContain('instanceService.listInstances');
    });
    it('the terminal WebSocket with a valid token reaches the gateway', async () => {
      const { calls } = await callsDuring(() => wsFirstMessage(`ws://127.0.0.1:${port}/api/terminal/x?token=${token}`));
      expect(calls).toContain('terminalGateway.handleConnection');
    });
  });
});
