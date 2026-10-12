// What the HTTP server logs, through the real createHttpServer (auth hook
// included) with fastify.inject and an in-memory logger at `debug`:
//   - one line per request (none of Fastify's own two): method, path,
//     status and time; actions at info, reads (polling, static files) at
//     debug, 4xx at warn, 5xx at error
//   - no query string, token, Authorization header or password in any line,
//     also for WebSocket upgrades (the terminal's ?token=, and one refused by
//     a route without a WebSocket handler, which @fastify/websocket logs)
//   - a route that throws inside /api: 500 in the API's format
//     (INTERNAL_ERROR), logged with its stack; the message hidden when
//     NODE_ENV=production
//   - a body that isn't JSON: 400 in the API's format (INVALID_REQUEST)
// Uses a temp directory only.
//
// Tests run in order and share state: run the whole file.
import path from 'node:path';
import pino from 'pino';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createApiServer, login, type ApiDeps, type ApiServer } from '../helpers/api-server.js';
import { useTempDir } from '../helpers/temp-dir.js';

const workRoot = useTempDir('squash-request-log-test-');

type Line = { level: number; msg: string; method?: string; url?: string; path?: string; statusCode?: number; responseTimeMs?: number; err?: { message: string; stack: string } };
const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;

describe('request log', () => {
  const PASSWORD = 'request-log-password';
  const lines: Line[] = [];
  const raw: string[] = [];
  let failList = false;
  let server: ApiServer;
  let token = '';
  beforeAll(async () => {
    const logger = pino({ level: 'debug' }, { write: (line: string) => { raw.push(line); lines.push(JSON.parse(line) as Line); } });
    const instanceService = {
      listInstances: async () => {
        if (failList) throw new Error('boom');
        return [];
      }
    } as unknown as ApiDeps['instanceService'];
    server = await createApiServer({ password: PASSWORD, staticDir: path.join(workRoot(), 'static'), deps: { logger, instanceService } });
    token = await login(server, PASSWORD);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await server?.close();
  });

  // The lines a request wrote: inject resolves once the response is sent,
  // and onResponse runs right after.
  const linesOf = async (send: () => Promise<{ statusCode: number; json: () => unknown }>) => {
    const from = lines.length;
    const res = await send();
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(from));
    return { res, lines: lines.slice(from) };
  };
  const get = (url: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => () => server.inject({ method: 'GET', url, headers });

  it('a successful action is one info line: method, path, status, time', () => {
    const loginLines = lines.filter(line => line.url === '/api/auth/login');
    expect(loginLines).toHaveLength(1);
    expect(loginLines[0]).toMatchObject({ level: INFO, msg: 'POST /api/auth/login 200', method: 'POST', statusCode: 200, responseTimeMs: expect.any(Number) });
    expect(lines.some(line => /incoming request|request completed/.test(line.msg))).toBe(false);
  });
  it('a poll is a debug line', async () => {
    const { lines: written } = await linesOf(get('/api/health', {}));
    expect(written).toMatchObject([{ level: DEBUG, msg: 'GET /api/health 200' }]);
  });
  it('static files and the SPA are debug lines', async () => {
    const { lines: written } = await linesOf(get('/', { accept: 'text/html' }));
    expect(written).toMatchObject([{ level: DEBUG, url: '/', statusCode: 200 }]);
  });
  it('a failed login is a warn line', async () => {
    const { res, lines: written } = await linesOf(() => server.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'smoke', password: 'wrong-password-in-body' } }));
    expect(res.statusCode).toBe(401);
    expect(written).toMatchObject([{ level: WARN, msg: 'POST /api/auth/login 401' }]);
  });
  it('an unknown /api path is a warn line', async () => {
    const { lines: written } = await linesOf(get('/api/no-such-route'));
    expect(written).toMatchObject([{ level: WARN, statusCode: 404 }]);
  });
  it('the query string is not logged', async () => {
    const { lines: written } = await linesOf(get('/api/instances?token=query-secret&x=1'));
    expect(written).toMatchObject([{ level: DEBUG, url: '/api/instances', msg: 'GET /api/instances 200' }]);
  });

  it('a route that throws: 500 INTERNAL_ERROR in the API format', async () => {
    failList = true;
    const { res, lines: written } = await linesOf(get('/api/instances'));
    expect([res.statusCode, res.json()]).toEqual([500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }]);
    await vi.waitFor(() => expect(lines.some(line => line.statusCode === 500)).toBe(true));
    const all = lines.slice(lines.indexOf(written[0]!));
    expect(all.find(line => line.msg === 'Request failed')).toMatchObject({ level: ERROR, err: { message: 'boom', stack: expect.stringContaining('Error: boom') } });
    expect(all.find(line => line.statusCode === 500)).toMatchObject({ level: ERROR, msg: 'GET /api/instances 500' });
  });
  it('with NODE_ENV=production the message is hidden', async () => {
    const before = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'production');
    let res;
    try {
      res = await get('/api/instances')();
    } finally {
      vi.stubEnv('NODE_ENV', before);
      failList = false;
    }
    expect([res.statusCode, res.json()]).toEqual([500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }]);
  });
  it('a body that is not JSON: 400 INVALID_REQUEST in the API format, a warn line', async () => {
    const { res, lines: written } = await linesOf(() =>
      server.inject({ method: 'POST', url: '/api/instances', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: '{not json' })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: expect.any(String) } });
    expect(written).toMatchObject([{ level: WARN, msg: 'POST /api/instances 400' }]);
  });

  it('a WebSocket upgrade logs no query string', async () => {
    const from = raw.length;
    const terminal = await server.injectWS('/api/terminal/x?token=ws-terminal-secret');
    terminal.terminate();
    const refused = await server.injectWS('/api/health?token=ws-refused-secret').catch(() => undefined);
    refused?.terminate();
    await vi.waitFor(() => expect(lines.slice(from).some(line => line.msg.includes('no websocket handler'))).toBe(true));
    expect(lines.slice(from).find(line => line.msg.includes('no websocket handler'))).toMatchObject({ path: '/api/health' });
    const written = raw.slice(from).join('');
    for (const secret of ['ws-terminal-secret', 'ws-refused-secret']) expect(written).not.toContain(secret);
  });

  it('no line holds a token, an Authorization header, a query or a password', () => {
    const text = raw.join('');
    for (const secret of [token, 'query-secret', 'ws-terminal-secret', 'ws-refused-secret', PASSWORD, 'wrong-password-in-body']) expect(text).not.toContain(secret);
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text).not.toContain('?');
  });
});
