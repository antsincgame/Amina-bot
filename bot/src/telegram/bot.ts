import { Bot, Context, session, SessionFlavor, InputFile, InlineKeyboard } from 'grammy';
import { config } from '../config/index.js';
import { telegramLogger } from '../config/logger.js';
import { aiService } from '../ai/openrouter.js';
import { processImageWithLLM, transcribeAudio } from '../ai/multimodal.js';
import { getSearchContext, enhanceResponseIfNeeded, searchAndFormat } from '../ai/websearch.js';
import { conversationsRepo, analyticsRepo } from '../db/supabase.js';
import { checkTelegramRateLimit } from '../utils/rate-limiter.js';
import { getErrorCode } from '../utils/error-handler.js';
import { 
  userProfileRepo, 
  userMemoryRepo, 
  userLogsRepo, 
  memoryExtractor,
  memoryContextBuilder,
  type TelegramUserInfo 
} from '../memory/user-memory.js';
import { detectReminderIntent, extractReminder } from '../reminders/reminder-parser.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { detectImageGenIntent, extractImagePrompt, generateImage } from '../ai/image-gen.js';
import { notesRepo } from '../features/notes-repo.js';
import { todosRepo } from '../features/todos-repo.js';
import { userPrefsRepo } from '../features/user-prefs-repo.js';
import { textToSpeech, detectLanguage } from '../features/tts.js';
import { sendDigestNow } from '../features/digest-scheduler.js';
import type { Message, AIMessage } from '../../../shared/types/index.js';

// --------------------------------------------
// Session Types
// --------------------------------------------

interface SessionData {
  conversationId: string | null;
  messageHistory: AIMessage[];
}

type BotContext = Context & SessionFlavor<SessionData>;

// --------------------------------------------
// Constants
// --------------------------------------------

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4096; // Telegram limit

// --------------------------------------------
// Create Bot Instance
// --------------------------------------------

export const createBot = (): Bot<BotContext> => {
  const bot = new Bot<BotContext>(config.telegram.token);

  // Session middleware
  bot.use(
    session({
      initial: (): SessionData => ({
        conversationId: null,
        messageHistory: [],
      }),
    })
  );

  // Error handler
  bot.catch((err) => {
    telegramLogger.error({ error: err.error, ctx: err.ctx?.update }, 'Bot error');
  });

  // Commands
  setupCommands(bot);

  // Message handlers
  setupMessageHandlers(bot);

  telegramLogger.info('Telegram bot configured');
  return bot;
};

// --------------------------------------------
// Command Handlers
// --------------------------------------------

const setupCommands = (bot: Bot<BotContext>): void => {
  // /start - Welcome message
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    
    telegramLogger.info({ userId }, 'User started bot');
    
    await analyticsRepo.log('message_received', 'telegram', {
      command: 'start',
      userId,
    });

    // Сохраняем/обновляем настройки пользователя
    try {
      await userPrefsRepo.getOrCreate(userId, ctx.chat.id, ctx.from?.first_name);
    } catch { /* не критично */ }

    const name = ctx.from?.first_name ? `, ${ctx.from.first_name}` : '';

    await ctx.reply(
      `👋 Привет${name}! Я Amina — твой персональный AI-ассистент.

Вот что я умею:

💬 **Текст** — задай любой вопрос
🎤 **Голос** — отправь голосовое, я пойму
📷 **Фото** — отправь картинку, я опишу
🌐 **Интернет** — ищу актуальную информацию
🎨 **Картинки** — «нарисуй...» или /imagine
⏰ **Напоминания** — «напомни через час...»
📌 **Заметки** — «запомни ...» или /note
✅ **Задачи** — /todo + /done
☀️ **Дайджест** — утренняя сводка /digest
🔊 **Голос** — «скажи голосом...»

📋 /help — полная справка со всеми командами

Просто напиши или скажи — я слушаю! 🎧`,
      { parse_mode: 'Markdown' }
    );
  });

  // /help - Help message
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 **Amina — Полная справка**

**📋 Все команды:**
/imagine \\_описание\\_ — сгенерировать картинку
/search \\_запрос\\_ — поиск в интернете
/note \\_текст\\_ — сохранить заметку
/notes — список заметок
/note\\_delete \\_номер\\_ — удалить заметку
/todo \\_текст\\_ — добавить задачу
/todos — список задач
/done \\_номер\\_ — отметить задачу выполненной
/reminders — напоминания
/remind\\_cancel \\_номер\\_ — отменить напоминание
/digest — утренний дайджест
/clear — очистить историю
/help — эта справка

