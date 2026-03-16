import type { BotContext } from '../bot.js';
import { MAX_HISTORY_MESSAGES } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { processImageWithLLM } from '../../ai/multimodal.js';
import { detectImageEditIntent, classifyImageEditIntentGroq } from '../../ai/image-gen.js';
import { conversationsRepo, analyticsRepo } from '../../db/index.js';
import { checkTelegramRateLimit } from '../../utils/rate-limiter.js';
import { sendLongMessage } from '../format.js';
import { ensureConversation } from './context-builder.js';
import { handleImageEdit } from './image-helpers.js';

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
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download document: ${response.status}`);

    const imageBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    const caption = ctx.message?.caption;
    const chatId = ctx.chat?.id ?? 0;

    // === PATH A: Документ + caption с edit-ключевыми словами → редактирование ===
    const isEditIntent = caption ? (detectImageEditIntent(caption) || await classifyImageEditIntentGroq(caption)) : false;
    if (isEditIntent) {
      telegramLogger.info({ userId, caption: caption?.substring(0, 60) }, 'Image edit detected via document caption');
      await handleImageEdit(ctx, imageBase64, mimeType, caption!, userId);
      return;
    }

    await ensureConversation(ctx, userId, chatId);

    const aiResponse = await processImageWithLLM(imageBase64, mimeType, caption, ctx.session.messageHistory);
    const userContent = caption ? `[Изображение "${document.file_name}" с подписью: "${caption}"]` : `[Изображение "${document.file_name}"]`;

    ctx.session.messageHistory.push({ role: 'user', content: userContent }, { role: 'assistant', content: aiResponse.content });
    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
      ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    const convId = ctx.session.conversationId;
    if (convId) {
      const nowISO = new Date().toISOString();
      Promise.all([
        conversationsRepo.addMessage(convId, { role: 'user', content: userContent, timestamp: nowISO, metadata: { type: 'document_image', fileName: document.file_name } }),
        conversationsRepo.addMessage(convId, { role: 'assistant', content: aiResponse.content, timestamp: nowISO, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } }),
        analyticsRepo.log('ai_response', 'telegram', { userId, type: 'document_image', model: aiResponse.model, tokens: aiResponse.tokens_used.total }),
      ]).catch((err) => { telegramLogger.warn({ error: err, userId }, 'Background document DB writes failed'); });
    }

    await sendLongMessage(ctx, aiResponse.content);
    telegramLogger.info({ userId }, 'Document image response sent');
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process document image');
    analyticsRepo.log('error', 'telegram', { userId, type: 'document_image', error: error instanceof Error ? error.message : 'Unknown' }).catch(() => {});
    await ctx.reply('😔 Не удалось обработать изображение. Попробуй ещё раз.');
  }
};
