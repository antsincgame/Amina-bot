/**
 * Morning Digest Scheduler
 * 
 * Каждую минуту проверяет, не пора ли отправить утренний дайджест.
 * TZ берётся из переменной окружения TZ (по умолчанию UTC).
 * 
 * Логика:
 * 1. Опционально подтягивает погоду
 * 2. Парсер собирает все news sections из настроенных RSS/JSON/HTML источников
 * 3. Из БД: напоминания на сегодня, задачи
 * 4. Всё передаётся в основную LLM с промптом только для narrative-части
 * 5. Структурированные news sections добавляются детерминированно
 */

import { InlineKeyboard, type Api, type RawApi } from 'grammy';
import { userPrefsRepo } from './user-prefs-repo.js';
import { todosRepo } from './todos-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { inlineCitations, markdownToTelegramHtml, splitIntoChunks, stripHtml } from '../telegram/format.js';
import { parseAllConfiguredSites } from './news-parser.js';
import { aiService } from '../ai/openrouter.js';
import { config } from '../config/index.js';
import { appLogger } from '../config/logger.js';
import { buildDigestClosing, buildParserOnlyNewsBundle, getTimeGreeting, webSearchWithRetry } from './digest-core.js';
import { buildHybridDigest, buildHybridDigestDeliveryKey } from './digest-hybrid.js';
import { digestDeliveryRepo, type DigestDeliveryKind } from './digest-hybrid-repo.js';

export {
  chunkHeadlinesForDigest,
  renderFallbackHeadlineBatch,
  shouldUseFallbackForDigestBatches,
} from './digest-core.js';

interface BotLike {
  api: Api<RawApi>;
}

const CHECK_INTERVAL_MS = 60_000; // 1 минута
const SENT_TODAY = new Set<string>(); // Защита от повторной отправки

let digestInterval: ReturnType<typeof setInterval> | null = null;
let midnightResetInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

/**
 * Запустить планировщик дайджестов
 */
export function startDigestScheduler(bot: BotLike): void {
  if (digestInterval) {
    appLogger.warn('Digest scheduler already running');
    return;
  }

  appLogger.info({ TZ: config.server.timeZone }, 'Starting morning digest scheduler');

  // Очищаем sent-кеш в полночь
  resetSentCacheAtMidnight();

  digestInterval = setInterval(() => {
    processDigests(bot).catch(err => {
      appLogger.error({ error: err }, 'Digest scheduler error');
    });
  }, CHECK_INTERVAL_MS);

  digestInterval.unref();
}

/**
 * Остановить планировщик
 */
export function stopDigestScheduler(): void {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
  }
  if (midnightResetInterval) {
    clearInterval(midnightResetInterval);
    midnightResetInterval = null;
  }
  appLogger.info('Digest scheduler stopped');
}

// ---- Кэш полных текстов дайджестов для озвучки ----
const digestFullTextCache = new Map<string, { text: string; createdAt: number }>();
const DIGEST_CACHE_TTL_MS = 30 * 60 * 1000; // 30 минут
let nextDigestId = 1;
const DIGEST_MESSAGE_DELAY_MS = 250;
const DIGEST_SEND_RETRY_ATTEMPTS = 4;

/** Сохранить полный текст дайджеста и вернуть ID */
function cacheDigestText(text: string): string {
  const now = Date.now();
  // Очистка устаревших записей
  for (const [key, val] of digestFullTextCache) {
    if (now - val.createdAt > DIGEST_CACHE_TTL_MS) digestFullTextCache.delete(key);
  }
  // Ограничение размера: максимум 50 записей
  if (digestFullTextCache.size >= 50) {
    const oldestKey = digestFullTextCache.keys().next().value;
    if (oldestKey) digestFullTextCache.delete(oldestKey);
  }
  const id = String(nextDigestId++);
  digestFullTextCache.set(id, { text, createdAt: now });
  return id;
}

/** Получить полный текст дайджеста по ID */
export function getDigestFullText(id: string): string | null {
  const entry = digestFullTextCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > DIGEST_CACHE_TTL_MS) {
    digestFullTextCache.delete(id);
    return null;
  }
  return entry.text;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error && 'description' in error && typeof error.description === 'string') {
    return error.description;
  }
  return String(error);
}

