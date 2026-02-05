/**
 * User Preferences Repository
 * Настройки пользователя: дайджест, город, таймзона
 */

import { getSupabase } from '../db/supabase.js';
import { dbLogger } from '../config/logger.js';

export interface UserPreferences {
  id: string;
  user_id: string;
  chat_id: number;
  digest_enabled: boolean;
  digest_hour: number;
  digest_city: string;
  first_name: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export const userPrefsRepo = {
  /**
   * Получить или создать настройки пользователя
   */
  async getOrCreate(
    userId: string,
    chatId: number,
    firstName?: string
  ): Promise<UserPreferences> {
    // Попытка найти существующие
    const { data: existing } = await getSupabase()
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (existing) {
      // Обновить first_name если изменилось
      if (firstName && existing.first_name !== firstName) {
        await getSupabase()
          .from('user_preferences')
          .update({ first_name: firstName })
          .eq('user_id', userId);
      }
      return existing as UserPreferences;
    }

    // Создать новые
    const { data, error } = await getSupabase()
      .from('user_preferences')
      .insert({
        user_id: userId,
        chat_id: chatId,
        first_name: firstName ?? null,
      })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to create user prefs');
      throw error;
    }

    return data as UserPreferences;
  },

  /**
   * Обновить настройки
   */
  async update(
    userId: string,
    updates: Partial<Pick<UserPreferences, 'digest_enabled' | 'digest_hour' | 'digest_city' | 'timezone'>>
  ): Promise<void> {
    const { error } = await getSupabase()
      .from('user_preferences')
      .update(updates)
      .eq('user_id', userId);

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to update user prefs');
      throw error;
    }
  },

  /**
   * Включить/выключить дайджест
   */
  async toggleDigest(userId: string, chatId: number, enabled: boolean): Promise<void> {
    // Upsert — если пользователя нет, создаём
    const { error } = await getSupabase()
      .from('user_preferences')
      .upsert(
        { user_id: userId, chat_id: chatId, digest_enabled: enabled },
        { onConflict: 'user_id' }
      );

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to toggle digest');
      throw error;
    }
  },

  /**
   * Получить всех пользователей с включённым дайджестом для данного часа
   */
  async getDigestUsers(hour: number): Promise<UserPreferences[]> {
    const { data, error } = await getSupabase()
      .from('user_preferences')
      .select('*')
      .eq('digest_enabled', true)
      .eq('digest_hour', hour);

    if (error) {
      dbLogger.error({ error, hour }, 'Failed to get digest users');
      return [];
    }

    return (data ?? []) as UserPreferences[];
  },

  /**
   * Получить настройки пользователя (или null)
   */
  async get(userId: string): Promise<UserPreferences | null> {
    const { data, error } = await getSupabase()
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) return null;
    return data as UserPreferences;
  },
};
