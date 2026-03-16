/**
 * Notes Repository — Appwrite backend
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query } from 'node-appwrite';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
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

    const doc = await (await getAW()).createDocument(DB_ID(), COLL, ID.unique(), {
      user_id: userId, content: content.trim(), created_at: new Date().toISOString(),
    });
    dbLogger.info({ id: doc.$id, userId }, 'Note created');
    return docToNote(doc);
  },

  async getByUser(userId: string): Promise<Note[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.orderDesc('created_at'), Query.limit(100),
      ]);
      return r.documents.map(docToNote);
    } catch { return []; }
  },

  async deleteByIndex(userId: string, index: number): Promise<Note | null> {
    const notes = await this.getByUser(userId);
    const note = notes[index - 1];
    if (!note) return null;

    try {
      await (await getAW()).deleteDocument(DB_ID(), COLL, note.id);
      return note;
    } catch { return null; }
  },

  async countByUser(userId: string): Promise<number> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [Query.equal('user_id', userId), Query.limit(1)]);
      return r.total;
    } catch { return 0; }
  },
};
