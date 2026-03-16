import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settingsRepo } from '../../db/index.js';
import { aiLogger } from '../../config/logger.js';
import { clearApiKeysCache } from '../../config/index.js';
import { clearPerplexityCache } from '../../ai/websearch.js';
import { clearLiraXConfigCache } from '../../features/telephony/lirax.js';
import { clearLMStudioCache } from '../../ai/lmstudio.js';
import { invalidateTTSConfig } from '../../features/tts.js';

export async function registerSettingsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/settings
   * Get current AI settings
   */
  server.get('/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const settings = await settingsRepo.getAll();

      return reply.code(200).send({
        success: true,
        data: settings,
      });
    } catch (error) {
      aiLogger.error({ error }, 'Get settings error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch settings',
      });
    }
  });

  /**
   * POST /api/settings
   * Update multiple settings at once
   */
  server.post(
    '/settings',
    async (
      request: FastifyRequest<{
        Body: Record<string, string>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const settings = request.body as Record<string, string>;

        if (!settings || typeof settings !== 'object') {
          return reply.code(400).send({
            success: false,
            error: 'Invalid request body',
          });
        }

        // Update each setting
        for (const [key, value] of Object.entries(settings)) {
          if (typeof value === 'string') {
            await settingsRepo.set(key, value);
          }
        }

        clearApiKeysCache();
        clearPerplexityCache();
        clearLiraXConfigCache();
        clearLMStudioCache();
        settingsRepo.invalidateCache?.();
        invalidateTTSConfig();

        aiLogger.info({ keys: Object.keys(settings) }, 'Settings updated via API (caches invalidated)');

        return reply.code(200).send({
          success: true,
          message: 'Settings updated successfully',
        });
      } catch (error) {
        aiLogger.error({ error }, 'Update settings error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to update settings',
        });
      }
    }
  );

  /**
   * PUT /api/settings/:key
   * Update a single setting
   */
  server.put(
    '/settings/:key',
    async (
      request: FastifyRequest<{
        Params: { key: string };
        Body: { value: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { key } = request.params;
        const { value } = request.body as { value: string };

        if (value === undefined || value === null) {
          return reply.code(400).send({
            success: false,
            error: 'Value is required',
          });
        }

        await settingsRepo.set(key, value);

        clearApiKeysCache();
        clearPerplexityCache();
        clearLiraXConfigCache();
        clearLMStudioCache();
        settingsRepo.invalidateCache?.();
        invalidateTTSConfig();

        aiLogger.info({ key }, 'Setting updated via API (caches invalidated)');

        return reply.code(200).send({
          success: true,
          message: `Setting ${key} updated successfully`,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Update setting error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to update setting',
        });
      }
    }
  );
}
