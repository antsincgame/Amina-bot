/**
 * Reminders Repository
 * CRUD операции для напоминаний через Supabase
 */

import { getSupabase } from '../db/supabase.js';
import { dbLogger } from '../config/logger.js';
import type { Reminder } from '../../../shared/types/index.js';

const MAX_REMINDERS_PER_USER = 20;

export const remindersRepo = {
  /**
   * Создать напоминание
   */
  async create(
    userId: string,
    chatId: number,
    task: string,
    scheduledAt: string
  ): Promise<Reminder> {
    // Проверяем лимит
    const count = await this.countByUser(userId);
    if (count >= MAX_REMINDERS_PER_USER) {
      throw new Error(`Максимум ${MAX_REMINDERS_PER_USER} активных напоминаний. Удали старые через /reminders.`);
    }

    const { data, error } = await getSupabase()
      .from('reminders')
      .insert({
        user_id: userId,
        chat_id: chatId,
        task,
        scheduled_at: scheduledAt,
      })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to create reminder');
      throw error;
    }

    dbLogger.info({ id: data.id, userId, scheduledAt }, 'Reminder created');
    return data as Reminder;
  },

  /**
   * Получить все просроченные (пора отправить) напоминания
   */
  async getDue(): Promise<Reminder[]> {
    const { data, error } = await getSupabase()
      .from('reminders')
      .select('*')
      .eq('is_completed', false)
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(50); // Не больше 50 за раз

    if (error) {
      dbLogger.error({ error }, 'Failed to get due reminders');
      return [];
    }

    return (data ?? []) as Reminder[];
  },

  /**
   * Пометить напоминание как выполненное
   */
  async markCompleted(id: string): Promise<void> {
    const { error } = await getSupabase()
      .from('reminders')
      .update({
        is_completed: true,
        completed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      dbLogger.error({ error, id }, 'Failed to mark reminder completed');
      throw error;
    }
  },

  /**
   * Активные напоминания пользователя (для /reminders)
   */
  async getByUser(userId: string): Promise<Reminder[]> {
    const { data, error } = await getSupabase()
      .from('reminders')
      .select('*')
      .eq('user_id', userId)
      .eq('is_completed', false)
      .order('scheduled_at', { ascending: true });

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to get user reminders');
      return [];
    }

    return (data ?? []) as Reminder[];
  },

  /**
   * Удалить напоминание (только своё)
   */
  async delete(id: string, userId: string): Promise<boolean> {
    const { error, count } = await getSupabase()
      .from('reminders')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      dbLogger.error({ error, id, userId }, 'Failed to delete reminder');
      return false;
    }

    return (count ?? 0) > 0;
  },

  /**
   * Количество активных напоминаний пользователя
   */
  async countByUser(userId: string): Promise<number> {
    const { count, error } = await getSupabase()
      .from('reminders')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_completed', false);

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to count user reminders');
      return 0;
    }

    return count ?? 0;
  },
};
