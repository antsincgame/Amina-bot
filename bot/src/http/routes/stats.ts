import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAdminAuth } from '../../api/routes/middleware.js';
import { analyticsRepo } from '../../db/index.js';
import { userProfileRepo } from '../../memory/user-memory.js';
import { httpLogger } from '../../config/logger.js';

export function registerStatsRoutes(server: FastifyInstance): void {
  server.get('/api/stats', async (request: FastifyRequest<{ Querystring: { from?: string; to?: string } }>, reply: FastifyReply) => {
    const admin = await requireAdminAuth(request, reply);
    if (!admin) return reply;

    try {
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const rawFrom = request.query.from;
      const rawTo = request.query.to;
      const fromDate = rawFrom ? new Date(rawFrom) : defaultFrom;
      const toDate = rawTo ? new Date(rawTo) : now;

      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return {
          totalMessages: 0,
          totalCalls: 0,
          uniqueUsers: 0,
          tokensByDay: [],
          period: 'invalid',
        };
      }

      const [stats, allUsers] = await Promise.all([
        analyticsRepo.getStats(fromDate, toDate),
        userProfileRepo.getAll(1000, 0),
      ]);

      return {
        totalMessages: stats.totalMessages,
        totalCalls: stats.totalCalls,
        uniqueUsers: stats.uniqueUsers || allUsers.length,
        tokensByDay: stats.tokensByDay,
        period: `${fromDate.toISOString()}..${toDate.toISOString()}`,
      };
    } catch (error) {
      httpLogger.error({ error }, 'Failed to get stats');
      return {
        totalMessages: 0,
        totalCalls: 0,
        uniqueUsers: 0,
        tokensByDay: [],
        period: 'error',
      };
    }
  });
}
