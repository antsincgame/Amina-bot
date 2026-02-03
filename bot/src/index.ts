import Fastify from 'fastify';
import cors from '@fastify/cors';
import { webhookCallback } from 'grammy';
import { config } from './config/index.js';
import { logger, httpLogger } from './config/logger.js';
import { createBot } from './telegram/bot.js';
import { getSupabase } from './db/supabase.js';
import { aiService } from './ai/openrouter.js';

// --------------------------------------------
// Application Entry Point
// --------------------------------------------

const main = async (): Promise<void> => {
  logger.info('🚀 Starting Amina Bot...');

  // Initialize Fastify server
  const server = Fastify({
    logger: false, // We use pino separately
  });

  // Register plugins
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Create Telegram bot
  const bot = createBot();

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
      // Check Supabase connection
      const supabase = getSupabase();
      const { error } = await supabase.from('settings').select('key').limit(1);
      checks['database'] = !error;
    } catch {
      checks['database'] = false;
    }

    try {
      // Check AI connection
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

  // Webhook endpoint for Telegram (production)
  if (config.isProd && config.telegram.webhook.url) {
    server.post('/webhook/telegram', webhookCallback(bot, 'fastify'));
    logger.info('Telegram webhook configured');
  }

  // Voximplant webhook endpoint
  server.post('/webhook/voximplant', async (request, reply) => {
    httpLogger.info({ body: request.body }, 'Voximplant webhook received');
    
    try {
      const { handleVoximplantWebhook } = await import('./voice/voximplant.js');
      const result = await handleVoximplantWebhook(request.body as Parameters<typeof handleVoximplantWebhook>[0]);
      return reply.send(result);
    } catch (error) {
      httpLogger.error({ error }, 'Voximplant webhook error');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  // API routes for admin panel
  server.get('/api/stats', async () => {
    // TODO: Implement stats endpoint
    return {
      totalMessages: 0,
      totalCalls: 0,
      totalUsers: 0,
    };
  });

  // Start server
  try {
    const address = await server.listen({
      port: config.server.port,
      host: '0.0.0.0',
    });

    logger.info(`📡 HTTP server listening on ${address}`);

    // Start bot
    if (config.isProd && config.telegram.webhook.url) {
      // Production: Set webhook
      await bot.api.setWebhook(`${config.telegram.webhook.url}/webhook/telegram`, {
        secret_token: config.telegram.webhook.secret,
      });
      logger.info('🔗 Telegram webhook set');
    } else {
      // Development: Use long polling
      bot.start({
        onStart: (botInfo) => {
          logger.info(`🤖 Bot @${botInfo.username} started (polling mode)`);
        },
      });
    }

    logger.info('✅ Amina Bot is ready!');
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down...');
    
    bot.stop();
    await server.close();
    
    logger.info('👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