function getRetryAfterMs(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'parameters' in error) {
    const parameters = error.parameters as { retry_after?: unknown };
    if (typeof parameters?.retry_after === 'number' && parameters.retry_after > 0) {
      return (parameters.retry_after + 1) * 1000;
    }
  }

  const message = getErrorMessage(error);
  const retryMatch = message.match(/retry after\s+(\d+)/i);
  if (retryMatch?.[1]) {
    return (Number(retryMatch[1]) + 1) * 1000;
  }

  if (
    message.includes('429') ||
    message.toLowerCase().includes('too many requests') ||
    message.toLowerCase().includes('rate limit')
  ) {
    return 2000;
  }

  return null;
}

function isTelegramParseError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes('parse entities') ||
    message.includes('unsupported start tag') ||
    message.includes('entity beginning')
  );
}

function isTransientTelegramError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('bad gateway') ||
    message.includes('502')
  );
}

async function sendTelegramChunk(
  bot: BotLike,
  chatId: number,
  htmlChunk: string,
  htmlOptions: Record<string, unknown>,
  plainOptions: Record<string, unknown>,
): Promise<void> {
  let usePlainText = false;

  for (let attempt = 1; attempt <= DIGEST_SEND_RETRY_ATTEMPTS; attempt++) {
    try {
      if (usePlainText) {
        await bot.api.sendMessage(chatId, stripHtml(htmlChunk), plainOptions);
      } else {
        await bot.api.sendMessage(chatId, htmlChunk, htmlOptions);
      }
      return;
    } catch (error) {
      const retryAfterMs = getRetryAfterMs(error);
      if (retryAfterMs) {
        appLogger.warn({ chatId, attempt, retryAfterMs }, 'Digest chunk rate-limited, retrying');
        await sleep(retryAfterMs);
        continue;
      }

      if (!usePlainText && isTelegramParseError(error)) {
        appLogger.warn({ chatId, attempt, error: getErrorMessage(error) }, 'Digest chunk HTML parse failed, retrying as plain text');
        usePlainText = true;
        continue;
      }

      if (isTransientTelegramError(error) && attempt < DIGEST_SEND_RETRY_ATTEMPTS) {
        const backoffMs = attempt * 1000;
        appLogger.warn({ chatId, attempt, backoffMs, error: getErrorMessage(error) }, 'Digest chunk transient failure, retrying');
        await sleep(backoffMs);
        continue;
      }

      throw error;
    }
  }
}

/**
 * Отправить длинное сообщение, разбивая на части при необходимости.
 * Кнопка "Озвучить весь дайджест" ставится ТОЛЬКО на последнем сообщении.
 * Она озвучивает ВЕСЬ текст целиком, а не только один чанк.
 */
async function sendLongMessage(
  bot: BotLike,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'HTML'
): Promise<void> {
  // Кэшируем полный текст и создаём кнопку с ID
  const digestId = cacheDigestText(text);
  const keyboard = new InlineKeyboard().text('🔊 Озвучить дайджест', `read_aloud_digest:${digestId}`);

  const htmlText = parseMode === 'Markdown' ? markdownToTelegramHtml(text) : text;
  const chunks = splitIntoChunks(htmlText);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const htmlOptions: Record<string, unknown> = { parse_mode: 'HTML' };
    const plainOptions: Record<string, unknown> = {};
    if (isLast) {
      htmlOptions.reply_markup = keyboard;
      plainOptions.reply_markup = keyboard;
    }

    await sendTelegramChunk(bot, chatId, chunks[i]!, htmlOptions, plainOptions);

    if (!isLast) {
      await sleep(DIGEST_MESSAGE_DELAY_MS);
    }
  }
}

interface HybridDigestSendOptions {
  forceRefresh?: boolean;
  deliveryKind?: DigestDeliveryKind;
}

