import type { BotContext } from '../bot.js';
import { MAX_HISTORY_MESSAGES } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { aiService, isGibberish } from '../../ai/openrouter.js';
import { enhanceResponseIfNeeded, needsWebSearch, webSearch } from '../../ai/websearch.js';
import { conversationsRepo, analyticsRepo } from '../../db/index.js';
import { getErrorCode } from '../../utils/error-handler.js';
import {
  userProfileRepo,
  userLogsRepo,
  memoryExtractor,
  type TelegramUserInfo,
} from '../../memory/user-memory.js';
import { verifyResponse } from '../../ai/llm-verifier.js';
import type { AIResponse, AIMessage } from '../../../../shared/types/index.js';
import {
  sendLongMessage,
  looksLikeSearchSimulation,
  looksLikeSearchRefusal,
  llmIgnoredSearchData,
  formatPerplexityFallback,
} from '../format.js';
import { responseActionsKeyboard } from '../keyboards.js';
import { ensureConversation, buildFullContext } from './context-builder.js';
import {
  formatCitationsBlock,
  deduplicateSimilarQuestions,
  MIN_SEARCH_ANSWER_LENGTH,
  MIN_FORCE_ANSWER_LENGTH,
  AUTO_SUMMARY_INTERVAL,
} from './history-utils.js';
import { tryPostAIImageInterception } from './auto-detect.js';

/**
 * Обрабатывает AI-ответ: верификация, защита от отказов, симуляции, галлюцинаций.
 */
export const processAIResponse = async (
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

    const perplexityFix = await tryGetPerplexityData(webSearchContext, userMessage, userId);
    if (perplexityFix) return { ...response, content: perplexityFix };

    const forced = await forceAnswer(userMessage, userId);
    if (forced) return { ...response, content: forced };
  }

  return response;
};

/**
 * Пытается получить данные из Perplexity: сначала из кэша (контекста), потом свежий запрос.
 */
export const tryGetPerplexityData = async (
  webSearchContext: string,
  userMessage: string,
  userId: string,
): Promise<string | null> => {
  if (webSearchContext) {
    const cached = formatPerplexityFallback(webSearchContext);
    if (cached) {
      telegramLogger.info({ userId }, '✅ Using cached Perplexity data from context');
      return cached;
    }
  }

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
 */
export const forceAnswer = async (
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
export const addSearchWarning = (fullContext: string, userMessage: string, webSearchContext: string, userId: string): string => {
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
const getAIErrorMessages = (): Record<string, string> => ({
  MODEL_NOT_FOUND: `❌ Модель AI не найдена!\n\nТекущая модель не существует на OpenRouter.\nАдминистратор должен изменить модель в настройках:\n${config.adminUrl}/settings`,
  AUTH_ERROR: '🔑 Ошибка авторизации AI!\n\nНеверный API ключ OpenRouter.\nАдминистратор должен проверить настройки в переменных окружения.',
  RATE_LIMIT: '⏳ Слишком много запросов!\n\nЛимит OpenRouter превышен. Подожди минуту и попробуй снова.',
  PAYMENT_REQUIRED: '💳 Пополни баланс на OpenRouter или выбери бесплатную модель в админке.',
  ALL_MODELS_FAILED: '🔄 Все бесплатные модели AI заняты.\n\nПопробуй через 30 секунд или напиши /start для сброса.',
  RACE_TIMEOUT: '⏰ AI отвечает слишком долго.\n\nПопробуй ещё раз — может повезёт быстрее!',
  SERVER_ERROR: '🔧 Сервер AI временно недоступен.\n\nПопробуй через несколько минут.',
});

const AI_ERROR_DEFAULT = '😔 Извини, произошла ошибка. Попробуй ещё раз.';

/** Форматирует ошибку AI для пользователя */
export const formatAIError = (errorCode: string | undefined, errorMessage: string): string => {
  const messages = getAIErrorMessages();
  if (errorCode && messages[errorCode]) return messages[errorCode];
  for (const [code, msg] of Object.entries(messages)) {
    if (errorMessage.includes(code)) return msg;
  }
  if (errorMessage.includes('429') || errorMessage.includes('rate limit')) return messages.RATE_LIMIT ?? AI_ERROR_DEFAULT;
  if (errorMessage.includes('500') || errorMessage.includes('502')) return messages.SERVER_ERROR ?? AI_ERROR_DEFAULT;
  return AI_ERROR_DEFAULT;
};

/**
 * Общий пайплайн обработки сообщения через AI.
 * Используется и для текста, и для голоса — устраняет ~80% дублирования.
 */
export const processMessageThroughAI = async (
  ctx: BotContext,
  userText: string,
  userId: string,
  chatId: number,
  startTime: number,
  telegramInfo: TelegramUserInfo,
  messageType: 'message' | 'voice',
  extraMetadata?: Record<string, unknown>,
): Promise<void> => {
  await ensureConversation(ctx, userId, chatId);

  // Определяем — здоровалась ли Амина сегодня (из БД, не session)
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: config.server.timeZone }).format(now);
  const lastGreetingDate = await userProfileRepo.getLastGreetingDate(userId);
  const alreadyGreetedToday = lastGreetingDate === todayStr;

  // Build context in parallel
  const { memoryContext, webSearchContext } = await buildFullContext(userId, userText, telegramInfo.first_name, telegramInfo, alreadyGreetedToday);

  // Build user message — inject user name/context directly so weak models can't miss it
  const userName = telegramInfo.first_name || telegramInfo.username || null;
  const contextPrefix = (userName && !alreadyGreetedToday)
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
  const messagesForAI: AIMessage[] = [
    ...deduped,
    { role: 'user', content: augmentedUserText },
  ];

  // Build full context with search warning
  let fullContext = memoryContext + webSearchContext;
  fullContext = addSearchWarning(fullContext, userText, webSearchContext, userId);

  // Get AI response
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
  let finalContent = aiResponse.content;
  const greetingRegex = /^(привет[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?(?:👋\s*)?[\n\r]*|здравствуй(?:те)?[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|добр(?:ое|ый|ая)\s+(?:утро|утра|день|дня|вечер|вечера|ночь|ночи)[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?(?:☀️|🌞|🌙|🌅)?\s*[\n\r]*|хай[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|салют[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|приветствую[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*)/i;

  if (!alreadyGreetedToday) {
    if (greetingRegex.test(finalContent.trim())) {
      userProfileRepo.setLastGreetingDate(userId, todayStr).catch(() => {});
    }
  } else {
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

  // Автосуммаризация
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
