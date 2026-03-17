/**
 * Call Job Repository — Appwrite backend
 */

import { config } from '../../../config/index.js';

import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;
import type { TelephonyCallJob } from '../../../../../shared/types/telephony.js';
import { cleanText } from '../shared.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_tel_jobs';

const RETRY_BASE_DELAY_MS = 30_000;

interface TelephonyCallJobRow {
  id: string;
  session_id: string;
  job_type: TelephonyCallJob['jobType'];
  status: TelephonyCallJob['status'];
  dedupe_key: string;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_at: string | null;
  payload: Record<string, unknown> | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapRowToJob(row: TelephonyCallJobRow): TelephonyCallJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobType: row.job_type,
    status: row.status,
    dedupeKey: row.dedupe_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    lockedAt: row.locked_at,
    payload: row.payload ?? {},
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function docToJob(d: AppwriteDoc): TelephonyCallJob {
  const payload = typeof d.payload === 'string' ? (JSON.parse(d.payload || '{}')) : (d.payload ?? {});
  return {
    id: d.$id,
    sessionId: d.session_id,
    jobType: d.job_type,
    status: d.status,
    dedupeKey: d.dedupe_key,
    attempts: d.attempts ?? 0,
    maxAttempts: d.max_attempts ?? 5,
    nextRunAt: d.next_run_at || d.$createdAt,
    lockedAt: d.locked_at || null,
    payload,
    lastError: d.last_error || null,
    createdAt: d.created_at || d.$createdAt,
    updatedAt: d.updated_at || d.$updatedAt,
  };
}

function buildNextRunAt(attempts: number): string {
  const delayMs = RETRY_BASE_DELAY_MS * Math.max(1, attempts);
  return new Date(Date.now() + delayMs).toISOString();
}

export const callJobRepo = {
  async enqueueUnique(
    sessionId: string,
    jobType: TelephonyCallJob['jobType'],
    dedupeKey: string,
    payload: Record<string, unknown>,
    maxAttempts = 5,
  ): Promise<TelephonyCallJob> {
    await ensureTelephonyInfra();
    const cleanDedupeKey = cleanText(dedupeKey);
    const now = new Date().toISOString();

    const aw = await getAW();

    // Check for existing by dedupe_key (unique index)
    const existing = await aw.listDocuments(DB_ID(), COLL, [
      Query.equal('dedupe_key', cleanDedupeKey), Query.limit(1),
    ]);

    if (existing.documents.length > 0) {
      return docToJob(existing.documents[0]!);
    }

    const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), {
      session_id: sessionId,
      job_type: jobType,
      status: 'pending',
      dedupe_key: cleanDedupeKey,
      attempts: 0,
      max_attempts: maxAttempts,
      next_run_at: now,
      locked_at: null,
      payload: JSON.stringify(payload),
      last_error: null,
      created_at: now,
      updated_at: now,
    });
    return docToJob(doc);

  },

  async reserveDueJobs(
    jobType: TelephonyCallJob['jobType'],
    limit = 5,
  ): Promise<TelephonyCallJob[]> {
    await ensureTelephonyInfra();
    const nowIso = new Date().toISOString();

    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [
      Query.equal('job_type', jobType),
      Query.equal('status', 'pending'),
      Query.lessThanEqual('next_run_at', nowIso),
      Query.orderAsc('next_run_at'),
      Query.limit(limit),
    ]);

    const reserved: TelephonyCallJob[] = [];
    for (const doc of r.documents) {
      try {
        // Optimistic lock: update only if still pending
        const fresh = await aw.getDocument(DB_ID(), COLL, doc.$id);
        if (fresh.status !== 'pending') continue;

        const updated = await aw.updateDocument(DB_ID(), COLL, doc.$id, {
          status: 'processing',
          attempts: (fresh.attempts ?? 0) + 1,
          locked_at: nowIso,
          updated_at: nowIso,
        });
        reserved.push(docToJob(updated));
      } catch {
        // Skip if already taken
      }
    }
    return reserved;

  },

  async markCompleted(id: string): Promise<void> {
    await ensureTelephonyInfra();

    await (await getAW()).updateDocument(DB_ID(), COLL, id, {
      status: 'completed',
      locked_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    });

  },

  async markFailed(job: TelephonyCallJob, errorMessage: string): Promise<void> {
    await ensureTelephonyInfra();

    const terminal = job.attempts >= job.maxAttempts;

    await (await getAW()).updateDocument(DB_ID(), COLL, job.id, {
      status: terminal ? 'failed' : 'pending',
      locked_at: null,
      last_error: cleanText(errorMessage),
      next_run_at: terminal ? job.nextRunAt : buildNextRunAt(job.attempts),
      updated_at: new Date().toISOString(),
    });

  },
};
