import { InputFile } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { analyticsRepo } from '../../db/index.js';
import { editImage } from '../../ai/image-gen.js';
import { escapeHtml } from '../format.js';

/**
 * Скачивает фото из Telegram по массиву PhotoSize.
 * Возвращает { base64, mimeType } для дальнейшей обработки.
 */
export const downloadTelegramPhoto = async (
  ctx: BotContext,
  photos: Array<{ file_id: string; width: number; height: number }>,
): Promise<{ base64: string; mimeType: string }> => {
  const largestPhoto = photos[photos.length - 1];
  if (!largestPhoto) throw new Error('No photo found in message');
  const file = await ctx.api.getFile(largestPhoto.file_id);
  if (!file.file_path) throw Object.assign(new Error('Telegram не вернул путь к файлу'), { code: 'FILE_NOT_FOUND' });

  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download photo: ${response.status}`);

  const base64 = Buffer.from(await response.arrayBuffer()).toString('base64');
  const mimeType = file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { base64, mimeType };
};

export const handleImageEdit = async (
  ctx: BotContext,
  imageBase64: string,
  mimeType: string,
  editPrompt: string,
  userId: string,
): Promise<void> => {
  const statusMsg = await ctx.reply('✏️ Редактирую изображение... Это может занять 10-30 секунд.');
  await ctx.replyWithChatAction('upload_photo');

  try {
    const result = await editImage(imageBase64, mimeType, editPrompt);
    const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);

    await ctx.replyWithPhoto(
      new InputFile(result.image, 'edited.png'),
      {
        caption: `✏️ <b>Отредактировано</b>\n📝 ${escapeHtml(editPrompt)}\n⏱ ${timeSeconds}с | ${result.model}\n\n💡 <i>Ответь на это фото, чтобы продолжить редактирование</i>`,
        parse_mode: 'HTML',
      }
    );

    ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

    analyticsRepo.log('message_sent', 'telegram', {
      userId, type: 'image_edit', model: result.model, timeMs: result.generationTimeMs,
    }).catch(() => {});
    telegramLogger.info({ userId, prompt: editPrompt.substring(0, 60), model: result.model, timeMs: result.generationTimeMs }, 'Image edited successfully');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Не удалось отредактировать изображение.';
    telegramLogger.error({ error, userId, prompt: editPrompt.substring(0, 60) }, 'Image edit failed');
    analyticsRepo.log('error', 'telegram', { userId, type: 'image_edit', error: errorMsg }).catch(() => {});
    ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(`😔 ${errorMsg}`);
  }
};
