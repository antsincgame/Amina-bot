import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { aiLogger } from '../../config/logger.js';
import { userProfileRepo, userMemoryRepo, userLogsRepo, type UserLog } from '../../memory/user-memory.js';

export async function registerUsersRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/users
   * Get all user profiles
   */
  server.get(
    '/users',
    async (
      request: FastifyRequest<{
        Querystring: { limit?: string; offset?: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const limit = request.query.limit ? parseInt(request.query.limit, 10) : 100;
        const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;

        const users = await userProfileRepo.getAll(limit, offset);

        return reply.code(200).send({
          success: true,
          data: users,
          count: users.length,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get users error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch users',
        });
      }
    }
  );

  /**
   * GET /api/users/:userId
   * Get user profile by ID
   */
  server.get(
    '/users/:userId',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const profile = await userProfileRepo.get(userId);

        if (!profile) {
          return reply.code(404).send({
            success: false,
            error: 'User not found',
          });
        }

        return reply.code(200).send({
          success: true,
          data: profile,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get user error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch user',
        });
      }
    }
  );

  /**
   * GET /api/users/:userId/stats
   * Get user statistics
   */
  server.get(
    '/users/:userId/stats',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const stats = await userProfileRepo.getStats(userId);

        return reply.code(200).send({
          success: true,
          data: stats,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get user stats error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch user stats',
        });
      }
    }
  );

  /**
   * GET /api/users/:userId/memory
   * Get user memory entries
   */
  server.get(
    '/users/:userId/memory',
    async (
      request: FastifyRequest<{
        Params: { userId: string };
        Querystring: { type?: string; limit?: string; pinned?: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const { type, limit, pinned } = request.query;

        const VALID_MEMORY_TYPES = new Set(['fact', 'preference', 'context', 'summary', 'important'] as const);
        type MemoryType = 'fact' | 'preference' | 'context' | 'summary' | 'important';

        let memories;
        if (pinned === 'true') {
          memories = await userMemoryRepo.getPinned(userId);
        } else if (type && VALID_MEMORY_TYPES.has(type as MemoryType)) {
          memories = await userMemoryRepo.getByType(
            userId,
            type as MemoryType
          );
        } else {
          memories = await userMemoryRepo.getAll(
            userId,
            limit ? parseInt(limit, 10) : 50
          );
        }

        return reply.code(200).send({
          success: true,
          data: memories,
          count: memories.length,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get user memory error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch user memory',
        });
      }
    }
  );

  /**
   * POST /api/users/:userId/memory
   * Add memory entry for user
   */
  server.post(
    '/users/:userId/memory',
    async (
      request: FastifyRequest<{
        Params: { userId: string };
        Body: {
          memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
          content: string;
          is_pinned?: boolean;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const { memory_type, content, is_pinned } = request.body as {
          memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
          content: string;
          is_pinned?: boolean;
        };

        const memory = await userMemoryRepo.add(userId, memory_type, content, {
          source: 'admin',
          isPinned: is_pinned,
        });

        return reply.code(201).send({
          success: true,
          data: memory,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Add user memory error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to add user memory',
        });
      }
    }
  );

  /**
   * DELETE /api/users/:userId/memory/:memoryId
   * Deactivate memory entry
   */
  server.delete(
    '/users/:userId/memory/:memoryId',
    async (
      request: FastifyRequest<{
        Params: { userId: string; memoryId: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { memoryId } = request.params;
        await userMemoryRepo.deactivate(memoryId);

        return reply.code(200).send({
          success: true,
          message: 'Memory deactivated',
        });
      } catch (error) {
        aiLogger.error({ error }, 'Delete user memory error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to delete user memory',
        });
      }
    }
  );

  /**
   * GET /api/users/:userId/logs
   * Get user logs
   */
  server.get(
    '/users/:userId/logs',
    async (
      request: FastifyRequest<{
        Params: { userId: string };
        Querystring: {
          event_type?: string;
          from?: string;
          to?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const { event_type, from, to, limit } = request.query;

        const VALID_EVENT_TYPES = new Set([
          'message', 'voice', 'image', 'command', 'ai_response',
          'error', 'memory_created', 'memory_updated', 'session_start', 'session_end',
        ] as const);
        const validatedEventType = event_type && VALID_EVENT_TYPES.has(event_type as UserLog['event_type'])
          ? event_type as UserLog['event_type']
          : undefined;

        const logs = await userLogsRepo.getByUser(userId, {
          eventType: validatedEventType,
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
        aiLogger.error({ error }, 'Get user logs error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to fetch user logs',
        });
      }
    }
  );
}
