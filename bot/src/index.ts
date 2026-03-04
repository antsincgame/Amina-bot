import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { webhookCallback } from 'grammy';
import { config } from './config/index.js';
import { logger, serverLogger, httpLogger, appLogger } from './config/logger.js';
import { createBot } from './telegram/bot.js';
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
  logger: false, // We use pino separately
  trustProxy: true,
  // Таймауты для Render Starter plan (30 сек лимит)
  requestTimeout: 28000,        // 28 секунд (меньше лимита Render)
  connectionTimeout: 5000,      // 5 секунд на установку соединения
  keepAliveTimeout: 30000,      // 30 секунд keep-alive
  bodyLimit: 10485760,          // 10MB лимит тела запроса
});

// Bot instance
let bot: ReturnType<typeof createBot> | null = null;

// --------------------------------------------
// Setup Server Routes
// --------------------------------------------

const setupRoutes = async (server: FastifyInstance): Promise<void> => {
  // Register CORS
  const DEFAULT_ADMIN_ORIGIN = 'https://amina-admin.onrender.com';
  const allowedOrigins: string[] = [DEFAULT_ADMIN_ORIGIN];
  if (process.env.ADMIN_URL && process.env.ADMIN_URL !== DEFAULT_ADMIN_ORIGIN) {
    allowedOrigins.push(process.env.ADMIN_URL);
  }
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
        admin: 'https://amina-admin.onrender.com',
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

  // === ОПТИМИЗАЦИЯ: Health/Ready/Status кешируются на 10 секунд ===
  const HEALTH_CACHE_TTL = 10_000;
  let healthCache: { checks: Record<string, boolean>; ts: number } | null = null;

  server.get('/ready', async () => {
    const now = Date.now();
    if (healthCache && now - healthCache.ts < HEALTH_CACHE_TTL) {
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
    if (!healthCache || now - healthCache.ts >= HEALTH_CACHE_TTL) {
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

  // Register REST API routes for LLM interaction
  await registerApiRoutes(server);
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

    // Setup routes
    await setupRoutes(app);

    // Запускаем HTTP сервер ПЕРВЫМ — чтобы Render health check прошёл немедленно
    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
    serverLogger.info({ address }, '📡 HTTP server listening');

    // Дальнейшая инициализация — асинхронно, не блокирует health check

    // Test database connection
    appLogger.info('Testing database connection...');
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('settings').select('key').limit(1);
      if (error) {
        appLogger.warn({ error: error.message }, '⚠️ Database connection issue - continuing anyway');
      } else {
        appLogger.info('✓ Database connection OK');
      }
    } catch (error) {
      appLogger.warn({ error }, '⚠️ Database not available - continuing anyway');
    }

    // Telegram token: env или из админки (БД)
    if (!config.telegram.token) {
      const settings = await settingsRepo.getMany(['telegram_bot_token']);
      const tokenFromDb = settings['telegram_bot_token']?.trim();
      if (tokenFromDb) {
        config.setTelegramToken(tokenFromDb);
        appLogger.info('✓ Telegram token loaded from admin (database)');
      }
    } else {
      appLogger.info('✓ Telegram token from environment');
    }

    if (!config.telegram.token) {
      appLogger.fatal(
        'TELEGRAM_BOT_TOKEN не задан. Задайте его в Render (Environment) или в админке: API Ключи → Telegram Bot Token'
      );
      process.exit(1);
    }

    // Test OpenRouter connection (optional — ключ может быть в админке)
    appLogger.info('Testing OpenRouter connection...');
    const aiOk = await aiService.testConnection();
    if (!aiOk) {
      appLogger.warn('⚠️ OpenRouter test failed — задайте OPENROUTER_API_KEY в Render или в админке (API Ключи)');
    } else {
      appLogger.info('✓ OpenRouter connection OK');
    }

    // Create bot
    appLogger.info('Initializing Telegram bot...');
    bot = createBot();

    // Setup webhook if in production
    if (config.isProd && config.telegram.webhook.url) {
      try {
        app.post('/webhook/telegram', webhookCallback(bot, 'fastify', {
          secretToken: config.telegram.webhook.secret,
        }));
        await bot.api.setWebhook(`${config.telegram.webhook.url}/webhook/telegram`, {
          secret_token: config.telegram.webhook.secret,
        });
        appLogger.info('🔗 Telegram webhook configured');
      } catch (err) {
        appLogger.warn({ error: err }, '⚠️ Failed to set webhook — продолжаем без webhook');
      }
    }

    // Start bot polling (development) or webhook is already set (production)
    if (!config.isProd || !config.telegram.webhook.url) {
      bot.start({
        onStart: (botInfo) => {
          appLogger.info({ username: botInfo.username }, '🤖 Bot started (polling mode)');
        },
      }).catch((err) => {
        appLogger.error({ error: err?.message ?? err }, '❌ Bot polling start failed — продолжаем без polling');
      });
    }

    // Start reminder scheduler
    startReminderScheduler(bot);
    appLogger.info('⏰ Reminder scheduler started');

    // Start digest scheduler
    startDigestScheduler(bot);
    appLogger.info('☀️ Digest scheduler started');

    // Init voice messages infrastructure (bucket + table check)
    ensureVoiceMessagesInfra()
      .then(() => appLogger.info('🎤 Voice messages storage initialized'))
      .catch(err => appLogger.warn({ error: err }, 'Voice messages infra init failed (non-critical)'));

    // Register bot menu commands in Telegram UI (после старта бота)
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
      appLogger.info('📋 Bot menu commands registered');
    } catch (err) {
      appLogger.warn({ error: err }, '⚠️ Failed to set bot commands (non-critical)');
    }

    appLogger.info('✅ Amina Bot is ready!');
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
start();
