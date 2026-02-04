import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/index-simple.js';
import { logger, telegramLogger, serverLogger } from './config/logger-simple.js';
import { createBot } from './telegram/bot-simple.js';
import { aiService } from './ai/openrouter-simple.js';

// --------------------------------------------
// Initialize Services
// --------------------------------------------

const app = Fastify({
  logger: false, // Use custom pino logger
  trustProxy: true,
});

// Bot instance
let bot: ReturnType<typeof createBot> | null = null;

// --------------------------------------------
// Setup Server
// --------------------------------------------

const setupServer = async (app: FastifyInstance): Promise<void> => {
  // Register CORS
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Health Check Routes
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/api/status', async () => {
    const status = {
      server: 'ok',
      bot: bot ? 'initialized' : 'not_initialized',
      openrouter: 'checking',
    };

    try {
      const aiOk = await aiService.testConnection();
      status.openrouter = aiOk ? 'ok' : 'error';
    } catch {
      status.openrouter = 'error';
    }

    return status;
  });
};

// --------------------------------------------
// Start Application
// --------------------------------------------

const start = async (): Promise<void> => {
  try {
    // Validate configuration
    logger.info('Starting Amina Bot (Simple Version - No Database)...');
    logger.info({ config: { ...config, telegram: { token: '[REDACTED]' }, ai: { ...config.ai, apiKey: '[REDACTED]' } } }, 'Configuration loaded');

    // Setup server routes
    await setupServer(app);

    // Test OpenRouter connection
    logger.info('Testing OpenRouter connection...');
    const aiOk = await aiService.testConnection();
    if (!aiOk) {
      throw new Error('OpenRouter connection test failed');
    }
    logger.info('✓ OpenRouter connection OK');

    // Create bot
    logger.info('Initializing Telegram bot...');
    bot = createBot();
    
    // Start bot polling
    bot.start({
      onStart: (botInfo) => {
        telegramLogger.info({ username: botInfo.username }, 'Bot started successfully');
      },
    });

    // Start web server
    const port = config.server.port;
    const host = config.server.host;

    await app.listen({ port, host });
    serverLogger.info({ port, host }, 'Server started');

    logger.info('✓ Amina Bot is ready!');
  } catch (error) {
    logger.error({ error }, 'Failed to start application');
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

  logger.info('Shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the app
start();
