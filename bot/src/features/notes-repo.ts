/**
 * Notes Repository — Appwrite backend
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query, type Models } from 'node-appwrite';
import { getNotesSoftArchiveMap } from './notes-soft-archive.js';

type AppwriteDoc = Models.Document & Record<string, unknown>;

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_notes';

export interface Note { id: string; user_id: string; content: string; created_at: string; }

const MAX_NOTES_PER_USER = 100;

function docToNote(d: AppwriteDoc): Note {
  return { id: d.$id ?? d.id, user_id: d.user_id as string, content: d.content as string, created_at: (d.created_at || d.$createdAt) as string };
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
      const [r, archiveMap] = await Promise.all([
        (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.orderDesc('created_at'), Query.limit(100),
        ]),
        getNotesSoftArchiveMap(),
      ]);
      return r.documents.map(docToNote).filter((note) => !archiveMap.has(note.id));
    } catch (error) {
      dbLogger.warn({ error, userId }, 'Failed to load notes for user');
      return [];
    }
  },

  async listRecent(limit = 100, offset = 0, options: { includeArchived?: boolean } = {}): Promise<Note[]> {
    try {
      const [r, archiveMap] = await Promise.all([
        (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.orderDesc('created_at'),
        Query.limit(limit),
        Query.offset(offset),
        ]),
        getNotesSoftArchiveMap(),
      ]);
      const notes = r.documents.map(docToNote);
      return options.includeArchived ? notes : notes.filter((note) => !archiveMap.has(note.id));
    } catch (error) {
      dbLogger.warn({ error, limit, offset }, 'Failed to list recent notes');
      return [];
    }
  },

  async getById(noteId: string): Promise<Note | null> {
    try {
      const doc = await (await getAW()).getDocument(DB_ID(), COLL, noteId);
      return docToNote(doc);
    } catch (error) {
      dbLogger.warn({ error, noteId }, 'Failed to load note by id');
      return null;
    }
  },

  async deleteByIndex(userId: string, index: number): Promise<Note | null> {
    const notes = await this.getByUser(userId);
    const note = notes[index - 1];
    if (!note) return null;

    try {
      await (await getAW()).deleteDocument(DB_ID(), COLL, note.id);
      return note;
    } catch (error) {
      dbLogger.warn({ error, userId, noteId: note.id }, 'Failed to delete note by index');
      return null;
    }
  },

  async countByUser(userId: string): Promise<number> {
    try {
      const [r, archiveMap] = await Promise.all([
        (await getAW()).listDocuments(DB_ID(), COLL, [Query.equal('user_id', userId), Query.limit(100)]),
        getNotesSoftArchiveMap(),
      ]);
      return r.documents.map(docToNote).filter((note) => !archiveMap.has(note.id)).length;
    } catch (error) {
      dbLogger.warn({ error, userId }, 'Failed to count notes for user');
      return 0;
    }
  },
};
