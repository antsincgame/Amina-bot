/**
 * Morning Digest Scheduler
 * 
 * Каждую минуту проверяет, не пора ли отправить утренний дайджест.
 * Дайджест включает: погоду, напоминания на день, задачи, краткие новости.
 */

import type { Api, RawApi } from 'grammy';
import { userPrefsRepo } from './user-prefs-repo.js';
import { todosRepo } from './todos-repo.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { webSearch } from '../ai/websearch.js';
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
 * Сбросить кеш отправленных дайджестов в полночь (Москва)
 */
function resetSentCacheAtMidnight(): void {
  const now = new Date();
  const moscowHour = getMoscowHour(now);
  const moscowMinute = now.getMinutes();

  // Если полночь — очищаем
  if (moscowHour === 0 && moscowMinute === 0) {
    SENT_TODAY.clear();
  }

  // Проверяем каждый час
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

    // Получаем пользователей, у которых дайджест на этот час
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
        appLogger.info({ userId: user.user_id, hour: currentHour }, 'Digest sent');
      } catch (sendError) {
        const err = sendError as { error_code?: number };
        if (err.error_code === 403) {
          // Пользователь заблокировал бота — выключаем дайджест
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

/**
 * Собрать текст дайджеста
 */
async function buildDigest(
  userId: string,
  firstName: string | null,
  city: string
): Promise<string> {
  const greeting = getTimeGreeting(firstName);
  const sections: string[] = [greeting];

  // 1. Погода
  try {
    const weatherResult = await webSearch(`Погода ${city} сегодня температура`);
    if (weatherResult?.answer) {
      // Берём первые 200 символов
      const shortWeather = weatherResult.answer.slice(0, 200).trim();
      sections.push(`🌤 *Погода в ${city}:*\n${shortWeather}`);
    }
  } catch {
    sections.push(`🌤 _Не удалось получить погоду_`);
  }

  // 2. Напоминания на сегодня
  try {
    const reminders = await remindersRepo.getByUser(userId);
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    const todayReminders = reminders.filter(r => {
      const rDate = r.scheduled_at.split('T')[0];
      return rDate === todayStr;
    });

    if (todayReminders.length > 0) {
      const lines = todayReminders.map((r, i) => {
        const time = new Date(r.scheduled_at).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Moscow',
        });
        return `${i + 1}. ${time} — ${r.task}`;
      });
      sections.push(`⏰ *Напоминания на сегодня (${todayReminders.length}):*\n${lines.join('\n')}`);
    }
  } catch {
    // Пропускаем
  }

  // 3. Активные задачи
  try {
    const todos = await todosRepo.getForDigest(userId);
    if (todos.length > 0) {
      const MAX_SHOWN = 5;
      const lines = todos.slice(0, MAX_SHOWN).map((t, i) => `${i + 1}. ${t.task}`);
      const extra = todos.length > MAX_SHOWN ? `\n_...и ещё ${todos.length - MAX_SHOWN}_` : '';
      sections.push(`📝 *Задачи (${todos.length}):*\n${lines.join('\n')}${extra}`);
    }
  } catch {
    // Пропускаем
  }

  // 4. Короткие новости
  try {
    const newsResult = await webSearch('Главные новости сегодня коротко 3 пункта');
    if (newsResult?.answer) {
      const shortNews = newsResult.answer.slice(0, 300).trim();
      sections.push(`📰 *Новости:*\n${shortNews}`);
    }
  } catch {
    // Пропускаем
  }

  sections.push('_Настройки дайджеста: /digest_');

  return sections.join('\n\n');
}

/**
 * Приветствие по времени суток
 */
function getTimeGreeting(name: string | null): string {
  const hour = getMoscowHour(new Date());
  const nameStr = name ? `, ${name}` : '';

  if (hour >= 5 && hour < 12) return `☀️ *Доброе утро${nameStr}!*`;
  if (hour >= 12 && hour < 17) return `🌤 *Добрый день${nameStr}!*`;
  if (hour >= 17 && hour < 22) return `🌆 *Добрый вечер${nameStr}!*`;
  return `🌙 *Доброй ночи${nameStr}!*`;
}
