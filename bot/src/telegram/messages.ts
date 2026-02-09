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
import { aiService } from '../ai/openrouter.js';
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
import { detectReminderIntent, extractReminder } from '../reminders/reminder-parser.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { detectImageGenIntent, extractImagePrompt, generateImage, classifyImageIntentGroq, isAIResponseAboutImages } from '../ai/image-gen.js';
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

const buildReplyButtonHandlers = (ctx: BotContext, userId: string): Record<string, () => Promise<void>> => ({
  '🌐 Поиск': async () => {
    await ctx.reply('🔍 *Что найти в интернете?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingSearchQuery = true;
  },
  '🎨 Картинка': async () => {
    await ctx.reply('🎨 *Что нарисовать?*', { parse_mode: 'Markdown' });
    ctx.session.awaitingImagePrompt = true;
  },
  '📌 Заметки': async () => {
    try {
      const notes = await notesRepo.getByUser(userId);
      if (notes.length === 0) {
        await ctx.reply('📋 *Что запомнить?*', { parse_mode: 'Markdown' });
        ctx.session.awaitingNoteContent = true;
      } else {
        const lines = notes.map((n, i) => {
          // Усекаем длинные заметки при отображении (макс. 120 символов)
          const preview = n.content.length > 120 ? n.content.slice(0, 120).trimEnd() + '…' : n.content;
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
        await ctx.reply('✅ *Какую задачу добавить?*', { parse_mode: 'Markdown' });
        ctx.session.awaitingTodoTask = true;
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
          const d = new Date(r.scheduled_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. ${r.task} — ⏰ ${d}`;
        });
        await ctx.reply(`⏰ *Напоминания (${reminders.length}):*\n\n${lines.join('\n')}\n\n_/remind\\_cancel номер_`, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      telegramLogger.warn({ error: err, userId }, 'Failed to load reminders via button');
      await ctx.reply('😔 Не удалось загрузить напоминания.');
    }
  },
  '☀️ Дайджест': async () => {
    const prefs = await userPrefsRepo.get(userId);
    const status = prefs?.digest_enabled ? '✅ Включён' : '❌ Выключен';
    await ctx.reply(
      `☀️ *Дайджест:* ${status}\n\nВремя: ${prefs?.digest_hour ?? 10}:00 | Город: ${prefs?.digest_city ?? 'Гродно'}`,
      { parse_mode: 'Markdown', reply_markup: digestToggleKeyboard(prefs?.digest_enabled ?? false) }
    );
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
  // === Напоминания ===
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
    const isObviouslyNotImage = /^(назови|расскажи|найди|подскажи|посоветуй|порекомендуй|перечисли|объясни|сколько|когда|где|кто|что|как |какой|какая|какие|зачем|почему)\b/i.test(text.trim())
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
        { caption: `🎨 ${escapeMarkdown(cleanPrompt)}\n⏱ ${timeSeconds}с | FLUX.1-schnell` }
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
    memoryContextBuilder.buildContext(userId, telegramInfo ?? ({} as TelegramUserInfo)).catch((err) => {
      telegramLogger.warn({ error: err, userId }, 'Failed to build memory context');
      return '';
    }),
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
 * Обрабатывает AI-ответ: верификация через Perplexity, защита от симуляции и галлюцинаций.
 * 
 * Стратегия:
 * 1. Верификатор проверяет ответ (симуляция, отказ, галлюцинации)
 * 2. Если верификатор обнаружил проблему И дал correctedResponse → используем его
 * 3. Regex-детекция симуляции → замена на реальные данные
 * 4. НОВОЕ: если Perplexity данные БЫЛИ в контексте но LLM их проигнорировала →
 *    извлекаем и возвращаем данные НАПРЯМУЮ из контекста (без повторного API-вызова!)
 * 5. Если ничего не помогло → возвращаем оригинал
 */
const processAIResponse = async (
  response: AIResponse,
  userMessage: string,
  userId: string,
  webSearchContext: string,
): Promise<AIResponse> => {
  // === Верификация через Perplexity ===
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

    // Если верификатор дал исправленный ответ (из Perplexity) — используем его
    if (verification.correctedResponse) {
      telegramLogger.info({ userId, reason: verification.reason }, '✅ Using Perplexity-verified response instead of LLM hallucination');
      return {
        ...response,
        content: verification.correctedResponse,
      };
    }
  }

  // === Fallback 1: regex-детекция симуляции ===
  if (looksLikeSearchSimulation(response.content)) {
    telegramLogger.warn({ userId, responseSnippet: response.content.substring(0, 100) }, 'LLM simulated search (regex fallback)');

    // Сначала пробуем извлечь данные прямо из контекста (уже есть, не нужен API-вызов!)
    if (webSearchContext) {
      const fallback = formatPerplexityFallback(webSearchContext);
      if (fallback) {
        telegramLogger.info({ userId }, '✅ Replaced simulation with cached Perplexity data (from context)');
        return { ...response, content: fallback };
      }
    }

    // Если контекста нет — пытаемся вызвать Perplexity напрямую
    try {
      const { webSearch: doSearch } = await import('../ai/websearch.js');
      const searchResult = await doSearch(userMessage);
      if (searchResult.answer && searchResult.answer.length > 30) {
        let corrected = searchResult.answer;
        if (searchResult.citations.length > 0) {
          corrected += '\n\n📚 Источники:\n';
          searchResult.citations.slice(0, 5).forEach((url, i) => {
            corrected += `${i + 1}. ${url.length > 70 ? url.substring(0, 67) + '...' : url}\n`;
          });
        }
        telegramLogger.info({ userId }, '✅ Replaced simulation with fresh Perplexity data');
        return { ...response, content: corrected };
      }
    } catch (searchError) {
      telegramLogger.debug({ error: searchError }, 'Fallback Perplexity search failed');
    }

    // Последний вариант: сообщение пользователю
    return {
      ...response,
      content: '🔍 Я попыталась найти информацию, но поиск не вернул результатов.\n\n' +
        'Попробуй:\n• Нажать кнопку **🌐 Поиск** и написать запрос\n• Или команду `/search твой запрос`',
    };
  }

  // === Fallback 2: LLM проигнорировала данные из контекста ===
  // Это главный новый механизм: если Perplexity данные БЫЛИ предоставлены LLM,
  // но она их полностью проигнорировала (не использовала числа, факты, ссылки),
  // показываем данные Perplexity напрямую — без повторного API-вызова.
  if (webSearchContext && llmIgnoredSearchData(response.content, webSearchContext)) {
    telegramLogger.warn({
      userId,
      responseSnippet: response.content.substring(0, 100),
    }, '🚨 LLM ignored Perplexity search data → using raw Perplexity answer');

    analyticsRepo.log('message_received', 'telegram', {
      event: 'llm_ignored_search_data', responseLength: response.content.length,
    }, userId).catch(() => {});

    const fallback = formatPerplexityFallback(webSearchContext);
    if (fallback) {
      telegramLogger.info({ userId }, '✅ Using raw Perplexity data because LLM ignored them');
      return { ...response, content: fallback };
    }
  }

  return response;
};

/** Добавляет предупреждение LLM если поиск нужен, но данные не получены */
const addSearchWarning = (fullContext: string, userMessage: string, webSearchContext: string, userId: string): string => {
  if (!webSearchContext && needsWebSearch(userMessage)) {
    telegramLogger.warn({ userId, query: userMessage.substring(0, 50) }, 'Search needed but no data — injected warning');
    return fullContext + '\n\n⚠️ СИСТЕМНОЕ УВЕДОМЛЕНИЕ: Автоматический поиск был запрошен, но данные временно НЕ получены. ' +
      'СТРОГО ЗАПРЕЩЕНО: НЕ симулируй поиск, НЕ пиши "Ищу...", "Поиск в интернете", "Сейчас найду". ' +
      'НЕ говори "я не умею искать" — у тебя ЕСТЬ поиск, просто сейчас он не вернул данные. ' +
      'Предложи пользователю: нажать кнопку 🌐 Поиск или использовать /search для явного поиска по теме. ' +
      'НЕ выдумывай даты, факты, новости — если данных нет, так и скажи.';
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
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastGreetingDate = await userProfileRepo.getLastGreetingDate(userId);
  const alreadyGreetedToday = lastGreetingDate === todayStr;

  // Build context in parallel
  const { memoryContext, webSearchContext } = await buildFullContext(userId, userText, telegramInfo.first_name, telegramInfo, alreadyGreetedToday);

  // Add to history
  ctx.session.messageHistory.push({ role: 'user', content: userText });
  if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
    ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
  }

  // Build full context with search warning
  let fullContext = memoryContext + webSearchContext;
  fullContext = addSearchWarning(fullContext, userText, webSearchContext, userId);

  // Get AI response
  let aiResponse = await aiService.chat(ctx.session.messageHistory, 'telegram', fullContext);

  // Enhance with web search if AI is uncertain
  if (!webSearchContext) {
    const enhanced = await enhanceResponseIfNeeded(userText, aiResponse.content);
    if (enhanced.wasEnhanced) {
      aiResponse = { ...aiResponse, content: enhanced.response };
      telegramLogger.info({ userId }, `${messageType}: response enhanced with web search`);
    }
  }

  // Verify & protect from search simulation (text messages get full verification)
  if (messageType === 'message') {
    aiResponse = await processAIResponse(aiResponse, userText, userId, webSearchContext);
  }

  // Save to history
  // Раньше здесь была двойная проверка looksLikeSearchSimulation которая могла
  // перезаписать УЖЕ исправленный ответ (после processAIResponse).
  // Теперь processAIResponse гарантированно обрабатывает все случаи симуляции,
  // поэтому здесь просто сохраняем результат.
  ctx.session.messageHistory.push({ role: 'assistant', content: aiResponse.content });

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
  memoryExtractor.extractFacts(userId, userText, aiResponse.content).catch(() => {});

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
      { caption: `🎨 ${escapeMarkdown(cleanPrompt)}\n⏱ ${timeSeconds}с | FLUX.1-schnell` }
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
  const userId = ctx.from?.id.toString() ?? 'unknown';
  const chatId = ctx.chat?.id ?? 0;
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
        caption: `🎨 *${result.prompt}*\n\n_Модель: ${result.model}_\n_Время: ${result.generationTimeMs}мс_`,
        parse_mode: 'Markdown',
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
      await ctx.reply(`✅ Задача добавлена!\n\n☐ _${escapeMarkdown(userMessage)}_`, {
        parse_mode: 'Markdown',
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
  const userId = ctx.from?.id.toString() ?? 'unknown';
  const chatId = ctx.chat?.id ?? 0;
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
// Photo Message Handler
// ============================================

const handlePhotoMessage = async (ctx: BotContext): Promise<void> => {
  const userId = ctx.from?.id.toString() ?? 'unknown';
  const chatId = ctx.chat?.id ?? 0;
  const caption = ctx.message?.caption;

  telegramLogger.info({ userId, hasCaption: !!caption }, 'Photo message received');

  const rateLimitResult = checkTelegramRateLimit(userId);
  if (!rateLimitResult.allowed) { await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.'); return; }

  analyticsRepo.log('message_received', 'telegram', { userId, type: 'photo', hasCaption: !!caption }).catch(() => {});
  await ctx.replyWithChatAction('typing');

  try {
    const photos = ctx.message?.photo ?? [];
    const largestPhoto = photos[photos.length - 1];
    if (!largestPhoto) throw new Error('No photo found in message');
    const file = await ctx.api.getFile(largestPhoto.file_id);
    if (!file.file_path) throw Object.assign(new Error('Telegram не вернул путь к файлу'), { code: 'FILE_NOT_FOUND' });

    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download photo: ${response.status}`);

    const imageBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    const mimeType = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg';

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
        conversationsRepo.addMessage(convId, { role: 'user', content: userContent, timestamp: nowISO, metadata: { type: 'photo', width: largestPhoto.width, height: largestPhoto.height } }),
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
  const userId = ctx.from?.id.toString() ?? 'unknown';
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
    telegramLogger.warn({ userId }, 'Web search disabled — skipping');
    await ctx.reply('🔍 Поиск в интернете сейчас отключён.\n\n_Обратитесь к администратору._', { parse_mode: 'Markdown' });
    return true;
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
    telegramLogger.error({ error: err.message, code: errCode, userId, query: userMessage.substring(0, 80) }, 'Direct web search FAILED');
    await ctx.reply(formatSearchError(errCode), { parse_mode: 'Markdown' });
    return true;
  }
};

// ============================================
// History Sanitization
// ============================================

/** Очищает историю от отравленных ответов и симуляций поиска */
const sanitizeMessageHistory = (history: AIMessage[]): AIMessage[] => {
  if (history.length === 0) return history;

  // Remove search simulations
  let cleaned = history.filter(m => !(m.role === 'assistant' && looksLikeSearchSimulation(m.content)));

  // Detect context poisoning (same response 3+ times)
  const assistantResponses = cleaned.filter(m => m.role === 'assistant');
  const responseCounts = new Map<string, number>();
  for (const msg of assistantResponses) {
    const key = msg.content.substring(0, 100);
    responseCounts.set(key, (responseCounts.get(key) || 0) + 1);
  }

  const poisonedPrefixes = new Set<string>();
  for (const [prefix, count] of responseCounts) {
    if (count >= 3) poisonedPrefixes.add(prefix);
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
