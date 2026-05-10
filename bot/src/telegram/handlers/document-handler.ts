import type { BotContext } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { processImageWithLLM } from '../../ai/multimodal.js';
import { analyticsRepo } from '../../db/index.js';
import { checkTelegramRateLimit } from '../../utils/rate-limiter.js';
import { getErrorCode } from '../../utils/error-handler.js';
import { sendLongMessage } from '../format.js';
import { ensureConversation } from './context-builder.js';
import { handleImageEdit } from './image-helpers.js';
import { detectImageEditFromText, formatVisionError, persistTurn, pushSessionTurn } from './turn-helpers.js';

export const handleDocumentMessage = async (ctx: BotContext): Promise<void> => {
  if (!ctx.from?.id) {
    telegramLogger.warn('Document message without from.id — ignoring');
    return;
  }
  const userId = ctx.from.id.toString();
  const document = ctx.message?.document;
  if (!document) return;
  const mimeType = document.mime_type ?? '';

  if (!mimeType.startsWith('image/')) {
    await ctx.reply('📄 Пока что я могу анализировать только изображения. Отправь фото или картинку.');
    return;
  }

  telegramLogger.info({ userId, mimeType, fileName: document.file_name }, 'Document image received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) { await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.'); return; }

  analyticsRepo.log('message_received', 'telegram', { userId, type: 'document_image', mimeType }).catch(() => {});
  await ctx.replyWithChatAction('typing');

  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw Object.assign(new Error('Telegram не вернул путь к файлу'), { code: 'FILE_NOT_FOUND' });

    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
    const dlController = new AbortController();
    const dlTimeoutId = setTimeout(() => dlController.abort(), 30_000);
    let response: Response;
    try { response = await fetch(fileUrl, { signal: dlController.signal }); } finally { clearTimeout(dlTimeoutId); }
    if (!response.ok) throw new Error(`Failed to download document: ${response.status}`);

    const imageBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    const caption = ctx.message?.caption;
    const chatId = ctx.chat?.id ?? 0;

    // === PATH A: Документ + caption с edit-ключевыми словами → редактирование ===
    if (caption && await detectImageEditFromText(caption)) {
      telegramLogger.info({ userId, caption: caption.substring(0, 60) }, 'Image edit detected via document caption');
      await handleImageEdit(ctx, imageBase64, mimeType, caption, userId);
      return;
    }

    await ensureConversation(ctx, userId, chatId);

    const aiResponse = await processImageWithLLM(imageBase64, mimeType, caption, ctx.session.messageHistory);
    const userContent = caption ? `[Изображение "${document.file_name}" с подписью: "${caption}"]` : `[Изображение "${document.file_name}"]`;

    pushSessionTurn(ctx,
      { role: 'user', content: userContent },
      { role: 'assistant', content: aiResponse.content },
    );

    persistTurn(
      ctx.session.conversationId,
      { content: userContent, metadata: { type: 'document_image', fileName: document.file_name } },
      { content: aiResponse.content, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } },
      { userId, channel: 'document' },
    );
    if (ctx.session.conversationId) {
      analyticsRepo.log('ai_response', 'telegram', { userId, type: 'document_image', model: aiResponse.model, tokens: aiResponse.tokens_used.total }).catch(() => {});
    }

    await sendLongMessage(ctx, aiResponse.content);
    telegramLogger.info({ userId }, 'Document image response sent');
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process document image');
    const errorCode = getErrorCode(error);
    analyticsRepo.log('error', 'telegram', { userId, type: 'document_image', error: error instanceof Error ? error.message : 'Unknown', errorCode }).catch(() => {});
    await ctx.reply(formatVisionError(errorCode));
  }
};
