/**
 * Morning Digest Scheduler
 * 
 * Каждую минуту проверяет, не пора ли отправить утренний дайджест.
 * Сервер работает в TZ=Europe/Minsk — new Date() уже в минском времени.
 * 
 * Логика:
 * 1. Perplexity (sonar-reasoning-pro) ищет: погоду, новости города, новости Беларуси и мира
 * 2. Из БД: напоминания на сегодня, задачи
 * 3. Всё передаётся в основную LLM с промптом "обработай эмоционально"
 * 4. LLM формирует живой, авторский дайджест с комментариями
 */

import type { Api, RawApi } from 'grammy';
import { userPrefsRepo } from './user-prefs-repo.js';
import { todosRepo } from './todos-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { webSearch } from '../ai/websearch.js';
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
 * 1. Perplexity собирает сырые данные ПАРАЛЛЕЛЬНО (погода, новости города, мир)
 * 2. БД: напоминания, задачи
 * 3. LLM формирует живой текст
 * 
 * Улучшения:
 * - Увеличены токены для подробных ответов (forDigest: true)
 * - Повторные попытки при ошибках
 * - Лучшие промпты для поиска
 */
async function buildDigest(
  userId: string,
  firstName: string | null,
  city: string
): Promise<string> {
  const rawData: string[] = [];
  const todayStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  // --- Запускаем ВСЕ запросы параллельно ---
  const [weatherResult, cityNewsResult, worldNewsResult, remindersResult, todosResult] = 
    await Promise.allSettled([
      // 1. Погода — подробно
      webSearchWithRetry(
        `Погода ${city} Беларусь сегодня ${todayStr}: точная температура сейчас, днём и ночью, осадки, ветер, влажность, давление. Прогноз на весь день.`
      ),
      // 2. Новости города — подробные, конкретные
      webSearchWithRetry(
        `Последние новости ${city} Беларусь ${todayStr}: основные события, происшествия, решения властей, жизнь города за последние 24 часа. Минимум 5-7 конкретных новостей с датами и деталями.`
      ),
      // 3. Новости Беларуси и мира
      webSearchWithRetry(
        `Главные новости Беларуси и мира ${todayStr}: самые важные события за последние 24 часа. 5-7 конкретных пунктов с деталями.`
      ),
      // 4. Напоминания из БД
      remindersRepo.getByUser(userId),
      // 5. Задачи из БД
      todosRepo.getForDigest(userId),
    ]);

  // Обрабатываем результаты
  if (weatherResult.status === 'fulfilled' && weatherResult.value?.answer) {
    rawData.push(`[ПОГОДА ${city}]\n${weatherResult.value.answer}`);
  } else {
    rawData.push(`[ПОГОДА ${city}]\nНе удалось получить данные о погоде`);
    if (weatherResult.status === 'rejected') {
      appLogger.warn({ error: weatherResult.reason, city }, 'Digest: weather search failed after retries');
    }
  }

  if (cityNewsResult.status === 'fulfilled' && cityNewsResult.value?.answer) {
    rawData.push(`[НОВОСТИ ${city.toUpperCase()}]\n${cityNewsResult.value.answer}`);
  } else {
    rawData.push(`[НОВОСТИ ${city.toUpperCase()}]\nНе удалось получить новости города`);
    if (cityNewsResult.status === 'rejected') {
      appLogger.warn({ error: cityNewsResult.reason, city }, 'Digest: city news failed after retries');
    }
  }

  if (worldNewsResult.status === 'fulfilled' && worldNewsResult.value?.answer) {
    rawData.push(`[НОВОСТИ БЕЛАРУСИ И МИРА]\n${worldNewsResult.value.answer}`);
  } else {
    rawData.push(`[НОВОСТИ БЕЛАРУСИ И МИРА]\nНе удалось получить мировые новости`);
    if (worldNewsResult.status === 'rejected') {
      appLogger.warn({ error: worldNewsResult.reason }, 'Digest: world news failed after retries');
    }
  }

  // 4. Напоминания на сегодня
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

  // 5. Активные задачи
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
Составь УТРЕННИЙ ДАЙДЖЕСТ для ${nameStr} из города ${city}, Беларусь.

Вот данные из интернета и БД:

${rawData.join('\n\n')}

---

ЗАДАЧА: Живой, эмоциональный утренний дайджест.

ПРАВИЛА:
1. Тёплое приветствие по имени
2. Погода — с эмоциями и советом ("Бери зонт!" / "Идеально для прогулки!")
3. Новости ${city} — главная часть! Прокомментируй каждую с эмоцией
4. Новости Беларуси и мира — кратко, с комментарием
5. Напоминания/задачи — подбодри
6. Позитивное завершение
7. Эмодзи уместно, не перебарщивай
8. Формат: Markdown для Telegram (*bold* заголовки)
9. НЕ ПРИДУМЫВАЙ — только из данных выше
10. Если данные не получены — честно скажи, не выдумывай
11. Длина: 1500-3500 символов`;

  try {
    const llmResponse = await aiService.chat(
      [{ role: 'user', content: digestPrompt }],
      'telegram'
    );
    
    const keyboard = '📋 /digest | 🔄 /digest now';
    return llmResponse.content + `\n\n_${keyboard}_`;
  } catch (error) {
    appLogger.error({ error, userId }, 'LLM failed to process digest, using raw data');
    
    // Fallback: сырые данные
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
