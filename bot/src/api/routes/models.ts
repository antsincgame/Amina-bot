import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settingsRepo } from '../../db/index.js';
import { aiLogger } from '../../config/logger.js';
import { config, getApiKeys } from '../../config/index.js';
import { getProxyHeaders } from '../../config/ai-proxy.js';
import {
  getAllAudioModels,
  getAudioModelState,
  getFreeVisionModels,
  refreshFreeVisionModelsCache,
  getVisionFallbackStatus,
  getVisionModelState,
} from '../../ai/multimodal.js';

export async function registerModelsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/models/vision
   */
  server.get('/models/vision', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const models = await getFreeVisionModels();
      const fallbackStatus = getVisionFallbackStatus();
      const visionState = await getVisionModelState();
      return reply.code(200).send({
        success: true,
        data: {
          models,
          currentModel: visionState.effectiveModel,
          preferredModel: visionState.preferredModel,
          effectiveModel: visionState.effectiveModel,
          overrideModel: visionState.overrideModel,
          source: visionState.source,
          fallbackStatus,
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Get vision models error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch vision models',
      });
    }
  });

  /**
   * POST /api/models/vision/refresh
   */
  server.post('/models/vision/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const freshModels = await refreshFreeVisionModelsCache();
      const fallbackStatus = getVisionFallbackStatus();
      const visionState = await getVisionModelState();
      return reply.code(200).send({
        success: true,
        data: {
          models: freshModels,
          count: freshModels.length,
          currentModel: visionState.effectiveModel,
          preferredModel: visionState.preferredModel,
          effectiveModel: visionState.effectiveModel,
          overrideModel: visionState.overrideModel,
          source: visionState.source,
          fallbackStatus,
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Refresh vision models error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to refresh vision models',
      });
    }
  });

  /**
   * POST /api/models/vision/test
   * Проверяет конкретную vision модель реальным запросом с картинкой.
   */
  server.post('/models/vision/test', async (request: FastifyRequest<{ Body: { model: string } }>, reply: FastifyReply) => {
    const { model } = request.body as { model?: string };
    if (!model?.trim()) {
      return reply.code(400).send({ success: false, error: 'model is required' });
    }

    const start = Date.now();
    try {
      const keys = await getApiKeys();
      if (!keys.openrouter) {
        return reply.code(200).send({ success: false, status: 'error', error: 'OpenRouter API key not configured', latencyMs: 0 });
      }

      const { getProxyHeaders, getOpenRouterBaseUrl } = await import('../../config/ai-proxy.js');
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey: keys.openrouter,
        baseURL: getOpenRouterBaseUrl(),
        timeout: 15000,
        defaultHeaders: getProxyHeaders({ 'HTTP-Referer': config.botUrl, 'X-Title': 'Amina AI Bot' }),
      });

      const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const res = await client.chat.completions.create({
        model: model.trim(),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What color is this pixel? Answer in one word.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } },
          ],
        }],
        max_tokens: 10,
      });

      const content = res.choices?.[0]?.message?.content ?? '';
      const latencyMs = Date.now() - start;

      if (content.length > 0) {
        return reply.code(200).send({ success: true, status: 'ok', model: res.model || model, latencyMs, detail: content.slice(0, 50) });
      }
      return reply.code(200).send({ success: false, status: 'error', model, latencyMs, error: 'Модель вернула пустой ответ' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const latencyMs = Date.now() - start;
      let diagnosis = `Ошибка: ${msg.slice(0, 100)}`;
      if (msg.includes('404') || msg.includes('not found')) diagnosis = 'Модель не найдена на OpenRouter — удалена или переименована.';
      else if (msg.includes('429')) diagnosis = 'Превышен лимит запросов. Подождите минуту.';
      else if (msg.includes('402')) diagnosis = 'Недостаточно кредитов для этой модели.';
      else if (msg.includes('400')) diagnosis = 'Модель не поддерживает vision (изображения).';

      aiLogger.warn({ model, error: msg, latencyMs }, 'Vision model test failed');
      return reply.code(200).send({ success: false, status: 'error', model, latencyMs, error: diagnosis });
    }
  });

  /**
   * GET /api/models/audio
   */
  server.get('/models/audio', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const models = getAllAudioModels();
      const audioState = await getAudioModelState();
      return reply.code(200).send({
        success: true,
        data: {
          models,
          preferredModel: audioState.preferredModel,
          effectiveModel: audioState.effectiveModel,
          overrideModel: audioState.overrideModel,
          source: audioState.source,
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Get audio models error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch audio models',
      });
    }
  });

  /**
   * GET /api/models/openrouter/vision
   */
  server.get('/models/openrouter/vision', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const models = await refreshFreeVisionModelsCache();
      aiLogger.info({ count: models.length }, 'Fetched free vision models from OpenRouter');
      return reply.code(200).send({
        success: true,
        data: { free: models },
        source: 'openrouter',
      });
    } catch (error) {
      aiLogger.error({ error }, 'Fetch OpenRouter vision models error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch vision models from OpenRouter',
      });
    }
  });

  /**
   * GET /api/models/openrouter/audio
   */
  server.get('/models/openrouter/audio', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const keys = await getApiKeys();
      const apiKey = keys.openrouter || config.ai.apiKey;
      const response = await fetch(`${config.ai.baseUrl}/models`, {
        headers: getProxyHeaders({
          'Authorization': `Bearer ${apiKey}`,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status}`);
      }

      const data = await response.json() as { data: Array<{
        id: string;
        name: string;
        description?: string;
        pricing: { prompt: string; completion: string };
        architecture?: { input_modalities?: string[] };
      }> };

      // Filter models that support audio input
      const audioModels = data.data.filter(model =>
        model.architecture?.input_modalities?.includes('audio')
      );

      const free = audioModels
        .filter(m => m.pricing.prompt === '0' && m.pricing.completion === '0')
        .map(m => ({
          id: m.id,
          name: m.name,
          description: m.description || 'Audio модель',
        }));

      const premium = audioModels
        .filter(m => m.pricing.prompt !== '0' || m.pricing.completion !== '0')
        .slice(0, 10)
        .map(m => ({
          id: m.id,
          name: m.name,
          description: m.description || 'Audio модель (платная)',
        }));

      aiLogger.info({ freeCount: free.length, premiumCount: premium.length }, 'Fetched audio models from OpenRouter');

      return reply.code(200).send({
        success: true,
        data: { free, premium },
        source: 'openrouter',
      });
    } catch (error) {
      aiLogger.error({ error }, 'Fetch OpenRouter audio models error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch audio models from OpenRouter',
      });
    }
  });

  /**
   * GET /api/models/openrouter/image
   */
  server.get('/models/openrouter/image', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const keys = await getApiKeys();
      const apiKey = keys.openrouter || config.ai.apiKey;
      const response = await fetch(`${config.ai.baseUrl}/models`, {
        headers: getProxyHeaders({
          'Authorization': `Bearer ${apiKey}`,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status}`);
      }

      const data = await response.json() as { data: Array<{
        id: string;
        name: string;
        description?: string;
        pricing: { prompt: string; completion: string; image?: string };
        context_length?: number;
        architecture?: {
          modality?: string;
          output_modalities?: string[];
        };
      }> };

      const imageModels = data.data.filter(model => {
        if (model.architecture?.output_modalities?.includes('image')) return true;
        if (model.architecture?.modality === 'image') return true;
        const id = model.id.toLowerCase();
        if (id.includes('flux')) return true;
        if (id.includes('dall-e')) return true;
        if (id.includes('riverflow')) return true;
        if (id.includes('gemini') && id.includes('image')) return true;
        if (id.includes('gpt') && id.includes('image')) return true;
        return false;
      });

      // Sort by price (cheapest first)
      const sortedModels = imageModels
        .map(m => {
          const pricePerToken = m.pricing.image
            ? parseFloat(m.pricing.image)
            : parseFloat(m.pricing.completion);

          const pricePerImage = pricePerToken * 1000;

          return {
            id: m.id,
            name: m.name,
            description: m.description || 'Image generation model',
            pricing: {
              input: parseFloat(m.pricing.prompt),
              output: pricePerToken,
              perImage: pricePerImage,
            },
            contextLength: m.context_length,
          };
        })
        .filter(m => m.pricing.perImage >= 0)
        .sort((a, b) => a.pricing.perImage - b.pricing.perImage);

      const cheap = sortedModels.filter(m => m.pricing.perImage <= 0.05).slice(0, 10);
      const premiumImg = sortedModels.filter(m => m.pricing.perImage > 0.05).slice(0, 10);

      aiLogger.info({
        totalModels: sortedModels.length,
        cheapCount: cheap.length,
        premiumCount: premiumImg.length,
        cheapestModel: cheap[0]?.id,
        cheapestPrice: cheap[0]?.pricing.perImage,
      }, 'Fetched image generation models from OpenRouter');

      return reply.code(200).send({
        success: true,
        data: {
          cheap,
          premium: premiumImg,
          all: sortedModels.slice(0, 20),
        },
        source: 'openrouter',
      });
    } catch (error) {
      aiLogger.error({ error }, 'Fetch OpenRouter image models error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch image models from OpenRouter',
      });
    }
  });

  /**
   * GET /api/models/fallback
   */
  server.get('/models/fallback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { getFallbackModels, getFallbackStatus } = await import('../../ai/openrouter.js');
      const fallbackModels = await getFallbackModels();
      const status = await getFallbackStatus();

      return reply.code(200).send({
        success: true,
        data: {
          enabled: true,
          models: fallbackModels,
          currentModel: status.currentModel,
          lastSwitchReason: status.lastSwitchReason,
          lastSwitchTime: status.lastSwitchTime,
          cachedModels: status.cachedModels,
          cacheAge: status.cacheAge,
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Fallback models info error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to get fallback models info',
      });
    }
  });

  /**
   * POST /api/models/fallback/refresh
   */
  server.post('/models/fallback/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { refreshFreeModelsCache } = await import('../../ai/openrouter.js');
      const models = await refreshFreeModelsCache();

      aiLogger.info({ count: models.length }, 'Free models cache refreshed');

      return reply.code(200).send({
        success: true,
        data: {
          modelsCount: models.length,
          models: models,
          message: 'Free models cache refreshed from OpenRouter API',
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Failed to refresh free models cache');
      return reply.code(500).send({
        success: false,
        error: 'Failed to refresh free models cache',
      });
    }
  });
}
