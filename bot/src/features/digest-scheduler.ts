/**
 * Morning Digest Scheduler
 * 
 * Каждую минуту проверяет, не пора ли отправить утренний дайджест.
 * Сервер работает в TZ=Europe/Minsk — new Date() уже в минском времени.
 * 
 * Логика:
 * 1. Perplexity ищет: погоду, новости ГОРОДА, новости БЕЛАРУСИ (4 отдельных запроса)
 * 2. Из БД: напоминания на сегодня, задачи
 * 3. Всё передаётся в основную LLM с промптом "обработай эмоционально"
 * 4. LLM формирует живой, авторский дайджест с комментариями
 * 
 * ВАЖНО: Новости СТРОГО по Беларуси. Мировые новости ИСКЛЮЧЕНЫ.
 * Для этого: системный промпт Perplexity, белорусские СМИ, жёсткий LLM-промпт.
 */

import { InlineKeyboard, type Api, type RawApi } from 'grammy';
import { userPrefsRepo } from './user-prefs-repo.js';
import { todosRepo } from './todos-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { webSearch } from '../ai/websearch.js';
import { inlineCitations } from '../telegram/format.js';
import { parseAllConfiguredSites, type ParsedHeadline } from './news-parser.js';
import { aiService } from '../ai/openrouter.js';
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

  appLogger.info('Starting morning digest scheduler (TZ=Europe/Minsk)');

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
 * Сбросить кеш отправленных дайджестов в полночь
 * TZ=Europe/Minsk → new Date().getHours() возвращает минское время
 */
function resetSentCacheAtMidnight(): void {
  if (new Date().getHours() === 0) {
    SENT_TODAY.clear();
  }

  midnightResetInterval = setInterval(() => {
    if (new Date().getHours() === 0) {
      SENT_TODAY.clear();
      appLogger.debug('Digest SENT_TODAY cache cleared at midnight');
    }
  }, 60 * 60 * 1000);
  midnightResetInterval.unref();
}

/**
 * Обработать дайджесты
 */
