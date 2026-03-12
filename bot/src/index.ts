import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/index.js';
import {
  REQUEST_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  BODY_LIMIT_BYTES,
  HEALTH_CACHE_TTL_MS,
} from './config/constants.js';
import { serverLogger, httpLogger, appLogger } from './config/logger.js';
import { createBot } from './telegram/bot.js';
import { registerTelegramWebhookRoute } from './telegram/webhook.js';
import { getSupabase, settingsRepo } from './db/supabase.js';
import { aiService } from './ai/openrouter.js';
import { registerApiRoutes } from './api/routes.js';
import { stopCleanupInterval } from './utils/rate-limiter.js';
import { startReminderScheduler, stopReminderScheduler } from './reminders/reminder-scheduler.js';
import { startDigestScheduler, stopDigestScheduler } from './features/digest-scheduler.js';
import { ensureVoiceMessagesInfra } from './features/voice-messages-repo.js';

// --------------------------------------------
// Application Entry Point (v1.0.1)
// --------------------------------------------

const app = Fastify({
  logger: false,
  trustProxy: true,
  requestTimeout: REQUEST_TIMEOUT_MS,
  connectionTimeout: CONNECTION_TIMEOUT_MS,
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  bodyLimit: BODY_LIMIT_BYTES,
});

// Bot instance
let bot: ReturnType<typeof createBot> | null = null;

// --------------------------------------------
// Setup Server Routes
// --------------------------------------------

const setupRoutes = async (server: FastifyInstance): Promise<void> => {
  const allowedOrigins: string[] = [config.adminUrl];
  const leadOrigins = (process.env.LEAD_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  allowedOrigins.push(...leadOrigins);

  await server.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  // Root endpoint - info page
  server.get('/', async () => {
    return {
      service: 'Amina Telegram Bot',
      status: 'running',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        ready: '/ready',
        api: '/api/*',
        admin: config.adminUrl,
      },
      documentation: 'https://github.com/antsincgame/Amina-bot',
    };
  });

  // Health check endpoint
  server.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    };
  });

  // === ОПТИМИЗАЦИЯ: Health/Ready/Status кешируются ===
  let healthCache: { checks: Record<string, boolean>; ts: number } | null = null;

  server.get('/ready', async () => {
    const now = Date.now();
    if (healthCache && now - healthCache.ts < HEALTH_CACHE_TTL_MS) {
      const allHealthy = Object.values(healthCache.checks).every(Boolean);
      return { status: allHealthy ? 'ready' : 'degraded', checks: healthCache.checks, timestamp: new Date().toISOString(), cached: true };
    }

    const checks: Record<string, boolean> = { database: false, ai: false };

    // Проверки параллельно
    const dbCheck = async (): Promise<boolean> => {
      try {
        const { error } = await getSupabase().from('settings').select('key').limit(1);
        return !error;
      } catch { return false; }
    };
    const [dbOk, aiOk] = await Promise.all([
      dbCheck(),
      aiService.testConnection().catch(() => false),
    ]);
    checks['database'] = dbOk;
    checks['ai'] = aiOk;
    healthCache = { checks, ts: now };

    const allHealthy = Object.values(checks).every(Boolean);
    return { status: allHealthy ? 'ready' : 'degraded', checks, timestamp: new Date().toISOString() };
  });

  server.get('/api/status', async () => {
    const now = Date.now();
    // Reuse ready cache
    if (!healthCache || now - healthCache.ts >= HEALTH_CACHE_TTL_MS) {
      const dbCheck = async (): Promise<boolean> => {
        try {
          const { error } = await getSupabase().from('settings').select('key').limit(1);
          return !error;
        } catch { return false; }
      };
      const [dbOk, aiOk] = await Promise.all([
        dbCheck(),
        aiService.testConnection().catch(() => false),
      ]);
      healthCache = { checks: { database: dbOk, ai: aiOk }, ts: now };
    }
    return {
      checks: {
        telegram: { ready: true, engine: 'grammy' },
        ai: { ready: healthCache.checks['ai'] ?? false, engine: 'OpenRouter' },
        database: { ready: healthCache.checks['database'] ?? false, engine: 'Supabase' },
        admin: { ready: true, engine: 'React' },
      },
      timestamp: new Date().toISOString(),
    };
  });

  // API routes for admin panel - stats
  server.get('/api/stats', async () => {
    try {
      const { analyticsRepo } = await import('./db/supabase.js');
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      const stats = await analyticsRepo.getStats(weekAgo, now);
      return {
        totalMessages: stats.totalMessages,
        totalCalls: stats.totalCalls,
        totalUsers: stats.uniqueUsers,
        tokensByDay: stats.tokensByDay,
        period: '7d',
      };
    } catch (error) {
      httpLogger.error({ error }, 'Failed to get stats');
      return {
        totalMessages: 0,
        totalCalls: 0,
        totalUsers: 0,
        tokensByDay: [],
        period: '7d',
      };
    }
  });

  registerTelegramWebhookRoute(server, () => bot);

  // Register REST API routes for LLM interaction
  await registerApiRoutes(server);
};

// --------------------------------------------
// Background initialization (runs after HTTP server is up)
// --------------------------------------------

