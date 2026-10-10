import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { createHttpServer as CreateHttpServer } from '../../src/api/http/http-server.js';

export type ApiDeps = Parameters<typeof CreateHttpServer>[0];
export type ApiServer = Awaited<ReturnType<typeof CreateHttpServer>>;

export const API_USERNAME = 'smoke';

/**
 * The real createHttpServer, auth hook included, behind a login with a strong
 * password, serving a one-line SPA from `staticDir`. auth.ts reads AUTH_* once,
 * when it is first imported — so the env is set here and the server module is
 * loaded after it; call this before anything else imports either. Services
 * not given are empty objects (a route that reaches one fails loudly), except
 * the audit service, which records nothing: it must not write to logs/.
 */
export const createApiServer = async (options: {
  readonly password: string;
  readonly staticDir: string;
  readonly deps?: Partial<ApiDeps>;
}): Promise<ApiServer> => {
  vi.stubEnv('AUTH_USERNAME', API_USERNAME);
  vi.stubEnv('AUTH_PASSWORD', options.password);
  vi.stubEnv('AUTH_TOKEN', undefined);
  fs.mkdirSync(options.staticDir, { recursive: true });
  fs.writeFileSync(path.join(options.staticDir, 'index.html'), '<!doctype html><title>spa</title>');
  vi.stubEnv('SQUASH_STATIC_DIR', options.staticDir);

  const { createHttpServer } = await import('../../src/api/http/http-server.js');
  return createHttpServer({
    instanceService: {},
    logService: {},
    terminalService: {},
    terminalGateway: {},
    auditService: { record: async () => {} },
    templateService: {},
    serverLogService: {},
    ...options.deps
  } as ApiDeps);
};

/** The session token for API_USERNAME, or '' when login fails. */
export const login = async (server: ApiServer, password: string): Promise<string> => {
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username: API_USERNAME, password } });
  return (res.json() as { data?: { token?: string } }).data?.token ?? '';
};
