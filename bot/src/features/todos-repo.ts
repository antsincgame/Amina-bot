/**
 * Todos Repository — Appwrite backend
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_todos';

export interface Todo { id: string; user_id: string; task: string; is_done: boolean; done_at: string | null; created_at: string; }

const MAX_TODOS_PER_USER = 50;

function docToTodo(d: AppwriteDoc): Todo {
  return { id: d.$id ?? d.id, user_id: d.user_id, task: d.task, is_done: d.is_done ?? false,
    done_at: d.done_at || null, created_at: d.created_at || d.$createdAt };
}

export const todosRepo = {
  async create(userId: string, task: string): Promise<Todo> {
    if (!task?.trim()) throw new Error('Текст задачи не может быть пустым');
    const count = await this.countActive(userId);
    if (count >= MAX_TODOS_PER_USER) throw new Error(`Максимум ${MAX_TODOS_PER_USER} активных задач.`);

    const doc = await (await getAW()).createDocument(DB_ID(), COLL, ID.unique(), {
      user_id: userId, task: task.trim(), is_done: false, done_at: null, created_at: new Date().toISOString(),
    });
    dbLogger.info({ id: doc.$id, userId }, 'Todo created');
    return docToTodo(doc);
  },

  async getActive(userId: string): Promise<Todo[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.equal('is_done', false),
        Query.orderAsc('created_at'), Query.limit(100),
      ]);
      return r.documents.map(docToTodo);
    } catch (error) { dbLogger.warn({ error, userId }, 'todos-repo: getActive failed'); return []; }
  },

  async markDone(userId: string, index: number): Promise<Todo | null> {
    const todos = await this.getActive(userId);
    const todo = todos[index - 1];
    if (!todo) return null;
    try {
      await (await getAW()).updateDocument(DB_ID(), COLL, todo.id, { is_done: true, done_at: new Date().toISOString() });
      return todo;
    } catch (error) { dbLogger.warn({ error, userId }, 'todos-repo: markDone failed'); return null; }
  },

  async delete(userId: string, index: number): Promise<Todo | null> {
    const todos = await this.getActive(userId);
    const todo = todos[index - 1];
    if (!todo) return null;
    try {
      await (await getAW()).deleteDocument(DB_ID(), COLL, todo.id);
      return todo;
    } catch (error) { dbLogger.warn({ error, userId }, 'todos-repo: delete failed'); return null; }
  },

  async countActive(userId: string): Promise<number> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('user_id', userId), Query.equal('is_done', false), Query.limit(1),
      ]);
      return r.total;
    } catch (error) { dbLogger.warn({ error, userId }, 'todos-repo: countActive failed'); return 0; }
  },

  async getForDigest(userId: string): Promise<Todo[]> { return this.getActive(userId); },
};
