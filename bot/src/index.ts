import Fastify from 'fastify';
import { createRequire } from 'module';
import { config } from './config/index.js';
import {
  REQUEST_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  BODY_LIMIT_BYTES,
  INIT_DELAY_MS,
} from './config/constants.js';
import { serverLogger, appLogger } from './config/logger.js';
import type { createBot } from './telegram/bot.js';
import { setupRoutes } from './http/setup-routes.js';
import { initBotAndServices } from './bootstrap/init-bot-and-services.js';
import { shutdown, isShuttingDown } from './bootstrap/shutdown.js';

const require = createRequire(import.meta.url);
const APP_VERSION: string = (require('../package.json') as { version: string }).version;

const app = Fastify({
  logger: false,
  trustProxy: config.server.trustProxy,
  requestTimeout: REQUEST_TIMEOUT_MS,
  connectionTimeout: CONNECTION_TIMEOUT_MS,
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  bodyLimit: BODY_LIMIT_BYTES,
});

const botHolder: { bot: ReturnType<typeof createBot> | null } = { bot: null };

const start = async (): Promise<void> => {
  try {
    appLogger.info('Starting Amina Bot...');
    appLogger.info({
      env: config.isDev ? 'development' : 'production',
      port: config.server.port,
    }, 'Configuration loaded');

    await setupRoutes(app, {
      getBot: () => botHolder.bot,
      appVersion: APP_VERSION,
    });

    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
    serverLogger.info({ address }, 'HTTP server listening');
    appLogger.info({ delayMs: INIT_DELAY_MS }, 'HTTP server ready — starting background init');

    setTimeout(() => {
      if (isShuttingDown()) return;
      initBotAndServices(botHolder).catch(err => {
        appLogger.error({ error: err }, 'Background init error');
      });
    }, INIT_DELAY_MS);
  } catch (error) {
    appLogger.fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM', app, botHolder.bot));
process.on('SIGINT', () => shutdown('SIGINT', app, botHolder.bot));

start().catch((err) => {
  appLogger.fatal({ error: err }, 'Unhandled error in start()');
});

process.on('unhandledRejection', (reason) => {
  appLogger.fatal({ reason }, 'Unhandled Promise Rejection');
});

process.on('uncaughtException', (err) => {
  appLogger.fatal({ error: err.message }, 'Uncaught Exception');
  shutdown('uncaughtException', app, botHolder.bot).catch(() => process.exit(1));
});
