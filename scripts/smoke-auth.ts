// Regression smoke for the /api auth hook: every protected route refuses a
// request without a valid token however its path is written, and its handler
// never runs. Through the real createHttpServer, with every service a stub
// that counts its calls. Checks:
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
//
// Usage: npm run smoke:auth

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
};

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-auth-smoke-'));
process.on('exit', () => fs.rmSync(workRoot, { recursive: true, force: true }));
fs.writeFileSync(path.join(workRoot, 'index.html'), '<!doctype html><title>spa</title>');

// auth.ts reads these when it is first imported: a strong password, so the
// hook is what stands between the network and the handlers.
process.env.AUTH_USERNAME = 'smoke';
process.env.AUTH_PASSWORD = 'a-long-unguessable-smoke-password';
delete process.env.AUTH_TOKEN;
process.env.SQUASH_STATIC_DIR = workRoot;

const { createHttpServer } = await import('../src/api/http/http-server.js');
type ApiDeps = Parameters<typeof createHttpServer>[0];

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
  auditService: stub('auditService')
} as unknown as ApiDeps;
const server = await createHttpServer(deps);

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
  ['GET', '/api/audit'],
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/logout']
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

try {
  await server.ready();
  const registered = [...registeredRoutes(server.printRoutes({ commonPrefix: false }))].filter((route) => route.split(' ')[1]!.startsWith('/api'));
  const expected = [...PROTECTED.map(([method, route]) => `${method} ${route}`), ...PUBLIC_ROUTES];
  check(
    'the /api routes are exactly the listed protected and public ones',
    registered.length === expected.length && expected.every((route) => registered.includes(route)),
    `unlisted: ${registered.filter((route) => !expected.includes(route)).join(', ') || '-'}; missing: ${expected.filter((route) => !registered.includes(route)).join(', ') || '-'}`
  );

  for (const [method, , url, body] of PROTECTED) {
    for (const spelled of spellings(url)) {
      const before = calls.length;
      const res = await server.inject({ method: method as 'GET', url: spelled, ...(body === undefined ? {} : { payload: body as object }) });
      check(`no token: ${method} ${spelled}`, res.statusCode === 401 && calls.length === before, `${res.statusCode}, ${calls.slice(before).join(',') || 'no calls'}`);
    }
    const before = calls.length;
    const wrong = await server.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer not-a-session' }, ...(body === undefined ? {} : { payload: body as object }) });
    check(`wrong token: ${method} ${url}`, wrong.statusCode === 401 && calls.length === before);
  }

  // The %61pi spelling reaches the route: it must meet the hook, not miss it.
  const encoded = await server.inject({ method: 'GET', url: '/%61pi/instances' });
  check('an encoded path still meets the hook (401 UNAUTHORIZED)', encoded.statusCode === 401 && encoded.json().error?.code === 'UNAUTHORIZED', `${encoded.statusCode}`);

  await server.listen({ port: 0, host: '127.0.0.1' });
  const port = (server.server.address() as net.AddressInfo).port;
  for (const [method, , url, body] of PROTECTED) {
    for (const target of [`http://smoke${url}`, `http://smoke${url.replace('/api/', '/%61pi/')}`]) {
      const before = calls.length;
      const status = await rawStatus(port, method, target, body);
      check(`no token, absolute-form: ${method} ${target}`, status === 401 && calls.length === before, `${status}, ${calls.slice(before).join(',') || 'no calls'}`);
    }
  }

  // A WebSocket upgrade to a protected route meets the hook too.
  const upgrade = ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='];
  for (const target of ['/api/instances', '/%61pi/instances', `http://smoke/api/audit`]) {
    const before = calls.length;
    const status = await rawStatus(port, 'GET', target, undefined, upgrade);
    check(`no token, WebSocket upgrade: ${target}`, status === 401 && calls.length === before, `${status}`);
  }

  // The terminal WebSocket checks its own ?token=.
  const ws = `ws://127.0.0.1:${port}/api/terminal/x`;
  for (const [label, url] of [['no token', ws], ['a wrong token', `${ws}?token=not-a-session`], ['an encoded path, no token', `ws://127.0.0.1:${port}/%61pi/terminal/x`]] as const) {
    const before = calls.length;
    const first = await wsFirstMessage(url);
    check(`terminal WebSocket with ${label} is refused`, first.includes('Unauthorized') && !calls.slice(before).includes('terminalGateway.handleConnection'), first);
  }
  const headTerminal = await server.inject({ method: 'HEAD', url: '/api/terminal/x' });
  check('the terminal route has no HEAD route', headTerminal.statusCode === 404, `${headTerminal.statusCode}`);

  // Still public.
  const health = await server.inject({ method: 'GET', url: '/api/health' });
  const status = await server.inject({ method: 'GET', url: '/api/auth/status' });
  const badLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'smoke', password: 'wrong' } });
  const spa = await server.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
  const unknown = await server.inject({ method: 'GET', url: '/api/no-such-route' });
  check('health is public', health.statusCode === 200);
  check('auth status is public', status.statusCode === 200);
  check('login is reachable without a token (wrong password: its own 401)', badLogin.statusCode === 401 && badLogin.json().error?.code === 'INVALID_CREDENTIALS', badLogin.body);
  check('the SPA needs no token', spa.statusCode === 200 && spa.body.includes('spa'));
  check('an unknown /api path is 404', unknown.statusCode === 404);

  // Positive control: a valid token gets through to the handler.
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'smoke', password: 'a-long-unguessable-smoke-password' } });
  const token = (login.json() as { data?: { token?: string } }).data?.token;
  const before = calls.length;
  const allowed = await server.inject({ method: 'GET', url: '/api/instances', headers: { authorization: `Bearer ${token}` } });
  check('a valid token reaches the handler', allowed.statusCode === 200 && calls.slice(before).includes('instanceService.listInstances'), `${allowed.statusCode}`);
  const beforeWs = calls.length;
  await wsFirstMessage(`${ws}?token=${token}`);
  check('the terminal WebSocket with a valid token reaches the gateway', calls.slice(beforeWs).includes('terminalGateway.handleConnection'));
} finally {
  await server.close();
}

if (failures.length > 0) {
  console.log(`[smoke] ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[smoke] all auth checks passed');
