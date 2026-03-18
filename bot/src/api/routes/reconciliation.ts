import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ReconciliationApplyContract } from '../../../../shared/types/index.js';
import {
  applyNotesSoftArchiveBatch,
  getNotesReconciliationDetail,
  listNotesReconciliation,
  previewNotesReconciliationBatch,
} from '../../features/reconciliation/notes-reconciliation.js';
import { requireAdminAuth } from './middleware.js';
import {
  getTelephonyReconciliationDetail,
  listTelephonyReconciliation,
  previewTelephonyReconciliationBatch,
} from '../../features/reconciliation/telephony-reconciliation.js';

interface BatchPreviewBody {
  ids?: string[];
}

interface NotesApplyBody extends BatchPreviewBody {
  snapshotToken?: string;
  approvalNote?: string;
}

function readIds(body: BatchPreviewBody | undefined): string[] {
  return Array.isArray(body?.ids)
    ? body.ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

const APPLY_CONTRACT: ReconciliationApplyContract = {
  previewOnly: true,
  approvalRequired: true,
  staleCheck: 'approve stage must reject stale records when preview snapshot no longer matches latest updatedAt/detail state',
  auditTrail: [
    'batch_id with requested ids',
    'approved_by and approval_note',
    'preview snapshot hash or updatedAt guard',
    'per-record apply result',
  ],
  telephonyAllowedActions: [
    'link exact historical match by requestId/callId',
    'enrich missing fields without overwriting confirmed transcript/turns/outcome',
  ],
  notesAllowedActions: [
    'keep',
    'soft_archive obvious artifact after owner approval',
    'leave uncertain notes untouched',
  ],
};

export async function registerReconciliationRoutes(server: FastifyInstance): Promise<void> {
  server.get('/reconciliation/contract', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ success: true, data: APPLY_CONTRACT });
  });

  server.get(
    '/reconciliation/telephony',
    async (
      request: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 100;
        return reply.code(200).send({ success: true, data: await listTelephonyReconciliation(limit) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: message });
      }
    },
  );

  server.get(
    '/reconciliation/telephony/:sessionId',
    async (
      request: FastifyRequest<{ Params: { sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const detail = await getTelephonyReconciliationDetail(request.params.sessionId);
        if (!detail) {
          return reply.code(404).send({ success: false, error: 'Session not found' });
        }
        return reply.code(200).send({ success: true, data: detail });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: message });
      }
    },
  );

  server.post(
    '/reconciliation/telephony/batches/preview',
    async (
      request: FastifyRequest<{ Body: BatchPreviewBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const ids = readIds(request.body);
        return reply.code(200).send({
          success: true,
          data: await previewTelephonyReconciliationBatch(ids),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: message });
      }
    },
  );

  server.get(
    '/reconciliation/notes',
    async (
      request: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 120;
        return reply.code(200).send({ success: true, data: await listNotesReconciliation(limit) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: message });
      }
    },
  );

  server.get(
    '/reconciliation/notes/:noteId',
    async (
      request: FastifyRequest<{ Params: { noteId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const detail = await getNotesReconciliationDetail(request.params.noteId);
        if (!detail) {
          return reply.code(404).send({ success: false, error: 'Note not found' });
        }
        return reply.code(200).send({ success: true, data: detail });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: message });
      }
    },
  );

  server.post(
    '/reconciliation/notes/batches/preview',
    async (
      request: FastifyRequest<{ Body: BatchPreviewBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const ids = readIds(request.body);
        return reply.code(200).send({
          success: true,
          data: await previewNotesReconciliationBatch(ids),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: message });
      }
    },
  );

  server.post(
    '/reconciliation/notes/batches/apply',
    async (
      request: FastifyRequest<{ Body: NotesApplyBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const ids = readIds(request.body);
        const snapshotToken = typeof request.body.snapshotToken === 'string' ? request.body.snapshotToken.trim() : '';
        const approvalNote = typeof request.body.approvalNote === 'string' ? request.body.approvalNote.trim() : '';

        if (!snapshotToken) {
          return reply.code(400).send({ success: false, error: 'snapshotToken is required' });
        }
        if (!approvalNote) {
          return reply.code(400).send({ success: false, error: 'approvalNote is required' });
        }

        return reply.code(200).send({
          success: true,
          data: await applyNotesSoftArchiveBatch({
            noteIds: ids,
            snapshotToken,
            approvedBy: admin.email ?? admin.userId,
            approvalNote,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: message });
      }
    },
  );
}
