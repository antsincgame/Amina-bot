import { getSupabase } from '../../../db/supabase.js';
import type { TelephonyCallEvent } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

interface TelephonyCallEventRow {
  id: string;
  session_id: string;
  event_type: string;
  provider_event_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

function mapRowToEvent(row: TelephonyCallEventRow): TelephonyCallEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    providerEventId: row.provider_event_id,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  };
}

export const callEventRepo = {
  async record(
    sessionId: string,
    eventType: TelephonyCallEvent['eventType'],
    payload: Record<string, unknown> = {},
    providerEventId?: string | null,
  ): Promise<TelephonyCallEvent> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_events')
      .insert({
        session_id: sessionId,
        event_type: eventType,
        provider_event_id: providerEventId ?? null,
        payload,
      })
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    return mapRowToEvent(data as TelephonyCallEventRow);
  },

  async listBySession(sessionId: string): Promise<TelephonyCallEvent[]> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_events')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    return ((data as TelephonyCallEventRow[] | null) ?? []).map(mapRowToEvent);
  },
};
