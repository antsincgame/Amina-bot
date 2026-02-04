import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { webhookCallback } from 'grammy';
import { config } from './config/index.js';
import { logger, serverLogger, httpLogger } from './config/logger.js';
import { createBot } from './telegram/bot.js';
import { getSupabase } from './db/supabase.js';
import { aiService } from './ai/openrouter.js';

// --------------------------------------------
// Application Entry Point
// --------------------------------------------

const app = Fastify({
  logger: false, // We use pino separately
  trustProxy: true,
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
};

// --------------------------------------------
// Start Application
// --------------------------------------------

const start = async (): Promise<void> => {
  try {
    logger.info('🚀 Starting Amina Bot...');
    logger.info({
      env: config.isDev ? 'development' : 'production',
      port: config.server.port,
    }, 'Configuration loaded');

    // Setup routes
    await setupRoutes(app);

    // Test database connection
    logger.info('Testing database connection...');
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('settings').select('key').limit(1);
      if (error) {
        logger.warn({ error: error.message }, '⚠️ Database connection issue - continuing anyway');
      } else {
        logger.info('✓ Database connection OK');
      }
    } catch (error) {
      logger.warn({ error }, '⚠️ Database not available - continuing anyway');
    }

    // Test OpenRouter connection
    logger.info('Testing OpenRouter connection...');
    const aiOk = await aiService.testConnection();
    if (!aiOk) {
      logger.warn('⚠️ OpenRouter test failed - check API key');
    } else {
      logger.info('✓ OpenRouter connection OK');
    }

    // Create bot
    logger.info('Initializing Telegram bot...');
    bot = createBot();

    // Setup webhook if in production
    if (config.isProd && config.telegram.webhook.url) {
      app.post('/webhook/telegram', webhookCallback(bot, 'fastify'));
      await bot.api.setWebhook(`${config.telegram.webhook.url}/webhook/telegram`, {
        secret_token: config.telegram.webhook.secret,
      });
      logger.info('🔗 Telegram webhook configured');
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
          logger.info({ username: botInfo.username }, '🤖 Bot started (polling mode)');
        },
      });
    }

    logger.info('✅ Amina Bot is ready!');
  } catch (error) {
    logger.fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
};

// --------------------------------------------
// Graceful Shutdown
// --------------------------------------------

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Shutdown signal received');

  if (bot) {
    logger.info('Stopping bot...');
    await bot.stop();
  }

  logger.info('Closing server...');
  await app.close();

  logger.info('👋 Goodbye!');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Run
start();
