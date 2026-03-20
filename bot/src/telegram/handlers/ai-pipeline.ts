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
import {
  buildPersonaSystemPrompt,
  detectSelfDisclosureIntent,
} from '../../ai/persona.js';
import { buildSelfCoreSelfDisclosurePrompt } from '../../ai/self-core-kernel.js';
import { captureSelfCoreFromInteraction } from '../../ai/self-core.js';
import type { AIChatOptions } from '../../ai/openrouter.js';

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
    }, userId).catch((e) => telegramLogger.warn({ error: e }, 'analyticsRepo.log failed'));

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

    // Последний рубеж: честно сообщаем об ограничении
    return { ...response, content: getHonestFallback() };
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

    // Последний рубеж: честно сообщаем об ограничении
    return { ...response, content: getHonestFallback() };
  }

  return response;
};

/**
 * Честный ответ когда ни Perplexity, ни force-answer не дали usable результата.
 * Пользователь получает внятное объяснение вместо симуляции или тишины.
 */
export const getHonestFallback = (): string =>
  'Извини, сейчас не могу получить актуальные данные по этому вопросу. ' +
  'Попробуй спросить чуть позже или уточни запрос.';

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
 * Специальный ответ на вопросы про саму Амину.
 * Использует self-disclosure канон вместо general system prompt,
 * чтобы ответы были живыми и личными, а не функциональными.
 */
