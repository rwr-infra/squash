import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TemplateNameTakenError, type TemplateService } from '../../../services/template-service.js';
import { TemplateBodySchema, type TemplateBody, type TemplateIdParam } from '../schemas/template-schemas.js';

type RouteDeps = {
  templateService: TemplateService;
};

const notFound = (reply: FastifyReply, id: string) =>
  reply.status(404).send({
    success: false,
    error: { code: 'TEMPLATE_NOT_FOUND', message: `Template ${id} not found` }
  });

const invalidRequest = (reply: FastifyReply, message: string) =>
  reply.status(400).send({
    success: false,
    error: { code: 'INVALID_REQUEST', message }
  });

const nameTaken = (reply: FastifyReply, err: TemplateNameTakenError) =>
  reply.status(409).send({
    success: false,
    error: { code: 'TEMPLATE_NAME_TAKEN', message: err.message }
  });

export const registerTemplateRoutes = async (fastify: FastifyInstance, deps: RouteDeps) => {
  fastify.get('/templates', async (request, reply) => {
    return reply.status(200).send({
      success: true,
      data: deps.templateService.listTemplates()
    });
  });

  fastify.post('/templates', async (request: FastifyRequest<{ Body: TemplateBody }>, reply) => {
    const body = TemplateBodySchema.safeParse(request.body);
    if (!body.success) {
      return invalidRequest(reply, body.error.message);
    }
    try {
      const template = await deps.templateService.createTemplate(body.data);
      return reply.status(201).send({ success: true, data: template });
    } catch (err) {
      if (err instanceof TemplateNameTakenError) {
        return nameTaken(reply, err);
      }
      throw err;
    }
  });

  fastify.put('/templates/:id', async (request: FastifyRequest<{ Params: TemplateIdParam; Body: TemplateBody }>, reply) => {
    const { id } = request.params;
    const body = TemplateBodySchema.safeParse(request.body);
    if (!body.success) {
      return invalidRequest(reply, body.error.message);
    }
    try {
      const template = await deps.templateService.updateTemplate(id, body.data);
      if (!template) {
        return notFound(reply, id);
      }
      return reply.status(200).send({ success: true, data: template });
    } catch (err) {
      if (err instanceof TemplateNameTakenError) {
        return nameTaken(reply, err);
      }
      throw err;
    }
  });

  fastify.delete('/templates/:id', async (request: FastifyRequest<{ Params: TemplateIdParam }>, reply) => {
    const { id } = request.params;
    const deleted = await deps.templateService.deleteTemplate(id);
    if (!deleted) {
      return notFound(reply, id);
    }
    return reply.status(200).send({ success: true, data: { id, deleted: true } });
  });
};
