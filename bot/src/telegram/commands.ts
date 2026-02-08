/**
 * Telegram Command Handlers
 * 
 * Все /command обработчики:
 * /start, /menu, /help, /clear, /reminders, /remind_cancel,
 * /imagine, /search, /note, /notes, /note_delete,
 * /todo, /todos, /done, /digest
 */

import { Bot, InputFile, InlineKeyboard } from 'grammy';
import type { BotContext } from './bot.js';
import { telegramLogger } from '../config/logger.js';
import { analyticsRepo, conversationsRepo } from '../db/supabase.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { generateImage } from '../ai/image-gen.js';
import { searchAndFormat } from '../ai/websearch.js';
import { getErrorCode } from '../utils/error-handler.js';
import { notesRepo } from '../features/notes-repo.js';
import { todosRepo } from '../features/todos-repo.js';
import { userPrefsRepo } from '../features/user-prefs-repo.js';
import { sendDigestNow } from '../features/digest-scheduler.js';
import { parseAllConfiguredSites, getConfiguredSites } from '../features/news-parser.js';
import { escapeMarkdown, escapeHtml, sendLongMessage } from './format.js';
import {
  buildMainMenu,
  buildReplyKeyboard,
  notesListKeyboard,
  todosListKeyboard,
  todoDoneKeyboard,
  digestToggleKeyboard,
  digestControlsKeyboard,
} from './keyboards.js';

