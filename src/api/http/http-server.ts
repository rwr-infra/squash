import fastify, { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import type { InstanceService } from '../../services/instance-service.js';
import type { LogService } from '../../services/log-service.js';
import type { TerminalService } from '../../services/terminal-service.js';
import type { TerminalGateway } from '../ws/terminal-gateway.js';
import type { AuditService } from '../../services/audit-service.js';
import { registerInstanceRoutes } from './routes/instance-routes.js';
import { isAuthEnabled, isLoginEnabled, validateBearerToken, login, logout, currentUser } from './auth.js';
import { appPaths } from '../../app/paths.js';

export type ApiDeps = {
  instanceService: InstanceService;
  logService: LogService;
  terminalService: TerminalService;
  terminalGateway: TerminalGateway;
  auditService: AuditService;
};

export const createHttpServer = async (deps: ApiDeps): Promise<FastifyInstance> => {
  const logger = pino({
    name: 'http-server',
    level: process.env.LOG_LEVEL ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime
  });

  const server = fastify({
    disableRequestLogging: process.env.NODE_ENV === 'production'
  });

  await server.register(cors, {
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  await server.register(websocket);

  const staticPath = process.env.SQUASH_STATIC_DIR ?? appPaths.staticDir;

  await server.register(fastifyStatic, {
    root: staticPath,
    prefix: '/'
  });

  // All backend endpoints live under /api. Everything else is the SPA. Auth is
  // required for /api/* except the public ones (health, login, status) and the
  // WS terminal (which authenticates via its query token).
  const requiresAuth = (url: string): boolean => {
    const path = url.split('?')[0];
    if (!path.startsWith('/api/')) return false;
    if (path === '/api/health' || path === '/api/auth/login' || path === '/api/auth/status') return false;
    if (path.startsWith('/api/terminal')) return false;
    return true;
  };

  server.addHook('preHandler', async (request, reply) => {
    if (!requiresAuth(request.url)) return;
    if (isAuthEnabled && !validateBearerToken(request.headers.authorization)) {
      return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } });
    }
  });

  await server.register(async (api) => {
    api.get('/health', async () => ({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } }));

    // Tells the frontend whether to show a login screen.
    api.get('/auth/status', async () => ({ success: true, data: { loginEnabled: isLoginEnabled } }));

    api.post('/auth/login', async (request, reply) => {
      const body = (request.body ?? {}) as { username?: string; password?: string };
      const token = login(body.username ?? '', body.password ?? '');
      if (!token) {
        return reply.status(401).send({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
      }
      await deps.auditService.record('login', body.username ?? 'unknown');
      return reply.status(200).send({ success: true, data: { token, username: body.username } });
    });

    api.get('/auth/me', async (request) => ({
      success: true,
      data: { username: currentUser(request.headers.authorization) }
    }));

    api.post('/auth/logout', async (request) => {
      logout(request.headers.authorization);
      return { success: true, data: { ok: true } };
    });

    // WS terminal stream → /api/terminal/:instanceId (auth via ?token=).
    api.get('/terminal/:instanceId', { websocket: true }, (socket, request) => {
      const token = (request.query as { token?: string }).token;
      if (!validateBearerToken(token ? `Bearer ${token}` : undefined)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        socket.close();
        return;
      }
      const params = request.params as { instanceId: string };
      deps.terminalGateway.handleConnection(socket, { query: { instanceId: params.instanceId } });
    });

    await registerInstanceRoutes(api, deps);
  }, { prefix: '/api' });

  // SPA history fallback: serve index.html for browser navigations to client-side
  // routes (e.g. /login, /terminal/:id on refresh). Unmatched /api/* paths return
  // a JSON 404 instead of the HTML shell.
  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    if (request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  server.setErrorHandler((error: FastifyError, request, reply) => {
    server.log.error({ err: error, url: request.url }, 'Request error');
    return reply.status(error.statusCode ?? 500).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
      }
    });
  });

  return server;
};