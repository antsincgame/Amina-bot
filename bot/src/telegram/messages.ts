/**
 * Telegram Message Handlers
 * 
 * Обработчики сообщений:
 * - message:text  — текстовые сообщения + ReplyKeyboard кнопки
 * - message:voice — голосовые сообщения  
 * - message:photo — фотографии
 * - message:document — документы (изображения)
 * - message (catch-all) — неподдерживаемые типы
 */

import { Bot, InputFile, InlineKeyboard } from 'grammy';
import type { BotContext } from './bot.js';
import { MAX_HISTORY_MESSAGES } from './bot.js';
import { config } from '../config/index.js';
import { telegramLogger } from '../config/logger.js';
import { aiService, isGibberish } from '../ai/openrouter.js';
import { processImageWithLLM, transcribeAudio } from '../ai/multimodal.js';
import { getSearchContext, enhanceResponseIfNeeded, needsWebSearch, webSearch, isWebSearchEnabled, shouldForceWebSearch, searchAndFormat } from '../ai/websearch.js';
import { conversationsRepo, analyticsRepo } from '../db/supabase.js';
import { checkTelegramRateLimit } from '../utils/rate-limiter.js';
import { getErrorCode } from '../utils/error-handler.js';
import {
  userProfileRepo,
  userMemoryRepo,
  userLogsRepo,
  memoryExtractor,
  memoryContextBuilder,
  type TelegramUserInfo,
} from '../memory/user-memory.js';
import { detectReminderIntent, detectReminderListIntent, extractReminder } from '../reminders/reminder-parser.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { detectImageGenIntent, extractImagePrompt, generateImage, classifyImageIntentGroq, isAIResponseAboutImages, detectImageEditIntent, editImage, classifyImageEditIntentGroq } from '../ai/image-gen.js';
import { notesRepo } from '../features/notes-repo.js';
import { todosRepo } from '../features/todos-repo.js';
import { userPrefsRepo } from '../features/user-prefs-repo.js';
import { textToSpeech, detectLanguage } from '../features/tts.js';
import { sendDigestNow } from '../features/digest-scheduler.js';
import { verifyResponse } from '../ai/llm-verifier.js';
import { voiceMessagesRepo } from '../features/voice-messages-repo.js';
import type { AIMessage, AIResponse } from '../../../shared/types/index.js';
import {
  escapeMarkdown,
  escapeHtml,
  sendLongMessage,
  buildTimeContext,
  looksLikeSearchSimulation,
  looksLikeSearchRefusal,
  llmIgnoredSearchData,
  formatPerplexityFallback,
  inlineCitations,
  formatSearchError,
} from './format.js';
import {
  buildMainMenu,
  notesListKeyboard,
  todosListKeyboard,
  todoDoneKeyboard,
  digestToggleKeyboard,
  responseActionsKeyboard,
} from './keyboards.js';

// ============================================
// Constants
// ============================================

const MAX_CITATIONS_DISPLAY = 5;
const MAX_URL_DISPLAY_LENGTH = 70;
const MIN_SEARCH_ANSWER_LENGTH = 30;
const MIN_FORCE_ANSWER_LENGTH = 50;
const AUTO_SUMMARY_INTERVAL = 20;
const MAX_NOTE_PREVIEW_LENGTH = 120;

function formatCitationsBlock(citations: string[]): string {
  if (citations.length === 0) return '';
  return '\n\n📚 Источники:\n' + citations.slice(0, MAX_CITATIONS_DISPLAY)
    .map((url, i) => `${i + 1}. ${url.length > MAX_URL_DISPLAY_LENGTH ? url.substring(0, MAX_URL_DISPLAY_LENGTH - 3) + '...' : url}`)
    .join('\n') + '\n';
}

// ============================================
// Message Handlers Setup
// ============================================

export const setupMessageHandlers = (bot: Bot<BotContext>): void => {
  // Text messages
  bot.on('message:text', async (ctx) => handleTextMessage(ctx));

  // Voice messages
  bot.on('message:voice', async (ctx) => handleVoiceMessage(ctx));

  // Photo messages
  bot.on('message:photo', async (ctx) => handlePhotoMessage(ctx));

  // Document/file messages (images sent as files)
  bot.on('message:document', async (ctx) => handleDocumentMessage(ctx));

  // Catch-all for unsupported message types
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!msg.text && !msg.voice && !msg.photo && !msg.document) {
      await ctx.reply('🤔 Я понимаю текст, голосовые сообщения и изображения.');
    }
  });
};

// ============================================
// Reply Keyboard Button Handlers
// ============================================

const clearAwaitingFlags = (ctx: BotContext): void => {
  ctx.session.awaitingImagePrompt = false;
  ctx.session.awaitingTodoTask = false;
  ctx.session.awaitingNoteContent = false;
  ctx.session.awaitingSearchQuery = false;
};

