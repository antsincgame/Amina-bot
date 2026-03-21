import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiLogger } from '../../config/logger.js';
import { MINI_APP_REQUEST_TIMEOUT_MS } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { settingsRepo, conversationsRepo } from '../../db/index.js';
import { validateMessageContent, validateUserId } from '../../utils/validation.js';
import { validateTelegramWebAppInitData, parseTelegramUserIdFromInitData } from '../../utils/telegram-webapp-auth.js';
import { respondWithAminaCore } from '../../ai/amina-core-runtime.js';
import type { Message, AIMessage, Conversation } from '../../../../shared/types/index.js';
import { textToSpeech, detectLanguage } from '../../features/tts.js';
import { transcribeAudio } from '../../ai/multimodal.js';

const MINI_APP_MESSAGE_MAX = 4000;
const MAX_VOICE_FILE_BYTES = 10 * 1024 * 1024; // 10MB

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


async function processAiResponse(userId: string, messageContent: string, request: FastifyRequest, withAudio: boolean) {
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

  if (withAudio) {
    const lang = detectLanguage(aiResponse.content);
    const audio = await textToSpeech(aiResponse.content, lang);
    if (audio && audio.length > 0) {
      audioBase64 = audio.toString('base64');
      audioMimeType = 'audio/mpeg';
    }
  }

  const emotion = detectEmotion(aiResponse.content);

  return {
    conversationId: conversation.id,
    response: aiResponse.content,
    emotion,
    audioBase64,
    audioMimeType,
    timestamp: new Date().toISOString(),
  };
}

export async function registerMiniAppRoutes(server: FastifyInstance): Promise<void> {

  /**
   * POST /mini-app/message
   * Текстовый диалог + опционально TTS (mp3 base64) для мини-приложения.
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

        aiLogger.info({ userId }, 'Mini-app text message');

        const data = await processAiResponse(userId, messageContent, request, body.withAudio);

        return reply.code(200).send({ success: true, data });
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

  /**
   * POST /mini-app/voice
   * Голосовой ввод: принимает audio blob (FormData), транскрибирует через Groq Whisper,
   * обрабатывает через AI, возвращает ответ + TTS + transcript.
   * Работает на iOS (MediaRecorder → audio/mp4) и Chrome (audio/webm).
   */
  server.post(
    '/mini-app/voice',
    {
      onRequest: (request, _reply, done) => {
        request.raw.socket?.setTimeout(MINI_APP_REQUEST_TIMEOUT_MS);
        done();
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parts = request.parts();

        let audioBuffer: Buffer | null = null;
        let audioMimeType = 'audio/webm';
        let initData = '';

        for await (const part of parts) {
          if (part.type === 'file' && part.fieldname === 'audio') {
            audioMimeType = part.mimetype || 'audio/webm';
            audioBuffer = await part.toBuffer();
          } else if (part.type === 'field' && part.fieldname === 'initData') {
            initData = String(part.value ?? '');
          }
        }

        if (!audioBuffer || audioBuffer.length === 0) {
          return reply.code(400).send({ success: false, error: 'No audio file provided' });
        }
        if (!initData) {
          return reply.code(400).send({ success: false, error: 'Missing initData' });
        }

        const userIdRaw = ensureTelegramInit(reply, initData);
        if (!userIdRaw) return;

        const userId = validateUserId(userIdRaw);

        aiLogger.info({
          userId,
          audioSize: audioBuffer.length,
          mimeType: audioMimeType,
        }, 'Mini-app voice message received');

        const audioBase64 = audioBuffer.toString('base64');
        const transcription = await transcribeAudio(audioBase64, audioMimeType);

        if (!transcription.text.trim()) {
          return reply.code(200).send({
            success: true,
            data: {
              transcript: '',
              response: 'Не удалось распознать речь. Попробуйте ещё раз или напишите текстом.',
              emotion: 'neutral' as AvatarEmotion,
              timestamp: new Date().toISOString(),
            },
          });
        }

        aiLogger.info({
          userId,
          transcript: transcription.text.slice(0, 100),
          model: transcription.model,
        }, 'Mini-app voice transcribed');

        const messageContent = validateMessageContent(transcription.text);
        const data = await processAiResponse(userId, messageContent, request, true);

        return reply.code(200).send({
          success: true,
          data: {
            ...data,
            transcript: transcription.text,
          },
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        aiLogger.error({ error, message: errMsg }, 'Mini-app voice failed');
        return reply.code(500).send({ success: false, error: 'Voice processing error: ' + errMsg });
      }
    },
  );
}
