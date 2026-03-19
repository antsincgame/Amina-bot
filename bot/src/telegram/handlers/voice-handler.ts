import type { BotContext } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { transcribeAudio } from '../../ai/multimodal.js';
import { shouldForceWebSearch, needsWebSearch } from '../../ai/websearch.js';
import { analyticsRepo } from '../../db/index.js';
import { checkTelegramRateLimit } from '../../utils/rate-limiter.js';
import { getErrorCode } from '../../utils/error-handler.js';
import type { TelegramUserInfo } from '../../memory/user-memory.js';
import { detectImageEditIntent, classifyImageEditIntentGroq } from '../../ai/image-gen.js';
import { voiceMessagesRepo } from '../../features/voice-messages-repo.js';
import { handleAutoDetections } from './auto-detect.js';
import { downloadTelegramPhoto, handleImageEdit } from './image-helpers.js';
import { handleDirectWebSearch } from './web-search-handler.js';
import { processMessageThroughAI, formatAIError } from './ai-pipeline.js';

/** Маппинг кодов ошибок голоса → сообщения */
const VOICE_ERROR_MESSAGES: Record<string, string> = {
  AUDIO_MODEL_NOT_FOUND: '🔧 Audio модель не найдена.\n\nОбратитесь к администратору.',
  AUDIO_NOT_SUPPORTED: '🔧 Модель не поддерживает аудио.\n\nОбратитесь к администратору.',
  AUTH_ERROR: '🔑 Ошибка авторизации API. Обратитесь к администратору.',
  GROQ_AUTH_ERROR: '🔑 Ошибка авторизации API. Обратитесь к администратору.',
  RATE_LIMIT: '⏳ Слишком много запросов! Подожди минуту.',
  ALL_MODELS_FAILED: '🔄 Все модели AI заняты. Попробуй через 30 секунд.',
  RACE_TIMEOUT: '⏰ AI отвечает слишком долго. Попробуй ещё раз!',
  SERVER_ERROR: '🔧 Сервер AI временно недоступен.',
  FILE_TOO_LARGE: '📁 Голосовое сообщение слишком длинное.',
};