export const setupCommands = (bot: Bot<BotContext>): void => {
  // /start
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    telegramLogger.info({ userId }, 'User started bot');

    analyticsRepo.log('message_received', 'telegram', { command: 'start', userId }).catch(() => {});

    try {
      await userPrefsRepo.getOrCreate(userId, ctx.chat.id, ctx.from?.first_name);
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to init user prefs on /start');
    }

    const name = ctx.from?.first_name || 'друг';

    await ctx.reply(
      `✨ *Привет, ${name}!* Я — *Amina*, твой персональный AI-ассистент.\n\n` +
      `Вот что я умею:\n\n` +
      `💬 *Чат* — задай любой вопрос\n` +
      `🌐 *Интернет* — ищу актуальную информацию в сети\n` +
      `🎨 *Картинки* — «нарисуй...» или кнопка ниже\n` +
      `🎤 *Голос* — отправь голосовое, я пойму\n` +
      `📷 *Фото* — отправь картинку для анализа\n` +
      `⏰ *Напоминания* — «напомни через час...»\n` +
      `📌 *Заметки* — «запомни ...» или кнопка\n` +
      `✅ *Задачи* — добавляй и выполняй\n` +
      `☀️ *Дайджест* — утренняя сводка с погодой и новостями\n` +
      `🔊 *Озвучка* — «скажи голосом...»\n\n` +
      `👇 *Используй кнопки ниже или просто напиши!*`,
      { parse_mode: 'Markdown', reply_markup: buildReplyKeyboard() }
    );

    await ctx.reply(`🎛 *Быстрое меню* — нажми на нужную кнопку:`, {
      parse_mode: 'Markdown',
      reply_markup: buildMainMenu(),
    });
  });

  // /menu
  bot.command('menu', async (ctx) => {
    await ctx.reply(`🎛 *Меню Amina* — выбери действие:`, {
      parse_mode: 'Markdown',
      reply_markup: buildMainMenu(),
    });
  });

  // /help
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 *Amina — Полная справка*\n\n` +
      `*📋 Команды:*\n` +
      `/menu — главное меню с кнопками\n` +
      `/imagine \\_описание\\_ — картинка\n` +
      `/search \\_запрос\\_ — поиск в сети\n` +
      `/note \\_текст\\_ — заметка\n` +
      `/notes — список заметок\n` +
      `/note\\_delete \\_номер\\_ — удалить заметку\n` +
      `/todo \\_текст\\_ — задача\n` +
      `/todos — список задач\n` +
      `/done \\_номер\\_ — выполнить\n` +
      `/reminders — напоминания\n` +
      `/remind\\_cancel \\_номер\\_ — отменить\n` +
      `/digest — утренний дайджест\n` +
      `/clear — очистить историю\n\n` +
      `*💡 Быстрые действия (без команд):*\n` +
      `• _Нарисуй кота в космосе_ — картинка\n` +
      `• _Напомни через час позвонить_ — напоминание\n` +
      `• _Запомни: пароль 12345_ — заметка\n` +
      `• _Скажи голосом привет_ — озвучка\n` +
      `• _Курс доллара_ — автопоиск\n` +
      `• Отправь 📷 фото — опишу\n` +
      `• Отправь 🎤 голосовое — пойму`,
      { parse_mode: 'Markdown', reply_markup: buildMainMenu() }
    );
  });

  // /clear
  bot.command('clear', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat?.id ?? 0;
    
    // Очищаем сессию (контекст для AI)
    ctx.session.messageHistory = [];
    const oldConvId = ctx.session.conversationId;
    ctx.session.conversationId = null; // ВАЖНО: сбрасываем ID, чтобы создался новый диалог

    try {
      // Если был старый диалог — очищаем его сообщения в БД (но сохраняем саму запись)
      if (oldConvId) {
        await conversationsRepo.clearMessages(oldConvId);
        telegramLogger.info({ userId, conversationId: oldConvId }, 'Conversation messages cleared in DB');
      }
      
      // Создаём новый диалог для чистого старта
      const newConversation = await conversationsRepo.getOrCreate(
        userId, 'telegram',
        { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
      );
      ctx.session.conversationId = newConversation.id;
      telegramLogger.info({ userId, newConvId: newConversation.id }, 'New conversation created after clear');
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to clear/recreate conversation');
    }

    await ctx.reply('✅ История диалога очищена. Начнём сначала!');
  });

  // /reminders
  bot.command('reminders', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    try {
      const reminders = await remindersRepo.getByUser(userId);
      if (reminders.length === 0) {
        await ctx.reply('📋 У тебя нет активных напоминаний.\n\nНапиши мне что-то вроде:\n«Напомни через 2 часа позвонить маме»');
        return;
      }

      const lines = reminders.map((r, i) => {
        const dateStr = new Date(r.scheduled_at).toLocaleString('ru-RU', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
        return `${i + 1}. ${r.task}\n   ⏰ ${dateStr}`;
      });

      await ctx.reply(
        `📋 **Активные напоминания (${reminders.length}):**\n\n${lines.join('\n\n')}\n\n_Для отмены: /remind\\_cancel номер_`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to list reminders');
      await ctx.reply('😔 Не удалось загрузить напоминания. Попробуй позже.');
    }
  });

  // /remind_cancel
  bot.command('remind_cancel', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const arg = ctx.message?.text?.replace(/^\/remind_cancel\s*/i, '').trim();

    if (!arg) {
      await ctx.reply('Использование: `/remind_cancel номер`\n\nСначала посмотри список: /reminders', { parse_mode: 'Markdown' });
      return;
    }

    const index = parseInt(arg, 10);
    if (isNaN(index) || index < 1) {
      await ctx.reply('❌ Укажи номер напоминания из списка /reminders');
      return;
    }

    try {
      const reminders = await remindersRepo.getByUser(userId);
      if (index > reminders.length) {
        await ctx.reply(`❌ Напоминания с номером ${index} нет. У тебя ${reminders.length} активных.`);
        return;
      }

      const reminder = reminders[index - 1]!;
      const deleted = await remindersRepo.delete(reminder.id, userId);

      if (deleted) {
        await ctx.reply(`✅ Напоминание удалено: "${reminder.task}"`);
        telegramLogger.info({ userId, reminderId: reminder.id }, 'Reminder cancelled by user');
      } else {
        await ctx.reply('❌ Не удалось удалить напоминание.');
      }
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to cancel reminder');
      await ctx.reply('😔 Ошибка при удалении напоминания.');
    }
  });

  // /imagine
  bot.command('imagine', async (ctx) => {
    const prompt = ctx.match?.trim();
    const userId = ctx.from?.id.toString() ?? 'unknown';

    if (!prompt) {
      // Спрашиваем, что нарисовать
      await ctx.reply(
        '🎨 *Что нарисовать?*\n\n' +
        'Опиши изображение, которое хочешь создать.\n\n' +
        '_Например: кот-астронавт в космосе, закат над горами в стиле Ван Гога_',
        { parse_mode: 'Markdown' }
      );
      // Устанавливаем флаг ожидания описания для картинки
      ctx.session.awaitingImagePrompt = true;
      return;
    }

    telegramLogger.info({ userId, prompt }, 'Image generation requested');
    await ctx.reply('🎨 Генерирую изображение... Это может занять 10-30 секунд.');

    try {
      const result = await generateImage(prompt);
      const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);
      const safePrompt = escapeMarkdown(prompt);

      await ctx.replyWithPhoto(
        new InputFile(result.image, 'generated.png'),
        { caption: `🎨 ${safePrompt}\n⏱ ${timeSeconds}с | FLUX.1-schnell` }
      );

      telegramLogger.info({ userId, prompt, timeMs: result.generationTimeMs }, 'Image sent to user');
      analyticsRepo.log('message_received', 'telegram', {
        userId, event: 'image_generated', prompt, model: result.model, timeMs: result.generationTimeMs,
      }).catch(() => {});
    } catch (error: unknown) {
      const err = error as { message?: string };
      telegramLogger.error({ error, userId, prompt }, 'Image generation failed');
      await ctx.reply(`😔 ${err.message || 'Не удалось создать изображение. Попробуй позже.'}`);
    }
  });

  // /search
  bot.command('search', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const query = ctx.message?.text?.replace(/^\/search\s*/i, '').trim();

    if (!query) {
      await ctx.reply(
        '🔍 **Поиск в интернете**\n\n' +
        'Использование: `/search запрос`\n\n' +
        'Примеры:\n' +
        '• `/search погода в Москве`\n' +
        '• `/search курс доллара`\n' +
        '• `/search новости технологий`\n\n' +
        '_Обычно я сам ищу информацию когда нужно — просто спроси!_',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    telegramLogger.info({ userId, query }, 'Explicit web search');
    await ctx.replyWithChatAction('typing');

    try {
      const result = await searchAndFormat(query);
      await sendLongMessage(ctx, result);
      telegramLogger.info({ userId }, 'Explicit search completed');
    } catch (error) {
      const errorCode = getErrorCode(error);
      telegramLogger.warn({ error, errorCode, userId }, 'Explicit search failed');

      let errorMessage = '😔 Не удалось найти информацию. Попробуй переформулировать запрос.';
      if (errorCode === 'PERPLEXITY_NOT_CONFIGURED') errorMessage = '⚙️ Поиск не настроен. Обратитесь к администратору.';
      else if (errorCode === 'PERPLEXITY_RATE_LIMIT') errorMessage = '⏳ Слишком много запросов. Подожди минуту.';

      await ctx.reply(errorMessage);
    }
  });

  // ====== ЗАМЕТКИ ======

  // /note
  bot.command('note', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const content = ctx.match?.trim();

    if (!content) {
      await ctx.reply('📌 Чтобы сохранить заметку:\n\n/note Текст заметки\n\nПример: /note Купить молоко и хлеб');
      return;
    }

    try {
      const note = await notesRepo.create(userId, content);
      await ctx.reply(`📌 Заметка сохранена!\n\n<i>${escapeHtml(content)}</i>`, {
        parse_mode: 'HTML',
        reply_markup: notesListKeyboard(),
      });
      telegramLogger.info({ userId, noteId: note.id }, 'Note created');
    } catch (error: unknown) {
      const err = error as { message?: string };
      await ctx.reply(`😔 ${err.message || 'Не удалось сохранить заметку.'}`);
    }
  });

  // /notes
  bot.command('notes', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    try {
      const notes = await notesRepo.getByUser(userId);
      if (notes.length === 0) {
        await ctx.reply('📋 У тебя пока нет заметок.\n\nСоздай: /note текст');
        return;
      }

      const lines = notes.map((n, i) => {
        const date = new Date(n.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
        return `${i + 1}. ${escapeHtml(n.content)}\n   <i>${date}</i>`;
      });

      await ctx.reply(
        `📋 <b>Заметки (${notes.length}):</b>\n\n${lines.join('\n\n')}\n\n<i>Удалить: /note_delete номер</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to render notes with HTML, trying plaintext');
      // Fallback без форматирования
      try {
        const notes = await notesRepo.getByUser(userId);
        if (notes.length === 0) {
          await ctx.reply('📋 У тебя пока нет заметок. Создай: /note текст');
        } else {
          const lines = notes.map((n, i) => `${i + 1}. ${n.content}`);
          await ctx.reply(`📋 Заметки (${notes.length}):\n\n${lines.join('\n')}\n\nУдалить: /note_delete номер`);
        }
      } catch (err2) {
        telegramLogger.error({ error: err2, userId }, 'Failed to load notes even in plaintext');
        await ctx.reply('😔 Не удалось загрузить заметки.');
      }
    }
  });

  // /note_delete
  bot.command('note_delete', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const indexStr = ctx.match?.trim();
    const index = parseInt(indexStr || '', 10);

    if (!indexStr || isNaN(index) || index < 1) {
      await ctx.reply('❌ Укажи номер заметки: /note_delete 1');
      return;
    }

    try {
      const deleted = await notesRepo.deleteByIndex(userId, index);
      if (deleted) {
        const preview = deleted.content.length > 100 ? deleted.content.slice(0, 100) + '...' : deleted.content;
        await ctx.reply(`🗑 Заметка удалена: "${preview}"`);
      } else {
        await ctx.reply('❌ Заметка с таким номером не найдена.');
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to delete note');
      await ctx.reply('😔 Ошибка при удалении заметки.');
    }
  });

  // ====== TODO ======

  // /todo
  bot.command('todo', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const task = ctx.match?.trim();

    if (!task) {
      await ctx.reply('✅ Чтобы добавить задачу:\n\n`/todo Текст задачи`\n\nПример: `/todo Сделать отчёт`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      await todosRepo.create(userId, task);
      await ctx.reply(`✅ Задача добавлена!\n\n☐ _${task}_`, {
        parse_mode: 'Markdown',
        reply_markup: todosListKeyboard(),
      });
    } catch (error: unknown) {
      const err = error as { message?: string };
      await ctx.reply(`😔 ${err.message || 'Не удалось добавить задачу.'}`);
    }
  });

  // /todos
  bot.command('todos', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    try {
      const todos = await todosRepo.getActive(userId);
      if (todos.length === 0) {
        await ctx.reply('🎉 Все задачи выполнены!\n\nДобавь: `/todo текст`', { parse_mode: 'Markdown' });
        return;
      }

      const lines = todos.map((t, i) => `${i + 1}. ☐ ${t.task}`);
      await ctx.reply(
        `📋 *Задачи (${todos.length}):*\n\n${lines.join('\n')}\n\n_Нажми кнопку или: /done номер_`,
        { parse_mode: 'Markdown', reply_markup: todoDoneKeyboard(todos.length) }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load todos');
      await ctx.reply('😔 Не удалось загрузить задачи.');
    }
  });

  // /done
  bot.command('done', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const indexStr = ctx.match?.trim();
    const index = parseInt(indexStr || '', 10);

    if (!indexStr || isNaN(index) || index < 1) {
      await ctx.reply('❌ Укажи номер задачи: `/done 1`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      const done = await todosRepo.markDone(userId, index);
      if (done) await ctx.reply(`🎉 Выполнено: ~~${done.task}~~`, { parse_mode: 'Markdown' });
      else await ctx.reply('❌ Задача с таким номером не найдена.');
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to complete todo');
      await ctx.reply('😔 Ошибка при обновлении задачи.');
    }
  });

  // ====== ДАЙДЖЕСТ ======

  // /digest
  bot.command('digest', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const arg = ctx.match?.trim().toLowerCase();

    try {
      // /digest now
      if (arg === 'now' || arg === 'сейчас') {
        const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
        await ctx.reply('☀️ Собираю дайджест... Это может занять 15-30 секунд.');
        await ctx.replyWithChatAction('typing');

        try {
          await sendDigestNow(
            { api: ctx.api }, userId, chatId,
            prefs.first_name || ctx.from?.first_name || null,
            prefs.digest_city || 'Минск'
          );
        } catch (digestError) {
          telegramLogger.error({ error: digestError, userId }, 'Digest now failed');
          await ctx.reply('😔 Не удалось собрать дайджест. Попробуй позже.');
        }
        return;
      }

      // /digest город Минск
      if (arg?.startsWith('город') || arg?.startsWith('city')) {
        const city = arg.replace(/^(город|city)\s*/i, '').trim();
        if (!city) {
          await ctx.reply('Использование: `/digest город Минск`', { parse_mode: 'Markdown' });
          return;
        }
        await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
        await userPrefsRepo.update(userId, { digest_city: city });
        await ctx.reply(`🏙 Город дайджеста: *${city}*`, { parse_mode: 'Markdown' });
        return;
      }

      // /digest 7 — сменить час
      const hour = parseInt(arg || '', 10);
      if (!isNaN(hour) && hour >= 0 && hour <= 23) {
        await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
        await userPrefsRepo.update(userId, { digest_hour: hour });
        await ctx.reply(`🕐 Дайджест будет приходить в *${hour}:00* по Минску`, { parse_mode: 'Markdown' });
        return;
      }

      // /digest — показать статус
      const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
      const status = prefs.digest_enabled ? '✅ Включён' : '❌ Выключен';

      await ctx.reply(
        `☀️ *Утренний дайджест*\n\n` +
        `Статус: ${status}\n` +
        `Время: ${prefs.digest_hour}:00 по Минску\n` +
        `Город: ${prefs.digest_city}\n\n` +
        `📰 Включает: погоду, новости, напоминания и задачи`,
        { parse_mode: 'Markdown', reply_markup: digestControlsKeyboard(prefs.digest_enabled) }
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Digest command failed');
      await ctx.reply('😔 Ошибка при работе с дайджестом.');
    }
  });

  // /test_parser — проверить парсинг новостей (только для разработки/отладки)
  bot.command('test_parser', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    
    try {
      await ctx.reply('🔍 Запускаю парсинг всех настроенных сайтов...');
      await ctx.replyWithChatAction('typing');

      const sites = await getConfiguredSites();
      const enabledSites = sites.filter(s => s.enabled);

      if (enabledSites.length === 0) {
        await ctx.reply('❌ Нет активных новостных сайтов. Настройте их в админке.');
        return;
      }

      await ctx.reply(`📋 Активных сайтов: ${enabledSites.length}\n${enabledSites.map(s => `• ${s.name}`).join('\n')}`);

      const startTime = Date.now();
      const headlines = await parseAllConfiguredSites();
      const parseTimeMs = Date.now() - startTime;

      if (headlines.length === 0) {
        await ctx.reply(`❌ Не удалось спарсить заголовки ни с одного сайта.\nВремя: ${parseTimeMs}ms`);
        return;
      }

      // Группируем по источникам
      const bySource: Record<string, typeof headlines> = {};
      headlines.forEach(h => {
        if (!bySource[h.source]) bySource[h.source] = [];
        bySource[h.source]!.push(h);
      });

      let report = `✅ *Результаты парсинга* (${parseTimeMs}ms)\n\n`;
      report += `Всего заголовков: *${headlines.length}*\n\n`;

      for (const [source, items] of Object.entries(bySource)) {
        report += `📰 *${source}* (${items.length})\n`;
        items.slice(0, 3).forEach((h, i) => {
          const short = h.title.length > 60 ? h.title.slice(0, 60) + '...' : h.title;
          report += `${i + 1}. ${escapeMarkdown(short)}\n`;
        });
        if (items.length > 3) {
          report += `   _... и ещё ${items.length - 3}_\n`;
        }
        report += '\n';
      }

      await sendLongMessage(ctx, report);
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Test parser command failed');
      await ctx.reply(`😔 Ошибка парсинга: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });
};
