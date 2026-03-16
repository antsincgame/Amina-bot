/**
 * Call Session Repository — Appwrite backend
 */

import { config } from '../../../config/index.js';
import { settingsRepo } from '../../../db/index.js';
import { ID, Query } from 'node-appwrite';
import type { TelephonyAiCallSession } from '../../../../../shared/types/telephony.js';
import {
  LEGACY_SESSIONS_KEY,
  cleanText,
  normalizePhone,
  safeJsonParse,
} from '../shared.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_tel_sessions';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToSession(d: any): TelephonyAiCallSession {
  return {
    id: d.$id,
    ownerTelegramId: d.owner_telegram_id,
    initiatedBy: d.initiated_by,
    scenarioId: d.scenario_id,
    scenarioName: d.scenario_name ?? '',
    scenarioGoal: d.scenario_goal ?? '',
    callMode: d.call_mode,
    runtimeMode: d.runtime_mode ?? 'scripted',
    policyVersion: d.policy_version ?? 1,
    provider: d.provider ?? 'unknown',
    targetPhone: d.target_phone,
    task: d.task ?? '',
    summary: d.summary ?? '',
    successCriteria: d.success_criteria ?? '',
    resultPrompt: d.result_prompt ?? '',
    requestId: d.request_id || null,
    requestMode: d.request_mode ?? '',
    callId: d.call_id || null,
    recordLink: d.record_link || null,
    transcript: d.transcript || null,
    resultSummary: d.result_summary || null,
    outcomeLabel: d.outcome_label || null,
    status: d.status,
    createdAt: d.created_at || d.$createdAt,
    updatedAt: d.updated_at || d.$updatedAt,
  };
}

function sessionToAwDoc(session: TelephonyAiCallSession) {
  return {
    owner_telegram_id: session.ownerTelegramId,
    initiated_by: session.initiatedBy,
    scenario_id: session.scenarioId,
    scenario_name: session.scenarioName ?? '',
    scenario_goal: session.scenarioGoal ?? '',
    call_mode: session.callMode === 'speech' ? 'speech' : 'ask_question',
    runtime_mode: session.runtimeMode ?? 'scripted',
    policy_version: Number.isFinite(Number(session.policyVersion)) ? Number(session.policyVersion) : 1,
    provider: session.provider ?? 'unknown',
    target_phone: normalizePhone(session.targetPhone),
    task: session.task ?? '',
    summary: session.summary ?? '',
    success_criteria: session.successCriteria ?? '',
    result_prompt: session.resultPrompt ?? '',
    request_id: session.requestId || null,
    request_mode: session.requestMode ?? '',
    call_id: session.callId || null,
    record_link: session.recordLink || null,
    transcript: session.transcript || null,
    result_summary: session.resultSummary || null,
    outcome_label: session.outcomeLabel || null,
    status: session.status,
    created_at: session.createdAt || new Date().toISOString(),
    updated_at: session.updatedAt || new Date().toISOString(),
  };
}

async function importLegacySessions(): Promise<void> {
  const raw = await settingsRepo.get(LEGACY_SESSIONS_KEY);
  const parsed = raw ? safeJsonParse<TelephonyAiCallSession[]>(raw) : null;
  if (!Array.isArray(parsed) || parsed.length === 0) return;

  const aw = await getAW();
  for (const session of parsed) {
    const doc = sessionToAwDoc(session);
    await aw.createDocument(DB_ID(), COLL, ID.unique(), doc);
  }

}

let bootstrapped = false;
async function ensureBootstrapped(): Promise<void> {
  await ensureTelephonyInfra();
  if (bootstrapped) return;

  const aw = await getAW();
  const r = await aw.listDocuments(DB_ID(), COLL, [Query.limit(1)]);
  if (r.total === 0) await importLegacySessions();

  bootstrapped = true;
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

    const aw = await getAW();
    const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), sessionToAwDoc(session));
    return docToSession(doc);

  },

  async listRecent(limit = 20): Promise<TelephonyAiCallSession[]> {
    await ensureBootstrapped();

    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [
      Query.orderDesc('created_at'), Query.limit(limit),
    ]);
    return r.documents.map(docToSession);

  },

  async getById(id: string): Promise<TelephonyAiCallSession | null> {
    await ensureBootstrapped();

    try {
      const doc = await (await getAW()).getDocument(DB_ID(), COLL, id);
      return docToSession(doc);
    } catch { return null; }

  },

  async getByRequestId(requestId: string): Promise<TelephonyAiCallSession | null> {
    const normalized = cleanText(requestId);
    if (!normalized) return null;
    await ensureBootstrapped();

    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [
      Query.equal('request_id', normalized), Query.limit(1),
    ]);
    return r.documents.length > 0 ? docToSession(r.documents[0]) : null;

  },

  async getByCallId(callId: string): Promise<TelephonyAiCallSession | null> {
    const normalized = cleanText(callId);
    if (!normalized) return null;
    await ensureBootstrapped();

    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [
      Query.equal('call_id', normalized), Query.limit(1),
    ]);
    return r.documents.length > 0 ? docToSession(r.documents[0]) : null;

  },

  async findPendingByPhone(phone: string): Promise<TelephonyAiCallSession | null> {
    await ensureBootstrapped();
    const minCreatedAt = new Date(Date.now() - PENDING_MATCH_WINDOW_MS).toISOString();

    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [
      Query.equal('target_phone', normalizePhone(phone)),
      Query.equal('status', 'initiated'),
      Query.isNull('call_id'),
      Query.greaterThanEqual('created_at', minCreatedAt),
      Query.orderDesc('created_at'),
      Query.limit(1),
    ]);
    return r.documents.length > 0 ? docToSession(r.documents[0]) : null;

  },

  async update(id: string, updates: Partial<TelephonyAiCallSession>): Promise<TelephonyAiCallSession> {
    await ensureBootstrapped();

    const current = await this.getById(id);
    if (!current) throw new Error('Сессия звонка не найдена');

    const next: TelephonyAiCallSession = {
      ...current,
      ...updates,
      targetPhone: normalizePhone(updates.targetPhone ?? current.targetPhone),
      updatedAt: new Date().toISOString(),
    };

    const aw = await getAW();
    const doc = await aw.updateDocument(DB_ID(), COLL, id, sessionToAwDoc(next));
    return docToSession(doc);

  },
};
