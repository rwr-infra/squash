import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StaleIndexError } from '../../../core/log/line-index.js';
import type { ServerLogService } from '../../../services/server-log-service.js';
import type { InstanceIdParam } from '../schemas/instance-schemas.js';
import { ServerLogLinesQuerySchema, ServerLogSearchQuerySchema, SERVER_LOG_SEARCH_LIMIT } from '../schemas/server-log-schemas.js';

type RouteDeps = {
  serverLogService: ServerLogService;
};

const notFound = (reply: FastifyReply, id: string) =>
  reply.status(404).send({
    success: false,
    error: { code: 'INSTANCE_NOT_FOUND', message: `Instance ${id} not found` }
  });

const invalidRequest = (reply: FastifyReply, message: string) =>
  reply.status(400).send({
    success: false,
    error: { code: 'INVALID_REQUEST', message }
  });

// The file exists but can't be read right now (locked, permissions, not a
// regular file, rewritten on every attempt): say which and why, instead of
// the generic 500. Anything else — including Node's own ERR_* errors, which
// mean a bug rather than a file problem — goes to the error handler.
const unreadable = (reply: FastifyReply, err: unknown) => {
  if (err instanceof StaleIndexError) {
    return reply.status(503).send({
      success: false,
      error: { code: 'SERVER_LOG_CHANGING', message: 'rwr_server.log kept changing while it was read; try again' }
    });
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== 'string' || code.startsWith('ERR_')) throw err;
  return reply.status(503).send({
    success: false,
    error: { code: 'SERVER_LOG_UNREADABLE', message: `Cannot read rwr_server.log (${code})` }
  });
};

export const registerServerLogRoutes = async (fastify: FastifyInstance, deps: RouteDeps) => {
  // Where the file is and what the index covers; brings the index up to date.
  fastify.get('/instances/:id/server-log', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    try {
      const info = await deps.serverLogService.getInfo(id);
      if (!info) return notFound(reply, id);
      return reply.status(200).send({ success: true, data: info });
    } catch (err) {
      return unreadable(reply, err);
    }
  });

  fastify.get('/instances/:id/server-log/lines', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    const query = ServerLogLinesQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error.message);
    try {
      const range = await deps.serverLogService.readLines(id, query.data.from, query.data.count);
      if (!range) return notFound(reply, id);
      return reply.status(200).send({ success: true, data: { ...range.snapshot, from: range.from, lines: range.lines } });
    } catch (err) {
      return unreadable(reply, err);
    }
  });

  fastify.get('/instances/:id/server-log/search', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    const query = ServerLogSearchQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error.message);
    // A search reads the whole file: stop once nobody waits for the answer.
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    // Gone before we got here: its close event has already fired. (The
    // socket, not the request: a request reads as destroyed once its body
    // is consumed.)
    if (request.raw.socket?.destroyed === true) controller.abort();
    try {
      const result = await deps.serverLogService.search(id, query.data.q, query.data.caseSensitive, SERVER_LOG_SEARCH_LIMIT, controller.signal);
      if (!result) return notFound(reply, id);
      return reply.status(200).send({ success: true, data: { ...result.snapshot, matches: result.matches, truncated: result.truncated } });
    } catch (err) {
      // The client is gone: end the request without anyone to read it.
      if ((err as Error).name === 'AbortError') {
        return reply.status(499).send({ success: false, error: { code: 'CLIENT_CLOSED_REQUEST', message: 'Search aborted' } });
      }
      return unreadable(reply, err);
    }
  });
};
