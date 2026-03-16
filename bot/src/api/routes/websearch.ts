import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { aiLogger } from '../../config/logger.js';
import { getSearchModelInfo, getAvailableModels, isWebSearchEnabled } from '../../ai/websearch.js';

export async function registerWebsearchRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/websearch/info
   * Get current web search model info and pricing
   */
  server.get('/websearch/info', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const modelInfo = await getSearchModelInfo();
      const enabled = await isWebSearchEnabled();
      const allModels = getAvailableModels();

      return reply.code(200).send({
        success: true,
        data: {
          enabled,
          currentModel: modelInfo,
          availableModels: allModels.map(m => ({
            id: m.id,
            name: m.name,
            priceInput: m.inputPrice,
            priceOutput: m.outputPrice,
            requestFee: m.requestFee,
            hasInternet: m.online,
          })),
          note: 'Автоматически используется самая дешёвая online-модель',
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Get websearch info error');
      return reply.code(500).send({
        success: false,
        error: 'Failed to get websearch info',
      });
    }
  });
}