**💡 Быстрые действия (без команд):**
• _«Нарисуй кота в космосе»_ — генерация картинки
• _«Напомни через час позвонить»_ — напоминание
• _«Запомни: пароль от WiFi 12345»_ — заметка
• _«Скажи голосом привет мир»_ — озвучка
• _«Курс доллара»_ — автопоиск в интернете
• Отправь фото — опишу что на нём
• Отправь голосовое — пойму и отвечу`,
      { parse_mode: 'Markdown' }
    );
  });

  // /clear - Clear conversation history
  bot.command('clear', async (ctx) => {
    ctx.session.messageHistory = [];
    
    if (ctx.session.conversationId) {
      try {
        await conversationsRepo.clearMessages(ctx.session.conversationId);
      } catch (error) {
        telegramLogger.error({ error }, 'Failed to clear messages in DB');
      }
    }
    
    telegramLogger.info({ userId: ctx.from?.id }, 'Conversation cleared');
    
    await ctx.reply('🧹 История диалога очищена. Начнём сначала!');
  });

  // /reminders - Список активных напоминаний
  bot.command('reminders', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';

    try {
      const reminders = await remindersRepo.getByUser(userId);

      if (reminders.length === 0) {
        await ctx.reply('📋 У тебя нет активных напоминаний.\n\nНапиши мне что-то вроде:\n«Напомни через 2 часа позвонить маме»');
        return;
      }

      const lines = reminders.map((r, i) => {
        const date = new Date(r.scheduled_at);
        const dateStr = date.toLocaleString('ru-RU', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
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

  // /remind_cancel - Отмена напоминания по номеру
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

  // /imagine - Генерация изображения
  bot.command('imagine', async (ctx) => {
    const prompt = ctx.match?.trim();
    const userId = ctx.from?.id.toString() ?? 'unknown';

    if (!prompt) {
      await ctx.reply(
        '🎨 Опиши, что нарисовать!\n\n' +
        'Примеры:\n' +
        '• `/imagine кот-астронавт в космосе`\n' +
        '• `/imagine закат над горами в стиле Ван Гога`\n' +
        '• `/imagine futuristic city at night`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    telegramLogger.info({ userId, prompt }, 'Image generation requested');
    await ctx.reply('🎨 Генерирую изображение... Это может занять 10-30 секунд.');

    try {
      const result = await generateImage(prompt);
      const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);

      // Экранируем спецсимволы Markdown в промпте
      const safePrompt = escapeMarkdown(prompt);

      await ctx.replyWithPhoto(
        new InputFile(result.image, 'generated.png'),
        {
          caption: `🎨 ${safePrompt}\n⏱ ${timeSeconds}с | FLUX.1-schnell`,
        }
      );

      telegramLogger.info(
        { userId, prompt, timeMs: result.generationTimeMs },
        'Image sent to user'
      );

      // Аналитика
      try {
        await analyticsRepo.log('message_received', 'telegram', {
          userId,
          event: 'image_generated',
          prompt,
          model: result.model,
          timeMs: result.generationTimeMs,
        });
      } catch {
        // Аналитика не критична
      }
    } catch (error: unknown) {
      const err = error as { message?: string; code?: string };
      telegramLogger.error({ error, userId, prompt }, 'Image generation failed');
      await ctx.reply(`😔 ${err.message || 'Не удалось создать изображение. Попробуй позже.'}`);
    }
  });

  // /search - Explicit web search (показывает источники)
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
      
      if (errorCode === 'PERPLEXITY_NOT_CONFIGURED') {
        errorMessage = '⚙️ Поиск не настроен. Обратитесь к администратору.';
      } else if (errorCode === 'PERPLEXITY_RATE_LIMIT') {
        errorMessage = '⏳ Слишком много запросов. Подожди минуту.';
      }

      await ctx.reply(errorMessage);
    }
  });

  // ====== ЗАМЕТКИ ======

  // /note - Создать заметку
  bot.command('note', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const content = ctx.match?.trim();

    if (!content) {
      await ctx.reply(
        '📌 Чтобы сохранить заметку:\n\n`/note Текст заметки`\n\nПример: `/note Купить молоко и хлеб`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    try {
      const note = await notesRepo.create(userId, content);
      const keyboard = new InlineKeyboard()
        .text('📋 Все заметки', 'notes_list');

      await ctx.reply(`📌 Заметка сохранена!\n\n_${content}_`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      telegramLogger.info({ userId, noteId: note.id }, 'Note created');
    } catch (error: unknown) {
      const err = error as { message?: string };
      await ctx.reply(`😔 ${err.message || 'Не удалось сохранить заметку.'}`);
    }
  });

  // /notes - Список заметок
  bot.command('notes', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';

    try {
      const notes = await notesRepo.getByUser(userId);

      if (notes.length === 0) {
        await ctx.reply('📋 У тебя пока нет заметок.\n\nСоздай: `/note текст`', {
          parse_mode: 'Markdown',
        });
        return;
      }

      const lines = notes.map((n, i) => {
        const date = new Date(n.created_at).toLocaleDateString('ru-RU', {
          day: 'numeric',
          month: 'short',
        });
        return `${i + 1}. ${n.content}\n   _${date}_`;
      });

      await ctx.reply(
        `📋 *Заметки (${notes.length}):*\n\n${lines.join('\n\n')}\n\n_Удалить: /note\\_delete номер_`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      await ctx.reply('😔 Не удалось загрузить заметки.');
    }
  });

  // /note_delete - Удалить заметку
  bot.command('note_delete', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const indexStr = ctx.match?.trim();
    const index = parseInt(indexStr || '', 10);

    if (!indexStr || isNaN(index) || index < 1) {
      await ctx.reply('❌ Укажи номер заметки: `/note_delete 1`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      const deleted = await notesRepo.deleteByIndex(userId, index);
      if (deleted) {
        await ctx.reply(`🗑 Заметка удалена: "${deleted.content}"`);
      } else {
        await ctx.reply('❌ Заметка с таким номером не найдена.');
      }
    } catch {
      await ctx.reply('😔 Ошибка при удалении заметки.');
    }
  });

  // ====== TO-DO ======

  // /todo - Создать задачу
  bot.command('todo', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const task = ctx.match?.trim();

    if (!task) {
      await ctx.reply(
        '✅ Чтобы добавить задачу:\n\n`/todo Текст задачи`\n\nПример: `/todo Сделать отчёт`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    try {
      await todosRepo.create(userId, task);
      const keyboard = new InlineKeyboard()
        .text('📋 Все задачи', 'todos_list');

      await ctx.reply(`✅ Задача добавлена!\n\n☐ _${task}_`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (error: unknown) {
      const err = error as { message?: string };
      await ctx.reply(`😔 ${err.message || 'Не удалось добавить задачу.'}`);
    }
  });

  // /todos - Список задач
  bot.command('todos', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';

    try {
      const todos = await todosRepo.getActive(userId);

      if (todos.length === 0) {
        await ctx.reply('🎉 Все задачи выполнены!\n\nДобавь: `/todo текст`', {
          parse_mode: 'Markdown',
        });
        return;
      }

      const lines = todos.map((t, i) => `${i + 1}. ☐ ${t.task}`);

      const keyboard = new InlineKeyboard();
      const MAX_BUTTONS = Math.min(todos.length, 5);
      for (let i = 1; i <= MAX_BUTTONS; i++) {
        keyboard.text(`✅ ${i}`, `todo_done_${i}`);
      }

      await ctx.reply(
        `📋 *Задачи (${todos.length}):*\n\n${lines.join('\n')}\n\n_Нажми кнопку или: /done номер_`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } catch {
      await ctx.reply('😔 Не удалось загрузить задачи.');
    }
  });

  // /done - Отметить задачу выполненной
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
      if (done) {
        await ctx.reply(`🎉 Выполнено: ~~${done.task}~~`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('❌ Задача с таким номером не найдена.');
      }
    } catch {
      await ctx.reply('😔 Ошибка при обновлении задачи.');
    }
  });

  // ====== ДАЙДЖЕСТ ======

  // /digest - Управление утренним дайджестом
  bot.command('digest', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const arg = ctx.match?.trim().toLowerCase();

    try {
      // /digest now — запросить дайджест прямо сейчас
      if (arg === 'now' || arg === 'сейчас') {
        const prefs = await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
        await ctx.reply('☀️ Собираю дайджест... Это может занять 15-30 секунд.');
        await ctx.replyWithChatAction('typing');
        
        try {
          await sendDigestNow(
            { api: ctx.api },
            userId,
            chatId,
            prefs.first_name || ctx.from?.first_name || null,
            prefs.digest_city || 'Гродно'
          );
        } catch (digestError) {
          telegramLogger.error({ error: digestError, userId }, 'On-demand digest failed');
          await ctx.reply('😔 Не удалось собрать дайджест. Попробуй позже.');
        }
        return;
      }

      if (arg === 'on' || arg === 'вкл') {
        await userPrefsRepo.toggleDigest(userId, chatId, true);
        await ctx.reply(
          '☀️ Утренний дайджест *включён*!\n\n' +
          'Каждое утро в 10:00 (МСК) я пришлю:\n' +
          '🌤 Погоду\n📰 Новости твоего города\n🌍 Мировые новости\n⏰ Напоминания\n📝 Задачи\n\n' +
          'Всё это обработаю с эмоциями и комментариями!\n\n' +
          'Настройки:\n' +
          '`/digest off` — выключить\n' +
          '`/digest now` — получить прямо сейчас\n' +
          '`/digest 7` — изменить час (0-23)\n' +
          '`/digest город Минск` — город для новостей',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (arg === 'off' || arg === 'выкл') {
        await userPrefsRepo.toggleDigest(userId, chatId, false);
        await ctx.reply('🌙 Утренний дайджест *выключен*.', { parse_mode: 'Markdown' });
        return;
      }

      // Изменение часа
      const hourMatch = arg?.match(/^(\d{1,2})$/);
      if (hourMatch) {
        const hour = parseInt(hourMatch[1], 10);
        if (hour < 0 || hour > 23) {
          await ctx.reply('❌ Час должен быть от 0 до 23.');
          return;
        }
        await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
        await userPrefsRepo.update(userId, { digest_hour: hour });
        await ctx.reply(`⏰ Дайджест будет приходить в *${hour}:00* МСК.`, { parse_mode: 'Markdown' });
        return;
      }

      // Изменение города
      const cityMatch = arg?.match(/^город\s+(.+)$/i);
      if (cityMatch) {
        const city = cityMatch[1].trim();
        await userPrefsRepo.getOrCreate(userId, chatId, ctx.from?.first_name);
        await userPrefsRepo.update(userId, { digest_city: city });
        await ctx.reply(`🏙 Город для погоды: *${city}*`, { parse_mode: 'Markdown' });
        return;
      }

      // Показать текущие настройки
      const prefs = await userPrefsRepo.get(userId);
      const status = prefs?.digest_enabled ? '✅ Включён' : '❌ Выключен';
      const hour = prefs?.digest_hour ?? 10;
      const city = prefs?.digest_city ?? 'Гродно';

      const keyboard = new InlineKeyboard()
        .text(prefs?.digest_enabled ? '🔕 Выключить' : '🔔 Включить', 'digest_toggle');

      await ctx.reply(
        `☀️ *Утренний дайджест*\n\n` +
        `Статус: ${status}\n` +
        `Время: ${hour}:00 МСК\n` +
        `Город: ${city}\n\n` +
        `Настройки:\n` +
        '`/digest on` — включить\n' +
        '`/digest off` — выключить\n' +
        '`/digest now` — получить прямо сейчас\n' +
        '`/digest 10` — час отправки\n' +
        '`/digest город Минск` — город',
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } catch {
      await ctx.reply('😔 Ошибка настройки дайджеста.');
    }
  });

  // /voice - Включить/выключить голосовые ответы (сохраняем в settings)
  bot.command('voice', async (ctx) => {
    await ctx.reply(
      '🔊 *Голосовые ответы*\n\n' +
      'Я могу отвечать голосовым сообщением.\n' +
      'Просто напиши: *«скажи голосом ...»* или *«озвучь ...»*\n\n' +
      'Примеры:\n' +
      '• «Скажи голосом привет мир»\n' +
      '• «Озвучь стихотворение Пушкина»',
      { parse_mode: 'Markdown' }
    );
  });

  // ====== CALLBACK QUERIES (инлайн-кнопки) ======

  bot.callbackQuery('notes_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const notes = await notesRepo.getByUser(userId);

    if (notes.length === 0) {
      await ctx.editMessageText('📋 У тебя пока нет заметок.');
      return;
    }

    const lines = notes.map((n, i) => `${i + 1}. ${n.content}`);
    await ctx.editMessageText(
      `📋 *Заметки (${notes.length}):*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.callbackQuery('todos_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const todos = await todosRepo.getActive(userId);

    if (todos.length === 0) {
      await ctx.editMessageText('🎉 Все задачи выполнены!');
      return;
    }

    const lines = todos.map((t, i) => `${i + 1}. ☐ ${t.task}`);
    const keyboard = new InlineKeyboard();
    const MAX_BUTTONS = Math.min(todos.length, 5);
    for (let i = 1; i <= MAX_BUTTONS; i++) {
      keyboard.text(`✅ ${i}`, `todo_done_${i}`);
    }

    await ctx.editMessageText(
      `📋 *Задачи (${todos.length}):*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  });

  // Callback для кнопок "✅ 1", "✅ 2" и т.д.
  bot.callbackQuery(/^todo_done_(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const index = parseInt(ctx.match[1], 10);

    try {
      const done = await todosRepo.markDone(userId, index);
      if (done) {
        await ctx.answerCallbackQuery({ text: `✅ ${done.task}` });

        // Обновить список
        const remaining = await todosRepo.getActive(userId);
        if (remaining.length === 0) {
          await ctx.editMessageText('🎉 Все задачи выполнены!');
        } else {
          const lines = remaining.map((t, i) => `${i + 1}. ☐ ${t.task}`);
          const keyboard = new InlineKeyboard();
          const maxBtn = Math.min(remaining.length, 5);
          for (let i = 1; i <= maxBtn; i++) {
            keyboard.text(`✅ ${i}`, `todo_done_${i}`);
          }
          await ctx.editMessageText(
            `📋 *Задачи (${remaining.length}):*\n\n${lines.join('\n')}`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
          );
        }
      } else {
        await ctx.answerCallbackQuery({ text: '❌ Задача не найдена' });
      }
    } catch {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  });

  // Callback для дайджеста
  bot.callbackQuery('digest_toggle', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat?.id ?? 0;

    try {
      const prefs = await userPrefsRepo.get(userId);
      const newState = !(prefs?.digest_enabled ?? false);
      await userPrefsRepo.toggleDigest(userId, chatId, newState);

      await ctx.answerCallbackQuery({
        text: newState ? '✅ Дайджест включён' : '❌ Дайджест выключен',
      });

      const keyboard = new InlineKeyboard()
        .text(newState ? '🔕 Выключить' : '🔔 Включить', 'digest_toggle');

      await ctx.editMessageText(
        `☀️ *Утренний дайджест*\n\nСтатус: ${newState ? '✅ Включён' : '❌ Выключен'}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } catch {
      await ctx.answerCallbackQuery({ text: '❌ Ошибка' });
    }
  });

  // Callback: сохранить последний ответ в заметки
  bot.callbackQuery('save_to_notes', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const messageText = ctx.callbackQuery.message?.text;

    if (!messageText) {
      await ctx.answerCallbackQuery({ text: '❌ Нечего сохранять' });
      return;
    }

    try {
      // Берём первые 500 символов ответа
      const content = messageText.slice(0, 500);
      await notesRepo.create(userId, content);
      await ctx.answerCallbackQuery({ text: '📌 Сохранено в заметки!' });
    } catch {
      await ctx.answerCallbackQuery({ text: '❌ Не удалось сохранить' });
    }
  });

  // Callback: озвучить ответ
  bot.callbackQuery('read_aloud', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
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
    } catch {
      await ctx.reply('😔 Ошибка генерации голоса.');
    }
  });
};

