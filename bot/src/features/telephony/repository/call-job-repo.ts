import { getSupabase } from '../../../db/index.js';
import type { TelephonyCallJob } from '../../../../../shared/types/telephony.js';
import { cleanText } from '../shared.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

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
    const sb = getSupabase();
    const insertPayload = {
      session_id: sessionId,
      job_type: jobType,
      status: 'pending',
      dedupe_key: cleanDedupeKey,
      attempts: 0,
      max_attempts: maxAttempts,
      next_run_at: new Date().toISOString(),
      payload,
      locked_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await sb
      .from('telephony_call_jobs')
      .insert(insertPayload)
      .select('*')
      .single();

    if (!error) {
      return mapRowToJob(data as TelephonyCallJobRow);
    }

    if (error.code !== '23505') {
      throw error;
    }

    const { data: existing, error: existingError } = await sb
      .from('telephony_call_jobs')
      .select('*')
      .eq('dedupe_key', cleanDedupeKey)
      .single();

    if (existingError) {
      throw existingError;
    }

    return mapRowToJob(existing as TelephonyCallJobRow);
  },

  async reserveDueJobs(
    jobType: TelephonyCallJob['jobType'],
    limit = 5,
  ): Promise<TelephonyCallJob[]> {
    await ensureTelephonyInfra();

    const nowIso = new Date().toISOString();
    const { data, error } = await getSupabase()
      .from('telephony_call_jobs')
      .select('*')
      .eq('job_type', jobType)
      .eq('status', 'pending')
      .lte('next_run_at', nowIso)
      .order('next_run_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw error;
    }

    const candidates = ((data as TelephonyCallJobRow[] | null) ?? []).map(mapRowToJob);
    const reserved: TelephonyCallJob[] = [];

    for (const candidate of candidates) {
      const { data: reservedRow, error: reserveError } = await getSupabase()
        .from('telephony_call_jobs')
        .update({
          status: 'processing',
          attempts: candidate.attempts + 1,
          locked_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', candidate.id)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle();

      if (reserveError) {
        throw reserveError;
      }

      if (reservedRow) {
        reserved.push(mapRowToJob(reservedRow as TelephonyCallJobRow));
      }
    }

    return reserved;
  },

  async markCompleted(id: string): Promise<void> {
    await ensureTelephonyInfra();

    const { error } = await getSupabase()
      .from('telephony_call_jobs')
      .update({
        status: 'completed',
        locked_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      throw error;
    }
  },

  async markFailed(job: TelephonyCallJob, errorMessage: string): Promise<void> {
    await ensureTelephonyInfra();

    const terminal = job.attempts >= job.maxAttempts;
    const { error } = await getSupabase()
      .from('telephony_call_jobs')
      .update({
        status: terminal ? 'failed' : 'pending',
        locked_at: null,
        last_error: cleanText(errorMessage),
        next_run_at: terminal ? job.nextRunAt : buildNextRunAt(job.attempts),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    if (error) {
      throw error;
    }
  },
};
