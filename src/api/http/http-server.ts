import fastify, { FastifyInstance, FastifyError, type FastifyBaseLogger } from 'fastify';
import { stdSerializers } from 'pino';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { InstanceService } from '../../services/instance-service.js';
import type { LogService } from '../../services/log-service.js';
import type { TerminalService } from '../../services/terminal-service.js';
import type { TerminalGateway } from '../ws/terminal-gateway.js';
import type { AuditService } from '../../services/audit-service.js';
import type { TemplateService } from '../../services/template-service.js';
import type { ServerLogService } from '../../services/server-log-service.js';
import { registerInstanceRoutes } from './routes/instance-routes.js';
import { registerTemplateRoutes } from './routes/template-routes.js';
import { registerServerLogRoutes } from './routes/server-log-routes.js';
import { isAuthEnabled, isLoginEnabled, validateBearerToken, login, logout, currentUser } from './auth.js';
import { appPaths } from '../../app/paths.js';
import { requestLogLevel, requestLogPath, requestLogSerializers } from './request-log.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    // Served without a token (see the auth hook in createHttpServer).
    public?: boolean;
  }
}

export type ApiDeps = {
  instanceService: InstanceService;
  logService: LogService;
  terminalService: TerminalService;
  terminalGateway: TerminalGateway;
  auditService: AuditService;
  templateService: TemplateService;
  serverLogService: ServerLogService;
  // Where request lines and request errors go: src/index.ts passes its own
  // logger, whose destination survives a closed terminal. None: nothing is
  // logged.
  logger?: FastifyBaseLogger;
};

export const createHttpServer = async (deps: ApiDeps): Promise<FastifyInstance> => {
  const server = fastify({
    ...(deps.logger ? { loggerInstance: deps.logger.child({}, { serializers: requestLogSerializers(stdSerializers.err) }) } : {}),
    // Fastify's own request logging writes two lines per request, the query
    // string included: the hook below writes one, without it.
    disableRequestLogging: true
  });

  // One line per request, at a level that keeps polling out of the default
  // output (see requestLogLevel). Method, path, status and time only — no
  // headers, query or body, so no token or password.
  server.addHook('onResponse', async (request, reply) => {
    const url = requestLogPath(request.url);
    request.log[requestLogLevel(request.method, reply.statusCode)](
      { method: request.method, url, statusCode: reply.statusCode, responseTimeMs: Math.round(reply.elapsedTime) },
      `${request.method} ${url} ${reply.statusCode}`
    );
  });

  // Set before any plugin is registered: a plugin keeps the error handler of
  // when it was registered, and routes added earlier would answer with
  // Fastify's default one. A thrown 4xx (a body that isn't JSON, too large)
  // keeps its status and message; anything else is a 500, logged with its
  // stack.
  server.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({ success: false, error: { code: 'INVALID_REQUEST', message: error.message } });
    }
    request.log.error({ err: error }, 'Request failed');
    return reply.status(statusCode).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
      }
    });
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

  // All backend endpoints live under /api. Everything else is the SPA.
  await server.register(async (api) => {
    // Every route registered in here — below or by the route modules — needs
    // a valid token unless its own options mark it public (per method). This
    // looks at the route the request matched, never at the raw URL: the
    // router decodes %xx escapes and accepts absolute-form request lines
    // ("GET http://host/api/... HTTP/1.1"), so a check on the URL string can
    // be steered past while the request still reaches a protected route.
    // Requests that match no route get the 404 handler outside this scope.
    api.addHook('preHandler', async (request, reply) => {
      if (request.routeOptions.config.public) return;
      if (isAuthEnabled && !validateBearerToken(request.headers.authorization)) {
        return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } });
      }
    });
    const publicRoute = { config: { public: true } };

    api.get('/health', publicRoute, async () => ({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } }));

    // Tells the frontend whether to show a login screen.
    api.get('/auth/status', publicRoute, async () => ({ success: true, data: { loginEnabled: isLoginEnabled } }));

    api.post('/auth/login', publicRoute, async (request, reply) => {
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

    // WS terminal stream → /api/terminal/:instanceId. Public to the hook: it
    // checks the ?token= itself (browsers can't set headers on a WebSocket).
    // No HEAD route: it would call this socket handler as an HTTP one.
    api.get('/terminal/:instanceId', { websocket: true, exposeHeadRoute: false, ...publicRoute }, (socket, request) => {
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
    await registerTemplateRoutes(api, deps);
    await registerServerLogRoutes(api, deps);
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

  return server;
};