const buildReplyButtonHandlers = (ctx: BotContext, userId: string): Record<string, () => Promise<void>> => ({
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
          // Усекаем длинные заметки при отображении (макс. 120 символов)
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
          const d = new Date(r.scheduled_at).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. ${escapeHtml(r.task)} — ⏰ ${d}`;
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
        `☀️ <b>Дайджест:</b> ${status}\n\nВремя: ${prefs?.digest_hour ?? 10}:00 | Город: ${escapeHtml(prefs?.digest_city ?? 'Гродно')}`,
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
        prefs.digest_city || 'Гродно'
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

// ============================================
// Auto-detection Helpers
// ============================================

/** Обрабатывает автодетекции (напоминания, картинки, TTS, заметки). Возвращает true если обработано. */
const handleAutoDetections = async (
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
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Minsk',
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
  // Шаг 1: быстрая regex-проверка
  let imgPrompt: string | null = null;
  if (detectImageGenIntent(text)) {
    imgPrompt = extractImagePrompt(text);
    if (imgPrompt) {
      telegramLogger.info({ userId, prompt: imgPrompt, method: 'regex' }, 'Image gen detected (regex)');
    }
  }

  // Шаг 2: Groq-классификация как fallback (если regex не сработал)
  // ОПТИМИЗАЦИЯ: Не вызываем Groq для сообщений, которые явно НЕ про картинки —
  // вопросы, команды "назови/расскажи/найди", короткие фразы
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

  // Генерируем картинку если намерение обнаружено
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

// ============================================
// Conversation Helpers (DRY)
// ============================================

/** Создаёт/загружает conversation если ещё не инициализирован */
const ensureConversation = async (ctx: BotContext, userId: string, chatId: number): Promise<void> => {
  if (ctx.session.conversationId) return;

  const conversation = await conversationsRepo.getOrCreate(
    userId, 'telegram',
    { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
  );
  ctx.session.conversationId = conversation.id;
  ctx.session.messageHistory = conversation.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  ctx.session.messageHistory = sanitizeMessageHistory(ctx.session.messageHistory);
};

/** Строит контекст памяти с одной повторной попыткой */
const buildMemoryWithRetry = async (
  userId: string,
  telegramInfo: TelegramUserInfo,
): Promise<string> => {
  try {
    return await memoryContextBuilder.buildContext(userId, telegramInfo);
  } catch (err) {
    telegramLogger.warn({ error: err, userId }, 'Memory context attempt 1 failed, retrying...');
    try {
      return await memoryContextBuilder.buildContext(userId, telegramInfo);
    } catch (err2) {
      telegramLogger.error({ error: err2, userId }, 'Memory context attempt 2 failed — responding WITHOUT memory');
      return '';
    }
  }
};

/** Строит полный контекст (время + память + поиск) параллельно */
const buildFullContext = async (
  userId: string,
  userText: string,
  firstName?: string,
  telegramInfo?: TelegramUserInfo,
  alreadyGreetedToday?: boolean,
): Promise<{ memoryContext: string; webSearchContext: string }> => {
  const timeContext = buildTimeContext(firstName);

  const [memoryContextRaw, webSearchContext] = await Promise.all([
    buildMemoryWithRetry(userId, telegramInfo ?? ({} as TelegramUserInfo)),
    getSearchContext(userText).catch((err) => {
      telegramLogger.warn({ error: err, userId }, 'Failed to get search context');
      return '';
    }),
  ]);

  let memoryContext = timeContext + (memoryContextRaw ? '\n' + memoryContextRaw : '');
  
  // Антиповтор приветствия: если сегодня уже здоровалась — запрет
  if (alreadyGreetedToday) {
    memoryContext += '\n[ПРИВЕТСТВИЕ: ты уже здоровалась с пользователем сегодня. НЕ здоровайся повторно — не пиши "Привет", "Здравствуй", "Доброе утро/день/вечер" и т.п. в начале ответа. Сразу отвечай по существу.]';
  }
  
  return { memoryContext, webSearchContext };
};

/**
 * Обрабатывает AI-ответ: верификация, защита от отказов, симуляции, галлюцинаций.
 * 
 * ПРИНЦИП: Бот НИКОГДА не отказывает пользователю. Премиум-ассистент ВСЕГДА отвечает.
 * 
 * Стратегия (каждый шаг — попытка дать ОТВЕТ, не отказ):
 * 1. Верификатор → correctedResponse из Perplexity
 * 2. Симуляция → данные из контекста или свежий Perplexity запрос
 * 3. LLM проигнорировала данные → показать Perplexity напрямую
 * 4. LLM отказалась → forceAnswer (повторный запрос с жёстким промптом)
 * 5. Всё провалилось → свежий Perplexity запрос напрямую пользователю
 * 6. Даже Perplexity не смог → оригинальный ответ LLM (но без отказных фраз)
 */
const processAIResponse = async (
  response: AIResponse,
  userMessage: string,
  userId: string,
  webSearchContext: string,
): Promise<AIResponse> => {
  // === Шаг 1: Верификация через Perplexity ===
  const verification = await verifyResponse(userMessage, response.content, webSearchContext).catch(err => {
    telegramLogger.debug({ error: err }, 'Verification failed silently');
    return null;
  });

  if (verification && !verification.isValid && !verification.skipped) {
    telegramLogger.warn({
      userId, reason: verification.reason, verifyTimeMs: verification.verifyTimeMs,
      responseSnippet: response.content.substring(0, 80),
    }, '🚨 Verifier flagged response');
    analyticsRepo.log('message_received', 'telegram', {
      event: 'llm_verify_failed', reason: verification.reason, responseLength: response.content.length,
    }, userId).catch(() => {});

    if (verification.correctedResponse) {
      telegramLogger.info({ userId, reason: verification.reason }, '✅ Using Perplexity-verified response');
      return { ...response, content: verification.correctedResponse };
    }
  }

  // === Шаг 2: Симуляция поиска → данные из контекста или Perplexity ===
  if (looksLikeSearchSimulation(response.content)) {
    telegramLogger.warn({ userId, responseSnippet: response.content.substring(0, 100) }, 'LLM simulated search');

    const fixed = await tryGetPerplexityData(webSearchContext, userMessage, userId);
    if (fixed) return { ...response, content: fixed };

    // Perplexity недоступен → forceAnswer (LLM без симуляции)
    const forced = await forceAnswer(userMessage, userId);
    if (forced) return { ...response, content: forced };
  }

  // === Шаг 3: LLM проигнорировала данные из контекста → показать Perplexity напрямую ===
  if (webSearchContext && llmIgnoredSearchData(response.content, webSearchContext)) {
    telegramLogger.warn({ userId, responseSnippet: response.content.substring(0, 100) },
      '🚨 LLM ignored search data → using raw Perplexity');
    analyticsRepo.log('message_received', 'telegram', {
      event: 'llm_ignored_search_data', responseLength: response.content.length,
    }, userId).catch(() => {});

    const fallback = formatPerplexityFallback(webSearchContext);
    if (fallback) return { ...response, content: fallback };
  }

  // === Шаг 4: LLM отказалась отвечать → forceAnswer ===
  if (looksLikeSearchRefusal(response.content)) {
    telegramLogger.warn({ userId, responseSnippet: response.content.substring(0, 100) },
      '🚨 LLM refused to answer → forcing retry');

    // Сначала пробуем Perplexity
    const perplexityFix = await tryGetPerplexityData(webSearchContext, userMessage, userId);
    if (perplexityFix) return { ...response, content: perplexityFix };

    // Потом — повторный запрос к LLM с жёстким промптом
    const forced = await forceAnswer(userMessage, userId);
    if (forced) return { ...response, content: forced };
  }

  return response;
};

/**
 * Пытается получить данные из Perplexity: сначала из кэша (контекста), потом свежий запрос.
 * Никогда не возвращает сообщение-отказ — только реальные данные или null.
 */
const tryGetPerplexityData = async (
  webSearchContext: string,
  userMessage: string,
  userId: string,
): Promise<string | null> => {
  // Сначала из контекста (без API-вызова)
  if (webSearchContext) {
    const cached = formatPerplexityFallback(webSearchContext);
    if (cached) {
      telegramLogger.info({ userId }, '✅ Using cached Perplexity data from context');
      return cached;
    }
  }

  // Свежий запрос к Perplexity / OpenRouter :online
  try {
    const result = await webSearch(userMessage);
    if (result.answer && result.answer.length > MIN_SEARCH_ANSWER_LENGTH) {
      const text = result.answer + formatCitationsBlock(result.citations);
      telegramLogger.info({ userId }, '✅ Got fresh Perplexity data');
      return text;
    }
  } catch (err) {
    telegramLogger.debug({ error: err }, 'Perplexity search failed');
  }

  return null;
};

/**
 * Повторный запрос к LLM с жёстким промптом "просто ответь".
 * Используется когда LLM отказалась или симулировала поиск.
 * НИКОГДА не возвращает отказ — если и этот запрос плохой, возвращает null.
 */
const forceAnswer = async (
  userMessage: string,
  userId: string,
): Promise<string | null> => {
  try {
    telegramLogger.info({ userId, query: userMessage.substring(0, 60) }, '🔄 Force-answering with strict prompt');

    const forceResult = await aiService.chat(
      [{ role: 'user', content: userMessage }],
      'telegram',
      'Ты — премиум AI-ассистент. Пользователь задал вопрос и ждёт ответ.\n\n' +
      'АБСОЛЮТНЫЕ ПРАВИЛА:\n' +
      '1. ОТВЕТЬ на вопрос. Это единственное, что от тебя требуется.\n' +
      '2. ЗАПРЕЩЕНО: отказывать, говорить "не могу", "не знаю", "обратитесь к...".\n' +
      '3. ЗАПРЕЩЕНО: перечислять свои возможности вместо ответа.\n' +
      '4. ЗАПРЕЩЕНО: симулировать поиск ("Ищу...", "Поиск...").\n' +
      '5. Если не уверен — дай лучший ответ из своих знаний с пометкой "по моим данным".\n' +
      '6. Ответ должен быть развёрнутым, полезным и конкретным.\n' +
      '7. Отвечай на русском языке.'
    );

    // Проверяем что retry не отказ
    if (forceResult.content &&
        forceResult.content.length > MIN_FORCE_ANSWER_LENGTH &&
        !looksLikeSearchSimulation(forceResult.content) &&
        !looksLikeSearchRefusal(forceResult.content)) {
      telegramLogger.info({ userId, length: forceResult.content.length }, '✅ Force-answer succeeded');
      return forceResult.content;
    }
  } catch (err) {
    telegramLogger.warn({ error: err, userId }, 'Force-answer failed');
  }

  return null;
};

/** Добавляет инструкцию LLM если поиск нужен, но данные не получены */
const addSearchWarning = (fullContext: string, userMessage: string, webSearchContext: string, userId: string): string => {
  if (!webSearchContext && needsWebSearch(userMessage)) {
    telegramLogger.warn({ userId, query: userMessage.substring(0, 50) }, 'Search needed but no data — instructing to answer from knowledge');
    return fullContext + '\n\n⚠️ СИСТЕМНОЕ УВЕДОМЛЕНИЕ: Автоматический поиск сейчас недоступен. ' +
      'ОБЯЗАТЕЛЬНО ответь на вопрос пользователя из своих знаний! ' +
      'Ты — премиум-ассистент, НИКОГДА не отказывай в помощи. ' +
      'Если точных данных нет — дай лучший ответ из того, что знаешь, с пометкой "по моим данным". ' +
      'НЕ симулируй поиск, НЕ пиши "Ищу...", "Поиск в интернете". ' +
      'НЕ перечисляй свои возможности вместо ответа. НЕ говори "не могу помочь". ' +
      'Просто ОТВЕТЬ на вопрос — развёрнуто, полезно, по существу.';
  }
  return fullContext;
};

/** Маппинг кодов ошибок → сообщения для пользователя */
const AI_ERROR_MESSAGES: Record<string, string> = {
  MODEL_NOT_FOUND: '❌ Модель AI не найдена!\n\nТекущая модель не существует на OpenRouter.\nАдминистратор должен изменить модель в настройках:\nhttps://amina-admin.onrender.com/settings',
  AUTH_ERROR: '🔑 Ошибка авторизации AI!\n\nНеверный API ключ OpenRouter.\nАдминистратор должен проверить настройки в Render.',
  RATE_LIMIT: '⏳ Слишком много запросов!\n\nЛимит OpenRouter превышен. Подожди минуту и попробуй снова.',
  PAYMENT_REQUIRED: '💳 Пополни баланс на OpenRouter или выбери бесплатную модель в админке.',
  ALL_MODELS_FAILED: '🔄 Все бесплатные модели AI заняты.\n\nПопробуй через 30 секунд или напиши /start для сброса.',
  RACE_TIMEOUT: '⏰ AI отвечает слишком долго.\n\nПопробуй ещё раз — может повезёт быстрее!',
  SERVER_ERROR: '🔧 Сервер AI временно недоступен.\n\nПопробуй через несколько минут.',
};

const AI_ERROR_DEFAULT = '😔 Извини, произошла ошибка. Попробуй ещё раз.';

/** Форматирует ошибку AI для пользователя */
const formatAIError = (errorCode: string | undefined, errorMessage: string): string => {
  if (errorCode && AI_ERROR_MESSAGES[errorCode]) return AI_ERROR_MESSAGES[errorCode];
  // Fallback: ищем код в тексте ошибки
  for (const [code, msg] of Object.entries(AI_ERROR_MESSAGES)) {
    if (errorMessage.includes(code)) return msg;
  }
  if (errorMessage.includes('429') || errorMessage.includes('rate limit')) return AI_ERROR_MESSAGES.RATE_LIMIT ?? AI_ERROR_DEFAULT;
  if (errorMessage.includes('500') || errorMessage.includes('502')) return AI_ERROR_MESSAGES.SERVER_ERROR ?? AI_ERROR_DEFAULT;
  return AI_ERROR_DEFAULT;
};

// ============================================
// Shared AI Response Pipeline (DRY)
// ============================================

/**
 * Общий пайплайн обработки сообщения через AI.
 * Используется и для текста, и для голоса — устраняет ~80% дублирования.
 */
const processMessageThroughAI = async (
  ctx: BotContext,
  userText: string,
  userId: string,
  chatId: number,
  startTime: number,
  telegramInfo: TelegramUserInfo,
  messageType: 'message' | 'voice',
  extraMetadata?: Record<string, unknown>,
): Promise<void> => {
  // Ensure conversation
  await ensureConversation(ctx, userId, chatId);

  // Определяем — здоровалась ли Амина сегодня (из БД, не session)
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' }).format(now);
  const lastGreetingDate = await userProfileRepo.getLastGreetingDate(userId);
  const alreadyGreetedToday = lastGreetingDate === todayStr;

  // Build context in parallel
  const { memoryContext, webSearchContext } = await buildFullContext(userId, userText, telegramInfo.first_name, telegramInfo, alreadyGreetedToday);

  // Build user message — inject user name/context directly so weak models can't miss it
  const userName = telegramInfo.first_name || telegramInfo.username || null;
  const contextPrefix = userName
    ? `[Меня зовут ${userName}. Обращайся ко мне по имени.]\n`
    : '';
  const augmentedUserText = contextPrefix + userText;

  // Add to history (original text without prefix to keep history clean)
  ctx.session.messageHistory.push({ role: 'user', content: userText });
  if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
    ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
  }

  // Build messages: deduplicate similar past questions to prevent model from copying old answers
  const historyWithoutLast = ctx.session.messageHistory.slice(0, -1);
  const deduped = deduplicateSimilarQuestions(historyWithoutLast, userText);
  const messagesForAI: typeof ctx.session.messageHistory = [
    ...deduped,
    { role: 'user', content: augmentedUserText },
  ];

  // Build full context with search warning
  let fullContext = memoryContext + webSearchContext;
  fullContext = addSearchWarning(fullContext, userText, webSearchContext, userId);

  // Get AI response (use augmented messages so name is always visible to model)
  let aiResponse = await aiService.chat(messagesForAI, 'telegram', fullContext);

  // Enhance with web search if AI is uncertain
  if (!webSearchContext) {
    const enhanced = await enhanceResponseIfNeeded(userText, aiResponse.content);
    if (enhanced.wasEnhanced) {
      aiResponse = { ...aiResponse, content: enhanced.response };
      telegramLogger.info({ userId }, `${messageType}: response enhanced with web search`);
    }
  }

  // Verify & protect from search simulation/refusal/ignorance
  // Применяем ко ВСЕМ типам сообщений (text + voice), т.к. голосовые проходят
  // тот же AI pipeline и бесплатные LLM отказывают одинаково для обоих типов
  aiResponse = await processAIResponse(aiResponse, userText, userId, webSearchContext);

  // Replace placeholder [Имя]/[Name] that weak models sometimes leave
  if (userName) {
    aiResponse = {
      ...aiResponse,
      content: aiResponse.content
        .replace(/\[Имя\]/gi, userName)
        .replace(/\[Name\]/gi, userName)
        .replace(/\[Пользователь\]/gi, userName)
        .replace(/\[User\]/gi, userName),
    };
  }

  // Save to history (skip gibberish to avoid poisoning context)
  if (!isGibberish(aiResponse.content)) {
    ctx.session.messageHistory.push({ role: 'assistant', content: aiResponse.content });
    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
      ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
    }
  } else {
    telegramLogger.warn({ userId, contentPreview: aiResponse.content.slice(0, 100) }, 'Gibberish response detected — not saving to history');
  }

  // Post-AI image interception
  if (await tryPostAIImageInterception(ctx, aiResponse.content, userText, userId)) return;

  // === ПРОГРАММНОЕ удаление повторного приветствия ===
  // Бесплатные модели часто ИГНОРИРУЮТ инструкцию "не здоровайся повторно",
  // поэтому убираем приветствие на уровне кода, а не полагаемся на LLM
  let finalContent = aiResponse.content;
  const greetingRegex = /^(привет[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?(?:👋\s*)?[\n\r]*|здравствуй(?:те)?[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|добр(?:ое|ый|ая)\s+(?:утро|утра|день|дня|вечер|вечера|ночь|ночи)[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?(?:☀️|🌞|🌙|🌅)?\s*[\n\r]*|хай[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|салют[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|приветствую[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*)/i;

  if (!alreadyGreetedToday) {
    // Первое приветствие за день — оставляем, запоминаем в БД
    if (greetingRegex.test(finalContent.trim())) {
      userProfileRepo.setLastGreetingDate(userId, todayStr).catch(() => {});
    }
  } else {
    // Уже здоровалась сегодня — вырезаем приветствие из начала ответа
    const stripped = finalContent.trim().replace(greetingRegex, '').replace(/^[\s\n\r]+/, '');
    if (stripped.length > 10) {
      finalContent = stripped;
      telegramLogger.debug({ userId }, 'Stripped repeated greeting from AI response');
    }
  }

  // Send response
  await sendLongMessage(ctx, finalContent, responseActionsKeyboard());

  // Fire-and-forget DB writes
  const responseTime = Date.now() - startTime;
  const convId = ctx.session.conversationId;
  userProfileRepo.updateOnMessage(userId, messageType, aiResponse.tokens_used.total, telegramInfo).catch(() => {});
  userLogsRepo.add(userId, 'ai_response', aiResponse.content, { chatId, type: messageType, responseLength: aiResponse.content.length }, {
    model: aiResponse.model, tokensPrompt: aiResponse.tokens_used.prompt, tokensCompletion: aiResponse.tokens_used.completion, responseTimeMs: responseTime,
  }).catch(() => {});
  memoryExtractor.extractFacts(userId, userText, aiResponse.content).catch((err) => {
    telegramLogger.warn({ error: err, userId }, 'extractFacts failed');
  });

  // Автосуммаризация: по счётчику сообщений (а не length, т.к. history capped at 20)
  ctx.session.messageCount = (ctx.session.messageCount ?? 0) + 1;
  if (ctx.session.messageCount % AUTO_SUMMARY_INTERVAL === 0) {
    memoryExtractor.summarizeConversation(userId, ctx.session.messageHistory).catch((err) => {
      telegramLogger.warn({ error: err, userId }, 'summarizeConversation failed');
    });
  }

  if (convId) {
    const nowISO = new Date().toISOString();
    Promise.all([
      conversationsRepo.addMessage(convId, { role: 'user', content: userText, timestamp: nowISO, metadata: extraMetadata }),
      conversationsRepo.addMessage(convId, { role: 'assistant', content: aiResponse.content, timestamp: nowISO, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } }),
      analyticsRepo.log('ai_response', 'telegram', { userId, type: messageType, model: aiResponse.model, tokens: aiResponse.tokens_used.total }),
    ]).catch((err) => { telegramLogger.warn({ error: err, userId }, `Background ${messageType} DB writes failed`); });
  }

  telegramLogger.info({ userId, tokens: aiResponse.tokens_used.total, responseTimeMs: responseTime }, `${messageType} response sent`);
};

// ============================================
// Post-AI Image Interception (safety net)
// ============================================

/**
 * Если основная AI ответила "я не умею создавать картинки" или подобное —
 * значит пользователь хотел картинку, но pre-AI детекция (regex + Groq) не сработала.
 * Перехватываем ответ и генерируем картинку вместо отправки отказа.
 */
const tryPostAIImageInterception = async (
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
    // Используем Groq для извлечения промпта из оригинального сообщения
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
    return true; // Считаем обработанным — не отправляем оригинальный отказ AI
  }
};

// ============================================
// Text Message Handler
// ============================================

const handleTextMessage = async (ctx: BotContext): Promise<void> => {
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
    ctx.session.awaitingImagePrompt = false; // сбрасываем флаг
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
      await notesRepo.create(userId, userMessage);
      await ctx.reply(`📌 Заметка сохранена!\n\n<i>${escapeHtml(userMessage)}</i>`, {
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
    const isEditIntent = detectImageEditIntent(userMessage) || await classifyImageEditIntentGroq(userMessage);
    if (isEditIntent) {
      telegramLogger.info({ userId, prompt: userMessage.substring(0, 60) }, 'Image edit detected via reply to photo/document');
      try {
        let imageData;
        if (replyPhoto && replyPhoto.length > 0) {
          imageData = await downloadTelegramPhoto(ctx, replyPhoto);
        } else {
          // Download document image
          const file = await ctx.api.getFile(replyDoc!.file_id);
          if (!file.file_path) throw new Error('File path not found');
          const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
          const resp = await fetch(fileUrl);
          if (!resp.ok) throw new Error('Failed to download document');
          imageData = {
            base64: Buffer.from(await resp.arrayBuffer()).toString('base64'),
            mimeType: replyDoc!.mime_type!,
          };
        }
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
    if (await handleAutoDetections(ctx, userMessage, userId, chatId)) return;

    if (shouldForceWebSearch(userMessage) || needsWebSearch(userMessage)) {
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

// ============================================
// Voice Message Handler
// ============================================

/** Маппинг кодов ошибок голоса → сообщения */
const VOICE_ERROR_MESSAGES: Record<string, string> = {
  AUDIO_MODEL_NOT_FOUND: '🔧 Audio модель не найдена.\n\nОбратитесь к администратору.',
  AUDIO_NOT_SUPPORTED: '🔧 Модель не поддерживает аудио.\n\nОбратитесь к администратору.',
  AUTH_ERROR: '🔑 Ошибка авторизации API. Обратитесь к администратору.',
  GROQ_AUTH_ERROR: '🔑 Ошибка авторизации API. Обратитесь к администратору.',
  RATE_LIMIT: '⏳ Слишком много запросов! Подожди минуту.',
  ALL_MODELS_FAILED: '🔄 Все модели AI заняты. Попробуй через 30 секунд.',
  RACE_TIMEOUT: '⏰ AI отвечает слишком долго. Попробуй ещё раз!',
  SERVER_ERROR: '🔧 Сервер AI временно недоступен.',
  FILE_TOO_LARGE: '📁 Голосовое сообщение слишком длинное.',
};

const handleVoiceMessage = async (ctx: BotContext): Promise<void> => {
  if (!ctx.from?.id) {
    telegramLogger.warn('Voice message without from.id — ignoring');
    return;
  }
  if (!ctx.chat?.id) {
    telegramLogger.warn('Voice message without chat.id — ignoring');
    return;
  }
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id;
  const duration = ctx.message?.voice?.duration ?? 0;
  const startTime = Date.now();

  telegramLogger.info({ userId, duration }, 'Voice message received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) {
    await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
    return;
  }

  analyticsRepo.log('message_received', 'telegram', { userId, type: 'voice', duration }).catch(() => {});
  await ctx.replyWithChatAction('typing');

  try {
    // Download & transcribe voice
    const file = await ctx.getFile();
    if (!file.file_path) throw Object.assign(new Error('Telegram не вернул путь к файлу'), { code: 'FILE_NOT_FOUND' });
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;

    telegramLogger.debug({ filePath: file.file_path }, 'Downloading voice file');
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download voice file: ${response.status}`);

    const audioArrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(audioArrayBuffer);
    const audioBase64 = audioBuffer.toString('base64');
    
    // Запускаем загрузку в Storage и транскрипцию ПАРАЛЛЕЛЬНО
    const voiceFilePath = `${userId}/${Date.now()}_${file.file_unique_id}.ogg`;
    const uploadPromise = voiceMessagesRepo.upload(audioBuffer, voiceFilePath, userId, duration, file.file_unique_id)
      .catch(err => { telegramLogger.warn({ error: err, userId }, 'Voice storage upload failed (non-critical)'); return null; });

    const transcription = await transcribeAudio(audioBase64, 'audio/ogg');
    const transcribedText = transcription.text;
    telegramLogger.debug({ userId, transcription: transcribedText.substring(0, 100) }, 'Voice transcribed');
    
    // Дожидаемся upload и обновляем транскрипцию (fire-and-forget)
    uploadPromise.then(record => {
      if (record?.id) {
        voiceMessagesRepo.updateTranscription(record.id, transcribedText)
          .catch(err => telegramLogger.warn({ error: err }, 'Failed to update voice transcription'));
      }
    }).catch(() => {});

    const telegramInfo: TelegramUserInfo = {
      id: ctx.from?.id ?? 0, username: ctx.from?.username,
      first_name: ctx.from?.first_name, last_name: ctx.from?.last_name,
      language_code: ctx.from?.language_code,
    };

    // === PATH C: Voice reply to photo → image edit ===
    const replyMsg = ctx.message?.reply_to_message;
    const voiceReplyPhoto = replyMsg?.photo;
    const voiceReplyDoc = replyMsg?.document;
    const isImageDoc = voiceReplyDoc?.mime_type?.startsWith('image/');

    if ((voiceReplyPhoto && voiceReplyPhoto.length > 0) || isImageDoc) {
      const isEditIntent = detectImageEditIntent(transcribedText) || await classifyImageEditIntentGroq(transcribedText);
      if (isEditIntent) {
        telegramLogger.info({ userId, prompt: transcribedText.substring(0, 60) }, 'Image edit detected via voice reply to photo/document');
        try {
          let imageData;
          if (voiceReplyPhoto && voiceReplyPhoto.length > 0) {
            imageData = await downloadTelegramPhoto(ctx, voiceReplyPhoto);
          } else {
            // Download document image
            const file = await ctx.api.getFile(voiceReplyDoc!.file_id);
            if (!file.file_path) throw new Error('File path not found');
            const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
            const resp = await fetch(fileUrl);
            if (!resp.ok) throw new Error('Failed to download document');
            imageData = {
              base64: Buffer.from(await resp.arrayBuffer()).toString('base64'),
              mimeType: voiceReplyDoc!.mime_type!,
            };
          }
          await handleImageEdit(ctx, imageData.base64, imageData.mimeType, transcribedText, userId);
        } catch (editError) {
          const editMsg = editError instanceof Error ? editError.message : 'Не удалось отредактировать изображение.';
          telegramLogger.error({ error: editError, userId }, 'Voice reply-to-image edit failed');
          await ctx.reply(`😔 ${editMsg}`);
        }
        return;
      }
    }

    // Auto-detections
    if (await handleAutoDetections(ctx, transcribedText, userId, chatId)) return;

    // Direct web search
    if (shouldForceWebSearch(transcribedText) || needsWebSearch(transcribedText)) {
      const handled = await handleDirectWebSearch(ctx, transcribedText, userId, chatId, startTime);
      if (handled) return;
    }

    // Use shared AI pipeline
    await processMessageThroughAI(ctx, transcribedText, userId, chatId, startTime, telegramInfo, 'voice', { type: 'voice', voice_duration: duration });
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process voice message');
    const errorCode = getErrorCode(error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    analyticsRepo.log('error', 'telegram', { userId, type: 'voice', error: errorMsg, errorCode }).catch(() => {});
    await ctx.reply(errorCode ? (VOICE_ERROR_MESSAGES[errorCode] ?? formatAIError(errorCode, errorMsg)) : formatAIError(errorCode, errorMsg));
  }
};

