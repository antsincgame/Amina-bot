import { getSupabase } from '../../../db/supabase.js';
import type { TelephonyCallOutcome } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

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

export const callOutcomeRepo = {
  async saveForSession(
    sessionId: string,
    outcome: Omit<TelephonyCallOutcome, 'id' | 'sessionId' | 'createdAt' | 'updatedAt'>,
  ): Promise<TelephonyCallOutcome> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_outcomes')
      .upsert(
        {
          session_id: sessionId,
          outcome_label: outcome.outcomeLabel,
          result_summary: outcome.resultSummary,
          confidence: outcome.confidence,
          metadata: outcome.metadata,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'session_id' },
      )
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    return mapRowToOutcome(data as TelephonyCallOutcomeRow);
  },

  async getBySession(sessionId: string): Promise<TelephonyCallOutcome | null> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_outcomes')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapRowToOutcome(data as TelephonyCallOutcomeRow) : null;
  },
};
