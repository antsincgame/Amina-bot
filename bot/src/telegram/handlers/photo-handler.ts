import type { BotContext } from '../bot.js';
import { MAX_HISTORY_MESSAGES } from '../bot.js';
import { telegramLogger } from '../../config/logger.js';
import { processImageWithLLM } from '../../ai/multimodal.js';
import { detectImageEditIntent, classifyImageEditIntentGroq } from '../../ai/image-gen.js';
import { conversationsRepo, analyticsRepo } from '../../db/index.js';
import { checkTelegramRateLimit } from '../../utils/rate-limiter.js';
import { getErrorCode } from '../../utils/error-handler.js';
import { sendLongMessage } from '../format.js';
import { ensureConversation } from './context-builder.js';
import { downloadTelegramPhoto, handleImageEdit } from './image-helpers.js';

export const handlePhotoMessage = async (ctx: BotContext): Promise<void> => {
  if (!ctx.from?.id) {
    telegramLogger.warn('Photo message without from.id — ignoring');
    return;
  }
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat?.id ?? 0;
  const caption = ctx.message?.caption;

  telegramLogger.info({ userId, hasCaption: !!caption }, 'Photo message received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) { await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.'); return; }

  analyticsRepo.log('message_received', 'telegram', { userId, type: 'photo', hasCaption: !!caption }).catch(() => {});

  try {
    const photos = ctx.message?.photo ?? [];
    const { base64: imageBase64, mimeType } = await downloadTelegramPhoto(ctx, photos);

    // === PATH A: Фото + caption с edit-ключевыми словами → редактирование ===
    const isEditIntent = caption ? (detectImageEditIntent(caption) || await classifyImageEditIntentGroq(caption)) : false;
    if (isEditIntent) {
      telegramLogger.info({ userId, caption: caption?.substring(0, 60) }, 'Image edit detected via photo caption');
      await handleImageEdit(ctx, imageBase64, mimeType, caption!, userId);
      return;
    }

    // === Стандартный flow: vision analysis ===
    await ctx.replyWithChatAction('typing');
    await ensureConversation(ctx, userId, chatId);

    const aiResponse = await processImageWithLLM(imageBase64, mimeType, caption, ctx.session.messageHistory);
    const userContent = caption ? `[Изображение с подписью: "${caption}"]` : '[Изображение]';

    ctx.session.messageHistory.push({ role: 'user', content: userContent }, { role: 'assistant', content: aiResponse.content });
    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
      ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    const convId = ctx.session.conversationId;
    if (convId) {
      const nowISO = new Date().toISOString();
      Promise.all([
        conversationsRepo.addMessage(convId, { role: 'user', content: userContent, timestamp: nowISO, metadata: { type: 'photo' } }),
        conversationsRepo.addMessage(convId, { role: 'assistant', content: aiResponse.content, timestamp: nowISO, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } }),
        analyticsRepo.log('ai_response', 'telegram', { userId, type: 'photo', model: aiResponse.model, tokens: aiResponse.tokens_used.total }),
      ]).catch((err) => { telegramLogger.warn({ error: err, userId }, 'Background photo DB writes failed'); });
    }

    await sendLongMessage(ctx, aiResponse.content);
    telegramLogger.info({ userId, tokens: aiResponse.tokens_used.total }, 'Photo response sent');
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process photo');
    const errorCode = getErrorCode(error);
    analyticsRepo.log('error', 'telegram', { userId, type: 'photo', error: error instanceof Error ? error.message : 'Unknown', errorCode }).catch(() => {});

    let msg = '😔 Не удалось обработать изображение. Попробуй ещё раз.';
    if (errorCode === 'VISION_MODEL_NOT_FOUND') msg = '🔧 Vision модель не найдена.\n\nВ админке выберите другую модель.';
    else if (errorCode === 'VISION_SERVICE_UNAVAILABLE') msg = '⏳ Сервис анализа фото недоступен. Попробуй через минуту.';
    else if (errorCode === 'AUTH_ERROR') msg = '🔑 Ошибка авторизации API.';
    else if (errorCode === 'ALL_MODELS_FAILED' || errorCode === 'ALL_VISION_MODELS_FAILED') msg = '🔄 Все vision модели заняты. Попробуй через 30 сек.';
    else if (errorCode === 'RATE_LIMIT') msg = '⏳ Слишком много запросов!';
    else if (errorCode === 'VISION_RACE_TIMEOUT') msg = '⏰ Vision модели отвечают слишком долго. Попробуй ещё раз.';

    await ctx.reply(msg);
  }
};
