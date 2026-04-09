import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { appLogger } from '../config/logger.js';

export async function registerAdminStatic(
  server: FastifyInstance,
  adminDistPath: string,
  hasAdminDist: boolean,
): Promise<void> {
  if (!hasAdminDist) {
    appLogger.info('Admin dist not found — skipping static file serving');
    return;
  }

  await server.register(fastifyStatic, {
    root: adminDistPath,
    prefix: '/',
    wildcard: false,
  });

  const indexHtml = readFileSync(resolve(adminDistPath, 'index.html'), 'utf-8');
  server.setNotFoundHandler(async (request, reply) => {
    if (
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/webhook/') &&
      !request.url.startsWith('/mini-app/')
    ) {
      return reply.type('text/html').send(indexHtml);
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  appLogger.info({ path: adminDistPath }, 'Admin panel static files registered');
}
