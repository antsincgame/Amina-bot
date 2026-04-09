import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settingsRepo } from '../../db/index.js';
import { aiService } from '../../ai/openrouter.js';
import { requireAdminAuth } from '../../api/routes/middleware.js';
import { getChatRuntimeState } from '../../ai/runtime-truth.js';
import { config } from '../../config/index.js';
import { HEALTH_CACHE_TTL_MS, HEALTH_AI_TIMEOUT_MS } from '../../config/constants.js';
import type { createBot } from '../../telegram/bot.js';

interface HealthDeps {
  getBot: () => ReturnType<typeof createBot> | null;
  hasAdminDist: boolean;
  appVersion: string;
}

export function registerHealthRoutes(server: FastifyInstance, deps: HealthDeps): void {
  let healthCache: { checks: Record<string, boolean>; ts: number } | null = null;

  const dbCheck = async (): Promise<boolean> => {
    try {
      await settingsRepo.get('__healthcheck__');
      return true;
    } catch {
      return false;
    }
  };

  const aiCheck = async (): Promise<boolean> => {
    try {
      return await aiService.testConnection(HEALTH_AI_TIMEOUT_MS);
    } catch {
      return false;
    }
  };

  const runReadinessChecks = async (): Promise<Record<string, boolean>> => {
    const [dbOk, aiOk] = await Promise.all([dbCheck(), aiCheck()]);
    return { database: dbOk, ai: aiOk };
  };

  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: deps.appVersion,
  }));

  server.get('/ready', async () => {
    const now = Date.now();
    if (healthCache && now - healthCache.ts < HEALTH_CACHE_TTL_MS) {
      const allHealthy = Object.values(healthCache.checks).every(Boolean);
      return { status: allHealthy ? 'ready' : 'degraded', checks: healthCache.checks, timestamp: new Date().toISOString(), cached: true };
    }

    const checks = await runReadinessChecks();
    healthCache = { checks, ts: now };

    const allHealthy = Object.values(checks).every(Boolean);
    return { status: allHealthy ? 'ready' : 'degraded', checks, timestamp: new Date().toISOString() };
  });

  server.get('/api/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = await requireAdminAuth(request, reply);
    if (!admin) return reply;

    const now = Date.now();
    if (!healthCache || now - healthCache.ts >= HEALTH_CACHE_TTL_MS) {
      healthCache = { checks: await runReadinessChecks(), ts: now };
    }
    const chatRuntime = await getChatRuntimeState().catch(() => null);
    const bot = deps.getBot();
    const telegramReady = Boolean(bot && config.telegram.token);
    const telegramEngine = telegramReady
      ? (config.telegram.webhook.url ? 'grammy (runtime active)' : 'grammy (polling/runtime active)')
      : config.telegram.token
        ? 'grammy (token present, runtime not initialized yet)'
        : 'grammy (token missing)';
    const aiEngine = chatRuntime
      ? `${chatRuntime.resolvedProvider} · ${chatRuntime.resolvedModel}`
      : 'AI runtime state unavailable';

    return {
      checks: {
        telegram: { ready: telegramReady, engine: telegramEngine },
        ai: {
          ready: healthCache.checks['ai'] ?? false,
          engine: aiEngine,
        },
        database: { ready: healthCache.checks['database'] ?? false, engine: config.dbBackend === 'appwrite' ? 'Appwrite' : 'Legacy' },
        admin: { ready: deps.hasAdminDist, engine: deps.hasAdminDist ? 'React static bundle detected' : 'Admin bundle missing on server' },
      },
      timestamp: new Date().toISOString(),
    };
  });
}
