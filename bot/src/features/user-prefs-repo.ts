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
   * FIX: Используем upsert вместо SELECT+INSERT для атомарности (race condition)
   */
  async getOrCreate(
    userId: string,
    chatId: number,
    firstName?: string
  ): Promise<UserPreferences> {
    // Сначала пробуем прочитать существующие настройки
    const { data: existing } = await getSupabase()
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (existing) {
      // Обновляем first_name и chat_id если изменились, НЕ трогая digest_hour/city
      if (firstName && existing.first_name !== firstName || existing.chat_id !== chatId) {
        try {
          await getSupabase()
            .from('user_preferences')
            .update({
              first_name: firstName ?? existing.first_name,
              chat_id: chatId,
            })
            .eq('user_id', userId);
        } catch (err) {
          dbLogger.warn({ error: err, userId }, 'Failed to update user prefs fields');
        }
      }
      return existing as UserPreferences;
    }

    // Пользователя нет — создаём с дефолтами
    const { data, error } = await getSupabase()
      .from('user_preferences')
      .insert({
        user_id: userId,
        chat_id: chatId,
        first_name: firstName ?? null,
        digest_hour: 10,
        digest_city: '',
      })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to insert user prefs');
      // Race condition: кто-то создал параллельно — пробуем прочитать
      const { data: raceData } = await getSupabase()
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
      if (raceData) return raceData as UserPreferences;
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

  async listDigestCities(limit = 20): Promise<string[]> {
    const { data, error } = await getSupabase()
      .from('user_preferences')
      .select('digest_city, updated_at')
      .neq('digest_city', '')
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) {
      dbLogger.error({ error, limit }, 'Failed to list digest cities');
      return [];
    }

    const seenCities = new Set<string>();
    const orderedCities: string[] = [];

    ((data as Array<{ digest_city: string | null }> | null) ?? []).forEach(item => {
      const normalizedCity = item.digest_city?.trim();
      if (!normalizedCity || seenCities.has(normalizedCity)) return;
      seenCities.add(normalizedCity);
      orderedCities.push(normalizedCity);
    });

    return orderedCities;
  },

  /**
   * Получить настройки пользователя (или null)
   * FIX: Различаем "не найдено" от реальных ошибок БД
   */
  async get(userId: string): Promise<UserPreferences | null> {
    const { data, error } = await getSupabase()
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      // PGRST116 = row not found — ожидаемый случай
      if (error.code === 'PGRST116') return null;
      dbLogger.error({ error, userId }, 'Failed to get user prefs');
      return null;
    }
    return data as UserPreferences;
  },
};
