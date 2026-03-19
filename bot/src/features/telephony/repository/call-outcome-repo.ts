/**
 * Call Outcome Repository — Appwrite backend
 */

import { config } from '../../../config/index.js';

import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;
import type { TelephonyCallOutcome } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';
import { safeJsonParse } from '../shared.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_tel_outcomes';

interface TelephonyCallOutcomeRow {
  id: string;
  session_id: string;
  outcome_label: string;
  result_summary: string;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapRowToOutcome(row: TelephonyCallOutcomeRow): TelephonyCallOutcome {
  return {
    id: row.id,
    sessionId: row.session_id,
    outcomeLabel: row.outcome_label,
    resultSummary: row.result_summary,
    confidence: row.confidence,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function docToOutcome(d: AppwriteDoc): TelephonyCallOutcome {
  const metadata = typeof d.metadata === 'string' ? (safeJsonParse<Record<string, unknown>>(d.metadata) ?? {}) : (d.metadata ?? {});
  return {
    id: d.$id,
    sessionId: d.session_id,
    outcomeLabel: d.outcome_label,
    resultSummary: d.result_summary,
    confidence: d.confidence ?? null,
    metadata,
    createdAt: d.created_at || d.$createdAt,
    updatedAt: d.updated_at || d.$updatedAt,
  };
}

export const callOutcomeRepo = {
  async saveForSession(
    sessionId: string,
    outcome: Omit<TelephonyCallOutcome, 'id' | 'sessionId' | 'createdAt' | 'updatedAt'>,
  ): Promise<TelephonyCallOutcome> {
    await ensureTelephonyInfra();

    const now = new Date().toISOString();

    const aw = await getAW();
    const payload = {
      session_id: sessionId,
      outcome_label: outcome.outcomeLabel,
      result_summary: outcome.resultSummary,
      confidence: outcome.confidence ?? null,
      metadata: JSON.stringify(outcome.metadata ?? {}),
      updated_at: now,
    };

    // Unique per session_id — upsert manually
    const r = await aw.listDocuments(DB_ID(), COLL, [
      Query.equal('session_id', sessionId), Query.limit(1),
    ]);

    if (r.documents.length > 0) {
      const doc = await aw.updateDocument(DB_ID(), COLL, r.documents[0]!.$id, payload);
      return docToOutcome(doc);
    } else {
      const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), { ...payload, created_at: now });
      return docToOutcome(doc);
    }

  },

  async getBySession(sessionId: string): Promise<TelephonyCallOutcome | null> {
    await ensureTelephonyInfra();

    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [
      Query.equal('session_id', sessionId), Query.limit(1),
    ]);
    return r.documents.length > 0 ? docToOutcome(r.documents[0]!) : null;

  },
};
