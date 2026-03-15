/**
 * Todos Repository — dual backend (Appwrite primary)
 */

import { config } from '../config/index.js';
import { getSupabase } from '../db/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query } from 'node-appwrite';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_todos';

export interface Todo { id: string; user_id: string; task: string; is_done: boolean; done_at: string | null; created_at: string; }

const MAX_TODOS_PER_USER = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToTodo(d: any): Todo {
  return { id: d.$id ?? d.id, user_id: d.user_id, task: d.task, is_done: d.is_done ?? false,
    done_at: d.done_at || null, created_at: d.created_at || d.$createdAt };
}

export const todosRepo = {
  async create(userId: string, task: string): Promise<Todo> {
    if (!task?.trim()) throw new Error('Текст задачи не может быть пустым');
    const count = await this.countActive(userId);
    if (count >= MAX_TODOS_PER_USER) throw new Error(`Максимум ${MAX_TODOS_PER_USER} активных задач.`);

    if (useAW()) {
      const doc = await (await getAW()).createDocument(DB_ID(), COLL, ID.unique(), {
        user_id: userId, task: task.trim(), is_done: false, done_at: null, created_at: new Date().toISOString(),
      });
      dbLogger.info({ id: doc.$id, userId }, 'Todo created');
      return docToTodo(doc);
    } else {
      const { data, error } = await getSupabase().from('todos').insert({ user_id: userId, task: task.trim() }).select().single();
      if (error) { dbLogger.error({ error, userId }, 'Failed to create todo'); throw error; }
      dbLogger.info({ id: data.id, userId }, 'Todo created');
      return data as Todo;
    }
  },

  async getActive(userId: string): Promise<Todo[]> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
          Query.equal('user_id', userId), Query.equal('is_done', false),
          Query.orderAsc('created_at'), Query.limit(100),
        ]);
        return r.documents.map(docToTodo);
      } else {
        const { data, error } = await getSupabase().from('todos').select('*')
          .eq('user_id', userId).eq('is_done', false).order('created_at', { ascending: true });
        if (error) { dbLogger.error({ error, userId }, 'Failed to get todos'); return []; }
        return (data ?? []) as Todo[];
      }
    } catch { return []; }
  },

  async markDone(userId: string, index: number): Promise<Todo | null> {
    const todos = await this.getActive(userId);
    const todo = todos[index - 1];
    if (!todo) return null;
    try {
      if (useAW()) {
        await (await getAW()).updateDocument(DB_ID(), COLL, todo.id, { is_done: true, done_at: new Date().toISOString() });
      } else {
        const { error } = await getSupabase().from('todos').update({ is_done: true, done_at: new Date().toISOString() }).eq('id', todo.id).eq('user_id', userId);
        if (error) { dbLogger.error({ error, id: todo.id, userId }, 'Failed to mark todo done'); return null; }
      }
      return todo;
    } catch { return null; }
  },

  async delete(userId: string, index: number): Promise<Todo | null> {
    const todos = await this.getActive(userId);
    const todo = todos[index - 1];
    if (!todo) return null;
    try {
      if (useAW()) {
        await (await getAW()).deleteDocument(DB_ID(), COLL, todo.id);
      } else {
        const { error } = await getSupabase().from('todos').delete().eq('id', todo.id).eq('user_id', userId);
        if (error) { dbLogger.error({ error, id: todo.id, userId }, 'Failed to delete todo'); return null; }
      }
      return todo;
    } catch { return null; }
  },

  async countActive(userId: string): Promise<number> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
          Query.equal('user_id', userId), Query.equal('is_done', false), Query.limit(1),
        ]);
        return r.total;
      } else {
        const { count, error } = await getSupabase().from('todos').select('*', { count: 'exact', head: true })
          .eq('user_id', userId).eq('is_done', false);
        if (error) { dbLogger.error({ error, userId }, 'Failed to count todos'); return 0; }
        return count ?? 0;
      }
    } catch { return 0; }
  },

  async getForDigest(userId: string): Promise<Todo[]> { return this.getActive(userId); },
};
