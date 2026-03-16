import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { aiService } from '../../ai/openrouter.js';
import { conversationsRepo } from '../../db/index.js';
import { validateMessageContent, validateUserId } from '../../utils/validation.js';
import { aiLogger } from '../../config/logger.js';
import { LEADS_MESSAGE_MAX_LENGTH } from '../../config/constants.js';
import type { Message, AIMessage, Conversation } from '../../../../shared/types/index.js';

// --------------------------------------------
// Request Schemas
// --------------------------------------------

const chatRequestSchema = z.object({
  userId: z.string().min(1),
  message: z.string().min(1).max(LEADS_MESSAGE_MAX_LENGTH),
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
// Routes
// --------------------------------------------

export async function registerChatRoutes(server: FastifyInstance): Promise<void> {
  /**
   * POST /api/chat
   * Send a message and get AI response with conversation context
   */
  server.post('/chat', async (request: FastifyRequest, reply: FastifyReply) => {
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
      const aiMessages: AIMessage[] = conversation.messages
        .concat([userMessage])
        .map(m => ({ role: m.role, content: m.content }));
      const aiResponse = await aiService.chat(aiMessages);

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
  server.post(
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
}
