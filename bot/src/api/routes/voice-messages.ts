import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { aiLogger } from '../../config/logger.js';
import { voiceMessagesRepo } from '../../features/voice-messages-repo.js';
import archiver from 'archiver';

export async function registerVoiceMessagesRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/voice-messages
   */
  server.get(
    '/voice-messages',
    async (
      request: FastifyRequest<{
        Querystring: { userId?: string; dateFrom?: string; dateTo?: string; limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { userId, dateFrom, dateTo, limit, offset } = request.query as {
          userId?: string; dateFrom?: string; dateTo?: string; limit?: string; offset?: string;
        };

        // parseInt('abc', 10) → NaN, и NaN утечёт в Appwrite Query, что валит запрос с
        // непонятной ошибкой. Используем Number.isFinite + дефолт + clamp.
        const parseIntSafe = (raw: string | undefined, fallback: number, min: number, max: number): number => {
          if (!raw) return fallback;
          const parsed = Number.parseInt(raw, 10);
          if (!Number.isFinite(parsed)) return fallback;
          return Math.min(Math.max(parsed, min), max);
        };

        const result = await voiceMessagesRepo.list({
          userId,
          dateFrom,
          dateTo,
          limit: parseIntSafe(limit, 50, 1, 500),
          offset: parseIntSafe(offset, 0, 0, 1_000_000),
        });

        return reply.code(200).send({ success: true, data: result.data, total: result.total });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error: msg }, 'Failed to list voice messages');
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  /**
   * GET /api/voice-messages/stats
   */
  server.get(
    '/voice-messages/stats',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const stats = await voiceMessagesRepo.stats();
        return reply.code(200).send({ success: true, data: stats });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  /**
   * GET /api/voice-messages/:id/download
   */
  server.get(
    '/voice-messages/:id/download',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params as { id: string };
        const record = await voiceMessagesRepo.getById(id);
        if (!record) {
          return reply.code(404).send({ success: false, error: 'Voice message not found' });
        }

        const fileBuffer = await voiceMessagesRepo.downloadFile(record.file_path);
        if (!fileBuffer) {
          return reply.code(500).send({ success: false, error: 'Failed to load voice message file' });
        }

        const safeFileName = `voice_${record.user_id}_${record.duration}s.ogg`;
        reply.header('Content-Type', 'audio/ogg');
        reply.header('Content-Length', String(fileBuffer.length));
        reply.header('Content-Disposition', `inline; filename="${safeFileName}"`);
        return reply.code(200).send(fileBuffer);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  /**
   * POST /api/voice-messages/archive
   */
  server.post(
    '/voice-messages/archive',
    async (
      request: FastifyRequest<{
        Body: { userId?: string; dateFrom?: string; dateTo?: string; limit?: number };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { userId, dateFrom, dateTo, limit } = (request.body ?? {}) as {
          userId?: string; dateFrom?: string; dateTo?: string; limit?: number;
        };

        const safeLim = Math.min(limit ?? 100, 100);

        const records = await voiceMessagesRepo.getFiltered({
          userId,
          dateFrom,
          dateTo,
          limit: safeLim,
        });

        if (records.length === 0) {
          return reply.code(404).send({ success: false, error: 'No voice messages found' });
        }

        // Stream ZIP archive
        reply.raw.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="voice-messages-${new Date().toISOString().slice(0, 10)}.zip"`,
        });

        const archive = archiver('zip', { zlib: { level: 5 } });
        archive.pipe(reply.raw);

        // Download each file and add to archive
        for (const record of records) {
          const fileBuffer = await voiceMessagesRepo.downloadFile(record.file_path);
          if (fileBuffer) {
            const date = new Date(record.created_at).toISOString().slice(0, 10);
            const fileName = `${date}_user${record.user_id}_${record.duration}s.ogg`;
            archive.append(fileBuffer, { name: fileName });
          }
        }

        // Add metadata CSV
        const csv = [
          'id,user_id,duration_sec,file_size_bytes,transcription,created_at',
          ...records.map(r =>
            `${r.id},${r.user_id},${r.duration},${r.file_size},"${(r.transcription ?? '').replace(/"/g, '""')}",${r.created_at}`
          ),
        ].join('\n');
        archive.append(csv, { name: 'metadata.csv' });

        await archive.finalize();

        aiLogger.info({ count: records.length, userId, dateFrom, dateTo }, 'Voice messages archive created');
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error: msg }, 'Failed to create voice archive');
        // If headers not sent yet
        if (!reply.raw.headersSent) {
          return reply.code(500).send({ success: false, error: msg });
        }
      }
    },
  );
}
