import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { analyticsRepo } from '../../db/index.js';
import { aiLogger, getLogs, getLogStats } from '../../config/logger.js';
import { validateEventType } from '../../utils/validation.js';
import type { AnalyticsEventType, LogLevel } from '../../../../shared/types/index.js';

export async function registerLogsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/logs
   * Get system logs (errors, warnings)
   */
  server.get(
    '/logs',
    async (
      request: FastifyRequest<{
        Querystring: {
          level?: LogLevel;
          module?: string;
          from?: string;
          to?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { level, module, from, to, limit } = request.query;

        const logs = await getLogs({
          level: level as LogLevel | undefined,
          module,
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
          limit: limit ? parseInt(limit, 10) : 100,
        });

        return reply.code(200).send({
          success: true,
          data: logs,
          count: logs.length,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get logs error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch logs',
        });
      }
    }
  );

  /**
   * GET /api/logs/stats
   * Get log statistics
   */
  server.get(
    '/logs/stats',
    async (
      request: FastifyRequest<{
        Querystring: {
          from?: string;
          to?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { from, to } = request.query;

        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const stats = await getLogStats(
          from ? new Date(from) : weekAgo,
          to ? new Date(to) : now
        );

        return reply.code(200).send({
          success: true,
          data: stats,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get log stats error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch log stats',
        });
      }
    }
  );

  /**
   * GET /api/analytics
   * Get analytics events with optional filters
   */
  server.get(
    '/analytics',
    async (
      request: FastifyRequest<{
        Querystring: {
          from?: string;
          to?: string;
          channel?: string;
          eventType?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { from, to, channel, eventType, limit } = request.query;

        const validChannel = channel === 'telegram' || channel === 'voice' || channel === 'admin'
          ? channel
          : undefined;

        if (channel && channel !== 'all' && validChannel === undefined) {
          return reply.code(400).send({ success: false, error: 'Invalid channel filter' });
        }

        let validEventType: AnalyticsEventType | undefined;
        if (eventType) {
          try {
            validEventType = validateEventType(eventType);
          } catch {
            return reply.code(400).send({ success: false, error: 'Invalid analytics event type' });
          }
        }

        const events = await analyticsRepo.listEvents({
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
          channel: validChannel,
          eventType: validEventType,
          limit: limit ? parseInt(limit, 10) : 100,
        });

        return reply.code(200).send({
          success: true,
          data: events,
          count: events.length,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get analytics error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch analytics events',
        });
      }
    },
  );
}
