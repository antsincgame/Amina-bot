/**
 * Telegram Callback Query Handlers
 * 
 * Все обработчики inline-кнопок:
 * - Заметки: notes_list, save_to_notes, menu_notes, menu_note_help
 * - Задачи: todos_list, todo_done_N, menu_todos, menu_todo_help
 * - Дайджест: digest_toggle, digest_now, digest_city_help, digest_time_help, menu_digest
 * - Новости: news_curate (AI-обзор вайбкодинг новостей)
 * - Меню: menu_search, menu_imagine, menu_voice, menu_help, show_menu
 * - Действия: read_aloud, menu_reminders
 */

import { Bot, InputFile, InlineKeyboard } from 'grammy';
import type { BotContext } from './bot.js';
import { telegramLogger } from '../config/logger.js';
import { config } from '../config/index.js';
import { notesRepo } from '../features/notes-repo.js';
import { todosRepo } from '../features/todos-repo.js';
import { userPrefsRepo } from '../features/user-prefs-repo.js';
import { normalizeNoteInput } from '../features/note-normalizer.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { textToSpeech, detectLanguage } from '../features/tts.js';
import { userLogsRepo } from '../memory/user-memory.js';
import { sendDigestNow, getDigestFullText } from '../features/digest-scheduler.js';
import { getFullText } from './format.js';
import {
  buildMainMenu,
  todoDoneKeyboard,
  digestToggleKeyboard,
  digestControlsKeyboard,
  notesActionsKeyboard,
  remindersRefreshKeyboard,
} from './keyboards.js';
import { escapeHtml } from './format.js';