async function recordHybridDelivery(
  userId: string,
  chatId: number,
  city: string,
  digestDate: string,
  cacheKey: string,
  status: 'sending' | 'sent' | 'failed',
  deliveryKind: DigestDeliveryKind,
  lastError?: string,
): Promise<void> {
  const deliveryKey = buildHybridDigestDeliveryKey(userId, deliveryKind, city, digestDate);
  const existing = await digestDeliveryRepo.getByKey(deliveryKey);
  const nextAttemptCount = status === 'sending'
    ? (existing?.attempt_count ?? 0) + 1
    : (existing?.attempt_count ?? 1);

  await digestDeliveryRepo.upsert({
    delivery_key: deliveryKey,
    delivery_kind: deliveryKind,
    user_id: userId,
    chat_id: chatId,
    city,
    digest_date: digestDate,
    cache_key: cacheKey,
    status,
    attempt_count: nextAttemptCount,
    last_error: lastError ?? null,
    sent_at: status === 'sent' ? new Date().toISOString() : null,
  });
}

/**
 * Отправить дайджест по запросу пользователя (команда /digest now)
 */
export async function sendDigestNow(
  bot: BotLike,
  userId: string,
  chatId: number,
  firstName: string | null,
  city: string
): Promise<void> {
  const digestText = await buildDigest(userId, firstName, city);
  await sendLongMessage(bot, chatId, digestText, 'Markdown');
}

export async function buildHybridDigestText(
  userId: string,
  firstName: string | null,
  city: string,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  const { digestText } = await buildHybridDigest(userId, firstName, city, options);
  return digestText;
}

