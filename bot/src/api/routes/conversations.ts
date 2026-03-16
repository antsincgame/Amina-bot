import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { conversationsRepo } from '../../db/index.js';
import { aiLogger } from '../../config/logger.js';

export async function registerConversationsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/conversations/:conversationId
   * Get conversation history
   */
  server.get(
    '/conversations/:conversationId',
    async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply: FastifyReply) => {
      try {
        const { conversationId } = request.params;

        const conversation = await conversationsRepo.get(conversationId);

        return reply.code(200).send({
          success: true,
          data: conversation,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Get conversation error');
        return reply.code(404).send({
          success: false,
          error: 'Conversation not found',
        });
      }
    }
  );

  /**
   * DELETE /api/conversations/:conversationId
   * Clear conversation history (reset context)
   */
  server.delete(
    '/conversations/:conversationId',
    async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply: FastifyReply) => {
      try {
        const { conversationId } = request.params;

        await conversationsRepo.clearMessages(conversationId);

        aiLogger.info({ conversationId }, 'Conversation cleared');

        return reply.code(200).send({
          success: true,
          message: 'Conversation cleared successfully',
        });
      } catch (error) {
        aiLogger.error({ error }, 'Clear conversation error');
        return reply.code(500).send({
          success: false,
          error: 'Failed to clear conversation',
        });
      }
    }
  );
}
