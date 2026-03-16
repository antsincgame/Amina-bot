import { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { handleTextMessage } from './text-handler.js';
import { handleVoiceMessage } from './voice-handler.js';
import { handlePhotoMessage } from './photo-handler.js';
import { handleDocumentMessage } from './document-handler.js';

export const setupMessageHandlers = (bot: Bot<BotContext>): void => {
  bot.on('message:text', async (ctx) => handleTextMessage(ctx));
  bot.on('message:voice', async (ctx) => handleVoiceMessage(ctx));
  bot.on('message:photo', async (ctx) => handlePhotoMessage(ctx));
  bot.on('message:document', async (ctx) => handleDocumentMessage(ctx));

  // Catch-all for unsupported message types
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!msg.text && !msg.voice && !msg.photo && !msg.document) {
      await ctx.reply('🤔 Я понимаю текст, голосовые сообщения и изображения.');
    }
  });
};

// Re-export for backwards compatibility
export { handleTextMessage } from './text-handler.js';
export { handleVoiceMessage } from './voice-handler.js';
export { handlePhotoMessage } from './photo-handler.js';
export { handleDocumentMessage } from './document-handler.js';
export { downloadTelegramPhoto, handleImageEdit } from './image-helpers.js';
