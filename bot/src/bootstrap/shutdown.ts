import type Fastify from 'fastify';
import type { createBot } from '../telegram/bot.js';
import { appLogger } from '../config/logger.js';
import { stopCleanupInterval } from '../utils/rate-limiter.js';
import { stopReminderScheduler } from '../reminders/reminder-scheduler.js';
import { stopDigestScheduler } from '../features/digest-scheduler.js';
import { stopHybridDigestPrewarm } from '../features/digest-hybrid-prewarm.js';
import { stopTelephonyJobWorker } from '../features/telephony/service/postcall-job-worker.js';

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export async function shutdown(
  signal: string,
  app: ReturnType<typeof Fastify>,
  bot: ReturnType<typeof createBot> | null,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  appLogger.info({ signal }, 'Shutdown signal received');

  stopCleanupInterval();
  stopReminderScheduler();
  stopDigestScheduler();
  stopHybridDigestPrewarm();
  stopTelephonyJobWorker();

  if (bot) {
    appLogger.info('Stopping bot...');
    try { await bot.stop(); } catch (e) { appLogger.warn({ error: e }, 'Bot stop error (ignored)'); }
  }

  appLogger.info('Closing server...');
  try { await app.close(); } catch (e) { appLogger.warn({ error: e }, 'Server close error (ignored)'); }

  appLogger.info('Goodbye!');
  process.exit(0);
}
