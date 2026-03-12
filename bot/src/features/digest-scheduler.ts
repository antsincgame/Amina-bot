/**
 * Morning Digest Scheduler
 * 
 * Каждую минуту проверяет, не пора ли отправить утренний дайджест.
 * TZ берётся из переменной окружения TZ (по умолчанию UTC).
 * 
 * Логика:
 * 1. Perplexity ищет: погоду, местные новости города
 * 2. Парсер собирает AI/Tech заголовки из настроенных RSS/JSON/HTML источников
 * 3. Из БД: напоминания на сегодня, задачи
 * 4. Всё передаётся в основную LLM с промптом "обработай эмоционально"
 * 5. LLM формирует живой, авторский дайджест с комментариями
 */

import { InlineKeyboard, type Api, type RawApi } from 'grammy';
import { userPrefsRepo } from './user-prefs-repo.js';
import { todosRepo } from './todos-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { webSearch } from '../ai/websearch.js';
import { inlineCitations } from '../telegram/format.js';
import { parseAllConfiguredSites, filterByCategory, type ParsedHeadline } from './news-parser.js';
import { aiService } from '../ai/openrouter.js';
import { config } from '../config/index.js';
import { appLogger } from '../config/logger.js';

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
  const MAX_LENGTH = 4096;
  
  // Кэшируем полный текст и создаём кнопку с ID
  const digestId = cacheDigestText(text);
  const keyboard = new InlineKeyboard().text('🔊 Озвучить дайджест', `read_aloud_digest:${digestId}`);
  
  // Если текст короткий — отправляем одним сообщением
  if (text.length <= MAX_LENGTH) {
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: parseMode, reply_markup: keyboard });
    } catch {
      const plainText = text.replace(/[*_`~[\]()]/g, '');
      await bot.api.sendMessage(chatId, plainText, { reply_markup: keyboard });
    }
    return;
  }
  
  // Разбиваем на части по абзацам
  const paragraphs = text.split('\n\n');
  let chunk = '';
  const chunks: string[] = [];
  
  for (const para of paragraphs) {
    if (chunk.length + para.length + 2 > MAX_LENGTH) {
      if (chunk) {
        chunks.push(chunk.trim());
        chunk = '';
      }
      if (para.length > MAX_LENGTH) {
        const plainPara = para.replace(/[*_`~[\]()]/g, '').substring(0, MAX_LENGTH);
        chunks.push(plainPara);
        continue;
      }
    }
    chunk += (chunk ? '\n\n' : '') + para;
  }
  if (chunk.trim()) chunks.push(chunk.trim());
  
  // Отправляем все чанки: без кнопки, КРОМЕ последнего — с кнопкой озвучки
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const opts: Record<string, unknown> = { parse_mode: parseMode };
    if (isLast) opts.reply_markup = keyboard;
    
    try {
      await bot.api.sendMessage(chatId, chunks[i]!, opts);
    } catch {
      const plain = chunks[i]!.replace(/[*_`~[\]()]/g, '');
      await bot.api.sendMessage(chatId, plain, isLast ? { reply_markup: keyboard } : {});
    }
  }
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
  userId: string, firstName: string | null, city: string | null, timeoutMs = 90_000,
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
// Digest Builder: Perplexity → LLM
// --------------------------------------------

/**
 * Результат поиска с citations
 */
interface DigestSearchResult {
  answer: string;
  citations: string[];
}

/**
 * Поиск с повторной попыткой при ошибке. Сохраняет citations.
 */
async function webSearchWithRetry(
  query: string,
  retries = 2
): Promise<DigestSearchResult | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await webSearch(query, { forDigest: true });
      if (result.answer && result.answer.length > 10) {
        return { answer: result.answer, citations: result.citations ?? [] };
      }
      appLogger.warn({ query: query.substring(0, 50), attempt, answerLength: result.answer?.length ?? 0 }, 'Digest: search returned weak result');
    } catch (error) {
      appLogger.warn({ error, query: query.substring(0, 50), attempt }, `Digest: search attempt ${attempt} failed`);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }
  return null;
}

/**
 * Собрать дайджест:
 * 1. Perplexity: погода, местные новости города
 * 2. Парсер: AI/Tech/Asia заголовки из настроенных источников
 * 3. БД: напоминания, задачи
 * 4. LLM формирует живой, подробный текст
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

  const [weatherResult, parsedHeadlinesResult, remindersResult, todosResult] = 
    await Promise.allSettled([
      webSearchWithRetry(
        `Погода ${city} сегодня ${todayStr}: точная температура сейчас утром днём вечером, осадки, ветер, влажность, давление, ощущается как. Подробный прогноз на весь день.`
      ),

      parseAllConfiguredSites(),

      remindersRepo.getByUser(userId),
      todosRepo.getForDigest(userId),
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

  let parsedHeadlines: ParsedHeadline[] = [];
  let aiTechHeadlines: ParsedHeadline[] = [];
  let asiaAiHeadlines: ParsedHeadline[] = [];
  let communityHeadlines: ParsedHeadline[] = [];
  
  if (parsedHeadlinesResult.status === 'fulfilled') {
    const allParsed = parsedHeadlinesResult.value;
    parsedHeadlines = allParsed.filter(h => !h.category || h.category === 'city_local');
    aiTechHeadlines = filterByCategory(allParsed, 'ai_tech');
    asiaAiHeadlines = filterByCategory(allParsed, 'asia_tech');
    communityHeadlines = filterByCategory(allParsed, 'community');
  } else {
    appLogger.warn({ error: parsedHeadlinesResult.reason }, 'Digest: news parser failed');
  }

  if (parsedHeadlines.length > 0) {
    const headlineLines = parsedHeadlines.map(h =>
      `- [${h.title}](${h.url}) (source: ${h.source})`
    );
    rawData.push(
      `[МЕСТНЫЕ НОВОСТИ — ЗАГОЛОВКИ С НОВОСТНЫХ САЙТОВ ${city.toUpperCase()}]\n` +
      `Ниже — актуальные заголовки новостей, спарсенные с местных новостных сайтов.\n` +
      `Входные данные уже содержат ссылки. Сохрани их!\n` +
      `Для каждой новости ОБЯЗАТЕЛЬНО сохрани ссылку в формате Markdown: [заголовок](url)\n\n` +
      headlineLines.join('\n')
    );
    appLogger.info({ count: parsedHeadlines.length, city }, 'Digest: using parsed headlines for city news');
  }

  if (city) {
    const perplexityCityResult = await webSearchWithRetry(
      `Новости ${city} сегодня ${todayStr}: ` +
      `местные события, происшествия, решения городских властей, транспорт, благоустройство, культурная жизнь ${city}. ` +
      `Ищи ТОЛЬКО местные городские новости ${city}! Минимум 5 конкретных событий с датами. ` +
      `НЕ включай мировые новости — ТОЛЬКО ${city}.`
    );
    if (perplexityCityResult?.answer) {
      rawData.push(`[МЕСТНЫЕ НОВОСТИ ${city.toUpperCase()} — PERPLEXITY]\n${perplexityCityResult.answer}`);
      allCitations.push(...(perplexityCityResult.citations ?? []));
    }
  }

  // AI/TECH НОВОСТИ — из парсера (международные англоязычные источники)
  const allAiHeadlines = [...aiTechHeadlines, ...communityHeadlines];
  if (allAiHeadlines.length > 0) {
    const aiLines = allAiHeadlines.map((h, idx) =>
      `${idx + 1}. [${h.title}](${h.url}) (source: ${h.source})`
    );
    rawData.push(
      `[ТЕХНОЛОГИИ И AI — МЕЖДУНАРОДНЫЕ ИСТОЧНИКИ] (${allAiHeadlines.length} заголовков)\n` +
      `Ты ОБЯЗАНА включить ВСЕ ${allAiHeadlines.length} заголовков! Для каждого: перевод + 1 предложение комментария.\n` +
      `Группируй по категориям: 🚀 Релиз | 🔬 Исследование | 🛠 Инструмент | 💡 Тренд | 📊 Бенчмарк\n` +
      `ВАЖНО: Входные данные уже содержат ссылки [Title](URL). Твоя задача — перевести Title на русский, СОХРАНИВ ссылку!\n` +
      `Формат вывода: **1. [Заголовок на русском](url)** — комментарий\n\n` +
      aiLines.join('\n')
    );
    appLogger.info({ total: allAiHeadlines.length }, 'Digest: AI/Tech headlines added (ALL, no slice)');
  }

  // АЗИАТСКИЕ AI/TECH ИСТОЧНИКИ — китайские, японские, корейские
  if (asiaAiHeadlines.length > 0) {
    const asiaLines = asiaAiHeadlines.map((h, idx) => {
      const langLabel = h.language === 'zh' ? '🇨🇳' : h.language === 'ja' ? '🇯🇵' : h.language === 'ko' ? '🇰🇷' : '';
      return `${idx + 1}. ${langLabel} [${h.title}](${h.url}) (source: ${h.source})`;
    });
    rawData.push(
      `[AI НОВОСТИ ИЗ АЗИИ — КИТАЙ, ЯПОНИЯ, КОРЕЯ] (${asiaAiHeadlines.length} заголовков)\n` +
      `Ты ОБЯЗАНА включить ВСЕ ${asiaAiHeadlines.length} заголовков!\n` +
      `ВАЖНО: Входные данные уже содержат ссылки. Переведи заголовок, СОХРАНИВ ссылку!\n` +
      `Формат вывода: **1. [Перевод заголовка](url)** — комментарий\n\n` +
      asiaLines.join('\n')
    );
    appLogger.info({ total: asiaAiHeadlines.length }, 'Digest: Asia AI headlines added (ALL, no slice)');
  }

  // 5. Напоминания на сегодня
  if (remindersResult.status === 'fulfilled') {
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
  }

  // 6. Активные задачи
  if (todosResult.status === 'fulfilled') {
    const todos = todosResult.value;
    if (todos.length > 0) {
      const lines = todos.slice(0, 10).map(t => `- ${t.task}`);
      rawData.push(`[ЗАДАЧИ]\n${lines.join('\n')}`);
    }
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

  const digestPrompt = `Ты — Amina, персональный AI-ассистент И эксперт-журналист в области искусственного интеллекта и технологий вайбкодинга.
Ты глубоко разбираешься в: LLM, open-source моделях, AI-агентах, code generation, промпт-инжиниринге, Cursor, Copilot, локальных моделях (GGUF, llama.cpp), RAG, fine-tuning, MLOps.
Ты следишь за азиатским AI-рынком: DeepSeek, Qwen, китайские open-source модели, японские и корейские AI-стартапы.

Сейчас ${todayDate}.
Составь ПОДРОБНЫЙ УТРЕННИЙ ДАЙДЖЕСТ для ${nameStr} из города ${city}.

Вот собранные данные:

${rawData.join('\n\n')}${citationsBlock}

---

ЗАДАЧА: Подробный, живой, эмоциональный утренний дайджест с ЭКСПЕРТНЫМ разбором AI-новостей.

СТРУКТУРА ДАЙДЖЕСТА:
Включай ТОЛЬКО те разделы, для которых есть данные выше. Если раздела НЕТ в данных — МОЛЧА ПРОПУСТИ его.

1. **Приветствие** — тёплое, по имени, с упоминанием дня недели и даты

2. **Погода в ${city}** — подробно: температура (утро/день/вечер), осадки, ветер, давление, что надеть, совет

3. **Новости ${city}** — Каждую новость пронумеруй и прокомментируй с эмоцией (1-2 предложения авторского комментария). Это МЕСТНЫЕ городские новости!
   ВАЖНО: Если в данных есть заголовки со ссылками — ОБЯЗАТЕЛЬНО оформи как Markdown-ссылку: [заголовок](url).
   Если данных по городу нет — ПРОПУСТИ этот раздел целиком.

4. **Технологии и AI** — САМЫЙ ВАЖНЫЙ И ОБЪЁМНЫЙ РАЗДЕЛ:
   - Пронумеруй ВСЕ заголовки из данных выше (их пронумерованный список).
   - Для КАЖДОГО: переведи на русский + 1 предложение комментария.
   - Группируй: 🚀 Релизы, 🔬 Исследования, 🛠 Инструменты, 💡 Тренды.
   - Формат: **1. [Заголовок на русском](url)** — комментарий
   - ЗАПРЕЩЕНО пропускать заголовки! Каждый номер из данных ДОЛЖЕН быть в ответе.
   - Этот раздел должен занимать 60-70% всего дайджеста.
   Если данных нет — ПРОПУСТИ.

5. **AI из Азии** — если есть азиатские заголовки:
   - Пронумеруй ВСЕ заголовки и включи КАЖДЫЙ.
   - ПЕРЕВЕДИ каждый на русский, оригинал в скобках.
   - Формат: **1. [Перевод (原标题)](url)** — комментарий
   - ЗАПРЕЩЕНО пропускать заголовки!
   Если данных нет — ПРОПУСТИ.

6. **Напоминания и задачи** — если есть в данных, подбодри и дай совет по приоритетам

7. **Настрой на день** — позитивное мотивирующее завершение (КОРОТКО, 1-2 предложения)

ЖЁСТКИЕ ПРАВИЛА:
- ЗАПРЕЩЕНО писать "к сожалению, данных нет", "не удалось найти" — просто ПРОПУСТИ пустой раздел!
- Раздел "Технологии и AI" — САМЫЙ БОЛЬШОЙ. Он должен содержать КАЖДЫЙ пронумерованный заголовок из данных!
- Если AI-заголовков больше 50 — ВСЁ РАВНО включи каждый! Пиши кратко: 1 строка = перевод + ссылка + мини-комментарий.
- Допустимо опустить подробный комментарий если заголовков > 50, но сам заголовок + ссылка ОБЯЗАТЕЛЬНЫ!
- При переводе AI-терминов: оставляй английские термины как есть (LLM, RAG, fine-tuning, RLHF, benchmark)
- НЕ ПРИДУМЫВАЙ новости — только из данных выше
- ОБЯЗАТЕЛЬНО ставь ссылки [N] после фактов из Perplexity
- Формат: Markdown для Telegram (*bold*, _italic_)
- НЕ добавляй в конце инструкции вроде "/digest"`;

  try {
    const llmResponse = await aiService.chat(
      [{ role: 'user', content: digestPrompt }],
      'telegram'
    );
    
    // Пост-обработка: заменяем [N] на кликабельные Markdown-ссылки
    let finalDigest = llmResponse.content;
    if (uniqueCitations.length > 0) {
      finalDigest = inlineCitations(finalDigest, uniqueCitations);
    }
    
    return finalDigest;
  } catch (error) {
    appLogger.error({ error, userId }, 'LLM failed to process digest, using raw data');
    
    // Fallback: сырые данные с приветствием
    const greeting = getTimeGreeting(firstName);
    return `${greeting}\n\n${rawData.join('\n\n')}`;
  }
}

/**
 * Приветствие по времени суток (fallback)
 */
function getTimeGreeting(name: string | null): string {
  const hour = new Date().getHours();
  const nameStr = name ? `, ${name}` : '';

  if (hour >= 5 && hour < 12) return `☀️ *Доброе утро${nameStr}!*`;
  if (hour >= 12 && hour < 17) return `🌤 *Добрый день${nameStr}!*`;
  if (hour >= 17 && hour < 22) return `🌆 *Добрый вечер${nameStr}!*`;
  return `🌙 *Доброй ночи${nameStr}!*`;
}