async function processDigests(bot: BotLike): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const currentHour = new Date().getHours();

    const users = await userPrefsRepo.getDigestUsers(currentHour);
    if (users.length === 0) return;

    for (const user of users) {
      const cacheKey = `${user.user_id}_${currentHour}`;
      if (SENT_TODAY.has(cacheKey)) continue;

      try {
        const digestText = await buildDigest(user.user_id, user.first_name, user.digest_city);
        await sendLongMessage(bot, user.chat_id, digestText, 'Markdown');

        SENT_TODAY.add(cacheKey);
        appLogger.info({ userId: user.user_id, hour: currentHour, city: user.digest_city }, 'Digest sent');
      } catch (sendError) {
        const err = sendError as { error_code?: number };
        if (err.error_code === 403) {
          await userPrefsRepo.update(user.user_id, { digest_enabled: false });
          appLogger.warn({ userId: user.user_id }, 'User blocked bot, digest disabled');
        } else {
          appLogger.error({ error: sendError, userId: user.user_id }, 'Failed to send digest');
        }
      }
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
      if (result.answer && result.answer.length > 30) {
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
 * 1. Perplexity собирает БЕЛОРУССКИЕ данные ПАРАЛЛЕЛЬНО:
 *    - Погода города
 *    - Новости ГОРОДА (локальные)
 *    - Новости БЕЛАРУСИ (экономика, политика, общество)
 *    - Спорт/культура БЕЛАРУСИ
 * 2. БД: напоминания, задачи
 * 3. LLM формирует живой, подробный текст
 * 
 * КЛЮЧЕВОЕ: Все запросы содержат белорусские СМИ и ЖЁСТКИЙ фильтр по стране.
 * Мировые новости полностью исключены на ВСЕХ уровнях.
 */
async function buildDigest(
  userId: string,
  firstName: string | null,
  city: string
): Promise<string> {
  const rawData: string[] = [];
  const todayStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  // Белорусские СМИ — ИСКЛЮЧАЕМ минск-ориентированные если город не Минск
  const isGrodno = city.toLowerCase().includes('гродно') || city.toLowerCase().includes('grodno');
  const isMinsk = city.toLowerCase().includes('минск') || city.toLowerCase().includes('minsk');
  const bySources = isMinsk
    ? 'сайт belta.by, ont.by, tvr.by, sb.by, minsknews.by'
    : 'сайт belta.by, ont.by, tvr.by, sb.by' + (isGrodno ? ', grodnonews.by, newgrodno.by' : '');

  // Фильтр упоминания Минска для не-минских городов
  const minskFilter = !isMinsk
    ? ` СТРОГО ЗАПРЕЩЕНО включать новости про Минск, минские события, минский транспорт! Только общебелорусские новости без привязки к Минску!`
    : '';

  // --- Запускаем ВСЕ запросы параллельно ---
  // Парсер городских новостей ЗАМЕНЯЕТ Perplexity для местных новостей.
  // Perplexity остаётся для общих новостей Беларуси, погоды и спорта/культуры.
  const [weatherResult, parsedHeadlinesResult, belarusNewsResult, belarusSportCultureResult, remindersResult, todosResult] = 
    await Promise.allSettled([
      // 1. Погода — подробно с прогнозом
      webSearchWithRetry(
        `Погода ${city} Беларусь сегодня ${todayStr}: точная температура сейчас утром днём вечером, осадки, ветер, влажность, давление, ощущается как. Подробный прогноз на весь день.`
      ),

      // 2. ПАРСИНГ ЗАГОЛОВКОВ с настроенных новостных сайтов
      parseAllConfiguredSites(),

      // 3. Новости БЕЛАРУСИ — экономика, политика, общество (Perplexity)
      webSearchWithRetry(
        `Внутренние новости Беларуси ${todayStr} (${bySources}): ` +
        `белорусская экономика, решения правительства, законы, социальная политика, образование, здравоохранение, ` +
        `инфраструктура, строительство, IT-сектор Беларуси, курс белорусского рубля, цены` +
        (isGrodno ? `, Гродненская область, регионы Беларуси` : '') + `. ` +
        `СТРОГО только внутренние белорусские новости! НЕ включай мировые, российские, украинские новости!${minskFilter} ` +
        `Минимум 5-7 пунктов о жизни внутри Беларуси с конкретными фактами и цифрами.`
      ),

      // 4. Спорт и культура БЕЛАРУСИ — отдельный запрос для полноты
      webSearchWithRetry(
        `Спорт культура Беларусь ${city} сегодня ${todayStr}: белорусские спортсмены, ` +
        (isGrodno ? 'Неман Гродно, ' : '') +
        `БАТЭ, белорусский футбол хоккей биатлон, театры Беларуси, концерты, фестивали, выставки в ${city} и Беларуси. ` +
        `Только белорусский спорт и культура!${minskFilter} Минимум 3-5 событий.`
      ),

      // 5. Напоминания из БД
      remindersRepo.getByUser(userId),
      // 6. Задачи из БД
      todosRepo.getForDigest(userId),
    ]);

  // Собираем ВСЕ citations из всех поисковых запросов
  const allCitations: string[] = [];

  // Обрабатываем результаты поиска
  if (weatherResult.status === 'fulfilled' && weatherResult.value?.answer) {
    rawData.push(`[ПОГОДА ${city.toUpperCase()}]\n${weatherResult.value.answer}`);
    allCitations.push(...(weatherResult.value.citations ?? []));
  } else {
    rawData.push(`[ПОГОДА ${city.toUpperCase()}]\nДанные о погоде временно недоступны`);
    if (weatherResult.status === 'rejected') {
      appLogger.warn({ error: weatherResult.reason, city }, 'Digest: weather search failed');
    }
  }

  // ГОРОДСКИЕ НОВОСТИ — из парсера настроенных сайтов
  let parsedHeadlines: ParsedHeadline[] = [];
  if (parsedHeadlinesResult.status === 'fulfilled') {
    parsedHeadlines = parsedHeadlinesResult.value;
  } else {
    appLogger.warn({ error: parsedHeadlinesResult.reason }, 'Digest: news parser failed');
  }

  // ФИЛЬТРАЦИЯ: убираем заголовки с упоминанием Минска, если город НЕ Минск
  if (city !== 'Минск') {
    const originalCount = parsedHeadlines.length;
    parsedHeadlines = parsedHeadlines.filter(h => {
      const titleLower = h.title.toLowerCase();
      const urlLower = h.url.toLowerCase();
      // Исключаем если заголовок/URL содержит "минск", "minsk", "минчан", "минский"
      return !(
        titleLower.includes('минск') ||
        titleLower.includes('минчан') ||
        titleLower.includes('minsk') ||
        urlLower.includes('minsk')
      );
    });
    if (originalCount !== parsedHeadlines.length) {
      appLogger.info(
        { city, filtered: originalCount - parsedHeadlines.length, remaining: parsedHeadlines.length },
        'Digest: filtered out Minsk news'
      );
    }
  }

  if (parsedHeadlines.length > 0) {
    // Формат: каждый заголовок с ссылкой и источником
    const headlineLines = parsedHeadlines.map(h =>
      `- ${h.title} (ссылка: ${h.url}) [источник: ${h.source}]`
    );
    rawData.push(
      `[МЕСТНЫЕ НОВОСТИ — ЗАГОЛОВКИ С НОВОСТНЫХ САЙТОВ ${city.toUpperCase()}]\n` +
      `Ниже — актуальные заголовки новостей, спарсенные с местных новостных сайтов.\n` +
      `Для каждой новости ОБЯЗАТЕЛЬНО сохрани ссылку в формате Markdown: [заголовок](url)\n\n` +
      headlineLines.join('\n')
    );
    appLogger.info({ count: parsedHeadlines.length, city }, 'Digest: using parsed headlines for city news');
  } else {
    // FALLBACK: если парсер не дал результатов — используем Perplexity как раньше
    appLogger.info({ city }, 'Digest: no parsed headlines, falling back to Perplexity for city news');
    const fallbackResult = await webSearchWithRetry(
      `Новости ${city} Беларусь сегодня ${todayStr} site:${city === 'Гродно' ? 'grodnonews.by OR grodno.in OR newgrodno.by' : city === 'Минск' ? 'minsknews.by OR minsk-news.by' : 'belta.by'}: ` +
      `местные события, происшествия, решения городских властей, транспорт, благоустройство, культурная жизнь ${city}. ` +
      `Ищи ТОЛЬКО местные городские новости ${city}! Минимум 5 конкретных событий с датами. ` +
      `НЕ включай мировые или российские новости — ТОЛЬКО ${city}.`
    );
    if (fallbackResult?.answer) {
      rawData.push(`[МЕСТНЫЕ НОВОСТИ ${city.toUpperCase()}]\n${fallbackResult.answer}`);
    }
    // Если и fallback не дал результатов — не добавляем пустой блок, LLM пропустит раздел
  }

  if (belarusNewsResult.status === 'fulfilled' && belarusNewsResult.value?.answer) {
    let belarusNews = belarusNewsResult.value.answer;
    allCitations.push(...(belarusNewsResult.value.citations ?? []));
    // Фильтрация: убираем предложения с упоминанием Минска если город НЕ Минск
    if (!isMinsk) {
      const sentences = belarusNews.split(/(?<=[.!?])\s+/);
      const filtered = sentences.filter(s => {
        const lower = s.toLowerCase();
        // Расширенный фильтр: "мнс минска", "минский район", etc.
        return !lower.includes('минск') && !lower.includes('minsk') && !lower.includes('минчан');
      });
      if (filtered.length < sentences.length) {
        appLogger.info({ filtered: sentences.length - filtered.length }, 'Digest: filtered Minsk from Belarus news');
        belarusNews = filtered.join(' ');
      }
    }
    if (belarusNews.trim()) {
      rawData.push(`[НОВОСТИ БЕЛАРУСИ — ЭКОНОМИКА, ПОЛИТИКА, ОБЩЕСТВО]\n${belarusNews}`);
    }
  } else if (belarusNewsResult.status === 'rejected') {
    appLogger.warn({ error: belarusNewsResult.reason }, 'Digest: Belarus news failed');
  }

  if (belarusSportCultureResult.status === 'fulfilled' && belarusSportCultureResult.value?.answer) {
    let sportCulture = belarusSportCultureResult.value.answer;
    allCitations.push(...(belarusSportCultureResult.value.citations ?? []));
    // Фильтрация Минска из спорта/культуры
    if (!isMinsk) {
      const sentences = sportCulture.split(/(?<=[.!?])\s+/);
      const filtered = sentences.filter(s => {
        const lower = s.toLowerCase();
        return !lower.includes('минск') && !lower.includes('minsk') && !lower.includes('минчан');
      });
      if (filtered.length < sentences.length) {
        sportCulture = filtered.join(' ');
      }
    }
    if (sportCulture.trim()) {
      rawData.push(`[СПОРТ И КУЛЬТУРА БЕЛАРУСИ]\n${sportCulture}`);
    }
  } else if (belarusSportCultureResult.status === 'rejected') {
    appLogger.warn({ error: belarusSportCultureResult.reason }, 'Digest: Belarus sport/culture failed');
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

  const digestPrompt = `Ты — Amina, персональный ассистент. Сейчас ${todayDate}.
Составь ПОДРОБНЫЙ УТРЕННИЙ ДАЙДЖЕСТ для ${nameStr} из города ${city}, Беларусь.

Вот собранные данные:

${rawData.join('\n\n')}${citationsBlock}

---

ЗАДАЧА: Подробный, живой, эмоциональный утренний дайджест.

СТРУКТУРА ДАЙДЖЕСТА:
Включай ТОЛЬКО те разделы, для которых есть данные выше. Если раздела НЕТ в данных — МОЛЧА ПРОПУСТИ его, НЕ пиши "к сожалению, данных нет", "не удалось найти", "нет свежих новостей" и подобные извинения!

1. **Приветствие** — тёплое, по имени, с упоминанием дня недели и даты

2. **Погода в ${city}** — подробно: температура (утро/день/вечер), осадки, ветер, давление, что надеть, совет

3. **Новости ${city}** — Каждую новость пронумеруй и прокомментируй с эмоцией (1-2 предложения авторского комментария). Это МЕСТНЫЕ городские новости!
   ВАЖНО: Если в данных есть заголовки со ссылками — ОБЯЗАТЕЛЬНО оформи каждую новость как кликабельную Markdown-ссылку: [заголовок](url). НЕ теряй ссылки!
   Если данных по городу нет — ПРОПУСТИ этот раздел целиком.

4. **Новости Беларуси** — экономика, политика, общество, спорт, культура. Каждую с кратким комментарием.
   ОБЯЗАТЕЛЬНО: после каждой новости ставь ссылку на источник в формате [N] — число из КАРТЫ ИСТОЧНИКОВ выше.
   Пример: "Зарплаты бюджетников вырастут на 5% [3]" — где [3] это ссылка из карты.
   Если данных нет — ПРОПУСТИ этот раздел целиком. НЕ ИЗВИНЯЙСЯ!

5. **Технологии и AI** — если среди данных есть новости с vc.ru или про AI/технологии, выдели их в отдельный блок. Тоже с [N] ссылками. Если нет — пропусти.

6. **Напоминания и задачи** — если есть в данных, подбодри и дай совет по приоритетам

7. **Настрой на день** — позитивное мотивирующее завершение (КОРОТКО, 1-2 предложения)

ЖЁСТКИЕ ПРАВИЛА:
- ЗАПРЕЩЕНО писать "к сожалению, данных нет", "не удалось найти новости", "нет свежих новостей" — просто ПРОПУСТИ пустой раздел!
- ЗАПРЕЩЕНО включать мировые ПОЛИТИЧЕСКИЕ новости (Россия, Украина, США, Европа, Ближний Восток)!
- ЗАПРЕЩЕНО включать новости о войнах, конфликтах, катастрофах в других странах!
- ЗАПРЕЩЕНО включать новости Минска (происшествия, события, транспорт Минска) — НЕ УПОМИНАЙ Минск!
- Если в данных есть мировые новости или новости Минска — ПРОПУСТИ ИХ молча!
- ЗАПРЕЩЕНО упоминать МНС Минска, минский район, минчан, минские события — ЭТО Минск!
- Новости технологий/AI с vc.ru — МОЖНО включать (это отдельный раздел)
- ТОЛЬКО Беларусь (общенациональные) + ${city} (городские) + AI/технологии!${!isMinsk ? `
- ⚠️ АБСОЛЮТНЫЙ ЗАПРЕТ НА МИНСК! НЕ включай новости Минска, минские события, минский транспорт, происшествия в Минске!
- Если новость привязана к Минску (минский троллейбус, Ботанический сад Минска, минские улицы, МНС Минска) — ПРОПУСТИ ЕЁ!
- Заголовок секции "Новости ${city}", НЕ "Новости Минска"!
- Упоминание "Минск", "минский", "минчан" в дайджесте = ОШИБКА!` : ''}
- НЕ ПРИДУМЫВАЙ новости — только из данных выше
- НЕ ВЫДУМЫВАЙ и НЕ ИЗВИНЯЙСЯ за отсутствие данных — просто пропускай!
- ОБЯЗАТЕЛЬНО ставь ссылки [N] после каждого факта/новости (N = номер из КАРТЫ ИСТОЧНИКОВ)
- Эмодзи уместно, не перебарщивай
- Формат: Markdown для Telegram (*bold* заголовки, _italic_ для деталей)
- Длина: столько, сколько есть контента. Не растягивай искусственно.
- Каждая новость должна быть 2-3 предложения с комментарием
- НЕ добавляй в конце инструкции вроде "/digest", "/digest now" — дайджест завершается разделом "Настрой на день"`;

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
 * TZ=Europe/Minsk → getHours() = минское время
 */
function getTimeGreeting(name: string | null): string {
  const hour = new Date().getHours();
  const nameStr = name ? `, ${name}` : '';

  if (hour >= 5 && hour < 12) return `☀️ *Доброе утро${nameStr}!*`;
  if (hour >= 12 && hour < 17) return `🌤 *Добрый день${nameStr}!*`;
  if (hour >= 17 && hour < 22) return `🌆 *Добрый вечер${nameStr}!*`;
  return `🌙 *Доброй ночи${nameStr}!*`;
}
