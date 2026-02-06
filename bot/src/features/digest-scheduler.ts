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
 * Собрать дайджест:
 * 1. Perplexity собирает сырые данные ПАРАЛЛЕЛЬНО (погода, новости города, Беларусь и мир)
 * 2. БД: напоминания, задачи (параллельно)
 * 3. Основная LLM превращает всё в живой текст
 */
async function buildDigest(
  userId: string,
  firstName: string | null,
  city: string
): Promise<string> {
  const rawData: string[] = [];

  // --- Запускаем ВСЕ запросы параллельно для скорости ---
  const [weatherResult, cityNewsResult, worldNewsResult, remindersResult, todosResult] = 
    await Promise.allSettled([
      // 1. Погода
      webSearch(`Погода ${city} Беларусь сегодня температура осадки ветер`),
      // 2. Новости города
      webSearch(`Новости ${city} Беларусь сегодня: события, происшествия, жизнь города. 5-7 главных новостей.`),
      // 3. Новости Беларуси и мира
      webSearch('Главные новости Беларуси и мира сегодня коротко, 5-7 пунктов'),
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
      appLogger.warn({ error: weatherResult.reason, city }, 'Digest: weather search failed');
    }
  }

  if (cityNewsResult.status === 'fulfilled' && cityNewsResult.value?.answer) {
    rawData.push(`[НОВОСТИ ${city.toUpperCase()}]\n${cityNewsResult.value.answer}`);
  } else {
    rawData.push(`[НОВОСТИ ${city.toUpperCase()}]\nНе удалось получить новости города`);
    if (cityNewsResult.status === 'rejected') {
      appLogger.warn({ error: cityNewsResult.reason, city }, 'Digest: city news search failed');
    }
  }

  if (worldNewsResult.status === 'fulfilled' && worldNewsResult.value?.answer) {
    rawData.push(`[НОВОСТИ БЕЛАРУСИ И МИРА]\n${worldNewsResult.value.answer}`);
  } else if (worldNewsResult.status === 'rejected') {
    appLogger.warn({ error: worldNewsResult.reason }, 'Digest: world news search failed');
  }

  // 4. Напоминания на сегодня
  if (remindersResult.status === 'fulfilled') {
    const reminders = remindersResult.value;
    const todayStr = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

    const todayReminders = reminders.filter(r => {
      const reminderDate = new Date(r.scheduled_at).toLocaleDateString('sv-SE');
      return reminderDate === todayStr;
    });

    if (todayReminders.length > 0) {
      const lines = todayReminders.map(r => {
        const time = new Date(r.scheduled_at).toLocaleTimeString('ru-RU', {
          hour: '2-digit', minute: '2-digit',
        });
        return `${time} — ${r.task}`;
      });
      rawData.push(`[НАПОМИНАНИЯ НА СЕГОДНЯ]\n${lines.join('\n')}`);
    }
  }

  // 5. Активные задачи
  if (todosResult.status === 'fulfilled') {
    const todos = todosResult.value;
    if (todos.length > 0) {
      const lines = todos.slice(0, 7).map(t => `- ${t.task}`);
      rawData.push(`[ЗАДАЧИ]\n${lines.join('\n')}`);
    }
  }

  // --- Передаём сырые данные в LLM для эмоциональной обработки ---

  const nameStr = firstName || 'друг';
  const todayDate = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const digestPrompt = `Ты — Amina, персональный ассистент. Сейчас ${todayDate}.
Тебе нужно составить УТРЕННИЙ ДАЙДЖЕСТ для пользователя по имени ${nameStr} из города ${city}, Беларусь.

Вот сырые данные из интернета и базы данных:

${rawData.join('\n\n')}

---

ЗАДАЧА: Преврати это в живой, эмоциональный утренний дайджест.

ПРАВИЛА:
1. Начни с тёплого приветствия по имени
2. Погоду подай с эмоциями и советом ("Бери зонт!" или "Идеально для прогулки!")
3. Новости ${city} — главная часть! Прокомментируй каждую новость с живой реакцией, юмором или сочувствием
4. Новости Беларуси и мира — коротко, 2-3 предложения, с комментарием
5. Напоминания и задачи — если есть, подбодри и мотивируй
6. Заверши позитивной нотой или пожеланием на день
7. Используй эмодзи уместно, но не перебарщивай
8. Формат: Markdown (для Telegram), жирный текст (*bold*) для заголовков
9. НЕ придумывай новости — используй ТОЛЬКО то что в данных выше
10. Длина: 1500-3000 символов (не слишком коротко, не слишком длинно)`;

  try {
    const llmResponse = await aiService.chat(
      [{ role: 'user', content: digestPrompt }],
      'telegram'
    );
    
    // Добавляем подпись
    return llmResponse.content + '\n\n_Настройки: /digest | Запросить сейчас: /digest now_';
  } catch (error) {
    appLogger.error({ error, userId }, 'LLM failed to process digest, using raw data');
    
    // Fallback: отправляем сырые данные если LLM недоступна
    const greeting = getTimeGreeting(firstName);
    return `${greeting}\n\n${rawData.join('\n\n')}\n\n_Настройки: /digest_`;
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