export async function sendHybridDigestNow(
  bot: BotLike,
  userId: string,
  chatId: number,
  firstName: string | null,
  city: string,
  options?: HybridDigestSendOptions,
): Promise<void> {
  const { cacheKey, digestText, payload } = await buildHybridDigest(userId, firstName, city, {
    forceRefresh: options?.forceRefresh,
  });
  const deliveryKind = options?.deliveryKind ?? 'manual';

  try {
    await recordHybridDelivery(
      userId,
      chatId,
      payload.city,
      payload.digest_date,
      cacheKey,
      'sending',
      deliveryKind,
    );
    await sendLongMessage(bot, chatId, digestText, 'Markdown');
    await recordHybridDelivery(
      userId,
      chatId,
      payload.city,
      payload.digest_date,
      cacheKey,
      'sent',
      deliveryKind,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordHybridDelivery(
      userId,
      chatId,
      payload.city,
      payload.digest_date,
      cacheKey,
      'failed',
      deliveryKind,
      message,
    ).catch(repoError => {
      appLogger.warn({ error: repoError, userId, cacheKey }, 'Failed to persist hybrid delivery error');
    });
    throw error;
  }
}

/**
 * Сбросить кеш отправленных дайджестов в полночь (по серверному TZ)
 */
function resetSentCacheAtMidnight(): void {
  const serverTZ = config.server.timeZone;
  const currentHour = () => Number(new Intl.DateTimeFormat('en', { timeZone: serverTZ, hour: 'numeric', hour12: false }).format(new Date()));

  if (currentHour() === 0) {
    SENT_TODAY.clear();
  }

  midnightResetInterval = setInterval(() => {
    if (currentHour() === 0) {
      SENT_TODAY.clear();
      appLogger.debug('Digest SENT_TODAY cache cleared at midnight');
    }
  }, 5 * 60 * 1000);
  midnightResetInterval.unref();
}

/**
 * Обёртка с таймаутом для buildDigest
 */
async function buildDigestWithTimeout(
  userId: string, firstName: string | null, city: string | null, timeoutMs = 180_000,
): Promise<string> {
  return Promise.race([
    buildDigest(userId, firstName, city ?? ''),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`buildDigest timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

/**
 * Обработать дайджесты
 */
async function processDigests(bot: BotLike): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const currentHour = new Date().getHours();
    const todayStr = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

    const users = await userPrefsRepo.getDigestUsers(currentHour);
    if (users.length === 0) return;

    // Параллелизация с лимитом 3 одновременных дайджеста
    const CONCURRENCY = 3;
    for (let i = 0; i < users.length; i += CONCURRENCY) {
      const batch = users.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (user) => {
          const cacheKey = `${user.user_id}_${todayStr}_${currentHour}`;
          if (SENT_TODAY.has(cacheKey)) return;

          try {
            const digestText = await buildDigestWithTimeout(
              user.user_id, user.first_name, user.digest_city,
            );
            await sendLongMessage(bot, user.chat_id, digestText, 'Markdown');

            SENT_TODAY.add(cacheKey);
            appLogger.info({ userId: user.user_id, hour: currentHour, city: user.digest_city }, 'Digest sent');
          } catch (sendError) {
            const err = sendError as { error_code?: number; message?: string };
            if (err.error_code === 403) {
              await userPrefsRepo.update(user.user_id, { digest_enabled: false });
              appLogger.warn({ userId: user.user_id }, 'User blocked bot, digest disabled');
            } else {
              appLogger.error({ error: err.message, userId: user.user_id }, 'Failed to send digest');
            }
          }
        }),
      );
    }
  } finally {
    isProcessing = false;
  }
}

// --------------------------------------------
// Digest Builder: parser-only news + optional weather
// --------------------------------------------

/**
 * Собрать дайджест:
 * 1. Опционально: погода
 * 2. Парсер: все news sections из настроенных источников
 * 3. БД: напоминания, задачи
 * 4. LLM формирует только narrative-часть без news lists
 */
/**
 * Собрать полный дайджест (экспорт для публичного API).
 * userId='public' — без персональных напоминаний/задач.
 */
export async function buildDigest(
  userId: string,
  firstName: string | null,
  city: string
): Promise<string> {
  const rawData: string[] = [];
  const todayStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const shouldLoadPersonalData = userId !== 'public';

  const [weatherResult, parsedHeadlinesResult, remindersResult, todosResult] =
    await Promise.allSettled([
      webSearchWithRetry(
        `Погода ${city} сегодня ${todayStr}: точная температура сейчас утром днём вечером, осадки, ветер, влажность, давление, ощущается как. Подробный прогноз на весь день.`
      ),
      parseAllConfiguredSites(),
      shouldLoadPersonalData ? remindersRepo.getByUser(userId) : Promise.resolve([]),
      shouldLoadPersonalData ? todosRepo.getForDigest(userId) : Promise.resolve([]),
    ]);

  const allCitations: string[] = [];

  if (weatherResult.status === 'fulfilled' && weatherResult.value?.answer) {
    rawData.push(`[ПОГОДА ${city.toUpperCase()}]\n${weatherResult.value.answer}`);
    allCitations.push(...(weatherResult.value.citations ?? []));
  } else {
    rawData.push(`[ПОГОДА ${city.toUpperCase()}]\nДанные о погоде временно недоступны`);
    if (weatherResult.status === 'rejected') {
      appLogger.warn({ error: weatherResult.reason, city }, 'Digest: weather search failed');
    }
  }

  const parsedHeadlines = parsedHeadlinesResult.status === 'fulfilled'
    ? parsedHeadlinesResult.value
    : [];

  if (parsedHeadlinesResult.status === 'rejected') {
    appLogger.warn({ error: parsedHeadlinesResult.reason }, 'Digest: news parser failed');
  }

  const newsBundle = await buildParserOnlyNewsBundle(city, parsedHeadlines);

  // 5. Напоминания на сегодня
  if (shouldLoadPersonalData && remindersResult.status === 'fulfilled') {
    const reminders = remindersResult.value;
    const todayISO = new Date().toLocaleDateString('sv-SE');
    const todayReminders = reminders.filter(r => {
      const reminderDate = new Date(r.scheduled_at).toLocaleDateString('sv-SE');
      return reminderDate === todayISO;
    });
    if (todayReminders.length > 0) {
      const lines = todayReminders.map(r => {
        const time = new Date(r.scheduled_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        return `${time} — ${r.task}`;
      });
      rawData.push(`[НАПОМИНАНИЯ НА СЕГОДНЯ]\n${lines.join('\n')}`);
    }
  } else if (shouldLoadPersonalData && remindersResult.status === 'rejected') {
    appLogger.warn({ error: remindersResult.reason, userId }, 'Digest: reminders load failed');
  }

  // 6. Активные задачи
  if (shouldLoadPersonalData && todosResult.status === 'fulfilled') {
    const todos = todosResult.value;
    if (todos.length > 0) {
      const lines = todos.slice(0, 10).map(t => `- ${t.task}`);
      rawData.push(`[ЗАДАЧИ]\n${lines.join('\n')}`);
    }
  } else if (shouldLoadPersonalData && todosResult.status === 'rejected') {
    appLogger.warn({ error: todosResult.reason, userId }, 'Digest: todos load failed');
  }

  // Дедупликация citations и формирование карты
  const uniqueCitations = [...new Set(allCitations)];
  const citationsBlock = uniqueCitations.length > 0
    ? `\n\nКАРТА ИСТОЧНИКОВ (для ссылок [N]):\n${uniqueCitations.map((url, i) => `[${i + 1}] ${url}`).join('\n')}`
    : '';

  // --- LLM обработка ---
  const nameStr = firstName || 'друг';
  const todayDate = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const digestPrompt = `Ты — Amina, персональный AI-ассистент и редактор утреннего дайджеста.

Сейчас ${todayDate}.
Составь вступительную часть дайджеста для ${nameStr} из города ${city}.

ВАЖНО:
- Включай ТОЛЬКО разделы из данных ниже.
- НЕ пересказывай ленту новостных источников списком: структурированные секции со ссылками будут добавлены отдельно.
- НЕ создавай раздел "Новости ${city}" — он будет добавлен отдельно из parser-only источников.
- НЕ создавай раздел "Некатегоризированные источники" — он будет добавлен отдельно.
- НЕ создавай разделы "Технологии и AI" и "AI из Азии" — они будут добавлены отдельно.
- НЕ добавляй финальный раздел "Настрой на день" — он будет добавлен отдельно.
- Если в городских данных есть Markdown-ссылки, ОБЯЗАТЕЛЬНО сохрани их.
- Если у факта есть ссылки вида [N], сохрани их.
- Не пиши фразы про отсутствие данных — просто пропускай пустые разделы.

Вот собранные данные:

${rawData.join('\n\n')}${citationsBlock}

Нужные разделы:
1. **Приветствие**
2. **Погода в ${city}**
3. **Напоминания и задачи**

Формат: Markdown для Telegram.`;

  let narrativeDigest = '';
  try {
    const llmResponse = await aiService.chat(
      [{ role: 'user', content: digestPrompt }],
      'telegram'
    );
    
    // Пост-обработка: заменяем [N] на кликабельные Markdown-ссылки
    narrativeDigest = llmResponse.content;
    if (uniqueCitations.length > 0) {
      narrativeDigest = inlineCitations(narrativeDigest, uniqueCitations);
    }
  } catch (error) {
    appLogger.error({ error, userId }, 'LLM failed to process narrative digest, using raw data');
    
    // Fallback: сырые данные с приветствием
    const greeting = getTimeGreeting(firstName);
    narrativeDigest = `${greeting}\n\n${rawData.join('\n\n')}`;
    if (uniqueCitations.length > 0) {
      narrativeDigest = inlineCitations(narrativeDigest, uniqueCitations);
    }
  }

  appLogger.info({
    narrativeLength: narrativeDigest.length,
    localStructured: newsBundle.localHeadlines.length,
    uncategorizedStructured: newsBundle.uncategorizedHeadlines.length,
    aiHeadlines: newsBundle.allAiHeadlines.length,
    aiBatches: newsBundle.aiSections.length,
    asiaHeadlines: newsBundle.asiaHeadlines.length,
    asiaBatches: newsBundle.asiaSections.length,
    mergedDuplicates: newsBundle.counts.merged_duplicates,
  }, 'Digest: compiled narrative and headline batches');

  return [
    narrativeDigest.trim(),
    newsBundle.localSection,
    newsBundle.uncategorizedSection,
    ...newsBundle.aiSections,
    ...newsBundle.asiaSections,
    buildDigestClosing(firstName),
  ].filter(Boolean).join('\n\n');
}

