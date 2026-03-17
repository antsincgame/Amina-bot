import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { remindersRepo } from '../../reminders/reminders-repo.js';
import { notesRepo } from '../../features/notes-repo.js';
import { todosRepo } from '../../features/todos-repo.js';
import { userPrefsRepo } from '../../features/user-prefs-repo.js';
import { sendDigestNow } from '../../features/digest-scheduler.js';
import { escapeHtml } from '../format.js';
import { buildMainMenu, todoDoneKeyboard, digestToggleKeyboard } from '../keyboards.js';
import { MAX_NOTE_PREVIEW_LENGTH } from './history-utils.js';

export const clearAwaitingFlags = (ctx: BotContext): void => {
  ctx.session.awaitingImagePrompt = false;
  ctx.session.awaitingTodoTask = false;
  ctx.session.awaitingNoteContent = false;
  ctx.session.awaitingSearchQuery = false;
};

export const buildReplyButtonHandlers = (ctx: BotContext, userId: string): Record<string, () => Promise<void>> => ({
  '🌐 Поиск': async () => {
    clearAwaitingFlags(ctx);
    await ctx.reply('🔍 *Что найти в интернете?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingSearchQuery = true;
  },
  '🎨 Картинка': async () => {
    clearAwaitingFlags(ctx);
    await ctx.reply('🎨 *Что нарисовать?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingImagePrompt = true;
  },
  '📌 Заметки': async () => {
    try {
      const notes = await notesRepo.getByUser(userId);
      if (notes.length === 0) {
        clearAwaitingFlags(ctx);
        await ctx.reply('📋 *Что запомнить?*', { parse_mode: 'Markdown' });
        ctx.session.awaitingNoteContent = true;
      } else {
        const lines = notes.map((n, i) => {
          const preview = n.content.length > MAX_NOTE_PREVIEW_LENGTH ? n.content.slice(0, MAX_NOTE_PREVIEW_LENGTH).trimEnd() + '…' : n.content;
          return `${i + 1}. ${escapeHtml(preview)}`;
        });
        const keyboard = new InlineKeyboard().text('📌 Добавить', 'menu_note_help');
        await ctx.reply(
          `📋 <b>Заметки (${notes.length}):</b>\n\n${lines.join('\n')}\n\n<i>Удалить: /note_delete номер</i>`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load notes via button');
      await ctx.reply('😔 Не удалось загрузить заметки.');
    }
  },
  '✅ Задачи': async () => {
    try {
      const todos = await todosRepo.getActive(userId);
      if (todos.length === 0) {
        clearAwaitingFlags(ctx);
        await ctx.reply('✅ *Какую задачу добавить?*', { parse_mode: 'Markdown' });
        ctx.session.awaitingTodoTask = true;
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
      telegramLogger.warn({ error: err, userId }, 'Failed to load todos via button');
      await ctx.reply('😔 Не удалось загрузить задачи.');
    }
  },
  '⏰ Напоминания': async () => {
    try {
      const reminders = await remindersRepo.getByUser(userId);
      if (reminders.length === 0) {
        await ctx.reply('⏰ Нет активных напоминаний.\n\nНапиши: _напомни через 2 часа ..._', { parse_mode: 'Markdown' });
      } else {
        const lines = reminders.map((r, i) => {
          const dt = new Date(r.scheduled_at ?? '');
          const d = Number.isNaN(dt.getTime())
            ? '—'
            : dt.toLocaleString('ru-RU', { timeZone: config.server.timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          const task = typeof r.task === 'string' ? r.task : String(r.task ?? '—');
          return `${i + 1}. ${escapeHtml(task)} — ⏰ ${d}`;
        });
        await ctx.reply(`⏰ <b>Напоминания (${reminders.length}):</b>\n\n${lines.join('\n')}\n\n<i>/remind_cancel номер</i>`, { parse_mode: 'HTML' });
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load reminders via button');
      await ctx.reply('😔 Не удалось загрузить напоминания.');
    }
  },
  '☀️ Дайджест': async () => {
    try {
      const prefs = await userPrefsRepo.get(userId);
      const status = prefs?.digest_enabled ? '✅ Включён' : '❌ Выключен';
      await ctx.reply(
        `☀️ <b>Дайджест:</b> ${status}\n\nВремя: ${prefs?.digest_hour ?? 10}:00 | Город: ${escapeHtml(prefs?.digest_city ?? '')}`,
        { parse_mode: 'HTML', reply_markup: digestToggleKeyboard(prefs?.digest_enabled ?? false) }
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load digest prefs');
      await ctx.reply('😔 Не удалось загрузить настройки дайджеста.');
    }
  },
  '📰 Дайджест сейчас': async () => {
    const chatId = ctx.chat?.id ?? 0;
    const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
    await ctx.reply('☀️ Собираю дайджест... Это может занять 15-30 секунд.');
    await ctx.replyWithChatAction('typing');
    try {
      await sendDigestNow(
        { api: ctx.api }, userId, chatId,
        prefs.first_name || ctx.from?.first_name || null,
        prefs.digest_city || ''
      );
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Digest now failed via button');
      await ctx.reply('😔 Не удалось собрать дайджест. Попробуй позже.');
    }
  },
  '📋 Меню': async () => {
    await ctx.reply('🎛 *Меню Amina* — выбери действие:', { parse_mode: 'Markdown', reply_markup: buildMainMenu() });
  },
});
