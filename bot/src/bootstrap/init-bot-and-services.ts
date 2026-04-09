import { config } from '../config/index.js';
import { appLogger } from '../config/logger.js';
import { createBot } from '../telegram/bot.js';
import { settingsRepo } from '../db/index.js';
import { startReminderScheduler } from '../reminders/reminder-scheduler.js';
import { startDigestScheduler } from '../features/digest-scheduler.js';
import { scheduleHybridDigestPrewarm } from '../features/digest-hybrid-prewarm.js';
import { ensureVoiceMessagesInfra } from '../features/voice-messages-repo.js';
import { ensureTelephonyInfra } from '../features/telephony/repository/telephony-infra.js';
import { startTelephonyJobWorker } from '../features/telephony/service/postcall-job-worker.js';
import { ensureTelephonyRecordingsInfra } from '../features/telephony/telephony-recordings-repo.js';
import { syncSelfCoreSystemFacts } from '../ai/self-core.js';
import { isShuttingDown } from './shutdown.js';

interface BotHolder {
  bot: ReturnType<typeof createBot> | null;
}

export async function initBotAndServices(holder: BotHolder): Promise<void> {
  if (isShuttingDown()) return;

  try {
    await settingsRepo.get('__healthcheck__');
    appLogger.info(`Database connection OK (${config.dbBackend})`);
  } catch (error) {
    appLogger.warn({ error }, 'Database not available');
  }

  scheduleHybridDigestPrewarm();

  if (isShuttingDown()) return;

  if (!holder.bot) {
    if (!config.telegram.token) {
      const settings = await settingsRepo.getMany(['telegram_bot_token']);
      const tokenFromDb = settings['telegram_bot_token']?.trim();
      if (tokenFromDb) {
        config.setTelegramToken(tokenFromDb);
        appLogger.info('Telegram token from database');
      }
    }

    if (!config.telegram.token) {
      appLogger.warn('TELEGRAM_BOT_TOKEN not set — HTTP API only mode');
      return;
    }

    holder.bot = createBot();
    await holder.bot.init();
    appLogger.info('Telegram bot created and initialized');
  }

  const bot = holder.bot;
  const webhookBaseUrl = config.telegram.webhook.url?.replace(/\/+$/, '');
  const shouldUseWebhook = Boolean(config.isProd && config.telegram.token && webhookBaseUrl);

  if (shouldUseWebhook && webhookBaseUrl) {
    try {
      await bot.api.setWebhook(
        `${webhookBaseUrl}/webhook/telegram`,
        config.telegram.webhook.secret
          ? { secret_token: config.telegram.webhook.secret }
          : {},
      );
      appLogger.info('Telegram webhook activated');
    } catch (err) {
      appLogger.warn({ error: err }, 'Failed to set webhook — falling back to polling');
      try { await bot.api.deleteWebhook(); } catch { appLogger.debug('deleteWebhook skipped in fallback'); }
      bot.start({
        onStart: (botInfo) => appLogger.info({ username: botInfo.username }, 'Bot started (polling fallback)'),
      }).catch(pollErr => appLogger.error({ error: pollErr?.message ?? pollErr }, 'Polling fallback failed'));
    }
  } else {
    appLogger.info(config.isProd
      ? 'WEBHOOK_URL not set in production — starting polling mode'
      : 'Development mode — starting polling');
    try {
      await bot.api.deleteWebhook();
    } catch {
      appLogger.debug('deleteWebhook skipped');
    }
    bot.start({
      onStart: (botInfo) => {
        appLogger.info({ username: botInfo.username }, 'Bot started (polling)');
      },
    }).catch(err => {
      appLogger.error({ error: err?.message ?? err }, 'Polling start failed');
    });
  }

  if (isShuttingDown()) return;

  startReminderScheduler(bot);
  startDigestScheduler(bot);
  appLogger.info('Schedulers started');

  ensureVoiceMessagesInfra().catch(err =>
    appLogger.warn({ error: err }, 'Voice infra init failed')
  );
  ensureTelephonyInfra().catch(err =>
    appLogger.warn({ error: err }, 'Telephony infra init failed')
  );
  ensureTelephonyRecordingsInfra().catch(err =>
    appLogger.warn({ error: err }, 'Telephony recordings infra init failed')
  );
  syncSelfCoreSystemFacts().catch(err =>
    appLogger.warn({ error: err }, 'Self-core sync failed')
  );
  startTelephonyJobWorker();

  try {
    await bot.api.setMyCommands([
      { command: 'menu', description: 'Главное меню с кнопками' },
      { command: 'search', description: 'Поиск в интернете' },
      { command: 'imagine', description: 'Сгенерировать картинку' },
      { command: 'edit', description: 'Редактировать фото' },
      { command: 'note', description: 'Сохранить заметку' },
      { command: 'notes', description: 'Мои заметки' },
      { command: 'todo', description: 'Добавить задачу' },
      { command: 'todos', description: 'Список задач' },
      { command: 'done', description: 'Выполнить задачу' },
      { command: 'reminders', description: 'Мои напоминания' },
      { command: 'digest', description: 'Утренний дайджест' },
      { command: 'digest_all', description: 'Полный дайджест из всех источников' },
      { command: 'help', description: 'Справка по боту' },
    ]);
    appLogger.info('Bot commands registered');
  } catch (err) {
    appLogger.warn({ error: err }, 'Failed to set bot commands');
  }

  try {
    await bot.api.setChatMenuButton({
      menu_button: { type: 'commands' },
    });
    appLogger.info('Default menu button set to commands list');
  } catch (err) {
    appLogger.warn({ error: err }, 'Failed to set default menu button');
  }
}
