/**
 * Reminders Repository — Appwrite backend
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;
import type { Reminder } from '../../../shared/types/index.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_reminders';

const MAX_REMINDERS_PER_USER = 20;
const MAX_SEND_RETRIES = 5;
const RETRY_BACKOFF_MS = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;
const RETRY_TOLERANCE_MS = 30_000;

function docToReminder(d: AppwriteDoc): Reminder {
  return { id: d.$id ?? d.id, user_id: d.user_id, chat_id: d.chat_id, task: d.task,
    scheduled_at: d.scheduled_at, is_completed: d.is_completed ?? false,
    completed_at: d.completed_at, created_at: d.created_at || d.$createdAt,
    updated_at: d.updated_at || d.$updatedAt };
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function inferScheduledRetryCount(doc: unknown): number {
  if (!doc || typeof doc !== 'object') {
    return 0;
  }

  const reminderDoc = doc as { scheduled_at?: unknown; updated_at?: unknown };
  const scheduledAt = parseIsoDate(reminderDoc.scheduled_at);
  const updatedAt = parseIsoDate(reminderDoc.updated_at);
  if (!scheduledAt || !updatedAt) {
    return 0;
  }

  const delayMs = scheduledAt.getTime() - updatedAt.getTime();
  const matchedIndex = RETRY_BACKOFF_MS.findIndex((backoffMs) =>
    Math.abs(delayMs - backoffMs) <= RETRY_TOLERANCE_MS,
  );

  return matchedIndex === -1 ? 0 : matchedIndex + 1;
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
      const aw = await getAW();
      const nowISO = new Date().toISOString();
      const allDue: Reminder[] = [];
      let offset = 0;
      const PAGE_SIZE = 100;
      // Раньше было MAX_PAGES = 5 (потолок 500 напоминаний). При большом бэклоге часть due
      // не обрабатывалась и пользователи не получали уведомления.
      // Поднимаем потолок до 50 страниц (5000 напоминаний/цикл) — этого достаточно для практики,
      // и есть страховка на случай битого индекса.
      const MAX_PAGES = 50;

      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await aw.listDocuments(DB_ID(), COLL, [
          Query.equal('is_completed', false),
          Query.lessThanEqual('scheduled_at', nowISO),
          Query.orderAsc('scheduled_at'),
          Query.limit(PAGE_SIZE),
          Query.offset(offset),
        ]);
        allDue.push(...r.documents.map(docToReminder));
        if (r.documents.length < PAGE_SIZE) return allDue;
        offset += PAGE_SIZE;
      }

      dbLogger.warn(
        { returnedCount: allDue.length, pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
        'Reminder due scan reached hard page limit; remaining backlog will be picked up next cycle',
      );

      return allDue;
    } catch (error) {
      dbLogger.error({ error }, 'getDue() failed — Appwrite may be unreachable, due reminders will be retried next cycle');
      return [];
    }
  },

  async markCompleted(id: string): Promise<void> {
    const now = new Date().toISOString();
    await (await getAW()).updateDocument(DB_ID(), COLL, id, { is_completed: true, completed_at: now, updated_at: now });
  },

  /**
   * Помечает попытку отправки как неудачную.
   * Не использует `completed_at` для retry-state: это поле остаётся только датой завершения.
   * Повторные попытки кодируются переносом `scheduled_at` вперёд по backoff-окну.
   */
  async markFailed(id: string): Promise<void> {
    try {
      const aw = await getAW();
      const doc = await aw.getDocument(DB_ID(), COLL, id);
      const currentRetries = inferScheduledRetryCount(doc);
      const nextRetries = currentRetries + 1;
      const now = new Date();
      const nowIso = now.toISOString();

      if (currentRetries >= MAX_SEND_RETRIES) {
        await aw.updateDocument(DB_ID(), COLL, id, {
          is_completed: true,
          completed_at: nowIso,
          updated_at: nowIso,
        });
        dbLogger.error({ id, retries: currentRetries }, 'Reminder permanently failed after max retries');
      } else {
        const retryDelayMs = RETRY_BACKOFF_MS[currentRetries] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
        const nextAttemptAt = new Date(now.getTime() + retryDelayMs).toISOString();
        await aw.updateDocument(DB_ID(), COLL, id, {
          scheduled_at: nextAttemptAt,
          completed_at: null,
          updated_at: nowIso,
        });
        dbLogger.warn({ id, retries: nextRetries, maxRetries: MAX_SEND_RETRIES, nextAttemptAt },
          'Reminder send failed — will retry next cycle');
      }
    } catch (err) { dbLogger.error({ error: err, id }, 'Failed to update reminder retry state'); }
  },

  async getByUser(userId: string): Promise<Reminder[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.equal('is_completed', false),
        Query.orderAsc('scheduled_at'), Query.limit(100),
      ]);
      return r.documents.map(docToReminder);
    } catch (error) {
      dbLogger.warn({ error, userId }, 'Failed to load reminders for user');
      return [];
    }
  },

  async delete(id: string, userId: string): Promise<boolean> {
    try {
      const aw = await getAW();
      const doc = await aw.getDocument(DB_ID(), COLL, id);
      if (doc.user_id !== userId) return false;
      await aw.deleteDocument(DB_ID(), COLL, id);
      return true;
    } catch (error) {
      dbLogger.warn({ error, userId, reminderId: id }, 'Failed to delete reminder');
      return false;
    }
  },

  async countByUser(userId: string): Promise<number> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.equal('is_completed', false), Query.limit(1),
      ]);
      return r.total;
    } catch (error) {
      dbLogger.warn({ error, userId }, 'Failed to count reminders for user');
      return 0;
    }
  },
};