// ============================================
// Photo Download Helper (shared by photo handler + reply-to-photo edit)
// ============================================

/**
 * Скачивает фото из Telegram по массиву PhotoSize.
 * Возвращает { base64, mimeType } для дальнейшей обработки.
 */
const downloadTelegramPhoto = async (
  ctx: BotContext,
  photos: Array<{ file_id: string; width: number; height: number }>,
): Promise<{ base64: string; mimeType: string }> => {
  const largestPhoto = photos[photos.length - 1];
  if (!largestPhoto) throw new Error('No photo found in message');
  const file = await ctx.api.getFile(largestPhoto.file_id);
  if (!file.file_path) throw Object.assign(new Error('Telegram не вернул путь к файлу'), { code: 'FILE_NOT_FOUND' });

  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download photo: ${response.status}`);

  const base64 = Buffer.from(await response.arrayBuffer()).toString('base64');
  const mimeType = file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { base64, mimeType };
};

// ============================================
// Image Edit Handler (shared logic for all entry points)
// ============================================

const handleImageEdit = async (
  ctx: BotContext,
  imageBase64: string,
  mimeType: string,
  editPrompt: string,
  userId: string,
): Promise<void> => {
  const statusMsg = await ctx.reply('✏️ Редактирую изображение... Это может занять 10-30 секунд.');
  await ctx.replyWithChatAction('upload_photo');

  try {
    const result = await editImage(imageBase64, mimeType, editPrompt);
    const timeSeconds = (result.generationTimeMs / 1000).toFixed(1);

    await ctx.replyWithPhoto(
      new InputFile(result.image, 'edited.png'),
      {
        caption: `✏️ <b>Отредактировано</b>\n📝 ${escapeHtml(editPrompt)}\n⏱ ${timeSeconds}с | ${result.model}\n\n💡 <i>Ответь на это фото, чтобы продолжить редактирование</i>`,
        parse_mode: 'HTML',
      }
    );

    ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

    analyticsRepo.log('message_sent', 'telegram', {
      userId, type: 'image_edit', model: result.model, timeMs: result.generationTimeMs,
    }).catch(() => {});
    telegramLogger.info({ userId, prompt: editPrompt.substring(0, 60), model: result.model, timeMs: result.generationTimeMs }, 'Image edited successfully');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Не удалось отредактировать изображение.';
    telegramLogger.error({ error, userId, prompt: editPrompt.substring(0, 60) }, 'Image edit failed');
    analyticsRepo.log('error', 'telegram', { userId, type: 'image_edit', error: errorMsg }).catch(() => {});
    ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(`😔 ${errorMsg}`);
  }
};

// ============================================
// Photo Message Handler
// ============================================

const handlePhotoMessage = async (ctx: BotContext): Promise<void> => {
  if (!ctx.from?.id) {
    telegramLogger.warn('Photo message without from.id — ignoring');
    return;
  }
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat?.id ?? 0;
  const caption = ctx.message?.caption;

  telegramLogger.info({ userId, hasCaption: !!caption }, 'Photo message received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) { await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.'); return; }

  analyticsRepo.log('message_received', 'telegram', { userId, type: 'photo', hasCaption: !!caption }).catch(() => {});

  try {
    const photos = ctx.message?.photo ?? [];
    const { base64: imageBase64, mimeType } = await downloadTelegramPhoto(ctx, photos);

    // === PATH A: Фото + caption с edit-ключевыми словами → редактирование ===
    const isEditIntent = caption ? (detectImageEditIntent(caption) || await classifyImageEditIntentGroq(caption)) : false;
    if (isEditIntent) {
      telegramLogger.info({ userId, caption: caption?.substring(0, 60) }, 'Image edit detected via photo caption');
      await handleImageEdit(ctx, imageBase64, mimeType, caption!, userId);
      return;
    }

    // === Стандартный flow: vision analysis ===
    await ctx.replyWithChatAction('typing');
    await ensureConversation(ctx, userId, chatId);

    const aiResponse = await processImageWithLLM(imageBase64, mimeType, caption, ctx.session.messageHistory);
    const userContent = caption ? `[Изображение с подписью: "${caption}"]` : '[Изображение]';

    ctx.session.messageHistory.push({ role: 'user', content: userContent }, { role: 'assistant', content: aiResponse.content });
    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
      ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    const convId = ctx.session.conversationId;
    if (convId) {
      const nowISO = new Date().toISOString();
      Promise.all([
        conversationsRepo.addMessage(convId, { role: 'user', content: userContent, timestamp: nowISO, metadata: { type: 'photo' } }),
        conversationsRepo.addMessage(convId, { role: 'assistant', content: aiResponse.content, timestamp: nowISO, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } }),
        analyticsRepo.log('ai_response', 'telegram', { userId, type: 'photo', model: aiResponse.model, tokens: aiResponse.tokens_used.total }),
      ]).catch((err) => { telegramLogger.warn({ error: err, userId }, 'Background photo DB writes failed'); });
    }

    await sendLongMessage(ctx, aiResponse.content);
    telegramLogger.info({ userId, tokens: aiResponse.tokens_used.total }, 'Photo response sent');
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process photo');
    const errorCode = getErrorCode(error);
    analyticsRepo.log('error', 'telegram', { userId, type: 'photo', error: error instanceof Error ? error.message : 'Unknown', errorCode }).catch(() => {});

    let msg = '😔 Не удалось обработать изображение. Попробуй ещё раз.';
    if (errorCode === 'VISION_MODEL_NOT_FOUND') msg = '🔧 Vision модель не найдена.\n\nВ админке выберите другую модель.';
    else if (errorCode === 'VISION_SERVICE_UNAVAILABLE') msg = '⏳ Сервис анализа фото недоступен. Попробуй через минуту.';
    else if (errorCode === 'AUTH_ERROR') msg = '🔑 Ошибка авторизации API.';
    else if (errorCode === 'ALL_MODELS_FAILED') msg = '🔄 Все модели AI заняты. Через 30 сек.';
    else if (errorCode === 'RATE_LIMIT') msg = '⏳ Слишком много запросов!';

    await ctx.reply(msg);
  }
};

// ============================================
// Document (Image) Handler
// ============================================

const handleDocumentMessage = async (ctx: BotContext): Promise<void> => {
  if (!ctx.from?.id) {
    telegramLogger.warn('Document message without from.id — ignoring');
    return;
  }
  const userId = ctx.from.id.toString();
  const document = ctx.message?.document;
  if (!document) return;
  const mimeType = document.mime_type ?? '';

  if (!mimeType.startsWith('image/')) {
    await ctx.reply('📄 Пока что я могу анализировать только изображения. Отправь фото или картинку.');
    return;
  }

  telegramLogger.info({ userId, mimeType, fileName: document.file_name }, 'Document image received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) { await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.'); return; }

  analyticsRepo.log('message_received', 'telegram', { userId, type: 'document_image', mimeType }).catch(() => {});
  await ctx.replyWithChatAction('typing');

  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw Object.assign(new Error('Telegram не вернул путь к файлу'), { code: 'FILE_NOT_FOUND' });

    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download document: ${response.status}`);

    const imageBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    const caption = ctx.message?.caption;
    const chatId = ctx.chat?.id ?? 0;

    // === PATH A: Документ + caption с edit-ключевыми словами → редактирование ===
    const isEditIntent = caption ? (detectImageEditIntent(caption) || await classifyImageEditIntentGroq(caption)) : false;
    if (isEditIntent) {
      telegramLogger.info({ userId, caption: caption?.substring(0, 60) }, 'Image edit detected via document caption');
      await handleImageEdit(ctx, imageBase64, mimeType, caption!, userId);
      return;
    }

    await ensureConversation(ctx, userId, chatId);

    const aiResponse = await processImageWithLLM(imageBase64, mimeType, caption, ctx.session.messageHistory);
    const userContent = caption ? `[Изображение "${document.file_name}" с подписью: "${caption}"]` : `[Изображение "${document.file_name}"]`;

    ctx.session.messageHistory.push({ role: 'user', content: userContent }, { role: 'assistant', content: aiResponse.content });
    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
      ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    const convId = ctx.session.conversationId;
    if (convId) {
      const nowISO = new Date().toISOString();
      Promise.all([
        conversationsRepo.addMessage(convId, { role: 'user', content: userContent, timestamp: nowISO, metadata: { type: 'document_image', fileName: document.file_name } }),
        conversationsRepo.addMessage(convId, { role: 'assistant', content: aiResponse.content, timestamp: nowISO, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } }),
        analyticsRepo.log('ai_response', 'telegram', { userId, type: 'document_image', model: aiResponse.model, tokens: aiResponse.tokens_used.total }),
      ]).catch((err) => { telegramLogger.warn({ error: err, userId }, 'Background document DB writes failed'); });
    }

    await sendLongMessage(ctx, aiResponse.content);
    telegramLogger.info({ userId }, 'Document image response sent');
  } catch (error) {
    telegramLogger.error({ error, userId }, 'Failed to process document image');
    analyticsRepo.log('error', 'telegram', { userId, type: 'document_image', error: error instanceof Error ? error.message : 'Unknown' }).catch(() => {});
    await ctx.reply('😔 Не удалось обработать изображение. Попробуй ещё раз.');
  }
};

