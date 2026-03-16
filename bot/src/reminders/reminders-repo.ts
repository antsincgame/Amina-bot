/**
 * Reminders Repository — Appwrite backend
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query } from 'node-appwrite';
import type { Reminder } from '../../../shared/types/index.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_reminders';

const MAX_REMINDERS_PER_USER = 20;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToReminder(d: any): Reminder {
  return { id: d.$id ?? d.id, user_id: d.user_id, chat_id: d.chat_id, task: d.task,
    scheduled_at: d.scheduled_at, is_completed: d.is_completed ?? false,
    completed_at: d.completed_at, created_at: d.created_at || d.$createdAt,
    updated_at: d.updated_at || d.$updatedAt };
}

export const remindersRepo = {
  async create(userId: string, chatId: number, task: string, scheduledAt: string): Promise<Reminder> {
    if (!task?.trim()) throw new Error('Текст напоминания не может быть пустым');
    if (!scheduledAt) throw new Error('Время напоминания обязательно');
    const count = await this.countByUser(userId);
    if (count >= MAX_REMINDERS_PER_USER) throw new Error(`Максимум ${MAX_REMINDERS_PER_USER} активных напоминаний.`);

    const now = new Date().toISOString();
    const doc = await (await getAW()).createDocument(DB_ID(), COLL, ID.unique(), {
      user_id: userId, chat_id: chatId, task: task.trim(), scheduled_at: scheduledAt,
      is_completed: false, completed_at: null, created_at: now, updated_at: now,
    });
    dbLogger.info({ id: doc.$id, userId, scheduledAt }, 'Reminder created');
    return docToReminder(doc);
  },

  async getDue(): Promise<Reminder[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('is_completed', false),
        Query.lessThanEqual('scheduled_at', new Date().toISOString()),
        Query.orderAsc('scheduled_at'),
        Query.limit(50),
      ]);
      return r.documents.map(docToReminder);
    } catch { return []; }
  },

  async markCompleted(id: string): Promise<void> {
    const now = new Date().toISOString();
    await (await getAW()).updateDocument(DB_ID(), COLL, id, { is_completed: true, completed_at: now, updated_at: now });
  },

  async markFailed(id: string): Promise<void> {
    try {
      await (await getAW()).updateDocument(DB_ID(), COLL, id, {
        is_completed: true, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      dbLogger.warn({ id }, 'Reminder failed, marked completed');
    } catch (err) { dbLogger.error({ error: err, id }, 'Failed to update reminder retry'); }
  },

  async getByUser(userId: string): Promise<Reminder[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.equal('is_completed', false),
        Query.orderAsc('scheduled_at'), Query.limit(100),
      ]);
      return r.documents.map(docToReminder);
    } catch { return []; }
  },

  async delete(id: string, userId: string): Promise<boolean> {
    try {
      const aw = await getAW();
      const doc = await aw.getDocument(DB_ID(), COLL, id);
      if (doc.user_id !== userId) return false;
      await aw.deleteDocument(DB_ID(), COLL, id);
      return true;
    } catch { return false; }
  },

  async countByUser(userId: string): Promise<number> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.equal('is_completed', false), Query.limit(1),
      ]);
      return r.total;
    } catch { return 0; }
  },
};
