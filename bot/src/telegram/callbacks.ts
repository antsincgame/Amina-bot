/**
 * Telegram Callback Query Handlers
 * 
 * Все обработчики inline-кнопок:
 * - Заметки: notes_list, save_to_notes, menu_notes, menu_note_help
 * - Задачи: todos_list, todo_done_N, menu_todos, menu_todo_help
 * - Дайджест: digest_toggle, digest_now, digest_city_help, digest_time_help, menu_digest
 * - Меню: menu_search, menu_imagine, menu_voice, menu_help, show_menu
 * - Действия: read_aloud, menu_reminders
 */

import { Bot, InputFile, InlineKeyboard } from 'grammy';
import type { BotContext } from './bot.js';
import { telegramLogger } from '../config/logger.js';
import { notesRepo } from '../features/notes-repo.js';
import { todosRepo } from '../features/todos-repo.js';
import { userPrefsRepo } from '../features/user-prefs-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { textToSpeech, detectLanguage } from '../features/tts.js';
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
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
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
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const messageText = ctx.callbackQuery.message?.text;

    if (!messageText) {
      await ctx.answerCallbackQuery({ text: '❌ Нечего сохранять' });
      return;
    }

    try {
      // Очищаем текст от служебного мусора перед сохранением
      let content = messageText;

      // 1. Извлекаем из AI-формата заметки (разные кавычки: "", «», '')
      const aiNoteMatch = content.match(/[Зз]аметка\s+создана[:\s]*["«'"](.+?)["»'"]/s);
      if (aiNoteMatch?.[1]) {
        content = aiNoteMatch[1];
      }

      // 1b. Если AI-ответ о создании заметки ("Ты просил создать заметку X...") — извлекаем суть
      const aiNoteRequestMatch = content.match(/(?:просил[аи]?\s+)?создать\s+заметку\s+["«'"](.+?)["»'"]/i);
      if (aiNoteRequestMatch?.[1]) {
        content = aiNoteRequestMatch[1];
      }

      // 2. Убираем секцию "📚 Источники:" и всё после неё
      content = content.replace(/\n*📚\s*Источники?:[\s\S]*$/i, '');
      content = content.replace(/\n*Источники?:\s*\n[\s\S]*$/i, '');

      // 3. Убираем служебные фразы бота (поиск, ожидание)
      // Фикс: .*? → .* для захвата всей строки; + Unicode-эллипсис "…" + "..."
      content = content.replace(/^(Конечно!?\s*)?Сейчас\s+(я\s+)?найду[^\n]*\n*/i, '');
      content = content.replace(/^(Конечно!?\s*)?Сейчас\s+(я\s+)?(поищу|найду|посмотрю)[^\n]*\n*/i, '');
      content = content.replace(/^🔍?\s*Ищу[.…]{0,3}\s*\n*/gm, '');
      content = content.replace(/\(Поиск в интернете\)\s*/gi, '');

      // 3b. Убираем приветствия из начала (мусор от AI)
      content = content.replace(/^(привет[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?(?:👋\s*)?[\n\r]*)/i, '');
      content = content.replace(/^(здравствуй(?:те)?[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*)/i, '');

      // 3c. Убираем AI-метаразговор ("Я готова помочь!", "Пожалуйста, уточни:")
      content = content.replace(/\n*(?:Я\s+)?готов[аы]?\s+помочь[!.]*[\s\S]*/i, '');
      content = content.replace(/\n*Пожалуйста,?\s+уточни[\s\S]*/i, '');
      content = content.replace(/\n*Как только ты уточнишь[\s\S]*/i, '');

      // 4. Убираем голые URL и citation маркеры
      content = content.replace(/\[(\d+)\]/g, '');
      content = content.replace(/https?:\/\/[^\s)>\]]+/g, '');

      // 5. Убираем "Хочешь узнать больше..." в конце
      content = content.replace(/\n*Хочешь узнать больше[\s\S]*$/i, '');
      content = content.replace(/\n*Если (?:у тебя есть|хочешь)[\s\S]*$/i, '');
      content = content.replace(/\n*Дай знать[\s\S]*$/i, '');

      // 6. Убираем пустые строки и лишние пробелы
      content = content.replace(/\n{3,}/g, '\n\n').trim();

      // 7. Проверяем: если после очистки осталось < 3 символов или только мусор — отказываем
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
    await ctx.reply('📌 *Что запомнить?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingNoteContent = true;
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
    await ctx.reply('✅ *Какую задачу добавить?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingTodoTask = true;
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
    await ctx.reply('🔍 *Что найти в интернете?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingSearchQuery = true;
  });

  bot.callbackQuery('menu_imagine', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🎨 *Что нарисовать?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingImagePrompt = true;
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
      `/reminders — напоминания\n/digest — дайджест\n\n` +
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
