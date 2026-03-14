/**
 * Notes Repository
 * CRUD операции для заметок пользователя
 */

import { getSupabase } from '../db/index.js';
import { dbLogger } from '../config/logger.js';

export interface Note {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
}

const MAX_NOTES_PER_USER = 100;

export const notesRepo = {
  /**
   * Создать заметку
   */
  async create(userId: string, content: string): Promise<Note> {
    // Валидация
    if (!content || content.trim().length === 0) {
      throw new Error('Текст заметки не может быть пустым');
    }

    const count = await this.countByUser(userId);
    if (count >= MAX_NOTES_PER_USER) {
      throw new Error(`Максимум ${MAX_NOTES_PER_USER} заметок. Удали старые через /note_delete.`);
    }

    const { data, error } = await getSupabase()
      .from('notes')
      .insert({ user_id: userId, content: content.trim() })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to create note');
      throw error;
    }

    dbLogger.info({ id: data.id, userId }, 'Note created');
    return data as Note;
  },

  /**
   * Получить все заметки пользователя
   */
  async getByUser(userId: string): Promise<Note[]> {
    const { data, error } = await getSupabase()
      .from('notes')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to get notes');
      return [];
    }

    return (data ?? []) as Note[];
  },

  /**
   * Удалить заметку по номеру (1-based index)
   */
  async deleteByIndex(userId: string, index: number): Promise<Note | null> {
    const notes = await this.getByUser(userId);
    const note = notes[index - 1];
    if (!note) return null;

    const { error } = await getSupabase()
      .from('notes')
      .delete()
      .eq('id', note.id)
      .eq('user_id', userId);

    if (error) {
      dbLogger.error({ error, id: note.id, userId }, 'Failed to delete note');
      return null;
    }

    return note;
  },

  /**
   * Количество заметок пользователя
   */
  async countByUser(userId: string): Promise<number> {
    const { count, error } = await getSupabase()
      .from('notes')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to count notes');
      return 0;
    }

    return count ?? 0;
  },
};