export const handleVoiceMessage = async (ctx: BotContext): Promise<void> => {
  if (!ctx.from?.id) {
    telegramLogger.warn('Voice message without from.id — ignoring');
    return;
  }
  if (!ctx.chat?.id) {
    telegramLogger.warn('Voice message without chat.id — ignoring');
    return;
  }
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id;
  const duration = ctx.message?.voice?.duration ?? 0;
  const startTime = Date.now();

  telegramLogger.info({ userId, duration }, 'Voice message received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) {
    await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
    return;
  }

  analyticsRepo.log('message_received', 'telegram', { userId, type: 'voice', duration }).catch(() => {});
  await ctx.replyWithChatAction('typing');

  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw Object.assign(new Error('Telegram не вернул путь к файлу'), { code: 'FILE_NOT_FOUND' });
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;

    telegramLogger.debug({ filePath: file.file_path }, 'Downloading voice file');
    const voiceController = new AbortController();
    const voiceTimeoutId = setTimeout(() => voiceController.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(fileUrl, { signal: voiceController.signal });
    } finally {
      clearTimeout(voiceTimeoutId);
    }
    if (!response.ok) throw new Error(`Failed to download voice file: ${response.status}`);

    const audioArrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(audioArrayBuffer);
    const audioBase64 = audioBuffer.toString('base64');

    // Запускаем загрузку в Storage и транскрипцию ПАРАЛЛЕЛЬНО
    const voiceFilePath = `${userId}/${Date.now()}_${file.file_unique_id}.ogg`;
    const uploadPromise = voiceMessagesRepo.upload(audioBuffer, voiceFilePath, userId, duration, file.file_unique_id)
      .catch(err => { telegramLogger.warn({ error: err, userId }, 'Voice storage upload failed (non-critical)'); return null; });

    const transcription = await transcribeAudio(audioBase64, 'audio/ogg');
    const transcribedText = transcription.text;
    telegramLogger.debug({ userId, transcription: transcribedText.substring(0, 100) }, 'Voice transcribed');

    // Дожидаемся upload и обновляем транскрипцию (fire-and-forget)
    uploadPromise.then(record => {
      if (record?.id) {
        voiceMessagesRepo.updateTranscription(record.id, transcribedText)
          .catch(err => telegramLogger.warn({ error: err }, 'Failed to update voice transcription'));
      }
    }).catch(() => {});

    const telegramInfo: TelegramUserInfo = {
      id: ctx.from?.id ?? 0, username: ctx.from?.username,
      first_name: ctx.from?.first_name, last_name: ctx.from?.last_name,
      language_code: ctx.from?.language_code,
    };

    // === PATH C: Voice reply to photo → image edit ===
    const replyMsg = ctx.message?.reply_to_message;
    const voiceReplyPhoto = replyMsg?.photo;
    const voiceReplyDoc = replyMsg?.document;
    const isImageDoc = voiceReplyDoc?.mime_type?.startsWith('image/');

    if ((voiceReplyPhoto && voiceReplyPhoto.length > 0) || isImageDoc) {
      const isEditIntent = detectImageEditIntent(transcribedText) || await classifyImageEditIntentGroq(transcribedText);
      if (isEditIntent) {
        telegramLogger.info({ userId, prompt: transcribedText.substring(0, 60) }, 'Image edit detected via voice reply to photo/document');
        try {
          let imageData;
          if (voiceReplyPhoto && voiceReplyPhoto.length > 0) {
            imageData = await downloadTelegramPhoto(ctx, voiceReplyPhoto);
          } else {
            const docFile = await ctx.api.getFile(voiceReplyDoc!.file_id);
            if (!docFile.file_path) throw new Error('File path not found');
            const docUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${docFile.file_path}`;
            const docAbort = new AbortController();
            const docTimeout = setTimeout(() => docAbort.abort(), 30_000);
            let resp: Response;
            try { resp = await fetch(docUrl, { signal: docAbort.signal }); } finally { clearTimeout(docTimeout); }
            if (!resp.ok) throw new Error('Failed to download document');
            imageData = {
              base64: Buffer.from(await resp.arrayBuffer()).toString('base64'),
              mimeType: voiceReplyDoc!.mime_type!,
            };
          }
          await handleImageEdit(ctx, imageData.base64, imageData.mimeType, transcribedText, userId);
        } catch (editError) {
          const editMsg = editError instanceof Error ? editError.message : 'Не удалось отредактировать изображение.';
          telegramLogger.error({ error: editError, userId }, 'Voice reply-to-image edit failed');
          await ctx.reply(`😔 ${editMsg}`);
        }
        return;
      }
    }

    // Auto-detections
    if (await handleAutoDetections(ctx, transcribedText, userId, chatId)) return;

    // Direct web search
    if (shouldForceWebSearch(transcribedText) || needsWebSearch(transcribedText)) {
      const handled = await handleDirectWebSearch(ctx, transcribedText, userId, chatId, startTime);
      if (handled) return;
    }

    // Use shared AI pipeline
    await processMessageThroughAI(
      ctx,
      transcribedText,
      userId,
      chatId,
      startTime,
      telegramInfo,
      'voice',
      { type: 'voice', voice_duration: duration },
      { fallbackStrategy: 'sequential', fallbackModelLimit: 3 },
    );
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process voice message');
    const errorCode = getErrorCode(error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    analyticsRepo.log('error', 'telegram', { userId, type: 'voice', error: errorMsg, errorCode }).catch(() => {});
    await ctx.reply(errorCode ? (VOICE_ERROR_MESSAGES[errorCode] ?? formatAIError(errorCode, errorMsg)) : formatAIError(errorCode, errorMsg));
  }
};
