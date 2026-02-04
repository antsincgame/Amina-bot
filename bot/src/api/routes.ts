import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { aiService } from '../ai/openrouter.js';
import { conversationsRepo, settingsRepo } from '../db/supabase.js';
import { validateMessageContent, validateUserId } from '../utils/validation.js';
import { handleAIError } from '../utils/error-handler.js';
import { aiLogger, getLogs, getLogStats } from '../config/logger.js';
import { rateLimitHook } from '../utils/rate-limiter.js';
import { getAllVisionModels, getAllAudioModels } from '../ai/multimodal.js';
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
       * Get available vision models
       */
      apiServer.get('/models/vision', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const models = getAllVisionModels();
          return reply.code(200).send({
            success: true,
            data: models,
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
       * GET /api/models/audio
       * Get available audio models
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
    },
    { prefix: '/api' }
  );
}
