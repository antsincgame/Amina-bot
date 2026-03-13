import { getSupabase } from '../../../db/supabase.js';
import type { TelephonyCallTurn } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

interface TelephonyCallTurnRow {
  id: string;
  session_id: string;
  turn_index: number;
  speaker: TelephonyCallTurn['speaker'];
  source: TelephonyCallTurn['source'];
  content: string;
  confidence: number | null;
  created_at: string;
}

function mapRowToTurn(row: TelephonyCallTurnRow): TelephonyCallTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    speaker: row.speaker,
    source: row.source,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

export const callTurnRepo = {
  async replaceForSession(
    sessionId: string,
    turns: Array<Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt'>>,
  ): Promise<TelephonyCallTurn[]> {
    await ensureTelephonyInfra();

    const sb = getSupabase();
    const { error: deleteError } = await sb
      .from('telephony_call_turns')
      .delete()
      .eq('session_id', sessionId);

    if (deleteError) {
      throw deleteError;
    }

    if (turns.length === 0) {
      return [];
    }

    const { data, error } = await sb
      .from('telephony_call_turns')
      .insert(
        turns.map((turn) => ({
          session_id: sessionId,
          turn_index: turn.turnIndex,
          speaker: turn.speaker,
          source: turn.source,
          content: turn.content,
          confidence: turn.confidence,
        })),
      )
      .select('*')
      .order('turn_index', { ascending: true });

    if (error) {
      throw error;
    }

    return ((data as TelephonyCallTurnRow[] | null) ?? []).map(mapRowToTurn);
  },

  async listBySession(sessionId: string): Promise<TelephonyCallTurn[]> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_turns')
      .select('*')
      .eq('session_id', sessionId)
      .order('turn_index', { ascending: true });

    if (error) {
      throw error;
    }

    return ((data as TelephonyCallTurnRow[] | null) ?? []).map(mapRowToTurn);
  },
};
