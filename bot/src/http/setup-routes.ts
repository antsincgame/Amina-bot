import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config } from '../config/index.js';
import type { createBot } from '../telegram/bot.js';
import { registerTelegramWebhookRoute } from '../telegram/webhook.js';
import { registerApiRoutes } from '../api/routes.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerMiniAppRoutes } from './mini-app-routes.js';
import { registerAdminStatic } from './admin-static.js';

interface SetupDeps {
  getBot: () => ReturnType<typeof createBot> | null;
  appVersion: string;
}

export async function setupRoutes(server: FastifyInstance, deps: SetupDeps): Promise<void> {
  const allowedOrigins: string[] = [config.adminUrl];
  const leadOrigins = (process.env.LEAD_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  allowedOrigins.push(...leadOrigins);

  await server.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  const __dirname_check = dirname(fileURLToPath(import.meta.url));
  const adminDistPath = resolve(__dirname_check, '../../../admin-dist');
  const hasAdminDist = existsSync(resolve(adminDistPath, 'index.html'));

  if (!hasAdminDist) {
    server.get('/', async () => ({
      service: 'Amina Telegram Bot',
      status: 'running',
      version: deps.appVersion,
      endpoints: {
        health: '/health',
        ready: '/ready',
        api: '/api/*',
        admin: config.adminUrl,
      },
      documentation: 'https://github.com/antsincgame/Amina-bot',
    }));
  }

  registerHealthRoutes(server, {
    getBot: deps.getBot,
    hasAdminDist,
    appVersion: deps.appVersion,
  });
  registerStatsRoutes(server);
  registerMiniAppRoutes(server);
  registerTelegramWebhookRoute(server, deps.getBot);
  await registerApiRoutes(server);
  await registerAdminStatic(server, adminDistPath, hasAdminDist);
}
