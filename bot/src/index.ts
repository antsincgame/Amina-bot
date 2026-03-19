import type { FastifyInstance, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { config } from './config/index.js';
import {
  REQUEST_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  BODY_LIMIT_BYTES,
  HEALTH_CACHE_TTL_MS,
  HEALTH_AI_TIMEOUT_MS,
  INIT_DELAY_MS,
} from './config/constants.js';
import { serverLogger, httpLogger, appLogger } from './config/logger.js';
import { createBot } from './telegram/bot.js';
import { registerTelegramWebhookRoute } from './telegram/webhook.js';
import { settingsRepo, analyticsRepo } from './db/index.js';
import { userProfileRepo } from './memory/user-memory.js';
import { aiService } from './ai/openrouter.js';
import { registerApiRoutes } from './api/routes.js';
import { requireAdminAuth } from './api/routes/middleware.js';
import { stopCleanupInterval } from './utils/rate-limiter.js';
import { startReminderScheduler, stopReminderScheduler } from './reminders/reminder-scheduler.js';
import { startDigestScheduler, stopDigestScheduler } from './features/digest-scheduler.js';
import { scheduleHybridDigestPrewarm, stopHybridDigestPrewarm } from './features/digest-hybrid-prewarm.js';
import { ensureVoiceMessagesInfra } from './features/voice-messages-repo.js';
import { ensureTelephonyInfra } from './features/telephony/repository/telephony-infra.js';
import { startTelephonyJobWorker, stopTelephonyJobWorker } from './features/telephony/service/postcall-job-worker.js';
import { ensureTelephonyRecordingsInfra } from './features/telephony/telephony-recordings-repo.js';
import { syncSelfCoreSystemFacts } from './ai/self-core.js';
import { getChatRuntimeState } from './ai/runtime-truth.js';

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

  // Root endpoint - info page (only when admin panel is not bundled)
  const __filename_check = fileURLToPath(import.meta.url);
  const __dirname_check = dirname(__filename_check);
  const hasAdminDist = existsSync(resolve(__dirname_check, '../../admin-dist/index.html'));

  if (!hasAdminDist) {
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
  }

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

  const dbCheck = async (): Promise<boolean> => {
    try {
      // settingsRepo is already backend-aware via db/index.js
      await settingsRepo.get('__healthcheck__');
      return true;
    } catch {
      return false;
    }
  };

  const aiCheck = async (): Promise<boolean> => {
    try {
      return await aiService.testConnection(HEALTH_AI_TIMEOUT_MS);
    } catch {
      return false;
    }
  };

  const runReadinessChecks = async (): Promise<Record<string, boolean>> => {
    const [dbOk, aiOk] = await Promise.all([dbCheck(), aiCheck()]);
    return { database: dbOk, ai: aiOk };
  };

  server.get('/ready', async () => {
    const now = Date.now();
    if (healthCache && now - healthCache.ts < HEALTH_CACHE_TTL_MS) {
      const allHealthy = Object.values(healthCache.checks).every(Boolean);
      return { status: allHealthy ? 'ready' : 'degraded', checks: healthCache.checks, timestamp: new Date().toISOString(), cached: true };
    }

    const checks = await runReadinessChecks();
    healthCache = { checks, ts: now };

    const allHealthy = Object.values(checks).every(Boolean);
    return { status: allHealthy ? 'ready' : 'degraded', checks, timestamp: new Date().toISOString() };
  });

  server.get('/api/status', async (request, reply) => {
    const admin = await requireAdminAuth(request, reply);
    if (!admin) return reply;

    const now = Date.now();
    // Reuse ready cache
    if (!healthCache || now - healthCache.ts >= HEALTH_CACHE_TTL_MS) {
      healthCache = { checks: await runReadinessChecks(), ts: now };
    }
    const chatRuntime = await getChatRuntimeState().catch(() => null);
    const telegramReady = Boolean(bot && config.telegram.token);
    const telegramEngine = telegramReady
      ? (config.telegram.webhook.url ? 'grammy (runtime active)' : 'grammy (polling/runtime active)')
      : config.telegram.token
        ? 'grammy (token present, runtime not initialized yet)'
        : 'grammy (token missing)';
    const aiEngine = chatRuntime
      ? `${chatRuntime.resolvedProvider} · ${chatRuntime.resolvedModel}`
      : 'AI runtime state unavailable';

    return {
      checks: {
        telegram: { ready: telegramReady, engine: telegramEngine },
        ai: {
          ready: healthCache.checks['ai'] ?? false,
          engine: aiEngine,
        },
        database: { ready: healthCache.checks['database'] ?? false, engine: config.dbBackend === 'appwrite' ? 'Appwrite' : 'Legacy' },
        admin: { ready: hasAdminDist, engine: hasAdminDist ? 'React static bundle detected' : 'Admin bundle missing on server' },
      },
      timestamp: new Date().toISOString(),
    };
  });

  // API routes for admin panel - stats
  server.get('/api/stats', async (request: FastifyRequest<{ Querystring: { from?: string; to?: string } }>, reply) => {
    const admin = await requireAdminAuth(request, reply);
    if (!admin) return reply;

    try {
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const rawFrom = request.query.from;
      const rawTo = request.query.to;
      const fromDate = rawFrom ? new Date(rawFrom) : defaultFrom;
      const toDate = rawTo ? new Date(rawTo) : now;

      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return {
          totalMessages: 0,
          totalCalls: 0,
          uniqueUsers: 0,
          tokensByDay: [],
          period: 'invalid',
        };
      }

      const [stats, allUsers] = await Promise.all([
        analyticsRepo.getStats(fromDate, toDate),
        userProfileRepo.getAll(1000, 0),
      ]);

      return {
        totalMessages: stats.totalMessages,
        totalCalls: stats.totalCalls,
        uniqueUsers: stats.uniqueUsers || allUsers.length,
        tokensByDay: stats.tokensByDay,
        period: `${fromDate.toISOString()}..${toDate.toISOString()}`,
      };
    } catch (error) {
      httpLogger.error({ error }, 'Failed to get stats');
      return {
        totalMessages: 0,
        totalCalls: 0,
        uniqueUsers: 0,
        tokensByDay: [],
        period: 'error',
      };
    }
  });

  registerTelegramWebhookRoute(server, () => bot);

  // Register REST API routes for LLM interaction
  await registerApiRoutes(server);

  // --------------------------------------------
  // Serve Admin Panel (static files + SPA fallback)
  // --------------------------------------------
  const adminDistPath = resolve(__dirname_check, '../../admin-dist');

  if (hasAdminDist) {
    await server.register(fastifyStatic, {
      root: adminDistPath,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback: non-API GET routes → index.html
    const indexHtml = readFileSync(resolve(adminDistPath, 'index.html'), 'utf-8');
    server.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/webhook/')) {
        return reply.type('text/html').send(indexHtml);
      }
      return reply.code(404).send({ error: 'Not found' });
    });

    appLogger.info({ path: adminDistPath }, '📁 Admin panel static files registered');
  } else {
    appLogger.info('ℹ️ Admin dist not found — skipping static file serving');
  }
};

// --------------------------------------------
// Background initialization (runs after HTTP server is up)
// --------------------------------------------

const initBotAndServices = async (): Promise<void> => {
  if (shuttingDown) return;

  // Database check
  try {
    await settingsRepo.get('__healthcheck__');
    appLogger.info(`✓ Database connection OK (${config.dbBackend})`);
  } catch (error) {
    appLogger.warn({ error }, '⚠️ Database not available');
  }

  scheduleHybridDigestPrewarm();

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
    await bot.init();
    appLogger.info('✓ Telegram bot created and initialized');
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
      { command: 'digest_all', description: '🧠 Полный дайджест из всех источников' },
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
    appLogger.info({ delayMs: INIT_DELAY_MS }, '✅ HTTP server ready — starting background init');

    // Задержка перед фоновой инициализацией — даём платформе подтвердить health check
    setTimeout(() => {
      initBotAndServices().catch(err => {
        appLogger.error({ error: err }, 'Background init error');
      });
    }, INIT_DELAY_MS);
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
  stopHybridDigestPrewarm();
  stopTelephonyJobWorker();

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