export const setupCallbacks = (bot: Bot<BotContext>): void => {
  // ====== ЗАМЕТКИ ======

  bot.callbackQuery('notes_list', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id.toString();
    try {
      const notes = await notesRepo.getByUser(userId);

      if (notes.length === 0) {
        await ctx.editMessageText('📋 У тебя пока нет заметок.');
        return;
      }

      const lines = notes.map((n, i) => {
        // Усекаем длинные заметки при отображении (макс. 120 символов)
        const preview = n.content.length > 120 ? n.content.slice(0, 120).trimEnd() + '…' : n.content;
        return `${i + 1}. ${escapeHtml(preview)}`;
      });
      await ctx.editMessageText(
        `📋 <b>Заметки (${notes.length}):</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      telegramLogger.warn({ error: err }, 'Failed to load notes list (callback)');
      await ctx.editMessageText('😔 Не удалось загрузить заметки.');
    }
  });

  bot.callbackQuery('save_to_notes', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    const userId = ctx.from.id.toString();
    const messageText = ctx.callbackQuery.message?.text;

    if (!messageText) {
      await ctx.answerCallbackQuery({ text: '❌ Нечего сохранять' });
      return;
    }

    try {
      const normalized = normalizeNoteInput(messageText, 'callback_save_to_notes');
      const content = normalized.content;

      if (!content) {
        await ctx.answerCallbackQuery({ text: '❌ Нечего сохранять' });
        return;
      }

      await notesRepo.create(userId, content);
      void userLogsRepo.add(userId, 'command', 'note_saved_from_callback', {
        noteSource: normalized.source,
        rawLength: normalized.rawLength,
        normalizedLength: normalized.normalizedLength,
      });
      await ctx.answerCallbackQuery({ text: '📌 Сохранено в заметки!' });
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to save note (callback)');
      await ctx.answerCallbackQuery({ text: '❌ Не удалось сохранить' });
    }
  });

  bot.callbackQuery(/^save_to_notes_full:(.+)$/, async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    const userId = ctx.from.id.toString();
    const textId = ctx.match?.[1];
    const fullText = textId ? getFullText(textId) : null;

    if (!fullText) {
      await ctx.answerCallbackQuery({ text: '❌ Полный текст не найден, попробуй снова' });
      return;
    }

    try {
      const normalized = normalizeNoteInput(fullText, 'callback_save_to_notes_full');
      const content = normalized.content;
      if (!content) {
        await ctx.answerCallbackQuery({ text: '❌ Нечего сохранять' });
        return;
      }

      await notesRepo.create(userId, content);
      void userLogsRepo.add(userId, 'command', 'note_saved_from_full_callback', {
        noteSource: normalized.source,
        rawLength: normalized.rawLength,
        normalizedLength: normalized.normalizedLength,
      });
      await ctx.answerCallbackQuery({ text: '📌 Полный текст сохранён в заметки!' });
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to save full note (callback)');
      await ctx.answerCallbackQuery({ text: '❌ Не удалось сохранить' });
    }
  });

  bot.callbackQuery('menu_notes', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id.toString();
    try {
      const notes = await notesRepo.getByUser(userId);
      if (notes.length === 0) {
        const kb = new InlineKeyboard().text('📌 Создать заметку', 'menu_note_help');
        await ctx.reply('📋 У тебя пока нет заметок.', { reply_markup: kb });
      } else {
        const lines = notes.map((n, i) => {
          const date = new Date(n.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
          // Усекаем длинные заметки при отображении (макс. 150 символов)
          const preview = n.content.length > 150 ? n.content.slice(0, 150).trimEnd() + '…' : n.content;
          return `${i + 1}. ${escapeHtml(preview)}\n   <i>${date}</i>`;
        });
        await ctx.reply(
          `📋 <b>Заметки (${notes.length}):</b>\n\n${lines.join('\n\n')}\n\n<i>Удалить: /note_delete номер</i>`,
          { parse_mode: 'HTML', reply_markup: notesActionsKeyboard() }
        );
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load notes menu (callback)');
      await ctx.reply('😔 Не удалось загрузить заметки.');
    }
  });

  bot.callbackQuery('menu_note_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('📌 <b>Что запомнить?</b>', { parse_mode: 'HTML' });
    ctx.session.awaitingNoteContent = true;
  });

  // ====== ЗАДАЧИ ======

  bot.callbackQuery('todos_list', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id.toString();
    try {
      const todos = await todosRepo.getActive(userId);

      if (todos.length === 0) {
        await ctx.editMessageText('🎉 Все задачи выполнены!');
        return;
      }

      const lines = todos.map((t, i) => `${i + 1}. ☐ ${escapeHtml(t.task)}`);
      await ctx.editMessageText(
        `📋 <b>Задачи (${todos.length}):</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: todoDoneKeyboard(todos.length) }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load todos list (callback)');
      await ctx.editMessageText('😔 Не удалось загрузить задачи.');
    }
  });

  bot.callbackQuery(/^todo_done_(\d+)$/, async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    const userId = ctx.from.id.toString();
    const index = parseInt(ctx.match![1]!, 10);

    try {
      const done = await todosRepo.markDone(userId, index);
      if (done) {
        await ctx.answerCallbackQuery({ text: `✅ ${done.task}` });
        const remaining = await todosRepo.getActive(userId);
        if (remaining.length === 0) {
          await ctx.editMessageText('🎉 Все задачи выполнены!');
        } else {
          const lines = remaining.map((t, i) => `${i + 1}. ☐ ${escapeHtml(t.task)}`);
          await ctx.editMessageText(
            `📋 <b>Задачи (${remaining.length}):</b>\n\n${lines.join('\n')}`,
            { parse_mode: 'HTML', reply_markup: todoDoneKeyboard(remaining.length) }
          );
        }
      } else {
        await ctx.answerCallbackQuery({ text: '❌ Задача не найдена' });
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to complete todo (callback)');
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  });

  bot.callbackQuery('menu_todos', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id.toString();
    try {
      const todos = await todosRepo.getActive(userId);
      if (todos.length === 0) {
        const kb = new InlineKeyboard().text('✅ Добавить задачу', 'menu_todo_help');
        await ctx.reply('🎉 Все задачи выполнены!', { reply_markup: kb });
      } else {
        const lines = todos.map((t, i) => `${i + 1}. ☐ ${escapeHtml(t.task)}`);
        const keyboard = todoDoneKeyboard(todos.length);
        keyboard.row().text('➕ Добавить', 'menu_todo_help');
        await ctx.reply(
          `📋 <b>Задачи (${todos.length}):</b>\n\n${lines.join('\n')}`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load todos menu (callback)');
      await ctx.reply('😔 Не удалось загрузить задачи.');
    }
  });

  bot.callbackQuery('menu_todo_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('✅ <b>Какую задачу добавить?</b>', { parse_mode: 'HTML' });
    ctx.session.awaitingTodoTask = true;
  });

  // ====== ДАЙДЖЕСТ ======

  bot.callbackQuery('digest_toggle', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat?.id ?? 0;
    try {
      const prefs = await userPrefsRepo.get(userId);
      const newState = !(prefs?.digest_enabled ?? false);
      await userPrefsRepo.toggleDigest(userId, chatId, newState);
      await ctx.answerCallbackQuery({ text: newState ? '✅ Дайджест включён' : '❌ Дайджест выключен' });
      await ctx.editMessageText(
        `☀️ <b>Утренний дайджест</b>\n\nСтатус: ${newState ? '✅ Включён' : '❌ Выключен'}`,
        { parse_mode: 'HTML', reply_markup: digestToggleKeyboard(newState) }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to toggle digest (callback)');
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  });

  bot.callbackQuery('digest_now', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '☀️ Собираю дайджест...' });
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat?.id ?? 0;
    try {
      const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
      await ctx.reply('☀️ Собираю дайджест... Это может занять 15-30 секунд.');
      await sendDigestNow(
        { api: ctx.api }, userId, chatId,
        prefs.first_name || ctx.from?.first_name || null,
        prefs.digest_city || ''
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to send digest now (callback)');
      await ctx.reply('😔 Не удалось собрать дайджест. Попробуй позже.');
    }
  });

  bot.callbackQuery('digest_city_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🏙 <b>Изменить город:</b>\n\n<code>/digest город Москва</code>\n<code>/digest город Берлин</code>', { parse_mode: 'HTML' });
  });

  bot.callbackQuery('digest_time_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🕐 <b>Изменить время:</b>\n\n<code>/digest 7</code> — в 7:00\n<code>/digest 10</code> — в 10:00\n<code>/digest 22</code> — в 22:00', { parse_mode: 'HTML' });
  });

  bot.callbackQuery('menu_digest', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat?.id ?? 0;
    try {
      const prefs = await userPrefsRepo.get(userId);
      const status = prefs?.digest_enabled ? '✅ Включён' : '❌ Выключен';
      const hour = prefs?.digest_hour ?? 10;
      const city = prefs?.digest_city ?? '';

      await ctx.reply(
        `☀️ <b>Утренний дайджест</b>\n\nСтатус: ${status}\nВремя: ${hour}:00\nГород: ${escapeHtml(city || 'не задан')}\n\n📰 Включает: погоду, новости, напоминания и задачи`,
        { parse_mode: 'HTML', reply_markup: digestControlsKeyboard(prefs?.digest_enabled ?? false) }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load digest settings (callback)');
      await ctx.reply('😔 Ошибка загрузки настроек дайджеста.');
    }
  });

  // ====== AI-КУРИРОВАНИЕ НОВОСТЕЙ ======

  bot.callbackQuery('news_curate', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '📰 Собираю AI-обзор...' });
    await ctx.reply('📰 <b>Собираю AI-обзор новостей вайбкодинга...</b>\nЭто может занять 20-40 секунд.', { parse_mode: 'HTML' });

    try {
      const { parseAllConfiguredSites } = await import('../features/news-parser.js');
      const { filterHeadlinesForVibecoding } = await import('../features/news-vibecoding-filter.js');
      const { aiService } = await import('../ai/openrouter.js');

      const allHeadlines = await parseAllConfiguredSites();
      const filtered = await filterHeadlinesForVibecoding(allHeadlines);
      const top = filtered.slice(0, 10);

      if (top.length === 0) {
        await ctx.reply('😔 Новостей по вайбкодингу не найдено. Попробуй позже.');
        return;
      }

      const headlinesList = top
        .map((h, i) => `${i + 1}. "${h.title}" (${h.source})${h.description ? ` — ${h.description.slice(0, 100)}` : ''}`)
        .join('\n');

      const curatePrompt = [
        'Ты — AI-куратор новостей о вайбкодинге и AI-программировании для русскоязычной аудитории.',
        'Составь краткий обзор-дайджест из этих новостей на русском языке.',
        'Для каждой новости напиши 1-2 предложения: суть + почему это важно для разработчиков.',
        'Группируй по темам. Используй эмодзи для визуального разделения.',
        'Названия инструментов (Cursor, Claude Code и т.д.) оставляй на английском.',
        '',
        'Новости:',
        headlinesList,
      ].join('\n');

      const result = await aiService.chat(
        [{ role: 'user', content: curatePrompt }],
        'telegram',
        undefined,
        {
          temperature: 0.4,
          maxTokens: 2000,
          priority: 'background',
        },
      );

      const parts = result.content.match(/[\s\S]{1,4000}/g) ?? [result.content];
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' }).catch(() =>
          ctx.reply(part),
        );
      }
    } catch (err) {
      telegramLogger.warn({ error: err instanceof Error ? err.message : String(err) }, 'News curation failed');
      await ctx.reply('😔 Не удалось собрать AI-обзор. Попробуй позже.');
    }
  });

  // ====== МЕНЮ ======

  bot.callbackQuery('menu_search', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🔍 <b>Что найти в интернете?</b>', { parse_mode: 'HTML' });
    ctx.session.awaitingSearchQuery = true;
  });

  bot.callbackQuery('menu_imagine', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🎨 <b>Что нарисовать?</b>', { parse_mode: 'HTML' });
    ctx.session.awaitingImagePrompt = true;
  });

  bot.callbackQuery('edit_image_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '✏️ <b>Как редактировать:</b>\n\n' +
      '1. Ответь (reply) на фото текстом: <i>«убери фон»</i>\n' +
      '2. Или отправь фото с подписью: <i>«сделай ярче»</i>\n' +
      '3. Или ответь голосовым сообщением на фото\n\n' +
      '<b>Примеры:</b> убери фон, добавь шляпу, сделай в стиле аниме, замени цвет на красный',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('menu_reminders', async (ctx) => {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить пользователя' });
      return;
    }
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id.toString();
    try {
      const reminders = await remindersRepo.getByUser(userId);
      if (reminders.length === 0) {
        await ctx.reply(
          '⏰ <b>Напоминания</b>\n\nУ тебя нет активных напоминаний.\n\nПросто напиши:\n• <i>Напомни через 2 часа позвонить</i>\n• <i>Напомни завтра в 9:00 встреча</i>\n• <i>Через 30 минут выключи духовку</i>',
          { parse_mode: 'HTML' }
        );
      } else {
        const lines = reminders.map((r, i) => {
          const d = new Date(r.scheduled_at ?? '');
          const dateStr = Number.isNaN(d.getTime())
            ? '—'
            : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: config.server.timeZone });
          const task = typeof r.task === 'string' ? r.task : String(r.task ?? '—');
          return `${i + 1}. ${escapeHtml(task)}\n   ⏰ ${escapeHtml(dateStr)}`;
        });
        await ctx.reply(
          `⏰ <b>Напоминания (${reminders.length}):</b>\n\n${lines.join('\n\n')}\n\n<i>Отмена: /remind_cancel номер</i>`,
          { parse_mode: 'HTML', reply_markup: remindersRefreshKeyboard() }
        );
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load reminders (callback)');
      await ctx.reply('😔 Не удалось загрузить напоминания.');
    }
  });

  bot.callbackQuery('menu_voice', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '🔊 <b>Голосовые функции</b>\n\n<b>Отправь мне:</b>\n🎤 Голосовое сообщение — я расшифрую и отвечу\n\n<b>Попроси:</b>\n• <i>Скажи голосом привет мир</i>\n• <i>Озвучь стихотворение</i>\n\nТакже можно озвучить любой мой ответ кнопкой 🔊 под сообщением!',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('menu_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🤖 <b>Amina — Полная справка</b>\n\n` +
      `<b>📋 Команды:</b>\n` +
      `/menu — меню\n` +
      `/imagine <i>описание</i> — картинка\n` +
      `/search <i>запрос</i> — поиск\n` +
      `/note <i>текст</i> — заметка\n/notes — список\n` +
      `/todo <i>текст</i> — задача\n/todos — список\n/done <i>номер</i> — выполнить\n` +
      `/reminders — напоминания\n/digest — дайджест\n\n` +
      `<b>💡 Без команд:</b>\n` +
      `• <i>Нарисуй кота</i> — картинка\n• <i>Напомни через час</i> — напоминание\n• <i>Запомни: пароль 123</i> — заметка\n• <i>Курс доллара</i> — автопоиск`,
      { parse_mode: 'HTML', reply_markup: buildMainMenu() }
    );
  });

  bot.callbackQuery('menu_telephony', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '📞 <b>Телефония</b>\n\n' +
      'Амина умеет совершать и принимать звонки через IP-телефонию.\n\n' +
      '<b>Возможности:</b>\n' +
      '• AI-звонки по сценариям\n' +
      '• Распознавание речи в реальном времени\n' +
      '• Анализ записей звонков\n\n' +
      '<i>Управление телефонией доступно в админ-панели.</i>',
      { parse_mode: 'HTML' },
    );
  });

  bot.callbackQuery('show_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🎛 <b>Меню Амины</b> — выбирай:', { parse_mode: 'HTML', reply_markup: buildMainMenu() });
  });

  // ====== ДЕЙСТВИЯ ======

  bot.callbackQuery('read_aloud', async (ctx) => {
    const messageText = ctx.callbackQuery.message?.text;
    if (!messageText) {
      await ctx.answerCallbackQuery({ text: '❌ Нечего озвучивать' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🔊 Генерирую аудио...' });

    try {
      const lang = detectLanguage(messageText);
      const audio = await textToSpeech(messageText, lang);
      if (audio) {
        await ctx.replyWithVoice(new InputFile(audio, 'voice.mp3'));
      } else {
        await ctx.reply('😔 Не удалось сгенерировать аудио.');
      }
    } catch (err) {
      telegramLogger.warn({ error: err }, 'TTS generation failed (callback)');
      await ctx.reply('😔 Ошибка генерации голоса.');
    }
  });

  // Озвучка ПОЛНОГО дайджеста (все части целиком)
  bot.callbackQuery(/^read_aloud_digest:(.+)$/, async (ctx) => {
    const digestId = ctx.match![1];
    const fullText = getDigestFullText(digestId!);

    if (!fullText) {
      await ctx.answerCallbackQuery({ text: '⏱ Дайджест устарел, запросите новый через /digest now' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🔊 Озвучиваю весь дайджест...' });

    try {
      const lang = detectLanguage(fullText);
      const audio = await textToSpeech(fullText, lang);
      if (audio) {
        await ctx.replyWithVoice(new InputFile(audio, 'voice.mp3'));
      } else {
        await ctx.reply('😔 Не удалось сгенерировать аудио дайджеста.');
      }
    } catch (err) {
      telegramLogger.warn({ error: err, digestId }, 'TTS digest generation failed');
      await ctx.reply('😔 Ошибка генерации голоса для дайджеста.');
    }
  });

  // Озвучка ПОЛНОГО текста любого длинного сообщения (поиск, AI-ответ и т.п.)
  bot.callbackQuery(/^read_aloud_full:(.+)$/, async (ctx) => {
    const textId = ctx.match![1];
    const fullText = getFullText(textId!);

    if (!fullText) {
      // Fallback: озвучиваем текст текущего сообщения
      const messageText = ctx.callbackQuery.message?.text;
      if (!messageText) {
        await ctx.answerCallbackQuery({ text: '⏱ Текст устарел, попробуйте заново' });
        return;
      }
      await ctx.answerCallbackQuery({ text: '🔊 Генерирую аудио...' });
      try {
        const lang = detectLanguage(messageText);
        const audio = await textToSpeech(messageText, lang);
        if (audio) {
          await ctx.replyWithVoice(new InputFile(audio, 'voice.mp3'));
        } else {
          await ctx.reply('😔 Не удалось сгенерировать аудио.');
        }
      } catch (err) {
        telegramLogger.warn({ error: err }, 'TTS fallback generation failed');
        await ctx.reply('😔 Ошибка генерации голоса.');
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: '🔊 Озвучиваю полный ответ...' });

    try {
      const lang = detectLanguage(fullText);
      const audio = await textToSpeech(fullText, lang);
      if (audio) {
        await ctx.replyWithVoice(new InputFile(audio, 'voice.mp3'));
      } else {
        await ctx.reply('😔 Не удалось сгенерировать аудио.');
      }
    } catch (err) {
      telegramLogger.warn({ error: err, textId }, 'TTS full text generation failed');
      await ctx.reply('😔 Ошибка генерации голоса.');
    }
  });
};
