import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settingsRepo } from '../../db/index.js';
import { aiLogger } from '../../config/logger.js';
import { clearApiKeysCache } from '../../config/index.js';
import { clearPerplexityCache } from '../../ai/websearch.js';
import { clearLiraXConfigCache } from '../../features/telephony/lirax.js';
import { clearLMStudioCache } from '../../ai/lmstudio.js';
import { invalidateTTSConfig } from '../../features/tts.js';
import { clearPersonaCache } from '../../ai/persona.js';
import { clearSelfCoreCache, syncSelfCoreSystemFacts } from '../../ai/self-core.js';
import {
  getChatRuntimeState,
  getPersonaRuntimeState,
  getTtsRuntimeState,
} from '../../ai/runtime-truth.js';
import { clearTelephonyRuntimeConfigCache } from '../../features/telephony/service/telephony-runtime-config.js';
import { SETTINGS_REGISTRY, getSettingRegistryEntry, isKnownSettingKey } from '../../config/settings-registry.js';

function validateSettingValue(key: string, value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'Value must be a string.';
  }

  const registryEntry = getSettingRegistryEntry(key);
  if (!registryEntry) {
    return 'Unknown setting key.';
  }

  if (registryEntry.visibility === 'derived') {
    return 'Derived setting cannot be updated manually.';
  }

  const trimmedValue = value.trim();

  if (registryEntry.valueType === 'number' && trimmedValue.length > 0) {
    const parsed = Number(trimmedValue);
    if (!Number.isFinite(parsed)) {
      return 'Value must be a valid number.';
    }
  }

  if (registryEntry.valueType === 'boolean' && trimmedValue.length > 0) {
    if (!['true', 'false'].includes(trimmedValue)) {
      return 'Value must be true or false.';
    }
  }

  if (registryEntry.valueType === 'json' && trimmedValue.length > 0) {
    try {
      JSON.parse(trimmedValue);
    } catch {
      return 'Value must be valid JSON.';
    }
  }

  return null;
}

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

  server.get('/settings/registry', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({
      success: true,
      data: SETTINGS_REGISTRY,
    });
  });

  server.get('/settings/runtime-truth', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const [chat, tts, persona] = await Promise.all([
        getChatRuntimeState(),
        getTtsRuntimeState(),
        getPersonaRuntimeState(),
      ]);
      return reply.code(200).send({
        success: true,
        data: {
          chat,
          tts,
          persona,
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Get runtime truth error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch runtime truth',
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

        const entries = Object.entries(settings);
        const unknownKeys = entries
          .map(([key]) => key)
          .filter((key) => !isKnownSettingKey(key));

        if (unknownKeys.length > 0) {
          return reply.code(400).send({
            success: false,
            error: `Unknown setting keys: ${unknownKeys.join(', ')}`,
          });
        }

        for (const [key, value] of entries) {
          const validationError = validateSettingValue(key, value);
          if (validationError) {
            return reply.code(400).send({
              success: false,
              error: `${key}: ${validationError}`,
            });
          }
        }

        for (const [key, value] of entries) {
          await settingsRepo.set(key, value);
        }

        if ('preferred_vision_model' in settings) {
          try {
            await settingsRepo.set('effective_vision_model', settings.preferred_vision_model);
          } catch (visionError) {
            aiLogger.error({ error: visionError }, 'Failed to sync effective_vision_model after preferred_vision_model update');
          }
        }

        clearApiKeysCache();
        clearPerplexityCache();
        clearLiraXConfigCache();
        clearLMStudioCache();
        clearPersonaCache();
        clearSelfCoreCache();
        clearTelephonyRuntimeConfigCache();
        settingsRepo.invalidateCache?.();
        invalidateTTSConfig();
        await syncSelfCoreSystemFacts();

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

        const validationError = validateSettingValue(key, value);
        if (validationError) {
          return reply.code(400).send({
            success: false,
            error: validationError,
          });
        }

        await settingsRepo.set(key, value);

        if (key === 'preferred_vision_model') {
          try {
            await settingsRepo.set('effective_vision_model', value);
          } catch (visionError) {
            aiLogger.error({ error: visionError, key }, 'Failed to sync effective_vision_model after preferred_vision_model update');
          }
        }

        clearApiKeysCache();
        clearPerplexityCache();
        clearLiraXConfigCache();
        clearLMStudioCache();
        clearPersonaCache();
        clearSelfCoreCache();
        clearTelephonyRuntimeConfigCache();
        settingsRepo.invalidateCache?.();
        invalidateTTSConfig();
        await syncSelfCoreSystemFacts();

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
