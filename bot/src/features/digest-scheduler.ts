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

import type { Api, RawApi } from 'grammy';
import { userPrefsRepo } from './user-prefs-repo.js';
import { todosRepo } from './todos-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { webSearch } from '../ai/websearch.js';
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

/**
 * Отправить длинное сообщение, разбивая на части при необходимости
 */
async function sendLongMessage(
  bot: BotLike,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'HTML'
): Promise<void> {
  const MAX_LENGTH = 4096;
  
  // Если текст короткий — отправляем одним сообщением
  if (text.length <= MAX_LENGTH) {
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: parseMode });
    } catch {
      // Fallback: без форматирования
      const plainText = text.replace(/[*_`~[\]()]/g, '');
      await bot.api.sendMessage(chatId, plainText);
    }
    return;
  }
  
  // Разбиваем на части по абзацам
  const paragraphs = text.split('\n\n');
  let chunk = '';
  
  for (const para of paragraphs) {
    if (chunk.length + para.length + 2 > MAX_LENGTH) {
      if (chunk) {
        try {
          await bot.api.sendMessage(chatId, chunk.trim(), { parse_mode: parseMode });
        } catch {
          const plainChunk = chunk.trim().replace(/[*_`~[\]()]/g, '');
          await bot.api.sendMessage(chatId, plainChunk);
        }
        chunk = '';
      }
      // Если один абзац длиннее лимита — обрезаем
      if (para.length > MAX_LENGTH) {
        const plainPara = para.replace(/[*_`~[\]()]/g, '').substring(0, MAX_LENGTH);
        await bot.api.sendMessage(chatId, plainPara);
        continue;
      }
    }
    chunk += (chunk ? '\n\n' : '') + para;
  }
  
  if (chunk.trim()) {
    try {
      await bot.api.sendMessage(chatId, chunk.trim(), { parse_mode: parseMode });
    } catch {
      const plainChunk = chunk.trim().replace(/[*_`~[\]()]/g, '');
      await bot.api.sendMessage(chatId, plainChunk);
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
 * Поиск с повторной попыткой при ошибке
 */
async function webSearchWithRetry(
  query: string,
  retries = 2
): Promise<{ answer: string } | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await webSearch(query, { forDigest: true });
      if (result.answer && result.answer.length > 30) {
        return result;
      }
      appLogger.warn({ query: query.substring(0, 50), attempt, answerLength: result.answer?.length ?? 0 }, 'Digest: search returned weak result');
    } catch (error) {
      appLogger.warn({ error, query: query.substring(0, 50), attempt }, `Digest: search attempt ${attempt} failed`);
      if (attempt < retries) {
        // Пауза перед повтором (1.5 сек)
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

  // Обрабатываем результаты поиска
  if (weatherResult.status === 'fulfilled' && weatherResult.value?.answer) {
    rawData.push(`[ПОГОДА ${city.toUpperCase()}]\n${weatherResult.value.answer}`);
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
      // Исключаем если заголовок/URL содержит "минск", "minsk", "minsknews"
      return !(
        titleLower.includes('минск') ||
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
    } else {
      rawData.push(`[МЕСТНЫЕ НОВОСТИ ${city.toUpperCase()}]\nНе удалось получить местные новости`);
    }
  }

  if (belarusNewsResult.status === 'fulfilled' && belarusNewsResult.value?.answer) {
    let belarusNews = belarusNewsResult.value.answer;
    // Фильтрация: убираем предложения с упоминанием Минска если город НЕ Минск
    if (!isMinsk) {
      const sentences = belarusNews.split(/(?<=[.!?])\s+/);
      const filtered = sentences.filter(s => {
        const lower = s.toLowerCase();
        return !lower.includes('минск') && !lower.includes('minsk');
      });
      if (filtered.length < sentences.length) {
        appLogger.info({ filtered: sentences.length - filtered.length }, 'Digest: filtered Minsk from Belarus news');
        belarusNews = filtered.join(' ');
      }
    }
    rawData.push(`[НОВОСТИ БЕЛАРУСИ — ЭКОНОМИКА, ПОЛИТИКА, ОБЩЕСТВО]\n${belarusNews}`);
  } else {
    rawData.push(`[НОВОСТИ БЕЛАРУСИ]\nНе удалось получить новости Беларуси`);
    if (belarusNewsResult.status === 'rejected') {
      appLogger.warn({ error: belarusNewsResult.reason }, 'Digest: Belarus news failed');
    }
  }

  if (belarusSportCultureResult.status === 'fulfilled' && belarusSportCultureResult.value?.answer) {
    let sportCulture = belarusSportCultureResult.value.answer;
    // Фильтрация Минска из спорта/культуры
    if (!isMinsk) {
      const sentences = sportCulture.split(/(?<=[.!?])\s+/);
      const filtered = sentences.filter(s => {
        const lower = s.toLowerCase();
        return !lower.includes('минск') && !lower.includes('minsk');
      });
      if (filtered.length < sentences.length) {
        sportCulture = filtered.join(' ');
      }
    }
    if (sportCulture.trim()) {
      rawData.push(`[СПОРТ И КУЛЬТУРА БЕЛАРУСИ]\n${sportCulture}`);
    }
  } else {
    // Спорт/культура не критичны — не добавляем ошибку
    if (belarusSportCultureResult.status === 'rejected') {
      appLogger.warn({ error: belarusSportCultureResult.reason }, 'Digest: Belarus sport/culture failed');
    }
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

  // --- LLM обработка ---
  const nameStr = firstName || 'друг';
  const todayDate = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const digestPrompt = `Ты — Amina, персональный ассистент. Сейчас ${todayDate}.
Составь ПОДРОБНЫЙ УТРЕННИЙ ДАЙДЖЕСТ для ${nameStr} из города ${city}, Беларусь.

Вот собранные данные:

${rawData.join('\n\n')}

---

ЗАДАЧА: Подробный, живой, эмоциональный утренний дайджест.

СТРУКТУРА ДАЙДЖЕСТА (ОБЯЗАТЕЛЬНАЯ):

1. **Приветствие** — тёплое, по имени, с упоминанием дня недели и даты

2. **Погода в ${city}** — подробно: температура (утро/день/вечер), осадки, ветер, давление, что надеть, совет

3. **Новости ${city}** — ГЛАВНАЯ ЧАСТЬ дайджеста! Каждую новость пронумеруй и прокомментируй с эмоцией (1-2 предложения авторского комментария). Минимум 3-5 пунктов. Это МЕСТНЫЕ городские новости!
   ВАЖНО: Если в данных есть заголовки со ссылками — ОБЯЗАТЕЛЬНО оформи каждую новость как кликабельную Markdown-ссылку: [заголовок](url). НЕ теряй ссылки!

4. **Новости Беларуси** — экономика, политика, общество, спорт, культура. Каждую с кратким комментарием. Минимум 3-5 пунктов.

5. **Технологии и AI** — если среди данных есть новости с vc.ru или про AI/технологии, выдели их в отдельный блок. Выбирай самые интересные 3-5 новостей про AI, разработку, стартапы.

6. **Напоминания и задачи** — подбодри, дай совет по приоритетам

7. **Настрой на день** — позитивное мотивирующее завершение

ЖЁСТКИЕ ПРАВИЛА:
- ЗАПРЕЩЕНО включать мировые ПОЛИТИЧЕСКИЕ новости (Россия, Украина, США, Европа, Ближний Восток)!
- ЗАПРЕЩЕНО включать новости о войнах, конфликтах, катастрофах в других странах!
- Если в данных есть мировые политические новости — ПРОПУСТИ ИХ, не включай в дайджест!
- Новости технологий/AI с vc.ru — МОЖНО включать (это отдельный раздел)
- ТОЛЬКО Беларусь (общенациональные) + ${city} (городские) + AI/технологии!${!isMinsk ? `
- ⚠️ АБСОЛЮТНЫЙ ЗАПРЕТ НА МИНСК! НЕ включай новости Минска, минские события, минский транспорт, происшествия в Минске!
- Если новость привязана к Минску (минский троллейбус, Ботанический сад Минска, минские улицы) — ПРОПУСТИ ЕЁ!
- Заголовок секции "Новости ${city}", НЕ "Новости Минска"!
- Упоминание "Минск" в дайджесте = ОШИБКА!` : ''}
- НЕ ПРИДУМЫВАЙ новости — только из данных выше
- Если данных мало — честно скажи, не выдумывай
- Эмодзи уместно, не перебарщивай
- Формат: Markdown для Telegram (*bold* заголовки, _italic_ для деталей)
- Длина: 2500-5000 символов — дайджест должен быть ПОДРОБНЫМ!
- Каждая новость должна быть 2-3 предложения с комментарием`;

  try {
    const llmResponse = await aiService.chat(
      [{ role: 'user', content: digestPrompt }],
      'telegram'
    );
    
    const keyboard = '📋 /digest | 🔄 /digest now';
    return llmResponse.content + `\n\n_${keyboard}_`;
  } catch (error) {
    appLogger.error({ error, userId }, 'LLM failed to process digest, using raw data');
    
    // Fallback: сырые данные с приветствием
    const greeting = getTimeGreeting(firstName);
    return `${greeting}\n\n${rawData.join('\n\n')}\n\n_/digest — настройки дайджеста_`;
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
