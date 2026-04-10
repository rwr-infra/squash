import fastify, { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import pino from 'pino';
import type { InstanceService } from '../../services/instance-service.js';
import type { LogService } from '../../services/log-service.js';
import type { TerminalService } from '../../services/terminal-service.js';
import type { TerminalGateway } from '../ws/terminal-gateway.js';
import { registerInstanceRoutes } from './routes/instance-routes.js';

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

  server.get('/health', async (request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      timestamp: new Date().toISOString()
    });
  });

  server.get('/terminal/:instanceId', { websocket: true }, (socket, request) => {
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