export const selfDisclosureAnswer = async (
  userMessage: string,
  userId: string,
): Promise<string | null> => {
  try {
    telegramLogger.info({ userId, query: userMessage.substring(0, 60) }, '💬 Self-disclosure intent detected');
    const isShortQuery = userMessage.trim().length < 30;
    const selfIntroPrompt = await buildSelfCoreSelfDisclosurePrompt(isShortQuery ? 'short' : 'warm');

    const result = await aiService.chat(
      [
        { role: 'system', content: selfIntroPrompt },
        { role: 'user', content: userMessage },
      ],
      'telegram',
      undefined,
      { promptMode: 'passthrough', temperature: 0.75 },
    );

    if (result.content && result.content.length > 20) {
      return result.content;
    }
  } catch (err) {
    telegramLogger.warn({ error: err, userId }, 'Self-disclosure answer failed, falling back to normal pipeline');
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
    const forcePrompt = await buildPersonaSystemPrompt({
      channel: 'telegram',
      extraRules: [
        'Режим задачи: force-answer.',
        'Ответь кратко, честно и по делу.',
        'Не отказывайся без необходимости и не симулируй поиск.',
        'Если данных мало, дай лучший ответ из знаний и не выдумывай факты.',
      ],
    });

    const forceResult = await aiService.chat(
      [
        { role: 'system', content: forcePrompt },
        { role: 'user', content: userMessage },
      ],
      'telegram',
      undefined,
      { promptMode: 'passthrough' },
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
    return fullContext + '\n\n[Поиск недоступен. Ответь из своих знаний с пометкой "по моим данным". Не симулируй поиск.]';
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
  aiOptions?: AIChatOptions,
): Promise<void> => {
  await ensureConversation(ctx, userId, chatId);

  // Определяем — здоровалась ли Амина сегодня (из БД, не session)
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: config.server.timeZone }).format(now);
  const lastGreetingDate = await userProfileRepo.getLastGreetingDate(userId);
  const alreadyGreetedToday = lastGreetingDate === todayStr;

  // Resolve user timezone for time context
  let userTimezone: string | undefined;
  try {
    const { userPrefsRepo } = await import('../../features/user-prefs-repo.js');
    const prefs = await userPrefsRepo.get(userId);
    if (prefs?.timezone) userTimezone = prefs.timezone;
  } catch { /* fallback to server timezone */ }

  // Build context in parallel
  const { memoryContext, webSearchContext } = await buildFullContext(userId, userText, telegramInfo.first_name, telegramInfo, alreadyGreetedToday, userTimezone);

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

  // === Self-disclosure fast path: вопросы про саму Амину ===
  // Перехватываем до обычного пайплайна — используем canon self-description
  if (detectSelfDisclosureIntent(userText)) {
    const selfAnswer = await selfDisclosureAnswer(userText, userId);
    if (selfAnswer) {
      const selfResponse: AIResponse = {
        content: selfAnswer,
        model: 'persona-self-disclosure',
        tokens_used: { prompt: 0, completion: 0, total: 0 },
        finish_reason: 'stop',
      };
      ctx.session.messageHistory.push({ role: 'assistant', content: selfAnswer });
      await sendLongMessage(ctx, selfAnswer);

      // DB writes (same pattern as main path)
      const selfConvId = ctx.session.conversationId;
      if (selfConvId) {
        const nowISO = new Date().toISOString();
        conversationsRepo.addMessage(selfConvId, { role: 'user', content: userText, timestamp: nowISO })
          .then(() => conversationsRepo.addMessage(selfConvId, { role: 'assistant', content: selfAnswer, timestamp: nowISO, metadata: { model: 'persona-self-disclosure' } }))
          .catch((err) => { telegramLogger.warn({ error: err, userId }, 'Self-disclosure DB write failed'); });
      }
      userProfileRepo.updateOnMessage(userId, messageType, 0, telegramInfo).catch((e) => telegramLogger.warn({ error: e, userId }, 'updateOnMessage failed'));

      analyticsRepo.log('message_received', 'telegram', {
        event: 'self_disclosure_answered', messageType,
        responseLength: selfAnswer.length,
      }, userId).catch((e) => telegramLogger.warn({ error: e }, 'analyticsRepo.log failed'));
      memoryExtractor.extractFacts(userId, userText, selfAnswer).catch((e) => telegramLogger.warn({ error: e, userId }, 'extractFacts failed'));
      captureSelfCoreFromInteraction({ userMessage: userText, aiResponse: selfAnswer }).catch((e) => telegramLogger.warn({ error: e }, 'self-core growth failed'));
      return;
    }
  }

  // Get AI response
  let aiResponse = await aiService.chat(messagesForAI, 'telegram', fullContext, aiOptions);

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

  // Strip wrapper brackets/quotes that weak models add
  let cleanedContent = aiResponse.content.trim();
  if (/^\[.*\]$/s.test(cleanedContent)) {
    cleanedContent = cleanedContent.slice(1, -1).trim();
  }
  if (/^".*"$/s.test(cleanedContent)) {
    cleanedContent = cleanedContent.slice(1, -1).trim();
  }
  if (cleanedContent !== aiResponse.content) {
    aiResponse = { ...aiResponse, content: cleanedContent };
  }

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
  if (await tryPostAIImageInterception(ctx, aiResponse.content, userText, userId)) {
    // Сохраняем в БД даже при image interception
    const imgConvId = ctx.session.conversationId;
    if (imgConvId) {
      const nowISO = new Date().toISOString();
      conversationsRepo.addMessage(imgConvId, { role: 'user', content: userText, timestamp: nowISO, metadata: extraMetadata })
        .then(() => conversationsRepo.addMessage(imgConvId, { role: 'assistant', content: aiResponse.content, timestamp: nowISO, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model, image_intercepted: true } }))
        .catch((err) => { telegramLogger.warn({ error: err, userId }, 'Image interception DB write failed'); });
    }
    userProfileRepo.updateOnMessage(userId, messageType, aiResponse.tokens_used.total, telegramInfo).catch((e) => telegramLogger.warn({ error: e, userId }, 'updateOnMessage failed'));
    return;
  }

  // === ПРОГРАММНОЕ удаление повторного приветствия ===
  let finalContent = aiResponse.content;
  const greetingRegex = /^(привет[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?(?:👋\s*)?[\n\r]*|здравствуй(?:те)?[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|добр(?:ое|ый|ая)\s+(?:утро|утра|день|дня|вечер|вечера|ночь|ночи)[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?(?:☀️|🌞|🌙|🌅)?\s*[\n\r]*|хай[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|салют[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*|приветствую[,!\s]?\s*(?:[а-яё]+[,!\s]?\s*)?[\n\r]*)/i;

  if (!alreadyGreetedToday) {
    if (greetingRegex.test(finalContent.trim())) {
      userProfileRepo.setLastGreetingDate(userId, todayStr).catch((e) => telegramLogger.warn({ error: e, userId }, 'setLastGreetingDate failed'));
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
  userProfileRepo.updateOnMessage(userId, messageType, aiResponse.tokens_used.total, telegramInfo).catch((e) => telegramLogger.warn({ error: e, userId }, 'updateOnMessage failed'));
  userLogsRepo.add(userId, 'ai_response', aiResponse.content, { chatId, type: messageType, responseLength: aiResponse.content.length }, {
    model: aiResponse.model, tokensPrompt: aiResponse.tokens_used.prompt, tokensCompletion: aiResponse.tokens_used.completion, responseTimeMs: responseTime,
  }).catch((e) => telegramLogger.warn({ error: e, userId }, 'userLogsRepo.add failed'));
  memoryExtractor.extractFacts(userId, userText, aiResponse.content).catch((err) => {
    telegramLogger.warn({ error: err, userId }, 'extractFacts failed');
  });
  captureSelfCoreFromInteraction({ userMessage: userText, aiResponse: finalContent }).catch((err) => {
    telegramLogger.warn({ error: err, userId }, 'self-core growth failed');
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
    // Последовательная запись — параллельный addMessage теряет сообщения (read-modify-write race)
    conversationsRepo.addMessage(convId, { role: 'user', content: userText, timestamp: nowISO, metadata: extraMetadata })
      .then(() => conversationsRepo.addMessage(convId, { role: 'assistant', content: aiResponse.content, timestamp: nowISO, metadata: { tokens_used: aiResponse.tokens_used.total, model: aiResponse.model } }))
      .catch((err) => { telegramLogger.warn({ error: err, userId }, `Background ${messageType} DB writes failed`); });
    analyticsRepo.log('ai_response', 'telegram', { userId, type: messageType, model: aiResponse.model, tokens: aiResponse.tokens_used.total }).catch((e) => telegramLogger.warn({ error: e }, 'analyticsRepo.log failed'));
  }

  telegramLogger.info({ userId, tokens: aiResponse.tokens_used.total, responseTimeMs: responseTime }, `${messageType} response sent`);
};
