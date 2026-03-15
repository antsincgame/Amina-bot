/**
 * Telegram Command Handlers
 * 
 * Все /command обработчики:
 * /start, /menu, /help, /clear, /reminders, /remind_cancel,
 * /imagine, /search, /note, /notes, /note_delete,
 * /todo, /todos, /done, /digest, /digest_all
 */

import { Bot, InputFile } from 'grammy';
import type { BotContext } from './bot.js';
import { telegramLogger } from '../config/logger.js';
import { analyticsRepo, conversationsRepo } from '../db/index.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { generateImage } from '../ai/image-gen.js';
import { searchAndFormat } from '../ai/websearch.js';
import { getErrorCode } from '../utils/error-handler.js';
import { notesRepo } from '../features/notes-repo.js';
import { todosRepo } from '../features/todos-repo.js';
import { userPrefsRepo } from '../features/user-prefs-repo.js';
import { sendDigestNow, sendHybridDigestNow } from '../features/digest-scheduler.js';
import { parseAllConfiguredSites, getConfiguredSites } from '../features/news-parser.js';
import { escapeMarkdown, escapeHtml, sendLongMessage } from './format.js';
import { connectCall, getCallHistory, isTelephonyAllowed, getLiraXConfig } from '../features/telephony/lirax.js';
import {
  getTelephonyAiScenarios,
  isTelephonyOwner,
  startTelephonyAiCall,
} from '../features/telephony/ai-scenarios.js';
import { aiService } from '../ai/openrouter.js';
import type { AIMessage } from '../../../shared/types/index.js';
import type { TelephonyRuntimeMode } from '../../../shared/types/telephony.js';
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
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
      `🧠 *Полный дайджест* — /digest_all для полного Appwrite-пайплайна\n` +
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
      `/edit — редактирование фото\n` +
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
      `/digest\\_all — полный дайджест из всех источников\n` +
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    
    // Полная очистка сессии (контекст для AI)
    const oldConvId = ctx.session.conversationId;
    ctx.session.messageHistory = [];
    ctx.session.conversationId = null; // Сбрасываем — ensureConversation создаст/загрузит при следующем сообщении
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingTodoTask = false;
    ctx.session.awaitingNoteContent = false;
    ctx.session.awaitingSearchQuery = false;

    try {
      // Если был старый диалог — очищаем его сообщения в БД (но сохраняем саму запись)
      if (oldConvId) {
        await conversationsRepo.clearMessages(oldConvId);
        telegramLogger.info({ userId, conversationId: oldConvId }, 'Conversation messages cleared in DB');
      }
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to clear conversation');
    }

    telegramLogger.info({ userId, hadConvId: !!oldConvId }, 'Chat history cleared by user');
    await ctx.reply('✅ История диалога очищена. Начнём сначала!');
  });

  // /edit
  bot.command('edit', async (ctx) => {
    await ctx.reply(
      `✏️ <b>Редактирование изображений</b>\n\n` +
      `<b>Способ 1:</b> Отправь фото с подписью-инструкцией\n` +
      `<i>Например: отправь фото и напиши «убери фон»</i>\n\n` +
      `<b>Способ 2:</b> Ответь (reply) на любое фото текстом или голосовым\n` +
      `<i>Например: свайпни на фото и напиши «сделай ярче»</i>\n\n` +
      `<b>Что можно:</b>\n` +
      `• убери/замени/размой фон\n` +
      `• добавь текст/объект\n` +
      `• измени цвета, сделай ярче/темнее\n` +
      `• стилизуй (в стиле аниме, масло...)\n` +
      `• убери объект, обрежь, поверни`,
      { parse_mode: 'HTML' }
    );
  });

  // /reminders
  bot.command('reminders', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
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
        `📋 *Активные напоминания (${reminders.length}):*\n\n${lines.join('\n\n')}\n\n_Для отмены: /remind\\_cancel номер_`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to list reminders');
      await ctx.reply('😔 Не удалось загрузить напоминания. Попробуй позже.');
    }
  });

  // /remind_cancel
  bot.command('remind_cancel', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();

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

      await ctx.replyWithPhoto(
        new InputFile(result.image, 'generated.png'),
        { caption: `🎨 ${prompt}\n⏱ ${timeSeconds}с | FLUX.1-schnell` }
      );

      telegramLogger.info({ userId, prompt, timeMs: result.generationTimeMs }, 'Image sent to user');
      analyticsRepo.log('message_received', 'telegram', {
        userId, event: 'image_generated', prompt, model: result.model, timeMs: result.generationTimeMs,
      }).catch(() => {});
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Не удалось создать изображение. Попробуй позже.';
      telegramLogger.error({ error, userId, prompt }, 'Image generation failed');
      await ctx.reply(`😔 ${errMsg}`);
    }
  });

  // /search
  bot.command('search', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    const query = ctx.message?.text?.replace(/^\/search\s*/i, '').trim();

    if (!query) {
      await ctx.reply('🔍 *Что найти в интернете?*', { parse_mode: 'Markdown' });
      ctx.session.awaitingSearchQuery = true;
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    const content = ctx.match?.trim();

    if (!content) {
      await ctx.reply('📌 *Что запомнить?*', { parse_mode: 'Markdown' });
      ctx.session.awaitingNoteContent = true;
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    try {
      const notes = await notesRepo.getByUser(userId);
      if (notes.length === 0) {
        await ctx.reply('📋 У тебя пока нет заметок.\n\nСоздай: /note текст');
        return;
      }

      const lines = notes.map((n, i) => {
        const date = new Date(n.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
        // Усекаем длинные заметки при отображении (макс. 150 символов)
        const preview = n.content.length > 150 ? n.content.slice(0, 150).trimEnd() + '…' : n.content;
        return `${i + 1}. ${escapeHtml(preview)}\n   <i>${date}</i>`;
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
          const lines = notes.map((n, i) => {
            const preview = n.content.length > 150 ? n.content.slice(0, 150).trimEnd() + '…' : n.content;
            return `${i + 1}. ${preview}`;
          });
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    const task = ctx.match?.trim();

    if (!task) {
      await ctx.reply('✅ *Какую задачу добавить?*', { parse_mode: 'Markdown' });
      ctx.session.awaitingTodoTask = true;
      return;
    }

    try {
      await todosRepo.create(userId, task);
      await ctx.reply(`✅ Задача добавлена!\n\n☐ <i>${escapeHtml(task)}</i>`, {
        parse_mode: 'HTML',
        reply_markup: todosListKeyboard(),
      });
    } catch (error: unknown) {
      const err = error as { message?: string };
      await ctx.reply(`😔 ${err.message || 'Не удалось добавить задачу.'}`);
    }
  });

  // /todos
  bot.command('todos', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
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
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    const indexStr = ctx.match?.trim();
    const index = parseInt(indexStr || '', 10);

    if (!indexStr || isNaN(index) || index < 1) {
      await ctx.reply('❌ Укажи номер задачи: `/done 1`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      const done = await todosRepo.markDone(userId, index);
      if (done) await ctx.reply(`🎉 Выполнено: <s>${escapeHtml(done.task)}</s>`, { parse_mode: 'HTML' });
      else await ctx.reply('❌ Задача с таким номером не найдена.');
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to complete todo');
      await ctx.reply('😔 Ошибка при обновлении задачи.');
    }
  });

  // ====== ДАЙДЖЕСТ ======

  // /digest
  bot.command('digest', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
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
            prefs.digest_city || ''
          );
        } catch (digestError) {
          telegramLogger.error({ error: digestError, userId }, 'Digest now failed');
          await ctx.reply('😔 Не удалось собрать дайджест. Попробуй позже.');
        }
        return;
      }

      // /digest город Москва
      if (arg?.startsWith('город') || arg?.startsWith('city')) {
        const city = arg.replace(/^(город|city)\s*/i, '').trim();
        if (!city) {
          await ctx.reply('Использование: `/digest город Москва`', { parse_mode: 'Markdown' });
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
        await ctx.reply(`🕐 Дайджест будет приходить в *${hour}:00*`, { parse_mode: 'Markdown' });
        return;
      }

      // /digest — показать статус
      const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
      const status = prefs.digest_enabled ? '✅ Включён' : '❌ Выключен';

      await ctx.reply(
        `☀️ *Утренний дайджест*\n\n` +
        `Статус: ${status}\n` +
        `Время: ${prefs.digest_hour}:00\n` +
        `Город: ${prefs.digest_city}\n\n` +
        `📰 Включает: погоду, новости, напоминания и задачи`,
        { parse_mode: 'Markdown', reply_markup: digestControlsKeyboard(prefs.digest_enabled) }
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Digest command failed');
      await ctx.reply('😔 Ошибка при работе с дайджестом.');
    }
  });

  // /digest_all
  bot.command('digest_all', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id;

    try {
      const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
      await ctx.reply('🧠 Готовлю полный дайджест через Appwrite-пайплайн... Это может занять до 1-2 минут.');
      await ctx.replyWithChatAction('typing');

      await sendHybridDigestNow(
        { api: ctx.api },
        userId,
        chatId,
        prefs.first_name || ctx.from?.first_name || null,
        prefs.digest_city || '',
        {
          forceRefresh: true,
          deliveryKind: 'manual',
        },
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Hybrid digest command failed');
      await ctx.reply('😔 Не удалось собрать полный дайджест через Appwrite-пайплайн. Попробуй позже.');
    }
  });

  // ====== ТЕЛЕФОНИЯ (LiraX) — доступ только авторизованным ======

  const TELEPHONY_DENIED_MSG =
    '🔒 <b>Доступ запрещён</b>\n\n' +
    'Команды телефонии доступны только авторизованным пользователям.\n' +
    'Обратитесь к администратору для получения доступа.';

  // /call — произвольная команда звонка
  bot.command('call', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();

    const allowed = await isTelephonyAllowed(userId);
    if (!allowed) {
      await ctx.reply(TELEPHONY_DENIED_MSG, { parse_mode: 'HTML' });
      return;
    }

    const input = ctx.match?.trim() || '';

    const cfg = await getLiraXConfig();
    const hasOperatorPhone = !!cfg.operatorPhone;

    if (!input) {
      const modeHint = hasOperatorPhone
        ? `Режим: <b>реальный номер</b> (${escapeHtml(cfg.operatorPhone)} → клиент)`
        : `⚠️ Задайте <b>Телефон оператора</b> в админке для звонков на реальные номера`;

      await ctx.reply(
        '📞 <b>Телефония Amina</b>\n\n' +
        '<b>Простой звонок:</b>\n' +
        '<code>/call +375291234567</code>\n\n' +
        '<b>Звонок с голосовым сообщением:</b>\n' +
        '<code>/call +375291234567 напомни о встрече завтра в 14:00</code>\n\n' +
        `${modeHint}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.replyWithChatAction('typing');

    const phoneMatch = input.match(/(\+?\d[\d\s\-()]{6,})/);
    const phone = phoneMatch?.[1]?.replace(/[\s\-()]/g, '') ?? null;
    const instruction = phoneMatch?.[0]
      ? input.replace(phoneMatch[0], '').trim()
      : input;

    if (!phone) {
      await ctx.reply(
        '❌ <b>Не удалось распознать номер телефона</b>\n\n' +
        'Пример: <code>/call +375291234567</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    telegramLogger.info({ userId, phone, instruction, hasOperatorPhone }, '[LiraX] call command');

    if (!instruction) {
      try {
        const result = await connectCall(phone);
        const modeLabel = result.mode === 'make2calls'
          ? `АТС звонит на ${escapeHtml(cfg.operatorPhone)}, затем соединит с абонентом.`
          : 'АТС звонит на SIP-оператора, затем соединит с абонентом.';

        await ctx.reply(
          `📞 <b>Звонок инициирован!</b>\n\n` +
          `📱 Номер: <code>${escapeHtml(phone)}</code>\n` +
          `🆔 ID: <code>${result.id}</code>\n\n` +
          modeLabel,
          { parse_mode: 'HTML' },
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Неизвестная ошибка';
        telegramLogger.error({ error, userId, phone }, '[LiraX] connectCall failed');
        await ctx.reply(
          `❌ <b>Ошибка звонка:</b>\n<code>${escapeHtml(msg)}</code>`,
          { parse_mode: 'HTML' },
        );
      }
      return;
    }

    try {
      const systemPrompt = `Ты — телефонный ассистент Amina. Пользователь хочет позвонить клиенту и дал инструкцию.
Проанализируй инструкцию и определи:
1. Нужно ли голосовое сообщение (TTS) клиенту при соединении?
2. Краткое описание задачи.

Номер клиента: ${phone}
Инструкция: ${instruction}

Ответь СТРОГО в JSON:
{
  "summary": "краткое описание задачи (1-2 предложения)",
  "speech_text": "текст голосового сообщения для клиента (на русском, без 'ru ' префикса), или null если просто соединить",
  "type": "simple" | "tts"
}`;

      const messages: AIMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: instruction },
      ];

      const aiResult = await aiService.chat(messages);
      let parsed: { summary: string; speech_text: string | null; type: string };
      try {
        const jsonMatch = aiResult.content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch?.[0] || aiResult.content);
      } catch {
        parsed = { summary: instruction, speech_text: null, type: 'simple' };
      }

      const speechText = parsed.type === 'tts' && parsed.speech_text
        ? parsed.speech_text
        : undefined;

      const result = await connectCall(phone, speechText);
      const modeLabel = result.mode === 'make2calls'
        ? `АТС звонит на ${escapeHtml(cfg.operatorPhone)}, затем соединит с абонентом.`
        : 'АТС звонит на SIP-оператора, затем соединит с абонентом.';

      const speechInfo = speechText
        ? `\n🔊 Голосовое: <i>${escapeHtml(speechText)}</i>`
        : '';

      await ctx.reply(
        `📞 <b>Звонок инициирован!</b>\n\n` +
        `📱 Номер: <code>${escapeHtml(phone)}</code>\n` +
        `📋 Задание: ${escapeHtml(parsed.summary)}${speechInfo}\n` +
        `🆔 ID: <code>${result.id}</code>\n\n` +
        modeLabel,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Неизвестная ошибка';
      telegramLogger.error({ error, userId, phone, instruction }, '[LiraX] smart call failed');
      await ctx.reply(
        `❌ <b>Ошибка звонка:</b>\n<code>${escapeHtml(msg)}</code>`,
        { parse_mode: 'HTML' },
      );
    }
  });

  const TELEPHONY_OWNER_DENIED_MSG =
    '🔒 <b>Только владелец может запускать AI-звонки</b>\n\n' +
    'Укажите свой Telegram ID в поле <code>lirax_owner_chat_id</code> в админке телефонии.';

  bot.command('callai', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();

    if (!(await isTelephonyOwner(userId))) {
      await ctx.reply(TELEPHONY_OWNER_DENIED_MSG, { parse_mode: 'HTML' });
      return;
    }

    const scenarios = (await getTelephonyAiScenarios()).filter((scenario) => scenario.enabled);
    const scenarioList = scenarios.length > 0
      ? scenarios
        .map((scenario) => `• <code>${escapeHtml(scenario.id)}</code> — ${escapeHtml(scenario.name)}`)
        .join('\n')
      : '• Нет включённых сценариев';
    const helpText =
      '📞 <b>AI-звонок</b>\n\n' +
      'Формат:\n' +
      '<code>/callai scenario_id | +375291234567 | задача для ИИ</code>\n\n' +
      'Формат с runtime override:\n' +
      '<code>/callai scenario_id | +375291234567 | задача | realtime</code>\n\n' +
      'Быстрый режим по умолчанию:\n' +
      '<code>/callai +375291234567 | напомни о встрече и попроси подтвердить время</code>\n\n' +
      'Доступные сценарии:\n' +
      `${scenarioList}`;

    if (scenarios.length === 0) {
      await ctx.reply(helpText, { parse_mode: 'HTML' });
      return;
    }

    const input = ctx.match?.trim() || '';
    if (!input) {
      await ctx.reply(helpText, { parse_mode: 'HTML' });
      return;
    }

    const parts = input.split('|').map((part) => part.trim()).filter(Boolean);
    const looksLikePhone = (value: string): boolean => /(\+?\d[\d\s\-()]{6,})/.test(value);
    const parseRuntimeOverride = (value: string | undefined): TelephonyRuntimeMode | null => {
      switch ((value ?? '').trim().toLowerCase()) {
        case 'scripted':
          return 'scripted';
        case 'shadow':
          return 'shadow';
        case 'hybrid':
          return 'hybrid';
        case 'realtime':
          return 'realtime';
        default:
          return null;
      }
    };

    let scenarioId = scenarios[0]!.id;
    let phoneRaw = '';
    let task = '';
    let runtimeOverride: TelephonyRuntimeMode | null = null;

    const explicitRuntime = parseRuntimeOverride(parts.at(-1));
    const effectiveParts = explicitRuntime ? parts.slice(0, -1) : parts;
    runtimeOverride = explicitRuntime;

    if (effectiveParts.length >= 2 && looksLikePhone(effectiveParts[0] ?? '')) {
      phoneRaw = effectiveParts[0] ?? '';
      task = effectiveParts.slice(1).join(' | ');
    } else if (effectiveParts.length >= 3) {
      scenarioId = effectiveParts[0] ?? scenarioId;
      phoneRaw = effectiveParts[1] ?? '';
      task = effectiveParts.slice(2).join(' | ');
    } else {
      await ctx.reply(helpText, { parse_mode: 'HTML' });
      return;
    }

    if (!scenarios.some((scenario) => scenario.id === scenarioId)) {
      await ctx.reply(
        `❌ <b>Сценарий не найден:</b> <code>${escapeHtml(scenarioId)}</code>\n\n${helpText}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const phoneMatch = phoneRaw.match(/(\+?\d[\d\s\-()]{6,})/);
    const phone = phoneMatch?.[1]?.replace(/[\s\-()]/g, '') ?? '';
    if (!phone) {
      await ctx.reply('❌ <b>Не удалось распознать номер телефона</b>', { parse_mode: 'HTML' });
      return;
    }

    if (!task.trim()) {
      await ctx.reply('❌ <b>Опиши задачу для звонка после номера</b>', { parse_mode: 'HTML' });
      return;
    }

    await ctx.replyWithChatAction('typing');

    try {
      const { scenario, plan, result } = await startTelephonyAiCall({
        scenarioId,
        phone,
        task,
        ownerTelegramId: userId,
        initiatedBy: ctx.from.first_name || userId,
        runtimeOverride: runtimeOverride ?? undefined,
      });

      const details = plan.callMode === 'speech'
        ? `🔊 Озвучка: <i>${escapeHtml(plan.speechText ?? '—')}</i>`
        : `🗣 Приветствие: <i>${escapeHtml(plan.helloText ?? '—')}</i>\n❓ Вопрос: <i>${escapeHtml(plan.askText ?? '—')}</i>`;

      await ctx.reply(
        `📞 <b>AI-звонок запущен</b>\n\n` +
        `🎭 Сценарий: <b>${escapeHtml(scenario.name)}</b>\n` +
        `📱 Номер: <code>${escapeHtml(phone)}</code>\n` +
        `📋 План: ${escapeHtml(plan.summary)}\n` +
        `${details}\n` +
        `🆔 ID: <code>${escapeHtml(result.id || 'pending')}</code>\n` +
        `⚙️ Режим: <code>${escapeHtml(result.mode)}</code>\n` +
        `🎚 Override: <code>${escapeHtml(runtimeOverride ?? 'scenario-default')}</code>\n\n` +
        `После записи разговора я пришлю тебе расшифровку и итог в Telegram.`,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Неизвестная ошибка';
      telegramLogger.error({ error, userId, input }, '[LiraX] AI call failed');
      await ctx.reply(`❌ <b>Не удалось запустить AI-звонок:</b>\n<code>${escapeHtml(msg)}</code>`, {
        parse_mode: 'HTML',
      });
    }
  });

  // /calls — история звонков за сегодня (только авторизованные)
  bot.command('calls', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();

    const allowed = await isTelephonyAllowed(userId);
    if (!allowed) {
      await ctx.reply(TELEPHONY_DENIED_MSG, { parse_mode: 'HTML' });
      return;
    }

    await ctx.replyWithChatAction('typing');
    telegramLogger.info({ userId }, '[LiraX] call history requested');

    try {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);

      const fmt = (d: Date): string =>
        d.toISOString().replace('T', ' ').slice(0, 19);

      const calls = await getCallHistory(fmt(start), fmt(now));

      if (calls.length === 0) {
        await ctx.reply('📋 Звонков сегодня не было.');
        return;
      }

      const MAX_DISPLAYED = 20;
      const lines = calls.slice(0, MAX_DISPLAYED).map((c, i) => {
        const typeLabel = c.type === '1' ? '📞 Исх' : '📲 Вх';
        const dur = c.duration !== '0' ? `${c.duration}с` : '—';
        const time = c.start.slice(11, 16);
        return `${i + 1}. ${typeLabel} <code>${c.ani || c.dnis}</code> ${time} (${dur})`;
      });

      const header = calls.length > MAX_DISPLAYED
        ? ` (первые ${MAX_DISPLAYED} из ${calls.length})`
        : '';

      await ctx.reply(
        `📋 <b>Звонки сегодня${header}:</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Неизвестная ошибка';
      telegramLogger.error({ error, userId }, '[LiraX] call history failed');
      await ctx.reply(
        `❌ <b>Ошибка получения истории:</b>\n<code>${escapeHtml(msg)}</code>`,
        { parse_mode: 'HTML' },
      );
    }
  });

  // /test_parser — проверить парсинг новостей (только для разработки/отладки)
  bot.command('test_parser', async (ctx) => {
    if (!ctx.from?.id) return;
    const userId = ctx.from.id.toString();
    
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
