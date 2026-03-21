import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiLogger } from '../../config/logger.js';
import { MINI_APP_REQUEST_TIMEOUT_MS } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { settingsRepo } from '../../db/index.js';
import { validateMessageContent, validateUserId } from '../../utils/validation.js';
import { validateTelegramWebAppInitData, parseTelegramUserIdFromInitData } from '../../utils/telegram-webapp-auth.js';
import { respondWithAminaCore } from '../../ai/amina-core-runtime.js';
import { buildPersonaSystemPrompt } from '../../ai/persona.js';
import { conversationsRepo } from '../../db/index.js';
import type { Message, AIMessage, Conversation } from '../../../../shared/types/index.js';
import { textToSpeech, detectLanguage } from '../../features/tts.js';

const MINI_APP_MESSAGE_MAX = 4000;

type AvatarEmotion =
  | 'neutral'
  | 'happy'
  | 'ecstatic'
  | 'sad'
  | 'surprised'
  | 'thinking'
  | 'angry'
  | 'smirk'
  | 'sleepy'
  | 'flirty'
  | 'loving';

const EMOTION_PATTERNS: ReadonlyArray<{ emotion: AvatarEmotion; patterns: readonly string[] }> = [
  { emotion: 'ecstatic', patterns: ['🎉', '🥳', '🔥', 'ура', 'потрясающ', 'невероятн', 'восхитительн', 'обалде', 'круто', 'супер'] },
  { emotion: 'loving', patterns: ['❤', '💕', '💗', '💖', 'люблю', 'обожаю', 'любовь', 'нежн', 'дорог'] },
  { emotion: 'flirty', patterns: ['😏', '😘', '😉', 'хм-м', 'интересн', 'может быть', 'кто знает'] },
  { emotion: 'angry', patterns: ['😡', '😠', 'злюсь', 'бесит', 'раздраж', 'ненавиж', 'чёрт', 'дьявол', 'проклят'] },
  { emotion: 'sad', patterns: ['😢', '😭', '😞', 'грустн', 'печальн', 'жаль', 'к сожалени', 'увы', 'сочувств', 'плохо'] },
  { emotion: 'surprised', patterns: ['😲', '😮', '🤯', 'ого', 'ничего себе', 'вау', 'не может быть', 'серьёзно', 'правда?!'] },
  { emotion: 'thinking', patterns: ['🤔', 'хм', 'думаю', 'пожалуй', 'возможно', 'вероятно', 'предполагаю', 'анализир', 'рассмотр'] },
  { emotion: 'smirk', patterns: ['😏', 'хех', 'ирони', 'сарказм', 'забавн', 'ну-ну', 'ага, конечно'] },
  { emotion: 'sleepy', patterns: ['😴', '🥱', 'устал', 'сонн', 'спать', 'поздно', 'ночь', 'отдохн'] },
  { emotion: 'happy', patterns: ['😊', '😄', '🙂', 'рад', 'отличн', 'хорош', 'замечательн', 'прекрасн', 'здорово', 'с удовольств'] },
];

const detectEmotion = (text: string): AvatarEmotion => {
  const lower = text.toLowerCase();
  for (const { emotion, patterns } of EMOTION_PATTERNS) {
    if (patterns.some(p => lower.includes(p))) {
      return emotion;
    }
  }
  return 'neutral';
};

const miniAppMessageSchema = z.object({
  initData: z.string().min(1),
  message: z.string().min(1).max(MINI_APP_MESSAGE_MAX),
  withAudio: z.boolean().optional().default(true),
});

function miniAppAuthFail(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ success: false, error: message });
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

interface HeyGenTokenResponse {
  data: { token: string };
  error: null | string;
}

/**
 * Запросить streaming-токен у HeyGen API.
 */
const fetchHeygenStreamingToken = async (apiKey: string): Promise<string> => {
  const res = await fetch('https://api.heygen.com/v1/streaming.create_token', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HeyGen API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as HeyGenTokenResponse;
  if (!json.data?.token) {
    throw new Error('HeyGen API returned empty token');
  }
  return json.data.token;
};

export async function registerMiniAppRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /mini-app/heygen-token
   * Возвращает одноразовый streaming-токен HeyGen для фронтенда.
   */
  server.get(
    '/mini-app/heygen-token',
    async (request: FastifyRequest<{ Querystring: { initData?: string } }>, reply: FastifyReply) => {
      try {
        const initData = String(request.query.initData ?? '');
        if (!initData) {
          return miniAppAuthFail(reply, 400, 'Missing initData');
        }

        const userId = ensureTelegramInit(reply, initData);
        if (!userId) return;

        const dbKeys = await settingsRepo.getMany([
          'heygen_api_key', 'heygen_avatar_id', 'heygen_quality',
          'heygen_mode', 'heygen_knowledge_base',
        ]);
        const apiKey = dbKeys['heygen_api_key'] || config.heygen.apiKey;
        const avatarId = dbKeys['heygen_avatar_id'] || config.heygen.avatarId;
        const quality = dbKeys['heygen_quality'] || config.heygen.quality || 'low';
        const mode = dbKeys['heygen_mode'] || 'hybrid';
        const customKB = dbKeys['heygen_knowledge_base'] || '';

        if (!apiKey) {
          return reply.code(503).send({ success: false, error: 'HeyGen is not configured' });
        }

        /* Native mode: собираем knowledgeBase из Self-Core персоны + кастомные дополнения */
        let knowledgeBase = '';
        if (mode === 'native') {
          const personaPrompt = await buildPersonaSystemPrompt({ channel: 'voice' });
          const nativeRules = [
            personaPrompt,
            'ВАЖНО: Отвечай ТОЛЬКО на русском языке.',
            'Будь краткой — не более 2-3 предложений в ответе.',
            'Ты общаешься голосом, поэтому говори естественно, как живой человек.',
          ];
          if (customKB) nativeRules.push(customKB);
          knowledgeBase = nativeRules.join('\n\n');
          aiLogger.info({ userId, mode, quality, knowledgeBaseLength: knowledgeBase.length }, 'HeyGen native: persona loaded from Self-Core');
        }

        aiLogger.info({ userId, mode, quality }, 'HeyGen token request — pipeline config');

        const token = await fetchHeygenStreamingToken(apiKey);

        return reply.code(200).send({ success: true, token, avatarId, quality, mode, knowledgeBase });
      } catch (error) {
        aiLogger.error({ error }, 'HeyGen token request failed');
        return reply.code(502).send({ success: false, error: 'Failed to obtain HeyGen token' });
      }
    },
  );

  /**
   * POST /mini-app/message
   * Диалог + опционально TTS (mp3 base64) для мини-приложения.
   */
  server.post(
    '/mini-app/message',
    {
      onRequest: (request, _reply, done) => {
        request.raw.socket?.setTimeout(MINI_APP_REQUEST_TIMEOUT_MS);
        done();
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
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

      const existingMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const aiMessages: AIMessage[] = existingMessages
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

      const emotion = detectEmotion(aiResponse.content);

      return reply.code(200).send({
        success: true,
        data: {
          conversationId: conversation.id,
          response: aiResponse.content,
          emotion,
          audioBase64,
          audioMimeType,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ success: false, error: 'Invalid request', details: error.issues });
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      aiLogger.error({ error, message: errMsg }, 'Mini-app message failed');
      return reply.code(500).send({ success: false, error: 'Internal error: ' + errMsg });
    }
  },
  );
}
