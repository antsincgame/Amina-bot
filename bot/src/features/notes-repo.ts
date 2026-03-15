/**
 * Notes Repository — dual backend (Appwrite primary)
 */

import { config } from '../config/index.js';
import { getSupabase } from '../db/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query } from 'node-appwrite';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_notes';

export interface Note { id: string; user_id: string; content: string; created_at: string; }

const MAX_NOTES_PER_USER = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToNote(d: any): Note {
  return { id: d.$id ?? d.id, user_id: d.user_id, content: d.content, created_at: d.created_at || d.$createdAt };
}

export const notesRepo = {
  async create(userId: string, content: string): Promise<Note> {
    if (!content?.trim()) throw new Error('Текст заметки не может быть пустым');
    const count = await this.countByUser(userId);
    if (count >= MAX_NOTES_PER_USER) throw new Error(`Максимум ${MAX_NOTES_PER_USER} заметок.`);

    if (useAW()) {
      const doc = await (await getAW()).createDocument(DB_ID(), COLL, ID.unique(), {
        user_id: userId, content: content.trim(), created_at: new Date().toISOString(),
      });
      dbLogger.info({ id: doc.$id, userId }, 'Note created');
      return docToNote(doc);
    } else {
      const { data, error } = await getSupabase().from('notes').insert({ user_id: userId, content: content.trim() }).select().single();
      if (error) { dbLogger.error({ error, userId }, 'Failed to create note'); throw error; }
      dbLogger.info({ id: data.id, userId }, 'Note created');
      return data as Note;
    }
  },

  async getByUser(userId: string): Promise<Note[]> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
          Query.equal('user_id', userId), Query.orderDesc('created_at'), Query.limit(100),
        ]);
        return r.documents.map(docToNote);
      } else {
        const { data, error } = await getSupabase().from('notes').select('*').eq('user_id', userId).order('created_at', { ascending: false });
        if (error) { dbLogger.error({ error, userId }, 'Failed to get notes'); return []; }
        return (data ?? []) as Note[];
      }
    } catch { return []; }
  },

  async deleteByIndex(userId: string, index: number): Promise<Note | null> {
    const notes = await this.getByUser(userId);
    const note = notes[index - 1];
    if (!note) return null;

    try {
      if (useAW()) {
        await (await getAW()).deleteDocument(DB_ID(), COLL, note.id);
      } else {
        const { error } = await getSupabase().from('notes').delete().eq('id', note.id).eq('user_id', userId);
        if (error) { dbLogger.error({ error, id: note.id, userId }, 'Failed to delete note'); return null; }
      }
      return note;
    } catch { return null; }
  },

  async countByUser(userId: string): Promise<number> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [Query.equal('user_id', userId), Query.limit(1)]);
        return r.total;
      } else {
        const { count, error } = await getSupabase().from('notes').select('*', { count: 'exact', head: true }).eq('user_id', userId);
        if (error) { dbLogger.error({ error, userId }, 'Failed to count notes'); return 0; }
        return count ?? 0;
      }
    } catch { return 0; }
  },
};