const initBotAndServices = async (): Promise<void> => {
  if (shuttingDown) return;

  // Database check
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('settings').select('key').limit(1);
    if (error) {
      appLogger.warn({ error: error.message }, '⚠️ Database connection issue');
    } else {
      appLogger.info('✓ Database connection OK');
    }
  } catch (error) {
    appLogger.warn({ error }, '⚠️ Database not available');
  }

  // Create bot if not yet created (non-webhook mode)
  if (!bot) {
    if (!config.telegram.token) {
      const settings = await settingsRepo.getMany(['telegram_bot_token']);
      const tokenFromDb = settings['telegram_bot_token']?.trim();
      if (tokenFromDb) {
        config.setTelegramToken(tokenFromDb);
        appLogger.info('✓ Telegram token from database');
      }
    }

    if (!config.telegram.token) {
      appLogger.warn('⚠️ TELEGRAM_BOT_TOKEN не задан — только HTTP API режим');
      return;
    }

    bot = createBot();
    appLogger.info('✓ Telegram bot created');
  }

  const webhookBaseUrl = config.telegram.webhook.url?.replace(/\/+$/, '');
  const shouldUseWebhook = Boolean(config.isProd && config.telegram.token && webhookBaseUrl);

  // Activate webhook or start polling
  if (shouldUseWebhook && webhookBaseUrl) {
    try {
      await bot.api.setWebhook(
        `${webhookBaseUrl}/webhook/telegram`,
        config.telegram.webhook.secret
          ? { secret_token: config.telegram.webhook.secret }
          : {},
      );
      appLogger.info('🔗 Telegram webhook activated');
    } catch (err) {
      appLogger.warn({ error: err }, '⚠️ Failed to set webhook — falling back to polling');
      try { await bot.api.deleteWebhook(); } catch { appLogger.debug('deleteWebhook skipped in fallback'); }
      bot.start({
        onStart: (botInfo) => appLogger.info({ username: botInfo.username }, '🤖 Bot started (polling fallback)'),
      }).catch(pollErr => appLogger.error({ error: pollErr?.message ?? pollErr }, '❌ Polling fallback failed'));
    }
  } else {
    appLogger.info(config.isProd
      ? '⚠️ WEBHOOK_URL not set in production — starting polling mode'
      : '🔄 Development mode — starting polling');
    try {
      await bot.api.deleteWebhook();
    } catch {
      appLogger.debug('deleteWebhook skipped');
    }
    bot.start({
      onStart: (botInfo) => {
        appLogger.info({ username: botInfo.username }, '🤖 Bot started (polling)');
      },
    }).catch(err => {
      appLogger.error({ error: err?.message ?? err }, '❌ Polling start failed');
    });
  }

  // Schedulers
  startReminderScheduler(bot);
  startDigestScheduler(bot);
  appLogger.info('⏰ Schedulers started');

  // Voice messages (non-critical)
  ensureVoiceMessagesInfra().catch(err =>
    appLogger.warn({ error: err }, 'Voice infra init failed')
  );

  // Bot menu commands (non-critical)
  try {
    await bot.api.setMyCommands([
      { command: 'menu', description: '🎛 Главное меню с кнопками' },
      { command: 'search', description: '🌐 Поиск в интернете' },
      { command: 'imagine', description: '🎨 Сгенерировать картинку' },
      { command: 'edit', description: '✏️ Редактировать фото' },
      { command: 'note', description: '📌 Сохранить заметку' },
      { command: 'notes', description: '📋 Мои заметки' },
      { command: 'todo', description: '✅ Добавить задачу' },
      { command: 'todos', description: '📋 Список задач' },
      { command: 'done', description: '✔️ Выполнить задачу' },
      { command: 'reminders', description: '⏰ Мои напоминания' },
      { command: 'digest', description: '☀️ Утренний дайджест' },
      { command: 'help', description: '📋 Справка по боту' },
    ]);
    appLogger.info('📋 Bot commands registered');
  } catch (err) {
    appLogger.warn({ error: err }, '⚠️ Failed to set bot commands');
  }
};

// --------------------------------------------
// Start Application
// --------------------------------------------

const start = async (): Promise<void> => {
  try {
    appLogger.info('🚀 Starting Amina Bot...');
    appLogger.info({
      env: config.isDev ? 'development' : 'production',
      port: config.server.port,
    }, 'Configuration loaded');

    // Setup API routes
    await setupRoutes(app);

    // Запускаем HTTP сервер ПЕРВЫМ — health check мгновенный
    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
    serverLogger.info({ address }, '📡 HTTP server listening');
    appLogger.info('✅ HTTP server ready — starting background init in 5s');

    // Задержка перед фоновой инициализацией — даём Render подтвердить health check
    setTimeout(() => {
      initBotAndServices().catch(err => {
        appLogger.error({ error: err }, 'Background init error');
      });
    }, 5000);
  } catch (error) {
    appLogger.fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
};

// --------------------------------------------
// Graceful Shutdown
// --------------------------------------------

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  appLogger.info({ signal }, 'Shutdown signal received');

  // Cleanup intervals/timers
  stopCleanupInterval();
  stopReminderScheduler();
  stopDigestScheduler();

  if (bot) {
    appLogger.info('Stopping bot...');
    try { await bot.stop(); } catch (e) { appLogger.warn({ error: e }, 'Bot stop error (ignored)'); }
  }

  appLogger.info('Closing server...');
  try { await app.close(); } catch (e) { appLogger.warn({ error: e }, 'Server close error (ignored)'); }

  appLogger.info('👋 Goodbye!');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Run
start().catch((err) => {
  appLogger.fatal({ error: err }, 'Unhandled error in start()');
});

process.on('unhandledRejection', (reason) => {
  appLogger.fatal({ reason }, '⚠️ Unhandled Promise Rejection');
});

process.on('uncaughtException', (err) => {
  appLogger.fatal({ error: err.message }, '⚠️ Uncaught Exception');
  shutdown('uncaughtException').catch(() => process.exit(1));
});
