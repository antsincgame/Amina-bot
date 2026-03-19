import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { aiLogger } from '../../config/logger.js';
import {
  clearLMStudioCache,
  getLMStudioConfig,
  getLMStudioHealthStatus,
  fetchLMStudioModels,
  probeLMStudioDirect,
  probeLMStudioTunnelUrl,
  recordHeartbeat,
  getLMStudioCircuitStatus,
} from '../../ai/lmstudio.js';
import {
  getTunnelAuthFailure,
  getTunnelUrlValidationError,
  normalizeTunnelBaseUrl,
  persistRegisteredTunnelUrl,
} from './middleware.js';

export async function registerLmstudioRoutes(server: FastifyInstance): Promise<void> {
  server.get('/lmstudio/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cfg = await getLMStudioConfig();
      if (!cfg) {
        return reply.code(200).send({
          success: true,
          data: { configured: false, healthy: false, url: null },
        });
      }

      const status = await getLMStudioHealthStatus(cfg);
      const circuitBreaker = getLMStudioCircuitStatus();
      return reply.code(200).send({
        success: true,
        data: {
          configured: true,
          healthy: status.healthy,
          url: cfg.url,
          model: cfg.model,
          source: status.source,
          heartbeatAt: status.heartbeatAt ?? undefined,
          circuitBreaker,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  server.get('/lmstudio/models', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cfg = await getLMStudioConfig();
      if (!cfg) {
        return reply.code(200).send({
          success: true,
          data: { configured: false, models: [] },
        });
      }

      const models = await fetchLMStudioModels(cfg);
      return reply.code(200).send({
        success: true,
        data: { configured: true, models, url: cfg.url },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  server.post('/lmstudio/reload', async (_request: FastifyRequest, reply: FastifyReply) => {
    clearLMStudioCache();
    aiLogger.info('LM Studio config cache cleared via API');
    return reply.code(200).send({ success: true, message: 'LM Studio cache cleared' });
  });

  server.get('/lmstudio/health/debug', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      clearLMStudioCache();
      const cfg = await getLMStudioConfig();
      if (!cfg) {
        return reply.code(200).send({
          success: true,
          data: { configured: false, error: 'no_url' },
        });
      }
      const start = Date.now();
      const result = await probeLMStudioDirect(cfg, {
        timeoutMs: 25_000,
        userAgent: 'Amina-Bot/1.0 (LM-Studio-Debug)',
      });
      const latencyMs = Date.now() - start;

      return reply.code(200).send({
        success: true,
        data: {
          configured: true,
          healthy: result.healthy,
          url: cfg.url,
          status: result.status,
          endpoint: result.endpoint ?? undefined,
          latencyMs,
          error: result.error || undefined,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  // ============================================
  // Tunnel Registration
  // ============================================

  server.post(
    '/tunnel/register',
    async (
      request: FastifyRequest<{ Body: { url: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const authFailure = getTunnelAuthFailure(request);
        if (authFailure) {
          return reply.code(authFailure.statusCode).send({
            success: false,
            error: authFailure.error,
          });
        }

        const { url: tunnelUrl } = request.body as { url: string };

        if (!tunnelUrl || typeof tunnelUrl !== 'string') {
          return reply.code(400).send({
            success: false,
            error: 'url is required',
          });
        }

        const trimmed = normalizeTunnelBaseUrl(tunnelUrl);
        const validationError = getTunnelUrlValidationError(trimmed);
        if (validationError) {
          return reply.code(400).send({
            success: false,
            error: validationError,
          });
        }

        const healthy = await probeLMStudioTunnelUrl(trimmed);

        if (!healthy) {
          return reply.code(400).send({
            success: false,
            error: 'Tunnel URL is reachable, but does not expose a valid LM Studio models API',
          });
        }

        await persistRegisteredTunnelUrl(trimmed);

        aiLogger.debug(
          { url: trimmed, healthy },
          'Tunnel URL registered'
        );

        return reply.code(200).send({
          success: true,
          data: { url: trimmed, healthy, registeredAt: new Date().toISOString() },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error }, 'Tunnel registration failed');
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );

  server.post(
    '/tunnel/heartbeat',
    async (
      request: FastifyRequest<{ Body?: { url?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const authFailure = getTunnelAuthFailure(request);
        if (authFailure) {
          return reply.code(authFailure.statusCode).send({
            success: false,
            error: authFailure.error,
          });
        }

        const { url } = (request.body ?? {}) as { url?: string };
        if (!url || typeof url !== 'string') {
          return reply.code(400).send({ success: false, error: 'url is required' });
        }

        const normalizedIncoming = normalizeTunnelBaseUrl(url);
        const validationError = getTunnelUrlValidationError(normalizedIncoming);
        if (validationError) {
          return reply.code(400).send({ success: false, error: validationError });
        }

        const cfg = await getLMStudioConfig();
        const normalizedCurrent = cfg ? normalizeTunnelBaseUrl(cfg.url) : null;
        if (!cfg || normalizedIncoming !== normalizedCurrent) {
          const healthyIncoming = await probeLMStudioTunnelUrl(normalizedIncoming);
          if (!healthyIncoming) {
            return reply.code(409).send({
              success: false,
              error: cfg
                ? 'heartbeat url does not match registered tunnel and is not reachable from server'
                : 'LM Studio tunnel is not registered and incoming tunnel is not reachable from server',
            });
          }

          await persistRegisteredTunnelUrl(normalizedIncoming);
          aiLogger.info(
            { previousUrl: normalizedCurrent, url: normalizedIncoming },
            'Tunnel URL auto-registered via heartbeat',
          );

          return reply.code(200).send({
            success: true,
            data: {
              url: normalizedIncoming,
              updated: true,
            },
          });
        }

        const healthy = await probeLMStudioTunnelUrl(normalizedIncoming);
        if (!healthy) {
          return reply.code(409).send({ success: false, error: 'registered tunnel is not reachable from server' });
        }

        await recordHeartbeat(normalizedIncoming);
        return reply.code(200).send({ success: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );
}
