/**
 * Telegram Callback Query Handlers
 * 
 * Все обработчики inline-кнопок:
 * - Заметки: notes_list, save_to_notes, menu_notes, menu_note_help
 * - Задачи: todos_list, todo_done_N, menu_todos, menu_todo_help
 * - Дайджест: digest_toggle, digest_now, digest_city_help, digest_time_help, menu_digest
 * - Меню: menu_search, menu_imagine, menu_voice, menu_clear, menu_help, show_menu
 * - Действия: read_aloud, confirm_clear, cancel_clear, menu_reminders
 */

import { Bot, InputFile, InlineKeyboard } from 'grammy';
import type { BotContext } from './bot.js';
import { telegramLogger } from '../config/logger.js';
import { conversationsRepo } from '../db/supabase.js';
import { notesRepo } from '../features/notes-repo.js';
import { todosRepo } from '../features/todos-repo.js';
import { userPrefsRepo } from '../features/user-prefs-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { textToSpeech, detectLanguage } from '../features/tts.js';
import { sendDigestNow } from '../features/digest-scheduler.js';
import {
  buildMainMenu,
  todoDoneKeyboard,
  digestToggleKeyboard,
  digestControlsKeyboard,
  confirmClearKeyboard,
  notesActionsKeyboard,
  remindersRefreshKeyboard,
} from './keyboards.js';
import { escapeHtml } from './format.js';

