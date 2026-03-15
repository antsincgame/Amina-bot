/**
 * Call Outcome Repository — dual backend (Supabase + Appwrite)
 */

import { config } from '../../../config/index.js';
import { getSupabase } from '../../../db/index.js';
import { ID, Query } from 'node-appwrite';
import type { TelephonyCallOutcome } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToOutcome(d: any): TelephonyCallOutcome {
  const metadata = typeof d.metadata === 'string' ? (JSON.parse(d.metadata || '{}')) : (d.metadata ?? {});
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

    if (useAW()) {
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
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_outcomes')
        .upsert(
          {
            session_id: sessionId,
            outcome_label: outcome.outcomeLabel,
            result_summary: outcome.resultSummary,
            confidence: outcome.confidence,
            metadata: outcome.metadata,
            updated_at: now,
          },
          { onConflict: 'session_id' },
        )
        .select('*')
        .single();
      if (error) throw error;
      return mapRowToOutcome(data as TelephonyCallOutcomeRow);
    }
  },

  async getBySession(sessionId: string): Promise<TelephonyCallOutcome | null> {
    await ensureTelephonyInfra();

    if (useAW()) {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL, [
        Query.equal('session_id', sessionId), Query.limit(1),
      ]);
      return r.documents.length > 0 ? docToOutcome(r.documents[0]) : null;
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_outcomes')
        .select('*')
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapRowToOutcome(data as TelephonyCallOutcomeRow) : null;
    }
  },
};
