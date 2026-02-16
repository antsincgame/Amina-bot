import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { aiService } from '../ai/openrouter.js';
import { conversationsRepo, settingsRepo, promptsRepo } from '../db/supabase.js';
import { validateMessageContent, validateUserId } from '../utils/validation.js';
import { handleAIError } from '../utils/error-handler.js';
import { aiLogger, getLogs, getLogStats } from '../config/logger.js';
import { rateLimitHook } from '../utils/rate-limiter.js';
import { getAllAudioModels, getFreeVisionModels, refreshFreeVisionModelsCache, getVisionFallbackStatus } from '../ai/multimodal.js';
import { getSearchModelInfo, getAvailableModels, isWebSearchEnabled, clearPerplexityCache } from '../ai/websearch.js';
import { userProfileRepo, userMemoryRepo, userLogsRepo } from '../memory/user-memory.js';
import { config, clearApiKeysCache, getApiKeys } from '../config/index.js';
import { getConfiguredSites, saveConfiguredSites, parseNewsFromSite } from '../features/news-parser.js';
import { invalidateTTSConfig } from '../features/tts.js';
import { voiceMessagesRepo } from '../features/voice-messages-repo.js';
import archiver from 'archiver';
import type { Message, Conversation, LogLevel } from '../../../shared/types/index.js';

// --------------------------------------------
// Request Schemas
// --------------------------------------------

const chatRequestSchema = z.object({
  userId: z.string().min(1),
  message: z.string().min(1).max(10000),
  conversationId: z.string().uuid().optional(),
  channel: z.enum(['telegram', 'voice', 'all']).default('telegram'),
});

type ChatRequest = z.infer<typeof chatRequestSchema>;

const chatCompletionRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })
  ),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().min(1).max(16000).optional(),
});

type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

// --------------------------------------------
// API Routes
// --------------------------------------------

