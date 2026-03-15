/**
 * Call Event Repository — dual backend (Supabase + Appwrite)
 */

import { config } from '../../../config/index.js';
import { getSupabase } from '../../../db/index.js';
import { ID, Query } from 'node-appwrite';
import type { TelephonyCallEvent } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_tel_events';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToEvent(d: any): TelephonyCallEvent {
  const payload = typeof d.payload === 'string' ? (JSON.parse(d.payload || '{}')) : (d.payload ?? {});
  return {
    id: d.$id,
    sessionId: d.session_id,
    eventType: d.event_type,
    providerEventId: d.provider_event_id || null,
    payload,
    createdAt: d.created_at || d.$createdAt,
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

    if (useAW()) {
      const aw = await getAW();
      const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), {
        session_id: sessionId,
        event_type: eventType,
        provider_event_id: providerEventId ?? null,
        payload: JSON.stringify(payload),
        created_at: new Date().toISOString(),
      });
      return docToEvent(doc);
    } else {
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
      if (error) throw error;
      return mapRowToEvent(data as TelephonyCallEventRow);
    }
  },

  async listBySession(sessionId: string): Promise<TelephonyCallEvent[]> {
    await ensureTelephonyInfra();

    if (useAW()) {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL, [
        Query.equal('session_id', sessionId),
        Query.orderAsc('created_at'),
        Query.limit(100),
      ]);
      return r.documents.map(docToEvent);
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_events')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return ((data as TelephonyCallEventRow[] | null) ?? []).map(mapRowToEvent);
    }
  },
};
