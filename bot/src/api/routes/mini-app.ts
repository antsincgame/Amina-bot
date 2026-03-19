import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiLogger } from '../../config/logger.js';
import { config } from '../../config/index.js';
import { validateMessageContent, validateUserId } from '../../utils/validation.js';
import { validateTelegramWebAppInitData, parseTelegramUserIdFromInitData } from '../../utils/telegram-webapp-auth.js';
import { respondWithAminaCore } from '../../ai/amina-core-runtime.js';
import { conversationsRepo } from '../../db/index.js';
import type { Message, AIMessage, Conversation } from '../../../../shared/types/index.js';
import { textToSpeech, detectLanguage } from '../../features/tts.js';

const MINI_APP_MESSAGE_MAX = 4000;

const miniAppMessageSchema = z.object({
  initData: z.string().min(1),
  message: z.string().min(1).max(MINI_APP_MESSAGE_MAX),
  withAudio: z.boolean().optional().default(true),
});

function miniAppAuthFail(reply: FastifyReply, code: number, message: string): void {
  void reply.code(code).send({ success: false, error: message });
}

function ensureTelegramInit(reply: FastifyReply, initData: string): string | null {
  const token = config.telegram.token?.trim();
  if (!token) {
    miniAppAuthFail(reply, 503, 'Telegram bot token is not configured');
    return null;
  }
  if (!validateTelegramWebAppInitData(initData, token)) {
    miniAppAuthFail(reply, 401, 'Invalid or expired Telegram Web App session');
    return null;
  }
  const userId = parseTelegramUserIdFromInitData(initData);
  if (!userId) {
    miniAppAuthFail(reply, 401, 'Telegram user not found in initData');
    return null;
  }
  return userId;
}

export async function registerMiniAppRoutes(server: FastifyInstance): Promise<void> {
  /**
   * POST /mini-app/message
   * Диалог + опционально TTS (mp3 base64) для мини-приложения.
   */
  server.post('/mini-app/message', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = miniAppMessageSchema.parse(request.body);
      const userIdRaw = ensureTelegramInit(reply, body.initData);
      if (!userIdRaw) return;

      const userId = validateUserId(userIdRaw);
      const messageContent = validateMessageContent(body.message);

      aiLogger.info({ userId }, 'Mini-app chat request');

      const conversation: Conversation = await conversationsRepo.getOrCreate(userId, 'telegram', {
        source: 'mini_app',
        userAgent: request.headers['user-agent'] || 'mini-app',
      });

      const userMessage: Message = {
        role: 'user',
        content: messageContent,
        timestamp: new Date().toISOString(),
      };
      await conversationsRepo.addMessage(conversation.id, userMessage);

      const aiMessages: AIMessage[] = conversation.messages
        .concat([userMessage])
        .map(m => ({ role: m.role, content: m.content }));

      const { response: aiResponse } = await respondWithAminaCore({
        channel: 'telegram',
        userId,
        userText: messageContent,
        messages: aiMessages,
        includeMemory: true,
        includeSearch: true,
        enableSelfGrowth: true,
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: aiResponse.content,
        timestamp: new Date().toISOString(),
      };
      await conversationsRepo.addMessage(conversation.id, assistantMessage);

      let audioBase64: string | undefined;
      let audioMimeType: string | undefined;

      if (body.withAudio) {
        const lang = detectLanguage(aiResponse.content);
        const audio = await textToSpeech(aiResponse.content, lang);
        if (audio && audio.length > 0) {
          audioBase64 = audio.toString('base64');
          audioMimeType = 'audio/mpeg';
        }
      }

      return reply.code(200).send({
        success: true,
        data: {
          conversationId: conversation.id,
          response: aiResponse.content,
          audioBase64,
          audioMimeType,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ success: false, error: 'Invalid request', details: error.issues });
      }
      aiLogger.error({ error }, 'Mini-app message failed');
      return reply.code(500).send({ success: false, error: 'Internal error' });
    }
  });
}
