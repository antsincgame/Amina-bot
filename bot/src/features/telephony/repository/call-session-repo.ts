import { getSupabase, settingsRepo } from '../../../db/index.js';
import type { TelephonyAiCallSession } from '../../../../../shared/types/telephony.js';
import {
  LEGACY_SESSIONS_KEY,
  cleanText,
  normalizePhone,
  safeJsonParse,
} from '../shared.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

type CreateTelephonySessionInput = Omit<TelephonyAiCallSession, 'id' | 'createdAt' | 'updatedAt'>;
const PENDING_MATCH_WINDOW_MS = 45 * 60 * 1000;

interface TelephonySessionRow {
  id: string;
  owner_telegram_id: string;
  initiated_by: string;
  scenario_id: string;
  scenario_name: string;
  scenario_goal: string;
  call_mode: TelephonyAiCallSession['callMode'];
  runtime_mode: TelephonyAiCallSession['runtimeMode'];
  policy_version: number;
  provider: TelephonyAiCallSession['provider'];
  target_phone: string;
  task: string;
  summary: string;
  success_criteria: string;
  result_prompt: string;
  request_id: string | null;
  request_mode: string;
  call_id: string | null;
  record_link: string | null;
  transcript: string | null;
  result_summary: string | null;
  outcome_label: string | null;
  status: TelephonyAiCallSession['status'];
  created_at: string;
  updated_at: string;
}

function mapRowToSession(row: TelephonySessionRow): TelephonyAiCallSession {
  return {
    id: row.id,
    ownerTelegramId: row.owner_telegram_id,
    initiatedBy: row.initiated_by,
    scenarioId: row.scenario_id,
    scenarioName: row.scenario_name,
    scenarioGoal: row.scenario_goal,
    callMode: row.call_mode,
    runtimeMode: row.runtime_mode,
    policyVersion: row.policy_version,
    provider: row.provider,
    targetPhone: row.target_phone,
    task: row.task,
    summary: row.summary,
    successCriteria: row.success_criteria,
    resultPrompt: row.result_prompt,
    requestId: row.request_id,
    requestMode: row.request_mode,
    callId: row.call_id,
    recordLink: row.record_link,
    transcript: row.transcript,
    resultSummary: row.result_summary,
    outcomeLabel: row.outcome_label,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSessionToRow(session: TelephonyAiCallSession): TelephonySessionRow {
  return {
    id: session.id,
    owner_telegram_id: session.ownerTelegramId,
    initiated_by: session.initiatedBy,
    scenario_id: session.scenarioId,
    scenario_name: session.scenarioName,
    scenario_goal: session.scenarioGoal,
    call_mode: session.callMode === 'speech' ? 'speech' : 'ask_question',
    runtime_mode: session.runtimeMode ?? 'scripted',
    policy_version: Number.isFinite(Number(session.policyVersion)) ? Number(session.policyVersion) : 1,
    provider: session.provider ?? 'unknown',
    target_phone: normalizePhone(session.targetPhone),
    task: session.task,
    summary: session.summary,
    success_criteria: session.successCriteria,
    result_prompt: session.resultPrompt,
    request_id: session.requestId,
    request_mode: session.requestMode,
    call_id: session.callId,
    record_link: session.recordLink,
    transcript: session.transcript,
    result_summary: session.resultSummary,
    outcome_label: session.outcomeLabel,
    status: session.status,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

async function importLegacySessions(): Promise<void> {
  const raw = await settingsRepo.get(LEGACY_SESSIONS_KEY);
  const parsed = raw ? safeJsonParse<TelephonyAiCallSession[]>(raw) : null;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return;
  }

  const rows = parsed.map(mapSessionToRow);
  const { error } = await getSupabase()
    .from('telephony_call_sessions')
    .upsert(rows, { onConflict: 'id' });

  if (error) {
    throw error;
  }
}

async function ensureBootstrapped(): Promise<void> {
  await ensureTelephonyInfra();

  const { count, error } = await getSupabase()
    .from('telephony_call_sessions')
    .select('*', { count: 'exact', head: true });

  if (error) {
    throw error;
  }

  if ((count ?? 0) === 0) {
    await importLegacySessions();
  }
}

export const callSessionRepo = {
  async create(input: CreateTelephonySessionInput): Promise<TelephonyAiCallSession> {
    await ensureBootstrapped();

    const now = new Date().toISOString();
    const session: TelephonyAiCallSession = {
      ...input,
      id: crypto.randomUUID(),
      targetPhone: normalizePhone(input.targetPhone),
      createdAt: now,
      updatedAt: now,
    };

    const { data, error } = await getSupabase()
      .from('telephony_call_sessions')
      .insert(mapSessionToRow(session))
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    return mapRowToSession(data as TelephonySessionRow);
  },

  async listRecent(limit = 20): Promise<TelephonyAiCallSession[]> {
    await ensureBootstrapped();

    const { data, error } = await getSupabase()
      .from('telephony_call_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return ((data as TelephonySessionRow[] | null) ?? []).map(mapRowToSession);
  },

  async getById(id: string): Promise<TelephonyAiCallSession | null> {
    await ensureBootstrapped();

    const { data, error } = await getSupabase()
      .from('telephony_call_sessions')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapRowToSession(data as TelephonySessionRow) : null;
  },

  async getByRequestId(requestId: string): Promise<TelephonyAiCallSession | null> {
    const normalized = cleanText(requestId);
    if (!normalized) {
      return null;
    }

    await ensureBootstrapped();
    const { data, error } = await getSupabase()
      .from('telephony_call_sessions')
      .select('*')
      .eq('request_id', normalized)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapRowToSession(data as TelephonySessionRow) : null;
  },

  async getByCallId(callId: string): Promise<TelephonyAiCallSession | null> {
    const normalized = cleanText(callId);
    if (!normalized) {
      return null;
    }

    await ensureBootstrapped();
    const { data, error } = await getSupabase()
      .from('telephony_call_sessions')
      .select('*')
      .eq('call_id', normalized)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapRowToSession(data as TelephonySessionRow) : null;
  },

  async findPendingByPhone(phone: string): Promise<TelephonyAiCallSession | null> {
    await ensureBootstrapped();
    const minCreatedAt = new Date(Date.now() - PENDING_MATCH_WINDOW_MS).toISOString();

    const { data, error } = await getSupabase()
      .from('telephony_call_sessions')
      .select('*')
      .eq('target_phone', normalizePhone(phone))
      .eq('status', 'initiated')
      .is('call_id', null)
      .gte('created_at', minCreatedAt)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapRowToSession(data as TelephonySessionRow) : null;
  },

  async update(id: string, updates: Partial<TelephonyAiCallSession>): Promise<TelephonyAiCallSession> {
    await ensureBootstrapped();

    const current = await this.getById(id);
    if (!current) {
      throw new Error('Сессия звонка не найдена');
    }

    const next: TelephonyAiCallSession = {
      ...current,
      ...updates,
      targetPhone: normalizePhone(updates.targetPhone ?? current.targetPhone),
      updatedAt: new Date().toISOString(),
    };

    const { data, error } = await getSupabase()
      .from('telephony_call_sessions')
      .update(mapSessionToRow(next))
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    return mapRowToSession(data as TelephonySessionRow);
  },
};