// --------------------------------------------
// Message Handlers
// --------------------------------------------

const setupMessageHandlers = (bot: Bot<BotContext>): void => {
  // Text messages
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const userMessage = ctx.message.text;
    const startTime = Date.now();

    // Telegram user info for profile
    const telegramInfo: TelegramUserInfo = {
      id: ctx.from?.id ?? 0,
      username: ctx.from?.username,
      first_name: ctx.from?.first_name,
      last_name: ctx.from?.last_name,
      language_code: ctx.from?.language_code,
    };

    telegramLogger.debug({ userId, chatId, messageLength: userMessage.length }, 'Text message received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      telegramLogger.warn({ userId }, 'Rate limit exceeded for Telegram user');
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений. Подожди немного.');
      return;
    }

    // Log analytics (don't await - fire and forget)
    analyticsRepo.log('message_received', 'telegram', {
      userId,
      chatId,
      messageLength: userMessage.length,
    }).catch(() => {});

    // Log user message (don't await - fire and forget)
    userLogsRepo.add(userId, 'message', userMessage, {
      chatId,
      messageLength: userMessage.length,
    }).catch(() => {});

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // === Проверка на напоминание (до основного AI flow) ===
      if (detectReminderIntent(userMessage)) {
        try {
          const extracted = await extractReminder(userMessage, new Date());
          if (extracted) {
            await remindersRepo.create(userId, chatId, extracted.task, extracted.scheduled_at);

            // Сохраняем в conversation history для контекста
            if (!ctx.session.conversationId) {
              const conversation = await conversationsRepo.getOrCreate(
                userId,
                'telegram',
                { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
              );
              ctx.session.conversationId = conversation.id;
            }

            const userMsg: Message = {
              role: 'user',
              content: userMessage,
              timestamp: new Date().toISOString(),
            };
            const assistantMsg: Message = {
              role: 'assistant',
              content: extracted.reply,
              timestamp: new Date().toISOString(),
            };
            await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
            await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

            // Обновляем session history
            ctx.session.messageHistory.push(
              { role: 'user', content: userMessage },
              { role: 'assistant', content: extracted.reply }
            );

            await ctx.reply(extracted.reply);
            telegramLogger.info({ userId, task: extracted.task, scheduledAt: extracted.scheduled_at }, 'Reminder created');
            return;
          }
          // Если AI не смог распарсить — говорим пользователю
          telegramLogger.info({ userId }, 'Reminder detected but AI could not parse details');
          await ctx.reply('⏰ Похоже, ты хочешь поставить напоминание, но я не смогла разобрать детали.\n\nПопробуй написать чётче, например:\n«Напомни через 2 часа позвонить маме»');
          return;
        } catch (reminderError) {
          telegramLogger.warn({ error: reminderError, userId }, 'Reminder extraction failed');
          // ВАЖНО: НЕ продолжаем в обычный AI flow — иначе LLM ответит
          // "конечно, напомню" но реально напоминание НЕ будет создано
          await ctx.reply('⚠️ Не удалось создать напоминание — AI временно недоступен.\n\nПопробуй ещё раз через минуту.');
          return;
        }
      }

      // === Автодетекция генерации изображения ("нарисуй...", "сгенерируй...") ===
      if (detectImageGenIntent(userMessage)) {
        const imgPrompt = extractImagePrompt(userMessage);
        if (imgPrompt) {
          telegramLogger.info({ userId, prompt: imgPrompt }, 'Image gen auto-detected from text');
          await ctx.replyWithChatAction('upload_photo');

          try {
            const result = await generateImage(imgPrompt);
            const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);
            const cleanPrompt = imgPrompt.replace(/, high quality.*$/, '');
            const safePrompt = escapeMarkdown(cleanPrompt);

            await ctx.replyWithPhoto(
              new InputFile(result.image, 'generated.png'),
              {
                caption: `🎨 ${safePrompt}\n⏱ ${timeSeconds}с | FLUX.1-schnell`,
              }
            );

            try {
              await analyticsRepo.log('message_received', 'telegram', {
                userId,
                event: 'image_generated',
                prompt: imgPrompt,
                model: result.model,
                timeMs: result.generationTimeMs,
              });
            } catch {
              // Аналитика не критична
            }
            return;
          } catch (error: unknown) {
            const err = error as { message?: string; code?: string };
            telegramLogger.error({ error, userId }, 'Auto image gen failed');
            await ctx.reply(`😔 ${err.message || 'Не удалось создать изображение.'}`);
            return;
          }
        }
      }

      // === Автодетекция TTS: "скажи голосом...", "озвучь..." ===
      const ttsMatch = userMessage.match(/^(скажи голосом|озвучь|произнеси|read aloud)\s+(.+)/i);
      if (ttsMatch) {
        const ttsText = ttsMatch[2].trim();
        if (ttsText) {
          await ctx.replyWithChatAction('record_voice');
          try {
            const lang = detectLanguage(ttsText);
            const audio = await textToSpeech(ttsText, lang);
            if (audio) {
              await ctx.replyWithVoice(new InputFile(audio, 'voice.mp3'));
            } else {
              await ctx.reply('😔 Не удалось сгенерировать аудио. Попробуй позже.');
            }
          } catch {
            await ctx.reply('😔 Ошибка генерации голоса.');
          }
          return;
        }
      }

      // === Автодетекция заметок: "запомни ...", "запиши ..." ===
      const noteMatch = userMessage.match(/^(запомни|запиши|сохрани заметку)\s+(.+)/i);
      if (noteMatch) {
        const noteContent = noteMatch[2].trim();
        if (noteContent) {
          try {
            await notesRepo.create(userId, noteContent);
            const keyboard = new InlineKeyboard().text('📋 Все заметки', 'notes_list');
            await ctx.reply(`📌 Сохранено!\n\n_${noteContent}_`, {
              parse_mode: 'Markdown',
              reply_markup: keyboard,
            });
          } catch {
            await ctx.reply('😔 Не удалось сохранить заметку.');
          }
          return;
        }
      }

      // Get or create conversation
      if (!ctx.session.conversationId) {
        const conversation = await conversationsRepo.getOrCreate(
          userId,
          'telegram',
          { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
        );
        ctx.session.conversationId = conversation.id;
        ctx.session.messageHistory = conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
      }

      // Build memory context for personalized responses (graceful degradation)
      let memoryContext = '';
      try {
        memoryContext = await memoryContextBuilder.buildContext(userId, telegramInfo);
      } catch (memError) {
        telegramLogger.warn({ error: memError, userId }, 'Failed to build memory context, continuing without');
      }

      // Умный контекст: время суток, день недели, имя пользователя
      const timeContext = buildTimeContext(ctx.from?.first_name);
      memoryContext = timeContext + (memoryContext ? '\n' + memoryContext : '');

      // Прозрачный веб-поиск: бот сам решает нужен ли интернет
      const webSearchContext = await getSearchContext(userMessage);

      // Add user message to history
      ctx.session.messageHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Get AI response with memory context and web search results
      const fullContext = memoryContext + webSearchContext;
      let response = await aiService.chat(ctx.session.messageHistory, 'telegram', fullContext);

      // Если AI показывает неуверенность и поиск ещё не был сделан — пробуем найти ответ
      if (!webSearchContext) {
        const enhanced = await enhanceResponseIfNeeded(userMessage, response.content);
        if (enhanced.wasEnhanced) {
          response = { ...response, content: enhanced.response };
          telegramLogger.info({ userId }, 'Response enhanced with web search');
        }
      }

      // Add assistant response to history
      ctx.session.messageHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // Update user profile stats (fire and forget)
      userProfileRepo.updateOnMessage(userId, 'message', response.tokens_used.total, telegramInfo).catch(() => {});

      // Log AI response (fire and forget)
      const responseTime = Date.now() - startTime;
      userLogsRepo.add(userId, 'ai_response', response.content, {
        chatId,
        responseLength: response.content.length,
      }, {
        model: response.model,
        tokensPrompt: response.tokens_used.prompt,
        tokensCompletion: response.tokens_used.completion,
        responseTimeMs: responseTime,
      }).catch(() => {});

      // Extract facts from conversation (async, don't wait)
      memoryExtractor.extractFacts(userId, userMessage, response.content).catch(() => {});

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: userMessage,
        timestamp: new Date().toISOString(),
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: response.tokens_used.total,
          model: response.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      // Log analytics
      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        model: response.model,
        tokens: response.tokens_used.total,
      });

      // Send response with inline buttons
      const responseKeyboard = new InlineKeyboard()
        .text('📌 В заметки', 'save_to_notes')
        .text('🔊 Озвучить', 'read_aloud');

      await sendLongMessage(ctx, response.content, responseKeyboard);

      telegramLogger.info(
        { userId, tokens: response.tokens_used.total },
        'Response sent'
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorCode = getErrorCode(error);
      
      telegramLogger.error({ error, userId, errorCode }, 'Failed to process message');
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        error: errorMessage,
        errorCode,
      });

      // Подробные сообщения об ошибках для пользователя
      let userMessage = '😔 Извини, произошла ошибка. Попробуй ещё раз или напиши /clear для сброса диалога.';
      
      if (errorCode === 'MODEL_NOT_FOUND' || errorMessage.includes('MODEL_NOT_FOUND')) {
        userMessage = `❌ Модель AI не найдена!\n\n` +
          `Текущая модель не существует на OpenRouter.\n` +
          `Администратор должен изменить модель в настройках:\n` +
          `https://amina-admin.onrender.com/settings`;
      } else if (errorCode === 'AUTH_ERROR' || errorMessage.includes('AUTH_ERROR')) {
        userMessage = `🔑 Ошибка авторизации AI!\n\n` +
          `Неверный API ключ OpenRouter.\n` +
          `Администратор должен проверить настройки в Render.`;
      } else if (errorCode === 'RATE_LIMIT' || errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        userMessage = `⏳ Слишком много запросов!\n\nЛимит OpenRouter превышен. Подожди минуту и попробуй снова.`;
      } else if (errorCode === 'PAYMENT_REQUIRED') {
        userMessage = `💳 Пополни баланс на OpenRouter или выбери бесплатную модель в админке.`;
      } else if (errorCode === 'ALL_MODELS_FAILED' || errorMessage.includes('ALL_MODELS_FAILED')) {
        userMessage = `🔄 Все бесплатные модели AI заняты.\n\nПопробуй через 30 секунд или напиши /start для сброса.`;
      } else if (errorCode === 'RACE_TIMEOUT' || errorMessage.includes('RACE_TIMEOUT')) {
        userMessage = `⏰ AI отвечает слишком долго.\n\nПопробуй ещё раз — может повезёт быстрее!`;
      } else if (errorCode === 'SERVER_ERROR' || errorMessage.includes('500') || errorMessage.includes('502')) {
        userMessage = `🔧 Сервер AI временно недоступен.\n\nПопробуй через несколько минут.`;
      }

      await ctx.reply(userMessage);
    }
  });

  // Voice messages - transcribe and send to LLM
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const duration = ctx.message.voice.duration;
    const startTime = Date.now();
    
    telegramLogger.info({ userId, duration }, 'Voice message received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
      return;
    }

    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      type: 'voice',
      duration,
    });

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Download voice file
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      
      telegramLogger.debug({ fileUrl }, 'Downloading voice file');
      
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice file: ${response.status}`);
      }
      
      const audioBuffer = await response.arrayBuffer();
      const audioBase64 = Buffer.from(audioBuffer).toString('base64');
      
      // Get or create conversation
      if (!ctx.session.conversationId) {
        const conversation = await conversationsRepo.getOrCreate(
          userId,
          'telegram',
          { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
        );
        ctx.session.conversationId = conversation.id;
        ctx.session.messageHistory = conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
      }

      // 1. Транскрибируем аудио
      const transcription = await transcribeAudio(audioBase64, 'audio/ogg');
      const transcribedText = transcription.text;

      telegramLogger.debug({ userId, transcription: transcribedText.substring(0, 100) }, 'Voice transcribed');

      // Telegram user info for profile
      const telegramInfo: TelegramUserInfo = {
        id: ctx.from?.id ?? 0,
        username: ctx.from?.username,
        first_name: ctx.from?.first_name,
        last_name: ctx.from?.last_name,
        language_code: ctx.from?.language_code,
      };

      // 2. Проверяем: это напоминание?
      if (detectReminderIntent(transcribedText)) {
        try {
          const extracted = await extractReminder(transcribedText, new Date());
          if (extracted) {
            await remindersRepo.create(userId, chatId, extracted.task, extracted.scheduled_at);

            // Сохраняем в историю
            const userMsg: Message = {
              role: 'user',
              content: transcribedText,
              timestamp: new Date().toISOString(),
              metadata: { type: 'voice', voice_duration: duration },
            };
            const assistantMsg: Message = {
              role: 'assistant',
              content: extracted.reply,
              timestamp: new Date().toISOString(),
            };
            await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
            await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

            ctx.session.messageHistory.push(
              { role: 'user', content: transcribedText },
              { role: 'assistant', content: extracted.reply }
            );

            await ctx.reply(extracted.reply);
            telegramLogger.info({ userId, task: extracted.task }, 'Voice reminder created');
            return;
          }
          // AI не смог распарсить детали
          telegramLogger.info({ userId, transcribedText }, 'Voice reminder detected but AI could not parse');
          await ctx.reply('⏰ Похоже, ты хочешь напоминание, но я не смогла разобрать детали.\n\nПопробуй сказать чётче, например:\n«Напомни через 2 часа позвонить маме»');
          return;
        } catch (reminderError) {
          telegramLogger.warn({ error: reminderError, userId }, 'Voice reminder extraction failed');
          await ctx.reply('⚠️ Не удалось создать напоминание — AI временно недоступен.\n\nПопробуй ещё раз через минуту.');
          return;
        }
      }

      // 3. Автодетекция генерации изображения из голоса ("нарисуй...", "сгенерируй...")
      if (detectImageGenIntent(transcribedText)) {
        const imgPrompt = extractImagePrompt(transcribedText);
        if (imgPrompt) {
          telegramLogger.info({ userId, prompt: imgPrompt }, 'Image gen auto-detected from voice');
          await ctx.replyWithChatAction('upload_photo');

          try {
            const result = await generateImage(imgPrompt);
            const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);
            const cleanPrompt = imgPrompt.replace(/, high quality.*$/, '');
            const safePrompt = escapeMarkdown(cleanPrompt);

            await ctx.replyWithPhoto(
              new InputFile(result.image, 'generated.png'),
              {
                caption: `🎨 ${safePrompt}\n⏱ ${timeSeconds}с | FLUX.1-schnell`,
              }
            );

            try {
              await analyticsRepo.log('message_received', 'telegram', {
                userId,
                event: 'image_generated_voice',
                prompt: imgPrompt,
                model: result.model,
                timeMs: result.generationTimeMs,
              });
            } catch {
              // Аналитика не критична
            }
            return;
          } catch (error: unknown) {
            const err = error as { message?: string; code?: string };
            telegramLogger.error({ error, userId }, 'Voice image gen failed');
            await ctx.reply(`😔 ${err.message || 'Не удалось создать изображение.'}`);
            return;
          }
        }
      }

      // 4. Автодетекция TTS из голоса: "скажи голосом...", "озвучь..."
      const ttsMatch = transcribedText.match(/^(скажи голосом|озвучь|произнеси|read aloud)\s+(.+)/i);
      if (ttsMatch) {
        const ttsText = ttsMatch[2]?.trim();
        if (ttsText) {
          await ctx.replyWithChatAction('record_voice');
          try {
            const lang = detectLanguage(ttsText);
            const audio = await textToSpeech(ttsText, lang);
            if (audio) {
              await ctx.replyWithVoice(new InputFile(audio, 'voice.mp3'));
            } else {
              await ctx.reply('😔 Не удалось сгенерировать аудио. Попробуй позже.');
            }
          } catch {
            await ctx.reply('😔 Ошибка генерации голоса.');
          }
          return;
        }
      }

      // 5. Автодетекция заметок из голоса: "запомни...", "запиши..."
      const noteMatch = transcribedText.match(/^(запомни|запиши|сохрани заметку)\s+(.+)/i);
      if (noteMatch) {
        const noteContent = noteMatch[2]?.trim();
        if (noteContent) {
          try {
            await notesRepo.create(userId, noteContent);
            const keyboard = new InlineKeyboard().text('📋 Все заметки', 'notes_list');
            await ctx.reply(`📌 Сохранено!\n\n_${noteContent}_`, {
              parse_mode: 'Markdown',
              reply_markup: keyboard,
            });
          } catch {
            await ctx.reply('😔 Не удалось сохранить заметку.');
          }
          return;
        }
      }

      // 6. Обычный AI flow — с полным контекстом (время, память, веб-поиск)

      // Build memory context (graceful degradation)
      let memoryContext = '';
      try {
        memoryContext = await memoryContextBuilder.buildContext(userId, telegramInfo);
      } catch (memError) {
        telegramLogger.warn({ error: memError, userId }, 'Failed to build memory context for voice');
      }

      // Умный контекст: время суток, день недели, имя
      const timeContext = buildTimeContext(ctx.from?.first_name);
      memoryContext = timeContext + (memoryContext ? '\n' + memoryContext : '');

      // Прозрачный веб-поиск
      const webSearchContext = await getSearchContext(transcribedText);

      // Add user message to history
      ctx.session.messageHistory.push({
        role: 'user',
        content: transcribedText,
      });

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Get AI response with full context
      const fullContext = memoryContext + webSearchContext;
      let aiResponse = await aiService.chat(ctx.session.messageHistory, 'telegram', fullContext);

      // Если AI неуверен и поиск ещё не был сделан — пробуем найти ответ
      if (!webSearchContext) {
        const enhanced = await enhanceResponseIfNeeded(transcribedText, aiResponse.content);
        if (enhanced.wasEnhanced) {
          aiResponse = { ...aiResponse, content: enhanced.response };
          telegramLogger.info({ userId }, 'Voice response enhanced with web search');
        }
      }

      // Add assistant response to history
      ctx.session.messageHistory.push({
        role: 'assistant',
        content: aiResponse.content,
      });

      // Update user profile stats (fire and forget)
      userProfileRepo.updateOnMessage(userId, 'voice', aiResponse.tokens_used.total, telegramInfo).catch(() => {});

      // Log AI response (fire and forget)
      const responseTime = Date.now() - startTime;
      userLogsRepo.add(userId, 'ai_response', aiResponse.content, {
        chatId,
        type: 'voice',
        responseLength: aiResponse.content.length,
      }, {
        model: aiResponse.model,
        tokensPrompt: aiResponse.tokens_used.prompt,
        tokensCompletion: aiResponse.tokens_used.completion,
        responseTimeMs: responseTime,
      }).catch(() => {});

      // Extract facts from conversation (async, don't wait)
      memoryExtractor.extractFacts(userId, transcribedText, aiResponse.content).catch(() => {});

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: transcribedText,
        timestamp: new Date().toISOString(),
        metadata: { type: 'voice', voice_duration: duration },
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: aiResponse.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: aiResponse.tokens_used.total,
          model: aiResponse.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      // Log analytics
      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        type: 'voice',
        model: aiResponse.model,
        tokens: aiResponse.tokens_used.total,
        transcription_length: transcribedText.length,
      });

      // Send response with inline buttons
      const responseKeyboard = new InlineKeyboard()
        .text('📌 В заметки', 'save_to_notes')
        .text('🔊 Озвучить', 'read_aloud');

      await sendLongMessage(ctx, aiResponse.content, responseKeyboard);

      telegramLogger.info(
        { userId, tokens: aiResponse.tokens_used.total },
        'Voice response sent'
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process voice message');
      
      const errorCode = getErrorCode(error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        type: 'voice',
        error: errorMessage,
        errorCode,
      });

      // Детальные сообщения об ошибках
      let userMessage = '😔 Не удалось обработать голосовое сообщение. Попробуй ещё раз или отправь текст.';
      
      if (errorCode === 'AUDIO_MODEL_NOT_FOUND') {
        userMessage = `🔧 Audio модель не найдена на OpenRouter.\n\nОбратитесь к администратору для настройки модели в админке.`;
      } else if (errorCode === 'AUDIO_NOT_SUPPORTED') {
        userMessage = `🔧 Выбранная модель не поддерживает аудио.\n\nОбратитесь к администратору для смены модели.`;
      } else if (errorCode === 'AUTH_ERROR' || errorCode === 'GROQ_AUTH_ERROR') {
        userMessage = '🔑 Ошибка авторизации API. Обратитесь к администратору.';
      } else if (errorCode === 'RATE_LIMIT') {
        userMessage = '⏳ Слишком много запросов!\n\nПодожди минуту и попробуй снова.';
      } else if (errorCode === 'ALL_MODELS_FAILED') {
        userMessage = '🔄 Все бесплатные модели AI заняты.\n\nПопробуй через 30 секунд.';
      } else if (errorCode === 'RACE_TIMEOUT') {
        userMessage = '⏰ AI отвечает слишком долго.\n\nПопробуй ещё раз!';
      } else if (errorCode === 'SERVER_ERROR') {
        userMessage = '🔧 Сервер AI временно недоступен.\n\nПопробуй через несколько минут.';
      } else if (errorCode === 'FILE_TOO_LARGE') {
        userMessage = '📁 Голосовое сообщение слишком длинное.\n\nПопробуй записать сообщение короче.';
      }

      await ctx.reply(userMessage);
    }
  });

  // Photo messages - analyze and send to LLM
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption;
    
    telegramLogger.info({ userId, hasCaption: !!caption }, 'Photo message received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
      return;
    }

    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      type: 'photo',
      hasCaption: !!caption,
    });

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Get largest photo
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];
      
      if (!largestPhoto) {
        throw new Error('No photo found in message');
      }
      
      // Download photo
      const file = await ctx.api.getFile(largestPhoto.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      
      telegramLogger.debug({ fileUrl, width: largestPhoto.width, height: largestPhoto.height }, 'Downloading photo');
      
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download photo: ${response.status}`);
      }
      
      const imageBuffer = await response.arrayBuffer();
      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      
      // Determine MIME type
      const mimeType = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg';
      
      // Get or create conversation
      if (!ctx.session.conversationId) {
        const conversation = await conversationsRepo.getOrCreate(
          userId,
          'telegram',
          { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
        );
        ctx.session.conversationId = conversation.id;
        ctx.session.messageHistory = conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
      }

      // Process image: analyze + LLM
      const aiResponse = await processImageWithLLM(
        imageBase64,
        mimeType,
        caption,
        ctx.session.messageHistory
      );

      // Create user message content
      const userContent = caption
        ? `[Изображение с подписью: "${caption}"]`
        : '[Изображение]';

      // Update history
      ctx.session.messageHistory.push(
        { role: 'user', content: userContent },
        { role: 'assistant', content: aiResponse.content }
      );

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: userContent,
        timestamp: new Date().toISOString(),
        metadata: { 
          type: 'photo',
          width: largestPhoto.width,
          height: largestPhoto.height,
        },
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: aiResponse.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: aiResponse.tokens_used.total,
          model: aiResponse.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      // Log analytics
      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        type: 'photo',
        model: aiResponse.model,
        tokens: aiResponse.tokens_used.total,
      });

      // Send response
      await sendLongMessage(ctx, aiResponse.content);

      telegramLogger.info(
        { userId, tokens: aiResponse.tokens_used.total },
        'Photo response sent'
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process photo');
      
      const errorCode = getErrorCode(error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        type: 'photo',
        error: errorMessage,
        errorCode,
      });

      // Детальные сообщения об ошибках
      let userMessage = '😔 Не удалось обработать изображение. Попробуй ещё раз или отправь текст.';
      
      if (errorCode === 'VISION_MODEL_NOT_FOUND') {
        userMessage = `🔧 Vision модель не найдена на OpenRouter.\n\nВ админке → Голос и Фото выберите другую модель для изображений.`;
      } else if (errorCode === 'VISION_SERVICE_UNAVAILABLE') {
        userMessage = '⏳ Сервис анализа фото временно недоступен.\n\nПопробуй отправить фото через минуту.';
      } else if (errorCode === 'AUTH_ERROR') {
        userMessage = '🔑 Ошибка авторизации API. Обратитесь к администратору.';
      } else if (errorCode === 'ALL_MODELS_FAILED') {
        userMessage = '🔄 Все бесплатные модели AI заняты.\n\nПопробуй через 30 секунд.';
      } else if (errorCode === 'RACE_TIMEOUT') {
        userMessage = '⏰ AI отвечает слишком долго.\n\nПопробуй ещё раз!';
      } else if (errorCode === 'RATE_LIMIT') {
        userMessage = '⏳ Слишком много запросов!\n\nПодожди минуту.';
      }

      await ctx.reply(userMessage);
    }
  });

  // Document/file messages (images sent as files)
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const document = ctx.message.document;
    const mimeType = document.mime_type ?? '';
    
    // Check if it's an image
    if (!mimeType.startsWith('image/')) {
      await ctx.reply('📄 Пока что я могу анализировать только изображения. Отправь фото или картинку.');
      return;
    }

    telegramLogger.info({ userId, mimeType, fileName: document.file_name }, 'Document image received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
      return;
    }

    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      type: 'document_image',
      mimeType,
    });

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Download document
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download document: ${response.status}`);
      }
      
      const imageBuffer = await response.arrayBuffer();
      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      const caption = ctx.message.caption;
      const chatId = ctx.chat.id;
      
      // Get or create conversation
      if (!ctx.session.conversationId) {
        const conversation = await conversationsRepo.getOrCreate(
          userId,
          'telegram',
          { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
        );
        ctx.session.conversationId = conversation.id;
        ctx.session.messageHistory = conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
      }

      // Process image
      const aiResponse = await processImageWithLLM(
        imageBase64,
        mimeType,
        caption,
        ctx.session.messageHistory
      );

      const userContent = caption
        ? `[Изображение "${document.file_name}" с подписью: "${caption}"]`
        : `[Изображение "${document.file_name}"]`;

      // Update history
      ctx.session.messageHistory.push(
        { role: 'user', content: userContent },
        { role: 'assistant', content: aiResponse.content }
      );

      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: userContent,
        timestamp: new Date().toISOString(),
        metadata: { type: 'document_image', fileName: document.file_name },
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: aiResponse.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: aiResponse.tokens_used.total,
          model: aiResponse.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        type: 'document_image',
        model: aiResponse.model,
        tokens: aiResponse.tokens_used.total,
      });

      await sendLongMessage(ctx, aiResponse.content);

      telegramLogger.info({ userId }, 'Document image response sent');
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process document image');
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        type: 'document_image',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      await ctx.reply('😔 Не удалось обработать изображение. Попробуй ещё раз.');
    }
  });

  // Stickers and other unsupported media
  bot.on('message', async (ctx) => {
    // Catch-all for unsupported message types
    const msg = ctx.message;
    if (!msg.text && !msg.voice && !msg.photo && !msg.document) {
      await ctx.reply('🤔 Я понимаю текст, голосовые сообщения и изображения.');
    }
  });
};

// --------------------------------------------
// Utility Functions
// --------------------------------------------

// --------------------------------------------
// Smart Time Context
// --------------------------------------------

const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

/**
 * Контекст времени суток + день недели + имя для system prompt.
 * TZ=Europe/Moscow → new Date() уже в московском времени.
 */
const buildTimeContext = (firstName?: string): string => {
  const now = new Date();
  const hour = now.getHours();
  const day = WEEKDAYS_RU[now.getDay()] ?? 'неизвестно';
  const dateStr = now.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  let greeting = '';
  if (hour >= 5 && hour < 12) greeting = 'утро';
  else if (hour >= 12 && hour < 17) greeting = 'день';
  else if (hour >= 17 && hour < 22) greeting = 'вечер';
  else greeting = 'ночь';

  const nameStr = firstName ? `Имя пользователя: ${firstName}.` : '';

  return `[Контекст: ${dateStr}, ${day}, ${greeting} (${hour}:${String(now.getMinutes()).padStart(2, '0')} МСК). ${nameStr}]`;
};

// --------------------------------------------
// Escape Markdown special chars for Telegram
// --------------------------------------------

const escapeMarkdown = (text: string): string =>
  text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

// --------------------------------------------
// Send Long Message (split by Telegram limit)
// --------------------------------------------

const sendLongMessage = async (
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> => {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
    return;
  }

  // Split by paragraphs first, then by length
  const chunks: string[] = [];
  let currentChunk = '';

  const paragraphs = text.split('\n\n');
  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 > MAX_MESSAGE_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If single paragraph is too long, split by sentences
      if (paragraph.length > MAX_MESSAGE_LENGTH) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (currentChunk.length + sentence.length + 1 > MAX_MESSAGE_LENGTH) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  // Send all chunks (кнопки — только к последнему)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const isLast = i === chunks.length - 1;
    await ctx.reply(
      chunk,
      isLast && keyboard ? { reply_markup: keyboard } : undefined
    );
  }
};
