import type { FastifyInstance } from 'fastify';
import { registerMiddleware } from './middleware.js';
import { registerChatRoutes } from './chat.js';
import { registerConversationsRoutes } from './conversations.js';
import { registerSettingsRoutes } from './settings.js';
import { registerPromptsRoutes } from './prompts.js';
import { registerLogsRoutes } from './logs.js';
import { registerModelsRoutes } from './models.js';
import { registerWebsearchRoutes } from './websearch.js';
import { registerUsersRoutes } from './users.js';
import { registerNewsRoutes } from './news.js';
import { registerVoiceMessagesRoutes } from './voice-messages.js';
import { registerLmstudioRoutes } from './lmstudio.js';
import { registerTelephonyRoutes } from './telephony.js';

export async function registerApiRoutes(server: FastifyInstance): Promise<void> {
  // Register application/x-www-form-urlencoded parser at root level
  // (needed for LiraX PBX webhooks)
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const parsed = Object.fromEntries(new URLSearchParams(body as string));
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Prefix all routes with /api
  server.register(
    async (apiServer: FastifyInstance) => {
      // Apply rate limiting and admin guard middleware
      await registerMiddleware(apiServer);

      // Register all route modules
      await registerChatRoutes(apiServer);
      await registerConversationsRoutes(apiServer);
      await registerSettingsRoutes(apiServer);
      await registerPromptsRoutes(apiServer);
      await registerLogsRoutes(apiServer);
      await registerModelsRoutes(apiServer);
      await registerWebsearchRoutes(apiServer);
      await registerUsersRoutes(apiServer);
      await registerNewsRoutes(apiServer);
      await registerVoiceMessagesRoutes(apiServer);
      await registerLmstudioRoutes(apiServer);
      await registerTelephonyRoutes(apiServer);
    },
    { prefix: '/api' }
  );
}
