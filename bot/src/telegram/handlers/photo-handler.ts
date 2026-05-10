import type { BotContext } from '../bot.js';
import { telegramLogger } from '../../config/logger.js';
import { processImageWithLLM } from '../../ai/multimodal.js';
import { analyticsRepo } from '../../db/index.js';
import { checkTelegramRateLimit } from '../../utils/rate-limiter.js';
import { getErrorCode } from '../../utils/error-handler.js';
import { sendLongMessage } from '../format.js';
import { ensureConversation } from './context-builder.js';
import { downloadTelegramPhoto, handleImageEdit } from './image-helpers.js';
import { detectImageEditFromText, formatVisionError, persistTurn, pushSessionTurn } from './turn-helpers.js';

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
    if (caption && await detectImageEditFromText(caption)) {
      telegramLogger.info({ userId, caption: caption.substring(0, 60) }, 'Image edit detected via photo caption');
      await handleImageEdit(ctx, imageBase64, mimeType, caption, userId);
      return;
    }

    // === Стандартный flow: vision analysis ===
    await ctx.replyWithChatAction('typing');
    await ensureConversation(ctx, userId, chatId);

    const aiResponse = await processImageWithLLM(imageBase64, mimeType, caption, ctx.session.messageHistory);
    const userContent = caption ? `[Изображение с подписью: "${caption}"]` : '[Изображение]';

    pushSessionTurn(ctx,
      { role: 'user', content: userContent },
      { role: 'assistant', content: aiResponse.content },
    );

    persistTurn(
      ctx.session.conversationId,
      { content: userContent, metadata: { type: 'photo' } },
      { content: aiResponse.content, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } },
      { userId, channel: 'photo' },
    );
    if (ctx.session.conversationId) {
      analyticsRepo.log('ai_response', 'telegram', { userId, type: 'photo', model: aiResponse.model, tokens: aiResponse.tokens_used.total }).catch(() => {});
    }

    await sendLongMessage(ctx, aiResponse.content);
    telegramLogger.info({ userId, tokens: aiResponse.tokens_used.total }, 'Photo response sent');
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process photo');
    const errorCode = getErrorCode(error);
    analyticsRepo.log('error', 'telegram', { userId, type: 'photo', error: error instanceof Error ? error.message : 'Unknown', errorCode }).catch(() => {});
    await ctx.reply(formatVisionError(errorCode));
  }
};
