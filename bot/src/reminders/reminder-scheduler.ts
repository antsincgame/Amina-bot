/**
 * Reminder Scheduler
 * 
 * Периодически проверяет БД на просроченные напоминания
 * и отправляет уведомления через Telegram Bot API.
 */

import type { Api, RawApi } from 'grammy';
import { remindersRepo } from './reminders-repo.js';
import { clearReminderSent, getReminderDeliveryMap, markReminderSent } from './reminder-delivery-registry.js';
import { appLogger } from '../config/logger.js';

/** Минимальный интерфейс бота — нужен только api.sendMessage */
interface BotLike {
  api: Api<RawApi>;
}

const CHECK_INTERVAL_MS = 30_000; // 30 секунд

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

/**
 * Lease-сет для per-reminder deduplication в рамках текущего процесса.
 * Предотвращает повторную обработку одного и того же напоминания
 * если processReminders запустится до завершения текущего цикла.
 */
const inFlightReminderIds = new Set<string>();

/**
 * Запустить планировщик напоминаний
 */
export function startReminderScheduler(bot: BotLike): void {
  if (schedulerInterval) {
    appLogger.warn('Reminder scheduler already running');
    return;
  }

  appLogger.info({ intervalMs: CHECK_INTERVAL_MS }, 'Starting reminder scheduler');

  function scheduleNext() {
    schedulerInterval = setTimeout(async () => {
      await processReminders(bot as BotLike).catch(err => {
        appLogger.error({ error: err }, 'Reminder scheduler error');
      });
      scheduleNext();
    }, CHECK_INTERVAL_MS) as unknown as ReturnType<typeof setInterval>;
  }
  scheduleNext();
}

/**
 * Остановить планировщик
 */
export function stopReminderScheduler(): void {
  if (schedulerInterval) {
    clearTimeout(schedulerInterval);
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
    const deliveryMap = await getReminderDeliveryMap();

    if (dueReminders.length === 0) return;

    appLogger.info({ count: dueReminders.length }, 'Processing due reminders');

    for (const reminder of dueReminders) {
      // Claim/lease: пропускаем напоминания которые уже обрабатываются в этом процессе
      if (inFlightReminderIds.has(reminder.id)) {
        appLogger.debug({ id: reminder.id }, 'Reminder already in-flight, skipping this cycle');
        continue;
      }
      inFlightReminderIds.add(reminder.id);

      try {
        const sentEntry = deliveryMap.get(reminder.id);
        if (sentEntry) {
          appLogger.warn(
            { id: reminder.id, userId: reminder.user_id, sentAt: sentEntry.sentAt },
            'Reminder already sent earlier; retrying markCompleted without duplicate delivery'
          );

          try {
            await remindersRepo.markCompleted(reminder.id);
            await clearReminderSent(reminder.id);
          } catch (dbErr) {
            appLogger.error(
              { error: dbErr, id: reminder.id, userId: reminder.user_id, sentAt: sentEntry.sentAt },
              'Reminder still pending DB confirmation after prior successful send'
            );
          }

          continue;
        }

        const message = `🔔 Напоминание\n\n${reminder.task}`;
        await bot.api.sendMessage(reminder.chat_id, message);
        await markReminderSent(reminder.id, new Date().toISOString());

        try {
          await remindersRepo.markCompleted(reminder.id);
          await clearReminderSent(reminder.id);
        } catch (dbErr) {
          appLogger.error(
            { error: dbErr, id: reminder.id, userId: reminder.user_id },
            'Reminder sent but markCompleted failed — will not retry to avoid duplicate'
          );
        }

        appLogger.info(
          { id: reminder.id, userId: reminder.user_id, task: reminder.task },
          'Reminder sent'
        );
      } catch (sendError) {
        const err = sendError as { description?: string; error_code?: number };

        if (err.error_code === 403 || err.description?.includes('bot was blocked')) {
          appLogger.warn(
            { id: reminder.id, userId: reminder.user_id },
            'User blocked bot, marking reminder completed'
          );
          await remindersRepo.markCompleted(reminder.id).then(
            () => clearReminderSent(reminder.id),
          ).catch(e => appLogger.debug({ error: e }, 'markCompleted failed'));
        } else {
          appLogger.error(
            { error: sendError, id: reminder.id, userId: reminder.user_id },
            'Failed to send reminder'
          );
          await remindersRepo.markFailed(reminder.id).catch(e => appLogger.debug({ error: e }, 'markFailed failed'));
        }
      } finally {
        inFlightReminderIds.delete(reminder.id);
      }
    }
  } finally {
    isProcessing = false;
  }
}
