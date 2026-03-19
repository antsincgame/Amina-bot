import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { promptsRepo } from '../../db/index.js';
import { aiLogger } from '../../config/logger.js';
import { clearSelfCoreKernelCache } from '../../ai/self-core-kernel.js';

export async function registerPromptsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/prompts
   * Get all prompts
   */
  server.get('/prompts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const prompts = await promptsRepo.getAll();

      return reply.code(200).send({
        success: true,
        data: prompts,
      });
    } catch (error) {
      aiLogger.error({ error }, 'Get prompts error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch prompts',
      });
    }
  });

  /**
   * POST /api/prompts
   * Create a new prompt
   */
  server.post(
    '/prompts',
    async (
      request: FastifyRequest<{
        Body: {
          name: string;
          content: string;
          channel: 'telegram' | 'voice' | 'all';
          is_active?: boolean;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { name, content, channel, is_active } = request.body as {
          name: string;
          content: string;
          channel: 'telegram' | 'voice' | 'all';
          is_active?: boolean;
        };

        if (!name || !content || !channel) {
          return reply.code(400).send({
            success: false,
            error: 'Name, content, and channel are required',
          });
        }

        const prompt = await promptsRepo.create({
          name,
          content,
          channel,
          is_active: is_active ?? false,
        });

        aiLogger.info({ promptId: prompt.id }, 'Prompt created via API');
        clearSelfCoreKernelCache();

        return reply.code(201).send({
          success: true,
          data: prompt,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Create prompt error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to create prompt',
        });
      }
    }
  );

  /**
   * PUT /api/prompts/:id
   * Update a prompt
   */
  server.put(
    '/prompts/:id',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          name?: string;
          content?: string;
          channel?: 'telegram' | 'voice' | 'all';
          is_active?: boolean;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const updates = request.body as {
          name?: string;
          content?: string;
          channel?: 'telegram' | 'voice' | 'all';
          is_active?: boolean;
        };

        const prompt = await promptsRepo.update(id, updates);

        aiLogger.info({ promptId: id }, 'Prompt updated via API');
        clearSelfCoreKernelCache();

        return reply.code(200).send({
          success: true,
          data: prompt,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Update prompt error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to update prompt',
        });
      }
    }
  );

  /**
   * DELETE /api/prompts/:id
   * Delete a prompt
   */
  server.delete(
    '/prompts/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        await promptsRepo.delete(id);

        aiLogger.info({ promptId: id }, 'Prompt deleted via API');
        clearSelfCoreKernelCache();

        return reply.code(200).send({
          success: true,
          message: 'Prompt deleted successfully',
        });
      } catch (error) {
        aiLogger.error({ error }, 'Delete prompt error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to delete prompt',
        });
      }
    }
  );

  /**
   * POST /api/prompts/:id/activate
   * Set a prompt as active
   */
  server.post(
    '/prompts/:id/activate',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        await promptsRepo.setActive(id);

        aiLogger.info({ promptId: id }, 'Prompt activated via API');
        clearSelfCoreKernelCache();

        return reply.code(200).send({
          success: true,
          message: 'Prompt activated successfully',
        });
      } catch (error) {
        aiLogger.error({ error }, 'Activate prompt error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to activate prompt',
        });
      }
    }
  );
}
