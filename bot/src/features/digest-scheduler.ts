/**
 * Morning Digest Scheduler
 * 
 * Каждую минуту проверяет, не пора ли отправить утренний дайджест.
 * 
 * Логика:
 * 1. Perplexity (sonar-reasoning-pro) ищет: погоду, новости города, мировые новости
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
let isProcessing = false;

/**
 * Запустить планировщик дайджестов
 */
export function startDigestScheduler(bot: BotLike): void {
  if (digestInterval) {
    appLogger.warn('Digest scheduler already running');
    return;
  }

  appLogger.info('Starting morning digest scheduler');

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
    appLogger.info('Digest scheduler stopped');
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
  await bot.api.sendMessage(chatId, digestText, { parse_mode: 'Markdown' });
}

/**
 * Сбросить кеш отправленных дайджестов в полночь (Москва)
 */
function resetSentCacheAtMidnight(): void {
  const now = new Date();
  const moscowHour = getMoscowHour(now);

  if (moscowHour === 0) {
    SENT_TODAY.clear();
  }

  setInterval(() => {
    const h = getMoscowHour(new Date());
    if (h === 0) {
      SENT_TODAY.clear();
    }
  }, 60 * 60 * 1000).unref();
}

/**
 * Получить текущий час по Москве
 */
function getMoscowHour(date: Date): number {
  const moscowTime = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return moscowTime.getHours();
}

/**
 * Обработать дайджесты
 */
async function processDigests(bot: BotLike): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const now = new Date();
    const currentHour = getMoscowHour(now);

    const users = await userPrefsRepo.getDigestUsers(currentHour);
    if (users.length === 0) return;

    for (const user of users) {
      const cacheKey = `${user.user_id}_${currentHour}`;
      if (SENT_TODAY.has(cacheKey)) continue;

      try {
        const digestText = await buildDigest(user.user_id, user.first_name, user.digest_city);

        await bot.api.sendMessage(user.chat_id, digestText, {
          parse_mode: 'Markdown',
        });

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
 * 1. Perplexity собирает сырые данные (погода, новости города, мир)
 * 2. БД: напоминания, задачи
 * 3. Основная LLM превращает всё в живой текст
 */
async function buildDigest(
  userId: string,
  firstName: string | null,
  city: string
): Promise<string> {
  const rawData: string[] = [];

  // 1. Погода
  try {
    const weather = await webSearch(`Погода ${city} сегодня температура осадки ветер`);
    if (weather?.answer) {
      rawData.push(`[ПОГОДА ${city}]\n${weather.answer}`);
    }
  } catch {
    rawData.push(`[ПОГОДА ${city}]\nНе удалось получить данные`);
  }

  // 2. Новости города
  try {
    const cityNews = await webSearch(
      `Новости ${city} сегодня: события, происшествия, жизнь города. 5-7 главных новостей.`
    );
    if (cityNews?.answer) {
      rawData.push(`[НОВОСТИ ${city.toUpperCase()}]\n${cityNews.answer}`);
    }
  } catch {
    rawData.push(`[НОВОСТИ ${city.toUpperCase()}]\nНе удалось получить новости`);
  }

  // 3. Мировые/национальные новости (коротко)
  try {
    const worldNews = await webSearch(
      'Главные новости Беларуси и мира сегодня коротко, 3-5 пунктов'
    );
    if (worldNews?.answer) {
      rawData.push(`[НОВОСТИ МИРА И БЕЛАРУСИ]\n${worldNews.answer}`);
    }
  } catch {
    // Не критично
  }

  // 4. Напоминания на сегодня (из БД)
  try {
    const reminders = await remindersRepo.getByUser(userId);
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    const todayReminders = reminders.filter(r => r.scheduled_at.split('T')[0] === todayStr);

    if (todayReminders.length > 0) {
      const lines = todayReminders.map(r => {
        const time = new Date(r.scheduled_at).toLocaleTimeString('ru-RU', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
        });
        return `${time} — ${r.task}`;
      });
      rawData.push(`[НАПОМИНАНИЯ НА СЕГОДНЯ]\n${lines.join('\n')}`);
    }
  } catch { /* пропускаем */ }

  // 5. Активные задачи (из БД)
  try {
    const todos = await todosRepo.getForDigest(userId);
    if (todos.length > 0) {
      const lines = todos.slice(0, 7).map(t => `- ${t.task}`);
      rawData.push(`[ЗАДАЧИ]\n${lines.join('\n')}`);
    }
  } catch { /* пропускаем */ }

  // --- Передаём сырые данные в LLM для эмоциональной обработки ---

  const nameStr = firstName || 'друг';
  const now = new Date();
  const moscowDate = now.toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/Moscow',
  });

  const digestPrompt = `Ты — Amina, персональный ассистент. Сейчас ${moscowDate}.
Тебе нужно составить УТРЕННИЙ ДАЙДЖЕСТ для пользователя по имени ${nameStr} из города ${city}.

Вот сырые данные из интернета и базы данных:

${rawData.join('\n\n')}

---

ЗАДАЧА: Превратил это в живой, эмоциональный утренний дайджест.

ПРАВИЛА:
1. Начни с тёплого приветствия по имени
2. Погоду подай с эмоциями и советом ("Бери зонт!" или "Идеально для прогулки!")
3. Новости ${city} — главная часть! Прокомментируй каждую новость с живой реакцией, юмором или сочувствием
4. Мировые новости — коротко, 2-3 предложения, с комментарием
5. Напоминания и задачи — если есть, подбодри и мотивируй
6. Заверши позитивной нотой или пожеланием на день
7. Используй эмодзи уместно, но не перебарщивай
8. Формат: Markdown (для Telegram), жирный текст для заголовков
9. НЕ придумывай новости — используй ТОЛЬКО то что в данных выше
10. Длина: 1500-2500 символов (не слишком коротко, не слишком длинно)`;

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
 */
function getTimeGreeting(name: string | null): string {
  const hour = getMoscowHour(new Date());
  const nameStr = name ? `, ${name}` : '';

  if (hour >= 5 && hour < 12) return `☀️ *Доброе утро${nameStr}!*`;
  if (hour >= 12 && hour < 17) return `🌤 *Добрый день${nameStr}!*`;
  if (hour >= 17 && hour < 22) return `🌆 *Добрый вечер${nameStr}!*`;
  return `🌙 *Доброй ночи${nameStr}!*`;
}