// ============================================
// Direct Web Search Handler
// ============================================

const handleDirectWebSearch = async (
  ctx: BotContext,
  userMessage: string,
  userId: string,
  chatId: number,
  startTime: number,
): Promise<boolean> => {
  const searchEnabled = await isWebSearchEnabled();
  if (!searchEnabled) {
    telegramLogger.warn({ userId }, 'Web search disabled — falling through to AI');
    return false;
  }

  await ctx.replyWithChatAction('typing');

  try {
    telegramLogger.info({ userId, query: userMessage.substring(0, 80) }, 'Direct web search started');
    const searchResult = await webSearch(userMessage);
    telegramLogger.info({ userId, model: searchResult.model, tokens: searchResult.tokens_used.total }, 'Direct web search succeeded');

    // Format through LLM — с УСИЛЕННЫМИ инструкциями + citations map
    const timeContext = buildTimeContext(ctx.from?.first_name);
    
    // Передаём карту ссылок чтобы LLM мог вставлять [N] → кликабельные ссылки
    const citationsMap = searchResult.citations.length > 0
      ? `\n\nКАРТА ИСТОЧНИКОВ (используй номера [N] в тексте):\n${searchResult.citations.map((url, i) => `[${i + 1}] ${url}`).join('\n')}`
      : '';
    
    const searchContext = `${timeContext}\n\n=== ДАННЫЕ ИЗ ИНТЕРНЕТА (${new Date().toLocaleDateString('ru-RU')}) ===\n${searchResult.answer}${citationsMap}\n=== КОНЕЦ ДАННЫХ ===\n\n` +
      `КРИТИЧЕСКАЯ ИНСТРУКЦИЯ (ОБЯЗАТЕЛЬНО ВЫПОЛНИ):\n` +
      `1. Данные из интернета УЖЕ НАЙДЕНЫ и предоставлены выше — ИСПОЛЬЗУЙ ИХ!\n` +
      `2. Перескажи эти данные пользователю красиво, структурированно, своими словами.\n` +
      `3. Для КАЖДОГО пункта новости/факта сохраняй ссылку [N] на источник — пользователь должен видеть откуда информация.\n` +
      `4. АБСОЛЮТНО ЗАПРЕЩЕНО: писать "не могу искать", "нет доступа к интернету", "не удалось найти" — данные ЕСТЬ выше!\n` +
      `5. АБСОЛЮТНО ЗАПРЕЩЕНО: писать "Ищу...", "Поиск...", "Сейчас найду..."\n` +
      `6. АБСОЛЮТНО ЗАПРЕЩЕНО: игнорировать данные и предлагать пользователю искать самостоятельно.\n` +
      `7. Просто возьми данные из блока "=== ДАННЫЕ ИЗ ИНТЕРНЕТА ===" и представь их.`;

    await ensureConversation(ctx, userId, chatId);
    ctx.session.messageHistory.push({ role: 'user', content: userMessage });
    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
      ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    await ctx.replyWithChatAction('typing');
    const response = await aiService.chat(ctx.session.messageHistory, 'telegram', searchContext);

    // If LLM still simulates search OR refuses to use data — use raw results
    let finalContent = response.content;
    const llmRefusedSearch = looksLikeSearchSimulation(finalContent) || looksLikeSearchRefusal(finalContent);
    if (llmRefusedSearch) {
      telegramLogger.warn({ userId, reason: looksLikeSearchSimulation(finalContent) ? 'simulation' : 'refusal' }, 'LLM ignored/refused search data — using raw results');
      finalContent = searchResult.answer;
    }
    
    // Инлайн citations: [1] → кликабельная ссылка на источник
    if (searchResult.citations.length > 0) {
      finalContent = inlineCitations(finalContent, searchResult.citations);
    }

    ctx.session.messageHistory.push({ role: 'assistant', content: finalContent });

    const searchKeyboard = new InlineKeyboard().text('📌 В заметки', 'save_to_notes').text('🔊 Озвучить', 'read_aloud');
    await sendLongMessage(ctx, finalContent, searchKeyboard);

    // Fire-and-forget analytics
    const responseTime = Date.now() - startTime;
    const telegramInfo: TelegramUserInfo = {
      id: ctx.from?.id ?? 0, first_name: ctx.from?.first_name, last_name: ctx.from?.last_name,
      username: ctx.from?.username, language_code: ctx.from?.language_code,
    };
    userProfileRepo.updateOnMessage(userId, 'message', response.tokens_used.total, telegramInfo).catch(() => {});
    const convId = ctx.session.conversationId;
    if (convId) {
      const nowISO = new Date().toISOString();
      conversationsRepo.addMessage(convId, { role: 'user', content: userMessage, timestamp: nowISO }).catch((err) => { telegramLogger.warn({ error: err }, 'Search DB write failed'); });
      conversationsRepo.addMessage(convId, { role: 'assistant', content: finalContent, timestamp: nowISO }).catch((err) => { telegramLogger.warn({ error: err }, 'Search DB write failed'); });
    }
    analyticsRepo.log('message_sent', 'telegram', { userId, model: response.model, tokens: response.tokens_used.total, responseTimeMs: responseTime, webSearch: true, webSearchModel: searchResult.model }).catch(() => {});

    telegramLogger.info({ userId, responseTimeMs: responseTime, webSearchModel: searchResult.model }, 'Direct search response sent');
    return true;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const errCode = (error as { code?: string })?.code ?? 'UNKNOWN';
    telegramLogger.error({ error: err.message, code: errCode, userId, query: userMessage.substring(0, 80) }, 'Direct web search FAILED → falling through to LLM');
    // НЕ показываем ошибку пользователю — сообщение пройдёт через processMessageThroughAI
    // и LLM ответит из своих знаний. Премиум-бот НИКОГДА не показывает ошибки вместо ответа.
    return false;
  }
};

