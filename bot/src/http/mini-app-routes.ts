import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { getMiniAppHtml } from '../telegram/mini-app-html.js';
import { appLogger } from '../config/logger.js';

export function registerMiniAppRoutes(server: FastifyInstance): void {
  const sendMiniAppHtml = (reply: FastifyReply) => {
    try {
      return reply
        .header('Cache-Control', 'no-store, no-cache, must-revalidate')
        .header('Pragma', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(getMiniAppHtml());
    } catch (err) {
      appLogger.error({ err }, 'mini-app: failed to read mini-app-web.html');
      return reply.code(503).send({ error: 'Mini-app unavailable', code: 'MINI_APP_MISSING' });
    }
  };

  server.get('/mini-app', async (_request, reply) => reply.redirect('/mini-app/index.html'));
  server.get('/mini-app/', async (_request, reply) => sendMiniAppHtml(reply));
  server.get('/mini-app/index.html', async (_request, reply) => sendMiniAppHtml(reply));

  const avatarsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'telegram', 'avatars');
  server.get('/mini-app/avatars/:filename', async (request: FastifyRequest<{ Params: { filename: string } }>, reply: FastifyReply) => {
    const { filename } = request.params;
    if (!/^[\w-]+\.png$/.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }
    const filePath = resolve(avatarsDir, filename);
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'Avatar not found' });
    }
    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .type('image/png')
      .send(readFileSync(filePath));
  });

  try {
    getMiniAppHtml();
    appLogger.info('Telegram mini-app: HTML loaded from src/telegram/mini-app-web.html');
  } catch {
    appLogger.warn('Mini-app: mini-app-web.html not found');
  }
}
