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

// --------------------------------------------
// Application Entry Point
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
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Health check endpoint
  server.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    };
  });

  // Readiness check (with dependencies)
  server.get('/ready', async () => {
    const checks: Record<string, boolean> = {
      database: false,
      ai: false,
    };

    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('settings').select('key').limit(1);
      checks['database'] = !error;
    } catch {
      checks['database'] = false;
    }

    try {
      checks['ai'] = await aiService.testConnection();
    } catch {
      checks['ai'] = false;
    }

    const allHealthy = Object.values(checks).every(Boolean);

    return {
      status: allHealthy ? 'ready' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  });

  // API endpoint for service status (used by admin dashboard)
  server.get('/api/status', async () => {
    const checks: Record<string, { ready: boolean; engine: string }> = {
      telegram: { ready: true, engine: 'grammy' },
      ai: { ready: false, engine: 'OpenRouter' },
      database: { ready: false, engine: 'Supabase' },
    };

    try {
      checks['ai'] = { ready: await aiService.testConnection(), engine: 'OpenRouter' };
    } catch { /* ignore */ }

    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('settings').select('key').limit(1);
      checks['database'] = { ready: !error, engine: 'Supabase' };
    } catch { /* ignore */ }

    return { checks, timestamp: new Date().toISOString() };
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
      app.post('/webhook/telegram', webhookCallback(bot, 'fastify'));
      await bot.api.setWebhook(`${config.telegram.webhook.url}/webhook/telegram`, {
        secret_token: config.telegram.webhook.secret,
      });
      appLogger.info('🔗 Telegram webhook configured');
    }

    // Start server
    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
    serverLogger.info({ address }, '📡 HTTP server listening');

    // Start bot polling (development) or webhook is already set (production)
    if (!config.isProd || !config.telegram.webhook.url) {
      bot.start({
        onStart: (botInfo) => {
          appLogger.info({ username: botInfo.username }, '🤖 Bot started (polling mode)');
        },
      });
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

const shutdown = async (signal: string): Promise<void> => {
  appLogger.info({ signal }, 'Shutdown signal received');

  if (bot) {
    appLogger.info('Stopping bot...');
    await bot.stop();
  }

  appLogger.info('Closing server...');
  await app.close();

  appLogger.info('👋 Goodbye!');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Run
start();