// ============================================
// History Sanitization
// ============================================

/** Очищает историю от отравленных ответов и симуляций поиска */
/**
 * Removes past Q+A pairs where the user's question is similar to the current one.
 * Prevents weak models from copying their own previous answers verbatim.
 */
const deduplicateSimilarQuestions = (
  history: AIMessage[],
  currentQuestion: string,
): AIMessage[] => {
  const currentNorm = currentQuestion.toLowerCase().trim().replace(/[?!.,\s]+/g, ' ');
  if (currentNorm.length < 5) return history;

  const indicesToRemove = new Set<number>();

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg || msg.role !== 'user') continue;
    const pastNorm = msg.content.toLowerCase().trim().replace(/[?!.,\s]+/g, ' ');
    const isSimilar =
      pastNorm === currentNorm ||
      currentNorm.includes(pastNorm) ||
      pastNorm.includes(currentNorm);
    if (isSimilar) {
      indicesToRemove.add(i);
      if (i + 1 < history.length && history[i + 1]?.role === 'assistant') {
        indicesToRemove.add(i + 1);
      }
    }
  }

  if (indicesToRemove.size > 0) {
    telegramLogger.debug({ removed: indicesToRemove.size }, 'Deduped similar Q&A from history');
  }
  return history.filter((_, idx) => !indicesToRemove.has(idx));
};

