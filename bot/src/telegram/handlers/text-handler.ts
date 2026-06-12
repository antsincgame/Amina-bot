import { InputFile } from 'grammy';
import type { BotContext } from '../bot.js';
import { telegramLogger } from '../../config/logger.js';
import { analyticsRepo } from '../../db/index.js';
import { checkTelegramRateLimit } from '../../utils/rate-limiter.js';
import { getErrorCode } from '../../utils/error-handler.js';
import { userLogsRepo, type TelegramUserInfo } from '../../memory/user-memory.js';
import { generateImage } from '../../ai/image-gen.js';
import { searchAndFormat } from '../../ai/websearch.js';
import { normalizeNoteInput } from '../../features/note-normalizer.js';
import { notesRepo } from '../../features/notes-repo.js';
import { todosRepo } from '../../features/todos-repo.js';
import { escapeHtml, sendLongMessage } from '../format.js';
import { notesListKeyboard, todosListKeyboard } from '../keyboards.js';
import { handleAutoDetections } from './auto-detect.js';
import { buildReplyButtonHandlers, clearAwaitingFlags } from './reply-buttons.js';
import { downloadTelegramPhoto, downloadTelegramImageDocument, handleImageEdit } from './image-helpers.js';
import { handleDirectWebSearch, shouldForceWebSearch, needsWebSearch } from './web-search-handler.js';
import { processMessageThroughAI, formatAIError } from './ai-pipeline.js';
import { detectImageEditFromText } from './turn-helpers.js';
import { detectSelfDisclosureIntent } from '../../ai/persona.js';