export async function registerApiRoutes(server: FastifyInstance): Promise<void> {
  // Prefix all routes with /api
  server.register(
    async (apiServer: FastifyInstance) => {
      // Apply rate limiting to all API routes
      apiServer.addHook('preHandler', rateLimitHook('api'));

      /**
       * POST /api/chat
       * Send a message and get AI response with conversation context
       */
      apiServer.post('/chat', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const body = chatRequestSchema.parse(request.body);

          // Validate inputs
          const userId = validateUserId(body.userId);
          const messageContent = validateMessageContent(body.message);

          aiLogger.info({ userId, channel: body.channel }, 'API chat request');

          // Get or create conversation
          let conversation: Conversation;
          if (body.conversationId) {
            conversation = await conversationsRepo.get(body.conversationId);
          } else {
            // For 'all', use 'telegram' as default storage channel
            const storageChannel = body.channel === 'all' ? 'telegram' : body.channel;
            conversation = await conversationsRepo.getOrCreate(userId, storageChannel, {
              source: 'api',
              userAgent: request.headers['user-agent'] || 'unknown',
            });
          }

          // Add user message to conversation
          const userMessage: Message = {
            role: 'user',
            content: messageContent,
            timestamp: new Date().toISOString(),
          };
          await conversationsRepo.addMessage(conversation.id, userMessage);

          // Get AI response
          const aiResponse = await aiService.chat(conversation.messages.concat([userMessage]));

          // Add AI response to conversation
          const assistantMessage: Message = {
            role: 'assistant',
            content: aiResponse.content,
            timestamp: new Date().toISOString(),
          };
          await conversationsRepo.addMessage(conversation.id, assistantMessage);

          aiLogger.info(
            { userId, conversationId: conversation.id },
            'API chat completed successfully'
          );

          return reply.code(200).send({
            success: true,
            data: {
              conversationId: conversation.id,
              response: aiResponse.content,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          if (error instanceof z.ZodError) {
            return reply.code(400).send({
              success: false,
              error: 'Invalid request',
              details: error.errors,
            });
          }

          aiLogger.error({ error }, 'API chat error');
          return reply.code(500).send({
            success: false,
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      /**
       * POST /api/chat/completions
       * OpenAI-compatible chat completions endpoint
       * Allows direct access to LLM without conversation storage
       */
      apiServer.post(
        '/chat/completions',
        async (request: FastifyRequest, reply: FastifyReply) => {
          try {
            const body = chatCompletionRequestSchema.parse(request.body);

            aiLogger.info({ messageCount: body.messages.length }, 'API completion request');

            // Convert messages to our format
            const messages: Message[] = body.messages.map((msg) => ({
              role: msg.role,
              content: msg.content,
              timestamp: new Date().toISOString(),
            }));

            // Get AI response (optionally override settings)
            const aiResult = await aiService.chat(messages);

            aiLogger.info('API completion completed successfully');

            // OpenAI-compatible response format
            return reply.code(200).send({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model || aiResult.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: aiResult.content,
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: aiResult.tokens_used.prompt,
                completion_tokens: aiResult.tokens_used.completion,
                total_tokens: aiResult.tokens_used.total,
              },
            });
          } catch (error) {
            if (error instanceof z.ZodError) {
              return reply.code(400).send({
                success: false,
                error: 'Invalid request',
                details: error.errors,
              });
            }

            aiLogger.error({ error }, 'API completion error');
            return reply.code(500).send({
              success: false,
              error: 'Internal server error',
              message: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
      );

      /**
       * GET /api/conversations/:conversationId
       * Get conversation history
       */
      apiServer.get(
        '/conversations/:conversationId',
        async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply: FastifyReply) => {
          try {
            const { conversationId } = request.params;

            const conversation = await conversationsRepo.get(conversationId);

            return reply.code(200).send({
              success: true,
              data: conversation,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get conversation error');
            return reply.code(404).send({
              success: false,
              error: 'Conversation not found',
            });
          }
        }
      );

      /**
       * DELETE /api/conversations/:conversationId
       * Clear conversation history (reset context)
       */
      apiServer.delete(
        '/conversations/:conversationId',
        async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply: FastifyReply) => {
          try {
            const { conversationId } = request.params;

            await conversationsRepo.clearMessages(conversationId);

            aiLogger.info({ conversationId }, 'Conversation cleared');

            return reply.code(200).send({
              success: true,
              message: 'Conversation cleared successfully',
            });
          } catch (error) {
            aiLogger.error({ error }, 'Clear conversation error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to clear conversation',
            });
          }
        }
      );

      /**
       * GET /api/settings
       * Get current AI settings
       */
      apiServer.get('/settings', async (request: FastifyRequest, reply: FastifyReply) => {
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
      apiServer.post(
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

            // Инвалидируем ВСЕ кэши после обновления настроек
            clearApiKeysCache();
            clearPerplexityCache();
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
      apiServer.put(
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

            aiLogger.info({ key }, 'Setting updated via API');

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

      // ============================================
      // Prompts Endpoints
      // ============================================

      /**
       * GET /api/prompts
       * Get all prompts
       */
      apiServer.get('/prompts', async (request: FastifyRequest, reply: FastifyReply) => {
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
      apiServer.post(
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
      apiServer.put(
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
      apiServer.delete(
        '/prompts/:id',
        async (
          request: FastifyRequest<{ Params: { id: string } }>,
          reply: FastifyReply
        ) => {
          try {
            const { id } = request.params;

            await promptsRepo.delete(id);

            aiLogger.info({ promptId: id }, 'Prompt deleted via API');

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
      apiServer.post(
        '/prompts/:id/activate',
        async (
          request: FastifyRequest<{ Params: { id: string } }>,
          reply: FastifyReply
        ) => {
          try {
            const { id } = request.params;

            await promptsRepo.setActive(id);

            aiLogger.info({ promptId: id }, 'Prompt activated via API');

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

      // ============================================
      // Logs Endpoints
      // ============================================

      /**
       * GET /api/logs
       * Get system logs (errors, warnings)
       */
      apiServer.get(
        '/logs',
        async (
          request: FastifyRequest<{
            Querystring: {
              level?: LogLevel;
              module?: string;
              from?: string;
              to?: string;
              limit?: string;
            };
          }>,
          reply: FastifyReply
        ) => {
          try {
            const { level, module, from, to, limit } = request.query;

            const logs = await getLogs({
              level: level as LogLevel | undefined,
              module,
              from: from ? new Date(from) : undefined,
              to: to ? new Date(to) : undefined,
              limit: limit ? parseInt(limit, 10) : 100,
            });

            return reply.code(200).send({
              success: true,
              data: logs,
              count: logs.length,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get logs error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to fetch logs',
            });
          }
        }
      );

      /**
       * GET /api/logs/stats
       * Get log statistics
       */
      apiServer.get(
        '/logs/stats',
        async (
          request: FastifyRequest<{
            Querystring: {
              from?: string;
              to?: string;
            };
          }>,
          reply: FastifyReply
        ) => {
          try {
            const { from, to } = request.query;
            
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const stats = await getLogStats(
              from ? new Date(from) : weekAgo,
              to ? new Date(to) : now
            );

            return reply.code(200).send({
              success: true,
              data: stats,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get log stats error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to fetch log stats',
            });
          }
        }
      );

      /**
       * GET /api/models/vision
       * Динамический список бесплатных vision моделей
       */
      apiServer.get('/models/vision', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const models = await getFreeVisionModels();
          const fallbackStatus = getVisionFallbackStatus();
          const currentModel = await settingsRepo.get('vision_model');
          return reply.code(200).send({
            success: true,
            data: {
              models,
              currentModel: currentModel || 'allenai/molmo-2-8b:free',
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
       * Принудительно обновить кэш бесплатных vision моделей
       */
      apiServer.post('/models/vision/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const freshModels = await refreshFreeVisionModelsCache();
          return reply.code(200).send({
            success: true,
            data: { models: freshModels, count: freshModels.length },
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
       * GET /api/models/audio
       * Get available audio models (static list)
       */
      apiServer.get('/models/audio', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const models = getAllAudioModels();
          return reply.code(200).send({
            success: true,
            data: models,
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
       * Динамический список бесплатных vision моделей от OpenRouter
       */
      apiServer.get('/models/openrouter/vision', async (request: FastifyRequest, reply: FastifyReply) => {
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
       * Fetch actual audio models from OpenRouter API
       */
      apiServer.get('/models/openrouter/audio', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const keys = await getApiKeys();
          const apiKey = keys.openrouter || config.ai.apiKey;
          const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
            },
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
       * Fetch image generation models from OpenRouter API with pricing
       */
      apiServer.get('/models/openrouter/image', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const keys = await getApiKeys();
          const apiKey = keys.openrouter || config.ai.apiKey;
          const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
            },
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

          // Filter models that support image generation
          const imageModels = data.data.filter(model => 
            model.architecture?.output_modalities?.includes('image') ||
            model.architecture?.modality === 'image' ||
            model.id.includes('flux') ||
            model.id.includes('gemini') && model.id.includes('image') ||
            model.id.includes('dall-e') ||
            model.id.includes('riverflow')
          );

          // Sort by price (cheapest first)
          const sortedModels = imageModels
            .map(m => {
              // Цена за image output (некоторые модели используют pricing.image, другие - completion)
              const imagePrice = m.pricing.image 
                ? parseFloat(m.pricing.image) 
                : parseFloat(m.pricing.completion);
              
              return {
                id: m.id,
                name: m.name,
                description: m.description || 'Image generation model',
                pricing: {
                  input: parseFloat(m.pricing.prompt),
                  output: imagePrice,
                  perImage: imagePrice, // для отображения в UI
                },
                contextLength: m.context_length,
              };
            })
            .sort((a, b) => a.pricing.perImage - b.pricing.perImage);

          // Разделяем на дешевые и дорогие
          const cheap = sortedModels.filter(m => m.pricing.perImage <= 0.05).slice(0, 10);
          const premium = sortedModels.filter(m => m.pricing.perImage > 0.05).slice(0, 10);

          aiLogger.info({ 
            totalModels: sortedModels.length,
            cheapCount: cheap.length, 
            premiumCount: premium.length,
            cheapestModel: cheap[0]?.id,
            cheapestPrice: cheap[0]?.pricing.perImage,
          }, 'Fetched image generation models from OpenRouter');

          return reply.code(200).send({
            success: true,
            data: { 
              cheap,  // ≤ $0.05 за картинку
              premium, // > $0.05 за картинку
              all: sortedModels.slice(0, 20), // топ-20 для селекта
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

      // ============================================
      // Fallback Models (Auto-switch) Endpoints
      // ============================================

      /**
       * GET /api/models/fallback
       * Get fallback models configuration for auto-switching
       */
      apiServer.get('/models/fallback', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const { getFallbackModels, getFallbackStatus } = await import('../ai/openrouter.js');
          const fallbackModels = await getFallbackModels();
          const status = await getFallbackStatus();
          
          return reply.code(200).send({
            success: true,
            data: {
              enabled: true, // Auto-fallback всегда включён
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
       * Force refresh free models cache from OpenRouter
       */
      apiServer.post('/models/fallback/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const { refreshFreeModelsCache } = await import('../ai/openrouter.js');
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

      // ============================================
      // Web Search (Perplexity) Endpoints
      // ============================================

      /**
       * GET /api/websearch/info
       * Get current web search model info and pricing
       */
      apiServer.get('/websearch/info', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const modelInfo = await getSearchModelInfo();
          const enabled = await isWebSearchEnabled();
          const allModels = getAvailableModels();

          return reply.code(200).send({
            success: true,
            data: {
              enabled,
              currentModel: modelInfo,
              availableModels: allModels.map(m => ({
                id: m.id,
                name: m.name,
                priceInput: m.inputPrice,
                priceOutput: m.outputPrice,
                requestFee: m.requestFee,
                hasInternet: m.online,
              })),
              note: 'Автоматически используется самая дешёвая online-модель',
            },
          });
        } catch (error) {
          aiLogger.error({ error }, 'Get websearch info error');
          return reply.code(500).send({
            success: false,
            error: 'Failed to get websearch info',
          });
        }
      });

      // ============================================
      // User Management Endpoints
      // ============================================

      /**
       * GET /api/users
       * Get all user profiles
       */
      apiServer.get(
        '/users',
        async (
          request: FastifyRequest<{
            Querystring: { limit?: string; offset?: string };
          }>,
          reply: FastifyReply
        ) => {
          try {
            const limit = request.query.limit ? parseInt(request.query.limit, 10) : 100;
            const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;

            const users = await userProfileRepo.getAll(limit, offset);

            return reply.code(200).send({
              success: true,
              data: users,
              count: users.length,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get users error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to fetch users',
            });
          }
        }
      );

      /**
       * GET /api/users/:userId
       * Get user profile by ID
       */
      apiServer.get(
        '/users/:userId',
        async (
          request: FastifyRequest<{ Params: { userId: string } }>,
          reply: FastifyReply
        ) => {
          try {
            const { userId } = request.params;
            const profile = await userProfileRepo.get(userId);

            if (!profile) {
              return reply.code(404).send({
                success: false,
                error: 'User not found',
              });
            }

            return reply.code(200).send({
              success: true,
              data: profile,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get user error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to fetch user',
            });
          }
        }
      );

      /**
       * GET /api/users/:userId/stats
       * Get user statistics
       */
      apiServer.get(
        '/users/:userId/stats',
        async (
          request: FastifyRequest<{ Params: { userId: string } }>,
          reply: FastifyReply
        ) => {
          try {
            const { userId } = request.params;
            const stats = await userProfileRepo.getStats(userId);

            return reply.code(200).send({
              success: true,
              data: stats,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get user stats error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to fetch user stats',
            });
          }
        }
      );

      /**
       * GET /api/users/:userId/memory
       * Get user memory entries
       */
      apiServer.get(
        '/users/:userId/memory',
        async (
          request: FastifyRequest<{
            Params: { userId: string };
            Querystring: { type?: string; limit?: string };
          }>,
          reply: FastifyReply
        ) => {
          try {
            const { userId } = request.params;
            const { type, limit } = request.query;

            let memories;
            if (type) {
              memories = await userMemoryRepo.getByType(
                userId,
                type as 'fact' | 'preference' | 'context' | 'summary' | 'important'
              );
            } else {
              memories = await userMemoryRepo.getAll(
                userId,
                limit ? parseInt(limit, 10) : 50
              );
            }

            return reply.code(200).send({
              success: true,
              data: memories,
              count: memories.length,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get user memory error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to fetch user memory',
            });
          }
        }
      );

      /**
       * POST /api/users/:userId/memory
       * Add memory entry for user
       */
      apiServer.post(
        '/users/:userId/memory',
        async (
          request: FastifyRequest<{
            Params: { userId: string };
            Body: {
              memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
              content: string;
              is_pinned?: boolean;
            };
          }>,
          reply: FastifyReply
        ) => {
          try {
            const { userId } = request.params;
            const { memory_type, content, is_pinned } = request.body as {
              memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
              content: string;
              is_pinned?: boolean;
            };

            const memory = await userMemoryRepo.add(userId, memory_type, content, {
              source: 'admin',
              isPinned: is_pinned,
            });

            return reply.code(201).send({
              success: true,
              data: memory,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Add user memory error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to add user memory',
            });
          }
        }
      );

      /**
       * DELETE /api/users/:userId/memory/:memoryId
       * Deactivate memory entry
       */
      apiServer.delete(
        '/users/:userId/memory/:memoryId',
        async (
          request: FastifyRequest<{
            Params: { userId: string; memoryId: string };
          }>,
          reply: FastifyReply
        ) => {
          try {
            const { memoryId } = request.params;
            await userMemoryRepo.deactivate(memoryId);

            return reply.code(200).send({
              success: true,
              message: 'Memory deactivated',
            });
          } catch (error) {
            aiLogger.error({ error }, 'Delete user memory error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to delete user memory',
            });
          }
        }
      );

      /**
       * GET /api/users/:userId/logs
       * Get user logs
       */
      apiServer.get(
        '/users/:userId/logs',
        async (
          request: FastifyRequest<{
            Params: { userId: string };
            Querystring: {
              event_type?: string;
              from?: string;
              to?: string;
              limit?: string;
            };
          }>,
          reply: FastifyReply
        ) => {
          try {
            const { userId } = request.params;
            const { event_type, from, to, limit } = request.query;

            const logs = await userLogsRepo.getByUser(userId, {
              eventType: event_type as any,
              from: from ? new Date(from) : undefined,
              to: to ? new Date(to) : undefined,
              limit: limit ? parseInt(limit, 10) : 100,
            });

            return reply.code(200).send({
              success: true,
              data: logs,
              count: logs.length,
            });
          } catch (error) {
            aiLogger.error({ error }, 'Get user logs error');
            return reply.code(500).send({
              success: false,
              error: 'Failed to fetch user logs',
            });
          }
        }
      );
      // ====== NEWS SOURCES (для дайджеста) ======

      /**
       * GET /api/news-sites
       * Получить список настроенных новостных сайтов
       */
      apiServer.get('/news-sites', async (_request: FastifyRequest, reply: FastifyReply) => {
        try {
          const sites = await getConfiguredSites();
          return reply.code(200).send({ success: true, data: sites });
        } catch (error) {
          aiLogger.error({ error }, 'Get news sites error');
          return reply.code(500).send({ success: false, error: 'Failed to fetch news sites' });
        }
      });

      /**
       * POST /api/news-sites
       * Сохранить список новостных сайтов
       */
      apiServer.post(
        '/news-sites',
        async (
          request: FastifyRequest<{ Body: Array<{ name: string; url: string; enabled: boolean }> }>,
          reply: FastifyReply,
        ) => {
          try {
            const sites = request.body;
            if (!Array.isArray(sites)) {
              return reply.code(400).send({ success: false, error: 'Body must be an array of sites' });
            }

            // Базовая валидация
            for (const site of sites) {
              if (!site.name || typeof site.name !== 'string') {
                return reply.code(400).send({ success: false, error: 'Each site must have a name' });
              }
              if (!site.url || typeof site.url !== 'string') {
                return reply.code(400).send({ success: false, error: 'Each site must have a url' });
              }
              try {
                const parsed = new URL(site.url);
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                  return reply.code(400).send({ success: false, error: `Unsupported protocol in URL: ${site.url}` });
                }
              } catch {
                return reply.code(400).send({ success: false, error: `Invalid URL: ${site.url}` });
              }
            }

            const normalized = sites.map(s => ({
              name: s.name.trim(),
              url: s.url.trim(),
              enabled: s.enabled !== false,
            }));

            await saveConfiguredSites(normalized);
            settingsRepo.invalidateCache?.();

            aiLogger.info({ count: normalized.length }, 'News sites updated');
            return reply.code(200).send({ success: true, message: 'News sites saved', data: normalized });
          } catch (error) {
            aiLogger.error({ error }, 'Save news sites error');
            return reply.code(500).send({ success: false, error: 'Failed to save news sites' });
          }
        },
      );

      /**
       * POST /api/news-sites/test
       * Тестовый парсинг одного сайта — для предпросмотра в админке
       */
      apiServer.post(
        '/news-sites/test',
        async (
          request: FastifyRequest<{ Body: { url: string } }>,
          reply: FastifyReply,
        ) => {
          try {
            const { url } = request.body as { url: string };
            if (!url) {
              return reply.code(400).send({ success: false, error: 'URL is required' });
            }

            try {
              const parsed = new URL(url);
              if (!['http:', 'https:'].includes(parsed.protocol)) {
                return reply.code(400).send({ success: false, error: 'Only http/https URLs are supported' });
              }
            } catch {
              return reply.code(400).send({ success: false, error: 'Invalid URL format' });
            }

            const startTime = Date.now();
            const headlines = await parseNewsFromSite(url);
            const parseTimeMs = Date.now() - startTime;

            aiLogger.info({ url, headlinesFound: headlines.length, parseTimeMs }, 'News site test parse');

            return reply.code(200).send({
              success: true,
              data: {
                url,
                headlines,
                count: headlines.length,
                parseTimeMs,
              },
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            aiLogger.warn({ error: msg, url: (request.body as { url?: string })?.url }, 'News site test parse failed');
            return reply.code(200).send({
              success: false,
              error: msg,
              data: { url: (request.body as { url?: string })?.url, headlines: [], count: 0 },
            });
          }
        },
      );
      // ============================================
      // Database Migration (self-service)
      // ============================================

      /**
       * POST /api/migrate/voice-messages — создать таблицу voice_messages
       * Безопасно: IF NOT EXISTS, можно вызывать повторно
       */
      apiServer.post(
        '/migrate/voice-messages',
        async (_request: FastifyRequest, reply: FastifyReply) => {
          try {
            const sb = (await import('../db/supabase.js')).getSupabase();
            
            // Check if table already exists
            const { error: checkError } = await sb.from('voice_messages').select('id').limit(1);
            if (!checkError) {
              return reply.code(200).send({ success: true, message: 'Table already exists' });
            }

            // Create via raw SQL using Supabase query (admin)
            // Since we can't run DDL via PostgREST, we need the table created via Supabase Dashboard
            // This endpoint validates the state and returns instructions
            return reply.code(200).send({
              success: false,
              message: 'Table does not exist. Please run the following SQL in Supabase Dashboard → SQL Editor:',
              sql: `CREATE TABLE IF NOT EXISTS voice_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration INTEGER DEFAULT 0,
  file_size INTEGER DEFAULT 0,
  transcription TEXT,
  telegram_file_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_messages_user ON voice_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_messages_created ON voice_messages(created_at DESC);`,
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            return reply.code(500).send({ success: false, error: msg });
          }
        },
      );

      // ============================================
      // Voice Messages API
      // ============================================

      /**
       * GET /api/voice-messages — список голосовых с фильтрами
       */
      apiServer.get(
        '/voice-messages',
        async (
          request: FastifyRequest<{
            Querystring: { userId?: string; dateFrom?: string; dateTo?: string; limit?: string; offset?: string };
          }>,
          reply: FastifyReply,
        ) => {
          try {
            const { userId, dateFrom, dateTo, limit, offset } = request.query as {
              userId?: string; dateFrom?: string; dateTo?: string; limit?: string; offset?: string;
            };

            const result = await voiceMessagesRepo.list({
              userId,
              dateFrom,
              dateTo,
              limit: limit ? parseInt(limit, 10) : 50,
              offset: offset ? parseInt(offset, 10) : 0,
            });

            return reply.code(200).send({ success: true, data: result.data, total: result.total });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            aiLogger.error({ error: msg }, 'Failed to list voice messages');
            return reply.code(500).send({ success: false, error: msg });
          }
        },
      );

      /**
       * GET /api/voice-messages/stats — статистика
       */
      apiServer.get(
        '/voice-messages/stats',
        async (_request: FastifyRequest, reply: FastifyReply) => {
          try {
            const stats = await voiceMessagesRepo.stats();
            return reply.code(200).send({ success: true, data: stats });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            return reply.code(500).send({ success: false, error: msg });
          }
        },
      );

      /**
       * GET /api/voice-messages/:id/download — signed URL для скачивания
       */
      apiServer.get(
        '/voice-messages/:id/download',
        async (
          request: FastifyRequest<{ Params: { id: string } }>,
          reply: FastifyReply,
        ) => {
          try {
            const { id } = request.params as { id: string };
            const record = await voiceMessagesRepo.getById(id);
            if (!record) {
              return reply.code(404).send({ success: false, error: 'Voice message not found' });
            }

            const signedUrl = await voiceMessagesRepo.getSignedUrl(record.file_path);
            if (!signedUrl) {
              return reply.code(500).send({ success: false, error: 'Failed to generate download URL' });
            }

            return reply.code(200).send({ success: true, data: { url: signedUrl, fileName: record.file_path } });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            return reply.code(500).send({ success: false, error: msg });
          }
        },
      );

      /**
       * POST /api/voice-messages/archive — ZIP-архив с фильтрами
       */
      apiServer.post(
        '/voice-messages/archive',
        async (
          request: FastifyRequest<{
            Body: { userId?: string; dateFrom?: string; dateTo?: string; limit?: number };
          }>,
          reply: FastifyReply,
        ) => {
          try {
            const { userId, dateFrom, dateTo, limit } = (request.body ?? {}) as {
              userId?: string; dateFrom?: string; dateTo?: string; limit?: number;
            };

            const records = await voiceMessagesRepo.getFiltered({
              userId,
              dateFrom,
              dateTo,
              limit: limit ?? 500,
            });

            if (records.length === 0) {
              return reply.code(404).send({ success: false, error: 'No voice messages found' });
            }

            // Stream ZIP archive
            reply.raw.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Disposition': `attachment; filename="voice-messages-${new Date().toISOString().slice(0, 10)}.zip"`,
            });

            const archive = archiver('zip', { zlib: { level: 5 } });
            archive.pipe(reply.raw);

            // Download each file and add to archive
            for (const record of records) {
              const fileBuffer = await voiceMessagesRepo.downloadFile(record.file_path);
              if (fileBuffer) {
                const date = new Date(record.created_at).toISOString().slice(0, 10);
                const fileName = `${date}_user${record.user_id}_${record.duration}s.ogg`;
                archive.append(fileBuffer, { name: fileName });
              }
            }

            // Add metadata CSV
            const csv = [
              'id,user_id,duration_sec,file_size_bytes,transcription,created_at',
              ...records.map(r => 
                `${r.id},${r.user_id},${r.duration},${r.file_size},"${(r.transcription ?? '').replace(/"/g, '""')}",${r.created_at}`
              ),
            ].join('\n');
            archive.append(csv, { name: 'metadata.csv' });

            await archive.finalize();

            aiLogger.info({ count: records.length, userId, dateFrom, dateTo }, 'Voice messages archive created');
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            aiLogger.error({ error: msg }, 'Failed to create voice archive');
            // If headers not sent yet
            if (!reply.raw.headersSent) {
              return reply.code(500).send({ success: false, error: msg });
            }
          }
        },
      );
    },
    { prefix: '/api' }
  );
}
