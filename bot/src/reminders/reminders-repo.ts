/**
 * Reminders Repository — dual backend (Supabase + Appwrite)
 */

import { config } from '../config/index.js';
import { getSupabase } from '../db/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query } from 'node-appwrite';
import type { Reminder } from '../../../shared/types/index.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_reminders';

const MAX_REMINDERS_PER_USER = 20;
const MAX_RETRY_COUNT = 10;

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

    if (useAW()) {
      const now = new Date().toISOString();
      const doc = await (await getAW()).createDocument(DB_ID(), COLL, ID.unique(), {
        user_id: userId, chat_id: chatId, task: task.trim(), scheduled_at: scheduledAt,
        is_completed: false, completed_at: null, created_at: now, updated_at: now,
      });
      dbLogger.info({ id: doc.$id, userId, scheduledAt }, 'Reminder created');
      return docToReminder(doc);
    } else {
      const { data, error } = await getSupabase().from('reminders').insert({
        user_id: userId, chat_id: chatId, task: task.trim(), scheduled_at: scheduledAt,
      }).select().single();
      if (error) { dbLogger.error({ error, userId }, 'Failed to create reminder'); throw error; }
      dbLogger.info({ id: data.id, userId, scheduledAt }, 'Reminder created');
      return data as Reminder;
    }
  },

  async getDue(): Promise<Reminder[]> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
          Query.equal('is_completed', false),
          Query.lessThanEqual('scheduled_at', new Date().toISOString()),
          Query.orderAsc('scheduled_at'),
          Query.limit(50),
        ]);
        return r.documents.map(docToReminder);
      } else {
        const { data, error } = await getSupabase().from('reminders').select('*')
          .eq('is_completed', false).lte('scheduled_at', new Date().toISOString())
          .order('scheduled_at', { ascending: true }).limit(50);
        if (error) { dbLogger.error({ error }, 'Failed to get due reminders'); return []; }
        return ((data ?? []) as Array<Reminder & { retry_count?: number }>)
          .filter(r => (r.retry_count ?? 0) < MAX_RETRY_COUNT) as Reminder[];
      }
    } catch { return []; }
  },

  async markCompleted(id: string): Promise<void> {
    const now = new Date().toISOString();
    if (useAW()) {
      await (await getAW()).updateDocument(DB_ID(), COLL, id, { is_completed: true, completed_at: now, updated_at: now });
    } else {
      const { error } = await getSupabase().from('reminders').update({ is_completed: true, completed_at: now }).eq('id', id);
      if (error) { dbLogger.error({ error, id }, 'Failed to mark reminder completed'); throw error; }
    }
  },

  async markFailed(id: string): Promise<void> {
    try {
      if (useAW()) {
        // Appwrite doesn't have retry_count column — just mark completed
        await (await getAW()).updateDocument(DB_ID(), COLL, id, {
          is_completed: true, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        dbLogger.warn({ id }, 'Reminder failed, marked completed (Appwrite)');
      } else {
        const { data: reminder } = await getSupabase().from('reminders').select('retry_count').eq('id', id).single();
        const newRetries = ((reminder as { retry_count?: number })?.retry_count ?? 0) + 1;
        if (newRetries >= MAX_RETRY_COUNT) {
          await getSupabase().from('reminders').update({ is_completed: true, completed_at: new Date().toISOString() }).eq('id', id);
          dbLogger.warn({ id, retries: newRetries }, 'Reminder exceeded max retries');
        } else {
          await getSupabase().from('reminders').update({ retry_count: newRetries } as Record<string, unknown>).eq('id', id);
        }
      }
    } catch (err) { dbLogger.error({ error: err, id }, 'Failed to update reminder retry'); }
  },

  async getByUser(userId: string): Promise<Reminder[]> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
          Query.equal('user_id', userId), Query.equal('is_completed', false),
          Query.orderAsc('scheduled_at'), Query.limit(100),
        ]);
        return r.documents.map(docToReminder);
      } else {
        const { data, error } = await getSupabase().from('reminders').select('*')
          .eq('user_id', userId).eq('is_completed', false).order('scheduled_at', { ascending: true });
        if (error) { dbLogger.error({ error, userId }, 'Failed to get reminders'); return []; }
        return (data ?? []) as Reminder[];
      }
    } catch { return []; }
  },

  async delete(id: string, userId: string): Promise<boolean> {
    try {
      if (useAW()) {
        const aw = await getAW();
        // Verify ownership
        const doc = await aw.getDocument(DB_ID(), COLL, id);
        if (doc.user_id !== userId) return false;
        await aw.deleteDocument(DB_ID(), COLL, id);
        return true;
      } else {
        const { data: existing } = await getSupabase().from('reminders').select('id').eq('id', id).eq('user_id', userId).single();
        if (!existing) return false;
        const { error } = await getSupabase().from('reminders').delete().eq('id', id).eq('user_id', userId);
        if (error) { dbLogger.error({ error, id, userId }, 'Failed to delete reminder'); return false; }
        return true;
      }
    } catch { return false; }
  },

  async countByUser(userId: string): Promise<number> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
          Query.equal('user_id', userId), Query.equal('is_completed', false), Query.limit(1),
        ]);
        return r.total;
      } else {
        const { count, error } = await getSupabase().from('reminders').select('*', { count: 'exact', head: true })
          .eq('user_id', userId).eq('is_completed', false);
        if (error) { dbLogger.error({ error, userId }, 'Failed to count reminders'); return 0; }
        return count ?? 0;
      }
    } catch { return 0; }
  },
};