export const handleTextMessage = async (ctx: BotContext): Promise<void> => {
  if (!ctx.from?.id) {
    telegramLogger.warn('Message without from.id — ignoring');
    return;
  }
  const userId = ctx.from.id.toString();
  if (!ctx.chat?.id) {
    telegramLogger.warn('Message without chat.id — ignoring');
    return;
  }
  const chatId = ctx.chat.id;
  const userMessage = ctx.message?.text ?? '';
  const startTime = Date.now();

  // === ReplyKeyboard кнопки ===
  const buttonHandler = buildReplyButtonHandlers(ctx, userId)[userMessage];
  if (buttonHandler) { await buttonHandler(); return; }

  // === Ожидание описания для /imagine ===
  if (ctx.session.awaitingImagePrompt) {
    ctx.session.awaitingImagePrompt = false;
    telegramLogger.info({ userId, prompt: userMessage }, 'Image generation requested (after /imagine)');
    await ctx.reply('🎨 Генерирую изображение... Это может занять 10-30 секунд.');

    try {
      const result = await generateImage(userMessage);
      await ctx.replyWithPhoto(new InputFile(result.image), {
        caption: `🎨 <b>${escapeHtml(result.prompt)}</b>\n\n<i>Модель: ${escapeHtml(result.model)}</i>\n<i>Время: ${result.generationTimeMs}мс</i>\n\n✏️ Ответь на это фото с описанием правок для редактирования`,
        parse_mode: 'HTML',
      });
      analyticsRepo.log('message_sent', 'telegram', { userId, type: 'image', model: result.model }).catch(() => {});
      telegramLogger.info({ userId, prompt: userMessage, model: result.model }, 'Image generated successfully');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      telegramLogger.error({ error, userId, prompt: userMessage }, 'Image generation failed');
      await ctx.reply(`😔 ${errorMsg}`);
      analyticsRepo.log('error', 'telegram', { userId, error: errorMsg }).catch(() => {});
    }
    return;
  }

  // === Ожидание задачи для /todo ===
  if (ctx.session.awaitingTodoTask) {
    ctx.session.awaitingTodoTask = false;
    try {
      await todosRepo.create(userId, userMessage);
      await ctx.reply(`✅ Задача добавлена!\n\n☐ <i>${escapeHtml(userMessage)}</i>`, {
        parse_mode: 'HTML',
        reply_markup: todosListKeyboard(),
      });
      telegramLogger.info({ userId, task: userMessage }, 'Todo created via awaiting');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Не удалось добавить задачу.';
      await ctx.reply(`😔 ${errorMsg}`);
    }
    return;
  }

  // === Ожидание заметки для /note ===
  if (ctx.session.awaitingNoteContent) {
    ctx.session.awaitingNoteContent = false;
    try {
      const normalized = normalizeNoteInput(userMessage, 'awaiting_note');
      await notesRepo.create(userId, normalized.content);
      void userLogsRepo.add(userId, 'command', 'note_created_from_awaiting', {
        noteSource: normalized.source,
        rawLength: normalized.rawLength,
        normalizedLength: normalized.normalizedLength,
      });
      await ctx.reply(`📌 Заметка сохранена!\n\n<i>${escapeHtml(normalized.content)}</i>`, {
        parse_mode: 'HTML',
        reply_markup: notesListKeyboard(),
      });
      telegramLogger.info({ userId }, 'Note created via awaiting');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Не удалось сохранить заметку.';
      await ctx.reply(`😔 ${errorMsg}`);
    }
    return;
  }

  // === Ожидание поискового запроса для /search ===
  if (ctx.session.awaitingSearchQuery) {
    ctx.session.awaitingSearchQuery = false;
    telegramLogger.info({ userId, query: userMessage }, 'Search requested via awaiting');
    await ctx.replyWithChatAction('typing');
    try {
      const result = await searchAndFormat(userMessage);
      await sendLongMessage(ctx, result);
    } catch (error) {
      const errorCode = getErrorCode(error);
      telegramLogger.warn({ error, errorCode, userId }, 'Awaiting search failed');
      await ctx.reply('😔 Не удалось найти информацию. Попробуй переформулировать.');
    }
    return;
  }

  const telegramInfo: TelegramUserInfo = {
    id: ctx.from?.id ?? 0, username: ctx.from?.username,
    first_name: ctx.from?.first_name, last_name: ctx.from?.last_name,
    language_code: ctx.from?.language_code,
  };

  telegramLogger.debug({ userId, chatId, messageLength: userMessage.length }, 'Text message received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) {
    telegramLogger.warn({ userId }, 'Rate limit exceeded');
    await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений. Подожди немного.');
    return;
  }

  analyticsRepo.log('message_received', 'telegram', { userId, chatId, messageLength: userMessage.length }).catch(() => {});
  userLogsRepo.add(userId, 'message', userMessage, { chatId, messageLength: userMessage.length }).catch(() => {});

  // === PATH B: Reply to photo with edit instructions ===
  const replyMsg = ctx.message?.reply_to_message;
  const replyPhoto = replyMsg?.photo;
  const replyDoc = replyMsg?.document;
  const isImageDoc = replyDoc?.mime_type?.startsWith('image/');

  if ((replyPhoto && replyPhoto.length > 0) || isImageDoc) {
    if (await detectImageEditFromText(userMessage)) {
      telegramLogger.info({ userId, prompt: userMessage.substring(0, 60) }, 'Image edit detected via reply to photo/document');
      try {
        const imageData = (replyPhoto && replyPhoto.length > 0)
          ? await downloadTelegramPhoto(ctx, replyPhoto)
          : await downloadTelegramImageDocument(ctx, replyDoc!);
        await handleImageEdit(ctx, imageData.base64, imageData.mimeType, userMessage, userId);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Не удалось отредактировать изображение.';
        telegramLogger.error({ error, userId }, 'Reply-to-image edit failed');
        await ctx.reply(`😔 ${errorMsg}`);
      }
      return;
    }
  }

  await ctx.replyWithChatAction('typing');

  try {
    // Short messages without explicit markers → skip auto-detection, go straight to LLM.
    // Маркеры синхронизированы с handlers в auto-detect.ts:
    // - reminder create: «напомни…»
    // - image gen: «нарисуй…»
    // - TTS: «скажи голосом…», «озвучь…», «произнеси…», «read aloud…»
    // - notes: «запомни…», «запиши…», «сохрани…», «заметка…», «заметь…», «записать…», «запомнить…»
    // - direct web search: «поищи…», «найди в интернете…»
    const isShortMessage = userMessage.length < 20;
    const hasExplicitMarker = /^(напомни|нарисуй|озвучь|скажи голосом|произнеси|read aloud|запомни|запомнить|запиши|записать|сохрани|заметка|заметь|поищи|найди в интернете)/i.test(userMessage.trim());

    if (isShortMessage && !hasExplicitMarker) {
      // Skip auto-detection for short ambiguous messages like "Чья ты жена?"
    } else if (await handleAutoDetections(ctx, userMessage, userId, chatId)) {
      return;
    }

    // Вопросы про саму Амину («кто ты», «расскажи о себе», «чья ты жена») НЕ уходят
    // в веб-поиск: иначе паттерн `/расскажи (про|о|об)/` перехватывал идентичность и
    // Амина искала саму себя в интернете вместо канона самораскрытия (fast-path в
    // processMessageThroughAI). Личность важнее поиска.
    if (
      !detectSelfDisclosureIntent(userMessage)
      && (shouldForceWebSearch(userMessage) || needsWebSearch(userMessage))
    ) {
      const handled = await handleDirectWebSearch(ctx, userMessage, userId, chatId, startTime);
      if (handled) return;
    }

    await processMessageThroughAI(ctx, userMessage, userId, chatId, startTime, telegramInfo, 'message');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = getErrorCode(error);
    telegramLogger.error({ error, userId, errorCode }, 'Failed to process message');
    analyticsRepo.log('error', 'telegram', { userId, error: errorMsg, errorCode }).catch(() => {});
    await ctx.reply(formatAIError(errorCode, errorMsg));
  }
};
