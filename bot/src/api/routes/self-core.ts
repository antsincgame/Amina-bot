import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildSelfCorePromptPreviews, getSelfCoreKernel } from '../../ai/self-core-kernel.js';
import {
  isManualSelfCoreCategory,
  selfCoreRepo,
  syncSelfCoreSystemFacts,
} from '../../ai/self-core.js';
import { aiLogger } from '../../config/logger.js';

const factCategorySchema = z.enum([
  'identity',
  'relationship',
  'capability',
  'limitation',
  'configuration',
  'observation',
  'lesson',
  'question',
  'preference',
]);

const factSourceSchema = z.enum([
  'system',
  'interaction',
  'admin',
  'manual',
  'reflection',
]);

const listFactsQuerySchema = z.object({
  category: factCategorySchema.optional(),
  source: factSourceSchema.optional(),
  includeInactive: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const createFactSchema = z.object({
  category: factCategorySchema,
  content: z.string().min(12).max(420),
  source: factSourceSchema.optional(),
});

const updateFactSchema = z.object({
  content: z.string().min(12).max(420).optional(),
  is_active: z.boolean().optional(),
});

const promptPreviewQuerySchema = z.object({
  channel: z.enum(['telegram', 'voice', 'digest', 'system']).optional(),
});

export async function registerSelfCoreRoutes(server: FastifyInstance): Promise<void> {
  server.get('/self-core/effective', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const kernel = await getSelfCoreKernel();
      return reply.code(200).send({ success: true, data: kernel });
    } catch (error) {
      aiLogger.error({ error }, 'Failed to fetch self-core kernel');
      return reply.code(500).send({ success: false, error: 'Failed to fetch self-core kernel' });
    }
  });

  server.get(
    '/self-core/facts',
    async (
      request: FastifyRequest<{ Querystring: z.infer<typeof listFactsQuerySchema> }>,
      reply: FastifyReply,
    ) => {
      try {
        const query = listFactsQuerySchema.parse(request.query);
        const facts = await selfCoreRepo.listFacts({
          category: query.category,
          source: query.source,
          includeInactive: query.includeInactive,
          limit: query.limit,
        });
        return reply.code(200).send({ success: true, data: facts });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ success: false, error: 'Invalid self-core facts query', details: error.errors });
        }
        aiLogger.error({ error }, 'Failed to fetch self-core facts');
        return reply.code(500).send({ success: false, error: 'Failed to fetch self-core facts' });
      }
    },
  );

  server.post(
    '/self-core/facts',
    async (
      request: FastifyRequest<{ Body: z.infer<typeof createFactSchema> }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = createFactSchema.parse(request.body);
        if (!isManualSelfCoreCategory(body.category)) {
          return reply.code(400).send({
            success: false,
            error: 'Identity, relationship and configuration are canonical persona/runtime fields and cannot be created manually in self-core.',
          });
        }
        const fact = await selfCoreRepo.addFact(
          body.category,
          body.content,
          body.source ?? 'manual',
        );

        if (!fact) {
          return reply.code(409).send({
            success: false,
            error: 'Fact was rejected as duplicate or invalid',
          });
        }

        return reply.code(201).send({ success: true, data: fact });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ success: false, error: 'Invalid self-core fact payload', details: error.errors });
        }
        aiLogger.error({ error }, 'Failed to create self-core fact');
        return reply.code(500).send({ success: false, error: 'Failed to create self-core fact' });
      }
    },
  );

  server.patch(
    '/self-core/facts/:id',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: z.infer<typeof updateFactSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params;
        const body = updateFactSchema.parse(request.body);

        if (body.content === undefined && body.is_active === undefined) {
          return reply.code(400).send({
            success: false,
            error: 'Provide content or is_active to update a self-core fact',
          });
        }

        await selfCoreRepo.updateFact(id, {
          content: body.content,
          is_active: body.is_active,
        });
        return reply.code(200).send({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ success: false, error: 'Invalid self-core fact update payload', details: error.errors });
        }
        aiLogger.error({ error }, 'Failed to update self-core fact');
        return reply.code(500).send({ success: false, error: 'Failed to update self-core fact' });
      }
    },
  );

  server.get(
    '/self-core/prompt-preview',
    async (
      request: FastifyRequest<{ Querystring: z.infer<typeof promptPreviewQuerySchema> }>,
      reply: FastifyReply,
    ) => {
      try {
        const query = promptPreviewQuerySchema.parse(request.query);
        const previews = await buildSelfCorePromptPreviews();
        const filtered = query.channel
          ? previews.filter((preview) => preview.channel === query.channel)
          : previews;
        return reply.code(200).send({ success: true, data: filtered });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ success: false, error: 'Invalid self-core prompt preview query', details: error.errors });
        }
        aiLogger.error({ error }, 'Failed to build self-core prompt previews');
        return reply.code(500).send({ success: false, error: 'Failed to build self-core prompt preview' });
      }
    },
  );

  server.post('/self-core/sync', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await syncSelfCoreSystemFacts();
      const kernel = await getSelfCoreKernel();
      return reply.code(200).send({ success: true, data: kernel });
    } catch (error) {
      aiLogger.error({ error }, 'Failed to sync self-core facts');
      return reply.code(500).send({ success: false, error: 'Failed to sync self-core facts' });
    }
  });
}
