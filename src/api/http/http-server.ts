import fastify, { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import type { InstanceService } from '../../services/instance-service.js';
import type { LogService } from '../../services/log-service.js';
import type { TerminalService } from '../../services/terminal-service.js';
import type { TerminalGateway } from '../ws/terminal-gateway.js';
import { registerInstanceRoutes } from './routes/instance-routes.js';
import { isAuthEnabled, validateBearerToken } from './auth.js';
import { appPaths } from '../../app/paths.js';

export type ApiDeps = {
  instanceService: InstanceService;
  logService: LogService;
  terminalService: TerminalService;
  terminalGateway: TerminalGateway;
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
    prefix: '/',
    decorateReply: false
  });

  server.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    if (url === '/health' || url.startsWith('/terminal')) return;
    if (isAuthEnabled && !validateBearerToken(request.headers.authorization)) {
      return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } });
    }
  });

  server.get('/terminal/:instanceId', { websocket: true }, (socket, request) => {
    const token = (request.query as { token?: string }).token;
    if (!validateBearerToken(token ? `Bearer ${token}` : undefined)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      socket.close();
      return;
    }
    const params = request.params as { instanceId: string };
    deps.terminalGateway.handleConnection(socket, { query: { instanceId: params.instanceId } });
  });

  await registerInstanceRoutes(server, deps);

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