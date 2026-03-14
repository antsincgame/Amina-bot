/**
 * Todos Repository
 * CRUD операции для списка задач пользователя
 */

import { getSupabase } from '../db/index.js';
import { dbLogger } from '../config/logger.js';

export interface Todo {
  id: string;
  user_id: string;
  task: string;
  is_done: boolean;
  done_at: string | null;
  created_at: string;
}

const MAX_TODOS_PER_USER = 50;

export const todosRepo = {
  /**
   * Создать задачу
   */
  async create(userId: string, task: string): Promise<Todo> {
    // Валидация
    if (!task || task.trim().length === 0) {
      throw new Error('Текст задачи не может быть пустым');
    }

    const count = await this.countActive(userId);
    if (count >= MAX_TODOS_PER_USER) {
      throw new Error(`Максимум ${MAX_TODOS_PER_USER} активных задач. Отметь выполненные через /done.`);
    }

    const { data, error } = await getSupabase()
      .from('todos')
      .insert({ user_id: userId, task: task.trim() })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to create todo');
      throw error;
    }

    dbLogger.info({ id: data.id, userId }, 'Todo created');
    return data as Todo;
  },

  /**
   * Получить активные задачи пользователя
   */
  async getActive(userId: string): Promise<Todo[]> {
    const { data, error } = await getSupabase()
      .from('todos')
      .select('*')
      .eq('user_id', userId)
      .eq('is_done', false)
      .order('created_at', { ascending: true });

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to get todos');
      return [];
    }

    return (data ?? []) as Todo[];
  },

  /**
   * Отметить задачу выполненной по номеру (1-based)
   */
  async markDone(userId: string, index: number): Promise<Todo | null> {
    const todos = await this.getActive(userId);
    const todo = todos[index - 1];
    if (!todo) return null;

    const { error } = await getSupabase()
      .from('todos')
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq('id', todo.id)
      .eq('user_id', userId);

    if (error) {
      dbLogger.error({ error, id: todo.id, userId }, 'Failed to mark todo done');
      return null;
    }

    return todo;
  },

  /**
   * Удалить задачу
   */
  async delete(userId: string, index: number): Promise<Todo | null> {
    const todos = await this.getActive(userId);
    const todo = todos[index - 1];
    if (!todo) return null;

    const { error } = await getSupabase()
      .from('todos')
      .delete()
      .eq('id', todo.id)
      .eq('user_id', userId);

    if (error) {
      dbLogger.error({ error, id: todo.id, userId }, 'Failed to delete todo');
      return null;
    }

    return todo;
  },

  /**
   * Количество активных задач
   */
  async countActive(userId: string): Promise<number> {
    const { count, error } = await getSupabase()
      .from('todos')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_done', false);

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to count todos');
      return 0;
    }

    return count ?? 0;
  },

  /**
   * Задачи для утреннего дайджеста (активные)
   */
  async getForDigest(userId: string): Promise<Todo[]> {
    return this.getActive(userId);
  },
};