export const setupCallbacks = (bot: Bot<BotContext>): void => {
  // ====== ЗАМЕТКИ ======

  bot.callbackQuery('notes_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    try {
      const notes = await notesRepo.getByUser(userId);

      if (notes.length === 0) {
        await ctx.editMessageText('📋 У тебя пока нет заметок.');
        return;
      }

      const lines = notes.map((n, i) => `${i + 1}. ${escapeHtml(n.content)}`);
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
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const messageText = ctx.callbackQuery.message?.text;

    if (!messageText) {
      await ctx.answerCallbackQuery({ text: '❌ Нечего сохранять' });
      return;
    }

    try {
      // Извлекаем полезный контент — убираем служебные фразы AI
      let content = messageText;
      const aiNoteMatch = content.match(/[Зз]аметка создана[:\s]*["«](.+?)["»]/s);
      if (aiNoteMatch?.[1]) {
        content = aiNoteMatch[1];
      }
      content = content.slice(0, 500).trim();

      if (!content) {
        await ctx.answerCallbackQuery({ text: '❌ Нечего сохранять' });
        return;
      }

      await notesRepo.create(userId, content);
      await ctx.answerCallbackQuery({ text: '📌 Сохранено в заметки!' });
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to save note (callback)');
      await ctx.answerCallbackQuery({ text: '❌ Не удалось сохранить' });
    }
  });

  bot.callbackQuery('menu_notes', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    try {
      const notes = await notesRepo.getByUser(userId);
      if (notes.length === 0) {
        const kb = new InlineKeyboard().text('📌 Создать заметку', 'menu_note_help');
        await ctx.reply('📋 У тебя пока нет заметок.', { reply_markup: kb });
      } else {
        const lines = notes.map((n, i) => {
          const date = new Date(n.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
          return `${i + 1}. ${escapeHtml(n.content)}\n   <i>${date}</i>`;
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
    await ctx.reply(
      '📌 <b>Как создать заметку:</b>\n\n• Напиши: <i>запомни купить молоко</i>\n• Или команда: /note Текст заметки\n\nПросмотр: /notes\nУдаление: /note_delete 1',
      { parse_mode: 'HTML' }
    );
  });

  // ====== ЗАДАЧИ ======

  bot.callbackQuery('todos_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const todos = await todosRepo.getActive(userId);

    if (todos.length === 0) {
      await ctx.editMessageText('🎉 Все задачи выполнены!');
      return;
    }

    const lines = todos.map((t, i) => `${i + 1}. ☐ ${t.task}`);
    await ctx.editMessageText(
      `📋 *Задачи (${todos.length}):*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', reply_markup: todoDoneKeyboard(todos.length) }
    );
  });

  bot.callbackQuery(/^todo_done_(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const index = parseInt(ctx.match![1]!, 10);

    try {
      const done = await todosRepo.markDone(userId, index);
      if (done) {
        await ctx.answerCallbackQuery({ text: `✅ ${done.task}` });
        const remaining = await todosRepo.getActive(userId);
        if (remaining.length === 0) {
          await ctx.editMessageText('🎉 Все задачи выполнены!');
        } else {
          const lines = remaining.map((t, i) => `${i + 1}. ☐ ${t.task}`);
          await ctx.editMessageText(
            `📋 *Задачи (${remaining.length}):*\n\n${lines.join('\n')}`,
            { parse_mode: 'Markdown', reply_markup: todoDoneKeyboard(remaining.length) }
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
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    try {
      const todos = await todosRepo.getActive(userId);
      if (todos.length === 0) {
        const kb = new InlineKeyboard().text('✅ Добавить задачу', 'menu_todo_help');
        await ctx.reply('🎉 Все задачи выполнены!', { reply_markup: kb });
      } else {
        const lines = todos.map((t, i) => `${i + 1}. ☐ ${t.task}`);
        const keyboard = todoDoneKeyboard(todos.length);
        keyboard.row().text('➕ Добавить', 'menu_todo_help');
        await ctx.reply(
          `📋 *Задачи (${todos.length}):*\n\n${lines.join('\n')}`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load todos menu (callback)');
      await ctx.reply('😔 Не удалось загрузить задачи.');
    }
  });

  bot.callbackQuery('menu_todo_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '✅ *Как добавить задачу:*\n\nКоманда: `/todo Сделать отчёт`\n\nВыполнить: `/done 1`\nСписок: /todos',
      { parse_mode: 'Markdown' }
    );
  });

  // ====== ДАЙДЖЕСТ ======

  bot.callbackQuery('digest_toggle', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat?.id ?? 0;
    try {
      const prefs = await userPrefsRepo.get(userId);
      const newState = !(prefs?.digest_enabled ?? false);
      await userPrefsRepo.toggleDigest(userId, chatId, newState);
      await ctx.answerCallbackQuery({ text: newState ? '✅ Дайджест включён' : '❌ Дайджест выключен' });
      await ctx.editMessageText(
        `☀️ *Утренний дайджест*\n\nСтатус: ${newState ? '✅ Включён' : '❌ Выключен'}`,
        { parse_mode: 'Markdown', reply_markup: digestToggleKeyboard(newState) }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to toggle digest (callback)');
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  });

  bot.callbackQuery('digest_now', async (ctx) => {
    await ctx.answerCallbackQuery({ text: '☀️ Собираю дайджест...' });
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat?.id ?? 0;
    try {
      const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
      await ctx.reply('☀️ Собираю дайджест... Это может занять 15-30 секунд.');
      await sendDigestNow(
        { api: ctx.api }, userId, chatId,
        prefs.first_name || ctx.from?.first_name || null,
        prefs.digest_city || 'Гродно'
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to send digest now (callback)');
      await ctx.reply('😔 Не удалось собрать дайджест. Попробуй позже.');
    }
  });

  bot.callbackQuery('digest_city_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🏙 *Изменить город:*\n\n`/digest город Минск`\n`/digest город Гродно`', { parse_mode: 'Markdown' });
  });

  bot.callbackQuery('digest_time_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🕐 *Изменить время:*\n\n`/digest 7` — в 7:00\n`/digest 10` — в 10:00\n`/digest 22` — в 22:00', { parse_mode: 'Markdown' });
  });

  bot.callbackQuery('menu_digest', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat?.id ?? 0;
    try {
      const prefs = await userPrefsRepo.get(userId);
      const status = prefs?.digest_enabled ? '✅ Включён' : '❌ Выключен';
      const hour = prefs?.digest_hour ?? 10;
      const city = prefs?.digest_city ?? 'Гродно';

      await ctx.reply(
        `☀️ *Утренний дайджест*\n\nСтатус: ${status}\nВремя: ${hour}:00 по Минску\nГород: ${city}\n\n📰 Включает: погоду, новости, напоминания и задачи`,
        { parse_mode: 'Markdown', reply_markup: digestControlsKeyboard(prefs?.digest_enabled ?? false) }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load digest settings (callback)');
      await ctx.reply('😔 Ошибка загрузки настроек дайджеста.');
    }
  });

  // ====== МЕНЮ ======

  bot.callbackQuery('menu_search', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '🌐 *Поиск в интернете*\n\nНапиши запрос или используй команду:\n`/search курс доллара`\n\nПримеры:\n• _Погода в Минске_\n• _Новости технологий_\n• _Цена биткоина_\n\n💡 Я автоматически ищу в сети когда нужно — просто спроси!',
      { parse_mode: 'Markdown' }
    );
  });

  bot.callbackQuery('menu_imagine', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '🎨 *Генерация картинок*\n\nНапиши что нарисовать или используй команду:\n`/imagine кот в космосе`\n\nПримеры:\n• _Нарисуй закат над горами_\n• _Сгенерируй логотип для кафе_\n\n⏱ Генерация занимает 10-30 секунд',
      { parse_mode: 'Markdown' }
    );
  });

  bot.callbackQuery('menu_reminders', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    try {
      const reminders = await remindersRepo.getByUser(userId);
      if (reminders.length === 0) {
        await ctx.reply(
          '⏰ *Напоминания*\n\nУ тебя нет активных напоминаний.\n\nПросто напиши:\n• _Напомни через 2 часа позвонить_\n• _Напомни завтра в 9:00 встреча_\n• _Через 30 минут выключи духовку_',
          { parse_mode: 'Markdown' }
        );
      } else {
        const lines = reminders.map((r, i) => {
          const dateStr = new Date(r.scheduled_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. ${r.task}\n   ⏰ ${dateStr}`;
        });
        await ctx.reply(
          `⏰ *Напоминания (${reminders.length}):*\n\n${lines.join('\n\n')}\n\n_Отмена: /remind\\_cancel номер_`,
          { parse_mode: 'Markdown', reply_markup: remindersRefreshKeyboard() }
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
      '🔊 *Голосовые функции*\n\n*Отправь мне:*\n🎤 Голосовое сообщение — я расшифрую и отвечу\n\n*Попроси:*\n• _Скажи голосом привет мир_\n• _Озвучь стихотворение_\n\nТакже можно озвучить любой мой ответ кнопкой 🔊 под сообщением!',
      { parse_mode: 'Markdown' }
    );
  });

  bot.callbackQuery('menu_clear', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '🧹 *Очистить историю диалога?*\n\n_Все предыдущие сообщения будут забыты._',
      { parse_mode: 'Markdown', reply_markup: confirmClearKeyboard() }
    );
  });

  bot.callbackQuery('confirm_clear', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat?.id ?? 0;
    
    // Полная очистка — как в /clear команде
    const oldConvId = ctx.session.conversationId;
    ctx.session.messageHistory = [];
    ctx.session.conversationId = null; // ВАЖНО: сбрасываем ID для создания нового диалога
    ctx.session.awaitingImagePrompt = false;

    try {
      // Очищаем сообщения в старом диалоге (данные остаются в Supabase)
      if (oldConvId) {
        await conversationsRepo.clearMessages(oldConvId);
        telegramLogger.info({ userId, conversationId: oldConvId }, 'Conversation messages cleared (callback)');
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to clear conversation history (callback)');
    }
    await ctx.answerCallbackQuery({ text: '✅ История очищена!' });
    await ctx.editMessageText('✅ История диалога очищена. Начнём сначала!');
  });

  bot.callbackQuery('cancel_clear', async (ctx) => {
    await ctx.answerCallbackQuery({ text: '↩️ Отменено' });
    await ctx.editMessageText('↩️ Очистка отменена.');
  });

  bot.callbackQuery('menu_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🤖 *Amina — Полная справка*\n\n` +
      `*📋 Команды:*\n` +
      `/menu — меню\n` +
      `/imagine \\_описание\\_ — картинка\n` +
      `/search \\_запрос\\_ — поиск\n` +
      `/note \\_текст\\_ — заметка\n/notes — список\n` +
      `/todo \\_текст\\_ — задача\n/todos — список\n/done \\_номер\\_ — выполнить\n` +
      `/reminders — напоминания\n/digest — дайджест\n/clear — очистить\n\n` +
      `*💡 Без команд:*\n` +
      `• _Нарисуй кота_ — картинка\n• _Напомни через час_ — напоминание\n• _Запомни: пароль 123_ — заметка\n• _Курс доллара_ — автопоиск`,
      { parse_mode: 'Markdown', reply_markup: buildMainMenu() }
    );
  });

  bot.callbackQuery('show_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(`🎛 *Меню Amina* — выбери действие:`, { parse_mode: 'Markdown', reply_markup: buildMainMenu() });
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
};