const sanitizeMessageHistory = (history: AIMessage[]): AIMessage[] => {
  if (history.length === 0) return history;

  // Remove search simulations
  let cleaned = history.filter(m => !(m.role === 'assistant' && looksLikeSearchSimulation(m.content)));

  // Detect context poisoning (same response 2+ times)
  const assistantResponses = cleaned.filter(m => m.role === 'assistant');
  const responseCounts = new Map<string, number>();
  for (const msg of assistantResponses) {
    const key = msg.content.substring(0, 100);
    responseCounts.set(key, (responseCounts.get(key) || 0) + 1);
  }

  const poisonedPrefixes = new Set<string>();
  for (const [prefix, count] of responseCounts) {
    if (count >= 2) poisonedPrefixes.add(prefix);
  }

  if (poisonedPrefixes.size > 0) {
    telegramLogger.warn({ poisonedCount: poisonedPrefixes.size, historyBefore: cleaned.length }, 'Context poisoning detected');
    const seen = new Set<string>();
    cleaned = cleaned.filter(m => {
      if (m.role !== 'assistant') return true;
      const prefix = m.content.substring(0, 100);
      if (poisonedPrefixes.has(prefix)) {
        if (seen.has(prefix)) return false;
        seen.add(prefix);
      }
      return true;
    });
    telegramLogger.info({ historyAfter: cleaned.length }, 'History sanitized');
  }

  return cleaned;
};
