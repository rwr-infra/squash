import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { InstanceService } from '../../../services/instance-service.js';
import type { LogService } from '../../../services/log-service.js';
import type { TerminalService } from '../../../services/terminal-service.js';
import type { AuditService } from '../../../services/audit-service.js';
import { currentUser } from '../auth.js';
import { CreateInstanceSchema, type CreateInstanceRequest, InstanceIdParamSchema, type InstanceIdParam, TailLogQuerySchema, type TailLogQuery, SendCommandSchema, type SendCommandRequest } from '../schemas/instance-schemas.js';

type RouteDeps = {
  instanceService: InstanceService;
  logService: LogService;
  terminalService: TerminalService;
  auditService: AuditService;
};

export const registerInstanceRoutes = async (fastify: FastifyInstance, deps: RouteDeps) => {
  fastify.get('/instances', async (request, reply) => {
    const instances = await deps.instanceService.listInstances();
    return reply.status(200).send({
      success: true,
      data: instances
    });
  });

  fastify.get('/instances/:id', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    const instance = await deps.instanceService.getInstance(id);
    if (!instance) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'INSTANCE_NOT_FOUND',
          message: `Instance ${id} not found`
        }
      });
    }
    return reply.status(200).send({
      success: true,
      data: instance
    });
  });

  fastify.post('/instances', async (request: FastifyRequest<{ Body: CreateInstanceRequest }>, reply) => {
    try {
      const validated = CreateInstanceSchema.parse(request.body);
      const instance = await deps.instanceService.createInstance(validated);
      await deps.auditService.record('create', currentUser(request.headers.authorization), instance.id);
      return reply.status(201).send({
        success: true,
        data: instance
      });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: err instanceof Error ? err.message : 'Invalid instance data'
        }
      });
    }
  });

  fastify.put('/instances/:id', async (request: FastifyRequest<{ Params: InstanceIdParam; Body: CreateInstanceRequest }>, reply) => {
    const { id } = request.params;
    let validated: CreateInstanceRequest;
    try {
      validated = CreateInstanceSchema.parse({ ...(request.body as object), id });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_REQUEST', message: err instanceof Error ? err.message : 'Invalid instance data' }
      });
    }

    try {
      const updated = await deps.instanceService.updateInstance(validated);
      if (!updated) {
        return reply.status(404).send({
          success: false,
          error: { code: 'INSTANCE_NOT_FOUND', message: `Instance ${id} not found` }
        });
      }
      return reply.status(200).send({ success: true, data: updated });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INSTANCE_ERROR', message: err instanceof Error ? err.message : 'Failed to update instance' }
      });
    }
  });

  fastify.post('/instances/:id/start', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    try {
      const runtime = await deps.instanceService.startInstance(id);
      if (!runtime) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'INSTANCE_NOT_FOUND',
            message: `Instance ${id} not found`
          }
        });
      }
      await deps.auditService.record('start', currentUser(request.headers.authorization), id);
      return reply.status(200).send({
        success: true,
        data: runtime
      });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INSTANCE_ERROR',
          message: err instanceof Error ? err.message : 'Failed to start instance'
        }
      });
    }
  });

  fastify.post('/instances/:id/stop', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    try {
      const runtime = await deps.instanceService.stopInstance(id);
      if (!runtime) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'INSTANCE_NOT_FOUND',
            message: `Instance ${id} not found`
          }
        });
      }
      await deps.auditService.record('stop', currentUser(request.headers.authorization), id);
      return reply.status(200).send({
        success: true,
        data: runtime
      });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INSTANCE_ERROR',
          message: err instanceof Error ? err.message : 'Failed to stop instance'
        }
      });
    }
  });

  fastify.post('/instances/:id/restart', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    try {
      const runtime = await deps.instanceService.restartInstance(id);
      if (!runtime) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'INSTANCE_NOT_FOUND',
            message: `Instance ${id} not found`
          }
        });
      }
      await deps.auditService.record('restart', currentUser(request.headers.authorization), id);
      return reply.status(200).send({
        success: true,
        data: runtime
      });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INSTANCE_ERROR',
          message: err instanceof Error ? err.message : 'Failed to restart instance'
        }
      });
    }
  });

  fastify.delete('/instances/:id', async (request: FastifyRequest<{ Params: InstanceIdParam }>, reply) => {
    const { id } = request.params;
    try {
      const deleted = await deps.instanceService.deleteInstance(id);
      if (!deleted) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'INSTANCE_NOT_FOUND',
            message: `Instance ${id} not found`
          }
        });
      }
      await deps.auditService.record('delete', currentUser(request.headers.authorization), id);
      return reply.status(200).send({
        success: true,
        data: { id, deleted: true }
      });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INSTANCE_ERROR',
          message: err instanceof Error ? err.message : 'Failed to delete instance'
        }
      });
    }
  });

  fastify.post('/instances/:id/command', async (request: FastifyRequest<{ Params: InstanceIdParam; Body: SendCommandRequest }>, reply) => {
    const { id } = request.params;

    const instance = await deps.instanceService.getInstance(id);
    if (!instance) {
      return reply.status(404).send({
        success: false,
        error: { code: 'INSTANCE_NOT_FOUND', message: `Instance ${id} not found` }
      });
    }

    let body: SendCommandRequest;
    try {
      body = SendCommandSchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_REQUEST', message: err instanceof Error ? err.message : 'Invalid command payload' }
      });
    }

    try {
      const output = await deps.terminalService.captureCommand(id, body.command, {
        appendNewline: body.appendNewline,
        captureMs: body.captureMs
      });
      await deps.auditService.record('command', currentUser(request.headers.authorization), id, body.command);
      return reply.status(200).send({
        success: true,
        data: body.captureMs && body.captureMs > 0 ? { output } : { accepted: true }
      });
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INSTANCE_ERROR', message: err instanceof Error ? err.message : 'Failed to send command' }
      });
    }
  });

  fastify.get('/instances/:id/logs/tail', async (request: FastifyRequest<{ Params: InstanceIdParam; Query: TailLogQuery }>, reply) => {
    const { id } = request.params;
    const { lines } = TailLogQuerySchema.parse(request.query);
    const logs = await deps.logService.getTail(id, lines);
    return reply.status(200).send({
      success: true,
      data: logs
    });
  });

  fastify.get('/audit', async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    const entries = await deps.auditService.list(Number.isFinite(limit) ? limit : 100);
    return reply.status(200).send({ success: true, data: entries });
  });
};