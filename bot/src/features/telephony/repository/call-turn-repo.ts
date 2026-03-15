/**
 * Call Turn Repository — dual backend (Appwrite primary)
 */

import { config } from '../../../config/index.js';
import { getSupabase } from '../../../db/index.js';
import { ID, Query } from 'node-appwrite';
import type { TelephonyCallTurn } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_tel_turns';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToTurn(d: any): TelephonyCallTurn {
  return {
    id: d.$id,
    sessionId: d.session_id,
    turnIndex: d.turn_index,
    speaker: d.speaker,
    source: d.source,
    content: d.content,
    confidence: d.confidence ?? null,
    createdAt: d.created_at || d.$createdAt,
  };
}

export const callTurnRepo = {
  async replaceForSession(
    sessionId: string,
    turns: Array<Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt'>>,
  ): Promise<TelephonyCallTurn[]> {
    await ensureTelephonyInfra();

    if (useAW()) {
      const aw = await getAW();
      // Delete existing turns for session
      let offset = 0;
      while (true) {
        const existing = await aw.listDocuments(DB_ID(), COLL, [
          Query.equal('session_id', sessionId), Query.limit(100), Query.offset(offset),
        ]);
        if (existing.documents.length === 0) break;
        for (const doc of existing.documents) {
          await aw.deleteDocument(DB_ID(), COLL, doc.$id);
        }
        if (existing.documents.length < 100) break;
      }

      if (turns.length === 0) return [];

      const now = new Date().toISOString();
      const results: TelephonyCallTurn[] = [];
      for (const turn of turns) {
        const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), {
          session_id: sessionId,
          turn_index: turn.turnIndex,
          speaker: turn.speaker,
          source: turn.source,
          content: turn.content,
          confidence: turn.confidence ?? null,
          created_at: now,
        });
        results.push(docToTurn(doc));
      }
      return results.sort((a, b) => a.turnIndex - b.turnIndex);
    } else {
      const sb = getSupabase();
      const { error: deleteError } = await sb
        .from('telephony_call_turns')
        .delete()
        .eq('session_id', sessionId);
      if (deleteError) throw deleteError;

      if (turns.length === 0) return [];

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
      if (error) throw error;
      return ((data as TelephonyCallTurnRow[] | null) ?? []).map(mapRowToTurn);
    }
  },

  async listBySession(sessionId: string): Promise<TelephonyCallTurn[]> {
    await ensureTelephonyInfra();

    if (useAW()) {
      const aw = await getAW();
      const all: TelephonyCallTurn[] = [];
      let offset = 0;
      while (true) {
        const r = await aw.listDocuments(DB_ID(), COLL, [
          Query.equal('session_id', sessionId),
          Query.orderAsc('turn_index'),
          Query.limit(100),
          Query.offset(offset),
        ]);
        all.push(...r.documents.map(docToTurn));
        if (r.documents.length < 100) break;
        offset += 100;
      }
      return all;
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_turns')
        .select('*')
        .eq('session_id', sessionId)
        .order('turn_index', { ascending: true });
      if (error) throw error;
      return ((data as TelephonyCallTurnRow[] | null) ?? []).map(mapRowToTurn);
    }
  },

  async getNextTurnIndex(sessionId: string): Promise<number> {
    const turns = await this.listBySession(sessionId);
    const lastTurn = turns.at(-1);
    return lastTurn ? lastTurn.turnIndex + 1 : 1;
  },

  async appendForSession(
    sessionId: string,
    turn: Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt' | 'turnIndex'> & { turnIndex?: number },
  ): Promise<TelephonyCallTurn> {
    await ensureTelephonyInfra();

    const turnIndex = Number.isFinite(turn.turnIndex) && Number(turn.turnIndex) > 0
      ? Number(turn.turnIndex)
      : await this.getNextTurnIndex(sessionId);

    if (useAW()) {
      const aw = await getAW();
      const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), {
        session_id: sessionId,
        turn_index: turnIndex,
        speaker: turn.speaker,
        source: turn.source,
        content: turn.content,
        confidence: turn.confidence ?? null,
        created_at: new Date().toISOString(),
      });
      return docToTurn(doc);
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_turns')
        .insert({
          session_id: sessionId,
          turn_index: turnIndex,
          speaker: turn.speaker,
          source: turn.source,
          content: turn.content,
          confidence: turn.confidence,
        })
        .select('*')
        .single();
      if (error) throw error;
      return mapRowToTurn(data as TelephonyCallTurnRow);
    }
  },

  async upsertForSession(
    sessionId: string,
    turn: Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt'>,
  ): Promise<TelephonyCallTurn> {
    await ensureTelephonyInfra();

    if (useAW()) {
      const aw = await getAW();
      // Find existing by session_id + turn_index
      const r = await aw.listDocuments(DB_ID(), COLL, [
        Query.equal('session_id', sessionId),
        Query.equal('turn_index', turn.turnIndex),
        Query.limit(1),
      ]);

      const payload = {
        session_id: sessionId,
        turn_index: turn.turnIndex,
        speaker: turn.speaker,
        source: turn.source,
        content: turn.content,
        confidence: turn.confidence ?? null,
        created_at: new Date().toISOString(),
      };

      if (r.documents.length > 0) {
        const doc = await aw.updateDocument(DB_ID(), COLL, r.documents[0]!.$id, payload);
        return docToTurn(doc);
      } else {
        const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), payload);
        return docToTurn(doc);
      }
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_turns')
        .upsert({
          session_id: sessionId,
          turn_index: turn.turnIndex,
          speaker: turn.speaker,
          source: turn.source,
          content: turn.content,
          confidence: turn.confidence,
        }, { onConflict: 'session_id,turn_index' })
        .select('*')
        .single();
      if (error) throw error;
      return mapRowToTurn(data as TelephonyCallTurnRow);
    }
  },
};
