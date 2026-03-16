import { InputFile } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { conversationsRepo, analyticsRepo } from '../../db/index.js';
import { detectReminderIntent, detectReminderListIntent, extractReminder } from '../../reminders/reminder-parser.js';
import { remindersRepo } from '../../reminders/reminders-repo.js';
import { detectImageGenIntent, extractImagePrompt, generateImage, classifyImageIntentGroq, isAIResponseAboutImages } from '../../ai/image-gen.js';
import { notesRepo } from '../../features/notes-repo.js';
import { textToSpeech, detectLanguage } from '../../features/tts.js';
import { escapeHtml } from '../format.js';
import { notesListKeyboard } from '../keyboards.js';
import { ensureConversation } from './context-builder.js';

/** Обрабатывает автодетекции (напоминания, картинки, TTS, заметки). Возвращает true если обработано. */
export const handleAutoDetections = async (
  ctx: BotContext,
  text: string,
  userId: string,
  chatId: number,
): Promise<boolean> => {
  // === Список напоминаний (НЕ создание, а просмотр) ===
  if (detectReminderListIntent(text)) {
    try {
      const reminders = await remindersRepo.getByUser(userId);
      if (reminders.length === 0) {
        await ctx.reply('⏰ У тебя нет активных напоминаний.\n\nНапиши, например: «Напомни через 2 часа позвонить маме»');
      } else {
        const lines = reminders.map((r, i) => {
          const dateStr = new Date(r.scheduled_at).toLocaleString('ru-RU', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: config.server.timeZone,
          });
          return `${i + 1}. ${escapeHtml(r.task)}\n   ⏰ ${dateStr}`;
        });
        await ctx.reply(
          `⏰ <b>Напоминания (${reminders.length}):</b>\n\n${lines.join('\n\n')}\n\n<i>Отмена: /remind_cancel номер</i>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to list reminders');
      await ctx.reply('😔 Не удалось загрузить напоминания.');
    }
    return true;
  }

  // === Напоминания (создание) ===
  if (detectReminderIntent(text)) {
    try {
      const extracted = await extractReminder(text, new Date());
      if (extracted) {
        await remindersRepo.create(userId, chatId, extracted.task, extracted.scheduled_at);
        await ensureConversation(ctx, userId, chatId);

        const nowISO = new Date().toISOString();
        await conversationsRepo.addMessage(ctx.session.conversationId!, { role: 'user', content: text, timestamp: nowISO });
        await conversationsRepo.addMessage(ctx.session.conversationId!, { role: 'assistant', content: extracted.reply, timestamp: nowISO });
        ctx.session.messageHistory.push({ role: 'user', content: text }, { role: 'assistant', content: extracted.reply });

        await ctx.reply(extracted.reply);
        telegramLogger.info({ userId, task: extracted.task, scheduledAt: extracted.scheduled_at }, 'Reminder created');
        return true;
      }
      telegramLogger.info({ userId }, 'Reminder detected but AI could not parse details');
      await ctx.reply('⏰ Похоже, ты хочешь поставить напоминание, но я не смогла разобрать детали.\n\nПопробуй написать чётче, например:\n«Напомни через 2 часа позвонить маме»');
      return true;
    } catch (reminderError) {
      telegramLogger.warn({ error: reminderError, userId }, 'Reminder extraction failed');
      await ctx.reply('⚠️ Не удалось создать напоминание — AI временно недоступен.\n\nПопробуй ещё раз через минуту.');
      return true;
    }
  }

  // === Генерация изображения ===
  let imgPrompt: string | null = null;
  if (detectImageGenIntent(text)) {
    imgPrompt = extractImagePrompt(text);
    if (imgPrompt) {
      telegramLogger.info({ userId, prompt: imgPrompt, method: 'regex' }, 'Image gen detected (regex)');
    }
  }

  if (!imgPrompt) {
    const isObviouslyNotImage = /^(назови|расскажи|найди|подскажи|посоветуй|порекомендуй|перечисли|объясни|сколько|когда|где|кто|что|как |какой|какая|какие|зачем|почему)(?:\s|$|,)/i.test(text.trim())
      || /\?$/.test(text.trim())
      || text.trim().length < 8;

    if (!isObviouslyNotImage) {
      const groqPrompt = await classifyImageIntentGroq(text);
      if (groqPrompt) {
        imgPrompt = groqPrompt;
        telegramLogger.info({ userId, prompt: imgPrompt, method: 'groq' }, 'Image gen detected (Groq classifier)');
      }
    }
  }

  if (imgPrompt) {
    await ctx.replyWithChatAction('upload_photo');
    try {
      const result = await generateImage(imgPrompt);
      const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);
      const cleanPrompt = imgPrompt.replace(/, high quality.*$/, '');
      await ctx.replyWithPhoto(
        new InputFile(result.image, 'generated.png'),
        { caption: `🎨 ${cleanPrompt}\n⏱ ${timeSeconds}с | ${result.model}\n\n✏️ Ответь на это фото с описанием правок для редактирования` }
      );
      analyticsRepo.log('message_received', 'telegram', { userId, event: 'image_generated', prompt: imgPrompt, model: result.model, timeMs: result.generationTimeMs }).catch(() => {});
      return true;
    } catch (error: unknown) {
      const err = error as { message?: string };
      telegramLogger.error({ error, userId }, 'Auto image gen failed');
      await ctx.reply(`😔 ${err.message || 'Не удалось создать изображение.'}`);
      return true;
    }
  }

  // === TTS: "скажи голосом...", "озвучь..." ===
  const ttsMatch = text.match(/^(скажи голосом|озвучь|произнеси|read aloud)\s+(.+)/i);
  if (ttsMatch) {
    const ttsText = ttsMatch[2]?.trim();
    if (ttsText) {
      await ctx.replyWithChatAction('record_voice');
      try {
        const lang = detectLanguage(ttsText);
        const audio = await textToSpeech(ttsText, lang);
        if (audio) await ctx.replyWithVoice(new InputFile(audio, 'voice.mp3'));
        else await ctx.reply('😔 Не удалось сгенерировать аудио. Попробуй позже.');
      } catch (err) {
        telegramLogger.warn({ error: err, userId }, 'TTS generation failed');
        await ctx.reply('😔 Ошибка генерации голоса.');
      }
      return true;
    }
  }

  // === Заметки: "запомни ...", "запиши ...", "заметка: ..." ===
  const noteMatch = text.match(/^(запомни|запомнить|запиши|записать|сохрани заметку|сохрани|заметка|заметь|запомни пожалуйста|запиши пожалуйста)[:\s]+(.+)/i);
  if (noteMatch) {
    const noteContent = noteMatch[2]?.trim();
    if (noteContent && noteContent.length > 1) {
      try {
        await notesRepo.create(userId, noteContent);
        await ctx.reply(`📌 Сохранено!\n\n<i>${escapeHtml(noteContent)}</i>`, {
          parse_mode: 'HTML',
          reply_markup: notesListKeyboard(),
        });
      } catch (err) {
        telegramLogger.warn({ error: err, userId }, 'Failed to save note via auto-detect');
        await ctx.reply('😔 Не удалось сохранить заметку.');
      }
      return true;
    }
  }

  return false;
};

/**
 * Если основная AI ответила "я не умею создавать картинки" или подобное —
 * перехватываем ответ и генерируем картинку вместо отправки отказа.
 */
export const tryPostAIImageInterception = async (
  ctx: BotContext,
  aiResponseText: string,
  originalUserText: string,
  userId: string,
): Promise<boolean> => {
  if (!isAIResponseAboutImages(aiResponseText)) return false;

  telegramLogger.info(
    { userId, aiSnippet: aiResponseText.substring(0, 80), userText: originalUserText.substring(0, 80) },
    '🎨 Post-AI interception: AI mentioned images, attempting Groq classify + generate'
  );

  try {
    const imgPrompt = await classifyImageIntentGroq(originalUserText);
    if (!imgPrompt) {
      telegramLogger.debug({ userId }, 'Post-AI interception: Groq did not confirm image intent');
      return false;
    }

    await ctx.replyWithChatAction('upload_photo');
    const result = await generateImage(imgPrompt);
    const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);
    const cleanPrompt = imgPrompt.replace(/, high quality.*$/, '');
    await ctx.replyWithPhoto(
      new InputFile(result.image, 'generated.png'),
      { caption: `🎨 ${cleanPrompt}\n⏱ ${timeSeconds}с | FLUX.1-schnell` }
    );
    analyticsRepo.log('message_received', 'telegram', {
      userId, event: 'image_generated_postai', prompt: imgPrompt,
      model: result.model, timeMs: result.generationTimeMs,
    }).catch(() => {});

    telegramLogger.info({ userId, prompt: imgPrompt, method: 'post-ai-interception' }, 'Image generated via post-AI interception');
    return true;
  } catch (error: unknown) {
    const err = error as { message?: string };
    telegramLogger.error({ error, userId }, 'Post-AI image interception failed');
    await ctx.reply(`😔 ${err.message || 'Не удалось создать изображение.'}`);
    return true;
  }
};
