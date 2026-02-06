/**
 * Reminders Repository
 * CRUD операции для напоминаний через Supabase
 * 
 * Исправлено:
 * - delete(): корректный вызов Supabase API (без аргументов в .delete())
 * - create(): валидация входных данных
 * - getDue(): фильтрация по retry_count (макс. 10 попыток)
 * - markFailed(): инкремент retry_count при ошибке отправки
 */

import { getSupabase } from '../db/supabase.js';
import { dbLogger } from '../config/logger.js';
import type { Reminder } from '../../../shared/types/index.js';

const MAX_REMINDERS_PER_USER = 20;
const MAX_RETRY_COUNT = 10; // Макс. попыток отправки перед отменой

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
    // Валидация входных данных
    if (!task || task.trim().length === 0) {
      throw new Error('Текст напоминания не может быть пустым');
    }
    if (!scheduledAt) {
      throw new Error('Время напоминания обязательно');
    }

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
        task: task.trim(),
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
   * Исключает напоминания с retry_count >= MAX_RETRY_COUNT
   */
  async getDue(): Promise<Reminder[]> {
    const { data, error } = await getSupabase()
      .from('reminders')
      .select('*')
      .eq('is_completed', false)
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(50);

    if (error) {
      dbLogger.error({ error }, 'Failed to get due reminders');
      return [];
    }

    // Фильтруем по retry_count (если колонка существует)
    return ((data ?? []) as Array<Reminder & { retry_count?: number }>).filter(r => {
      const retries = r.retry_count ?? 0;
      return retries < MAX_RETRY_COUNT;
    }) as Reminder[];
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
   * Увеличить счётчик попыток при ошибке отправки
   * Если retry_count >= MAX_RETRY_COUNT — помечаем как completed с ошибкой
   */
  async markFailed(id: string): Promise<void> {
    try {
      // Получаем текущий retry_count
      const { data: reminder } = await getSupabase()
        .from('reminders')
        .select('retry_count')
        .eq('id', id)
        .single();

      const currentRetries = (reminder as { retry_count?: number })?.retry_count ?? 0;
      const newRetries = currentRetries + 1;

      if (newRetries >= MAX_RETRY_COUNT) {
        // Превышен лимит — помечаем как completed (с ошибкой)
        await getSupabase()
          .from('reminders')
          .update({
            is_completed: true,
            completed_at: new Date().toISOString(),
          })
          .eq('id', id);
        dbLogger.warn({ id, retries: newRetries }, 'Reminder exceeded max retries, marked as completed');
      } else {
        // Инкрементируем retry_count (безопасно, если колонки нет — просто не обновит)
        await getSupabase()
          .from('reminders')
          .update({ retry_count: newRetries } as Record<string, unknown>)
          .eq('id', id);
        dbLogger.debug({ id, retries: newRetries }, 'Reminder retry count incremented');
      }
    } catch (err) {
      dbLogger.error({ error: err, id }, 'Failed to update reminder retry count');
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
   * FIX: Supabase JS v2 .delete() не принимает аргументы
   */
  async delete(id: string, userId: string): Promise<boolean> {
    // Сначала проверяем что напоминание существует и принадлежит пользователю
    const { data: existing } = await getSupabase()
      .from('reminders')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!existing) {
      return false; // Не найдено или не принадлежит пользователю
    }

    const { error } = await getSupabase()
      .from('reminders')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      dbLogger.error({ error, id, userId }, 'Failed to delete reminder');
      return false;
    }

    return true;
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
