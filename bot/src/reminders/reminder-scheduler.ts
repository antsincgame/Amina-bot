/**
 * Reminder Scheduler
 * 
 * Периодически проверяет БД на просроченные напоминания
 * и отправляет уведомления через Telegram Bot API.
 */

import type { Api, RawApi } from 'grammy';
import { remindersRepo } from './reminders-repo.js';
import { appLogger } from '../config/logger.js';

/** Минимальный интерфейс бота — нужен только api.sendMessage */
interface BotLike {
  api: Api<RawApi>;
}

const CHECK_INTERVAL_MS = 30_000; // 30 секунд

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

/**
 * Запустить планировщик напоминаний
 */
export function startReminderScheduler(bot: BotLike): void {
  if (schedulerInterval) {
    appLogger.warn('Reminder scheduler already running');
    return;
  }

  appLogger.info({ intervalMs: CHECK_INTERVAL_MS }, 'Starting reminder scheduler');

  schedulerInterval = setInterval(() => {
    processReminders(bot as BotLike).catch(err => {
      appLogger.error({ error: err }, 'Reminder scheduler error');
    });
  }, CHECK_INTERVAL_MS);

  // Не блокируем выход процесса
  schedulerInterval.unref();
}

/**
 * Остановить планировщик
 */
export function stopReminderScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    appLogger.info('Reminder scheduler stopped');
  }
}

/**
 * Обработать просроченные напоминания
 */
async function processReminders(bot: BotLike): Promise<void> {
  // Защита от параллельного выполнения
  if (isProcessing) return;
  isProcessing = true;

  try {
    const dueReminders = await remindersRepo.getDue();

    if (dueReminders.length === 0) return;

    appLogger.info({ count: dueReminders.length }, 'Processing due reminders');

    for (const reminder of dueReminders) {
      try {
        // Формируем сообщение (без parse_mode для надёжности)
        const message = `🔔 Напоминание\n\n${reminder.task}`;

        await bot.api.sendMessage(reminder.chat_id, message);

        // Помечаем как выполненное
        await remindersRepo.markCompleted(reminder.id);

        appLogger.info(
          { id: reminder.id, userId: reminder.user_id, task: reminder.task },
          'Reminder sent'
        );
      } catch (sendError) {
        const err = sendError as { description?: string; error_code?: number };

        // Если пользователь заблокировал бота — помечаем completed
        if (err.error_code === 403 || err.description?.includes('bot was blocked')) {
          appLogger.warn(
            { id: reminder.id, userId: reminder.user_id },
            'User blocked bot, marking reminder completed'
          );
          await remindersRepo.markCompleted(reminder.id);
        } else {
          appLogger.error(
            { error: sendError, id: reminder.id, userId: reminder.user_id },
            'Failed to send reminder'
          );
          // Инкрементируем retry_count; после MAX_RETRY_COUNT попыток — отменяем
          await remindersRepo.markFailed(reminder.id);
        }
      }
    }
  } finally {
    isProcessing = false;
  }
}
