import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import type {
  Settings,
  Prompt,
  Conversation,
  Message,
  AnalyticsEvent,
  AnalyticsEventType,
} from '../../../shared/types/index.js';
import {
  validateUserId,
  validateChannel,
  validateEventType,
  validateLimit,
  checkArraySize,
  MAX_CONVERSATION_MESSAGES,
} from '../utils/validation.js';
import { handleLegacyDbError, isNotFoundError } from '../utils/error-handler.js';

// --------------------------------------------
// Supabase Client Singleton
// --------------------------------------------

let supabase: SupabaseClient | null = null;

export const getSupabase = (): SupabaseClient => {
  if (!supabase) {
    supabase = createClient(config.db.url, config.db.serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
    dbLogger.info('Supabase client initialized');
  }
  return supabase;
};

// --------------------------------------------
// Settings Repository (with in-memory cache)
// --------------------------------------------

/** Кеш настроек: ключ → { value, timestamp } */
const SETTINGS_CACHE = new Map<string, { value: string | null; ts: number }>();
/** TTL кеша настроек — 5 минут. Настройки меняются редко. */
const SETTINGS_CACHE_TTL = 5 * 60 * 1000;
/** Максимальный размер кеша (ключей ~30, лимит с запасом) */
const SETTINGS_CACHE_MAX_SIZE = 100;

export const settingsRepo = {
  async get(key: string): Promise<string | null> {
    // Проверяем кеш
    const cached = SETTINGS_CACHE.get(key);
    if (cached && Date.now() - cached.ts < SETTINGS_CACHE_TTL) {
      return cached.value;
    }

    const { data, error } = await getSupabase()
      .from('settings')
      .select('value')
      .eq('key', key)
      .single();

    if (error) {
      if (isNotFoundError(error)) {
        SETTINGS_CACHE.set(key, { value: null, ts: Date.now() });
        return null;
      }
      dbLogger.error({ error, key }, 'Failed to get setting');
      throw error;
    }

    const value = (data as { value: string } | null)?.value ?? null;
    // Eviction: если кэш переполнен — удаляем самую старую запись
    if (SETTINGS_CACHE.size >= SETTINGS_CACHE_MAX_SIZE) {
      const oldestKey = SETTINGS_CACHE.keys().next().value;
      if (oldestKey) SETTINGS_CACHE.delete(oldestKey);
    }
    SETTINGS_CACHE.set(key, { value, ts: Date.now() });
    return value;
  },

  async set(key: string, value: string): Promise<void> {
    const { error } = await getSupabase()
      .from('settings')
      .upsert(
        { key, value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );

    if (error) {
      dbLogger.error({ error, key }, 'Failed to set setting');
      throw error;
    }

    // Инвалидируем кеш при записи
    SETTINGS_CACHE.set(key, { value, ts: Date.now() });
  },

  async getAll(): Promise<Settings[]> {
    const { data, error } = await getSupabase()
      .from('settings')
      .select('*')
      .order('key');

    if (error) {
      dbLogger.error({ error }, 'Failed to get all settings');
      throw error;
    }

    const settings = (data as Settings[]) ?? [];

    // Обновляем кеш всех полученных настроек
    const now = Date.now();
    for (const s of settings) {
      SETTINGS_CACHE.set(s.key, { value: s.value, ts: now });
    }

    return settings;
  },

  async getMany(keys: string[]): Promise<Record<string, string>> {
    // Проверяем какие ключи есть в кеше
    const now = Date.now();
    const result: Record<string, string> = {};
    const missedKeys: string[] = [];

    for (const key of keys) {
      const cached = SETTINGS_CACHE.get(key);
      if (cached && now - cached.ts < SETTINGS_CACHE_TTL) {
        if (cached.value !== null) {
          result[key] = cached.value;
        }
      } else {
        missedKeys.push(key);
      }
    }

    // Если всё в кеше — не ходим в БД
    if (missedKeys.length === 0) {
      return result;
    }

    const { data, error } = await getSupabase()
      .from('settings')
      .select('key, value')
      .in('key', missedKeys);

    if (error) {
      dbLogger.error({ error, keys: missedKeys }, 'Failed to get settings');
      throw error;
    }

    const fetched = (data as { key: string; value: string }[]) ?? [];
    for (const { key, value } of fetched) {
      result[key] = value;
      SETTINGS_CACHE.set(key, { value, ts: now });
    }

    for (const key of missedKeys) {
      if (!(key in result)) {
        SETTINGS_CACHE.set(key, { value: null, ts: now });
      }
    }

    return result;
  },

  /** Инвалидировать весь кеш настроек (используется при обновлении из админки) */
  invalidateCache(): void {
    SETTINGS_CACHE.clear();
  },
};

// --------------------------------------------
// Prompts Repository
// --------------------------------------------

export const promptsRepo = {
  async getActive(channel: 'telegram' | 'voice' | 'all'): Promise<Prompt | null> {
    const { data, error } = await getSupabase()
      .from('prompts')
      .select('*')
      .eq('is_active', true)
      .in('channel', [channel, 'all'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      dbLogger.error({ error, channel }, 'Failed to get active prompt');
      throw error;
    }

    return data as Prompt | null;
  },

  async getAll(): Promise<Prompt[]> {
    const { data, error } = await getSupabase()
      .from('prompts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      dbLogger.error({ error }, 'Failed to get all prompts');
      throw error;
    }

    return (data as Prompt[]) ?? [];
  },

  async create(prompt: Omit<Prompt, 'id' | 'created_at' | 'updated_at'>): Promise<Prompt> {
    const { data, error } = await getSupabase()
      .from('prompts')
      .insert(prompt)
      .select()
      .single();

    if (error) {
      dbLogger.error({ error }, 'Failed to create prompt');
      throw error;
    }

    return data as Prompt;
  },

  async update(id: string, updates: Partial<Omit<Prompt, 'id' | 'created_at'>>): Promise<Prompt> {
    const { data, error } = await getSupabase()
      .from('prompts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, id }, 'Failed to update prompt');
      throw error;
    }

    return data as Prompt;
  },

  async delete(id: string): Promise<void> {
    const { error } = await getSupabase()
      .from('prompts')
      .delete()
      .eq('id', id);

    if (error) {
      dbLogger.error({ error, id }, 'Failed to delete prompt');
      throw error;
    }
  },

  async setActive(id: string): Promise<void> {
    // Запоминаем текущий активный промпт для rollback
    const { data: currentActive } = await getSupabase()
      .from('prompts')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    const previousActiveId = (currentActive as { id: string } | null)?.id;

    // Деактивируем все
    const { error: deactivateError } = await getSupabase()
      .from('prompts')
      .update({ is_active: false })
      .eq('is_active', true);

    if (deactivateError) {
      dbLogger.error({ error: deactivateError }, 'Failed to deactivate prompts');
      throw deactivateError;
    }

    // Активируем выбранный
    const { error } = await getSupabase()
      .from('prompts')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      dbLogger.error({ error, id }, 'Failed to set active prompt — rolling back');
      // Rollback: восстанавливаем предыдущий активный промпт
      if (previousActiveId) {
        await getSupabase()
          .from('prompts')
          .update({ is_active: true })
          .eq('id', previousActiveId)
          .then(({ error: rollbackErr }) => {
            if (rollbackErr) dbLogger.error({ error: rollbackErr }, 'Rollback also failed');
          });
      }
      throw error;
    }
  },
};

// --------------------------------------------
// Conversations Repository
// --------------------------------------------

export const conversationsRepo = {
  async getOrCreate(
    userId: string,
    channel: 'telegram' | 'voice',
    metadata: Conversation['metadata']
  ): Promise<Conversation> {
    const validUserId = validateUserId(userId);
    const validChannel = validateChannel(channel);

    // Try to find existing conversation
    const { data: existing, error: findError } = await getSupabase()
      .from('conversations')
      .select('*')
      .eq('user_id', validUserId)
      .eq('channel', validChannel)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) {
      dbLogger.error({ error: findError, userId: validUserId }, 'Failed to find conversation');
      throw findError;
    }

    if (existing) {
      return existing as Conversation;
    }

    // Create new conversation
    const { data, error } = await getSupabase()
      .from('conversations')
      .insert({
        user_id: validUserId,
        channel: validChannel,
        messages: [],
        metadata,
      })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId: validUserId, channel: validChannel }, 'Failed to create conversation');
      throw error;
    }

    return data as Conversation;
  },

  async addMessage(conversationId: string, message: Message): Promise<void> {
    // Validate message array size limit
    checkArraySize([message], 1, 'Cannot add empty message');

    // Use PostgreSQL jsonb_set for atomic append operation
    // This prevents race conditions when multiple messages arrive simultaneously
    const { error } = await getSupabase().rpc('append_conversation_message', {
      conversation_id: conversationId,
      new_message: message as unknown as Record<string, unknown>,
    });

    if (error) {
      // If RPC function doesn't exist, fall back to read-modify-write with retry
      dbLogger.warn({ error }, 'RPC function not available, using fallback');
      return await this.addMessageFallback(conversationId, message);
    }

    dbLogger.debug({ conversationId }, 'Message added atomically');
  },

  /**
   * Fallback method for addMessage (non-atomic, has race condition risk)
   * @private
   */
  async addMessageFallback(conversationId: string, message: Message): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get current messages
        const { data: conv, error: fetchError } = await getSupabase()
          .from('conversations')
          .select('messages')
          .eq('id', conversationId)
          .single();

        if (fetchError) {
          dbLogger.error({ error: fetchError, conversationId }, 'Failed to fetch conversation');
          throw fetchError;
        }

        const currentMessages = (conv as { messages: Message[] } | null)?.messages ?? [];

        // Check array size limit
        checkArraySize(
          currentMessages,
          MAX_CONVERSATION_MESSAGES,
          `Conversation has too many messages (max ${MAX_CONVERSATION_MESSAGES})`
        );

        const messages = [...currentMessages, message];

        // Update with new message
        const { error } = await getSupabase()
          .from('conversations')
          .update({
            messages,
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversationId);

        if (error) {
          throw error;
        }

        // Success
        dbLogger.debug({ conversationId, attempt }, 'Message added (fallback)');
        return;
      } catch (error) {
        lastError = error as Error;
        dbLogger.warn({ error, attempt, conversationId }, 'Retry adding message');

        if (attempt < maxRetries) {
          // Exponential backoff
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        }
      }
    }

    dbLogger.error({ error: lastError, conversationId }, 'Failed to add message after retries');
    throw lastError;
  },

  async getMessages(conversationId: string, limit = 20): Promise<Message[]> {
    const validLimit = validateLimit(limit, 1, 1000);

    const { data, error } = await getSupabase()
      .from('conversations')
      .select('messages')
      .eq('id', conversationId)
      .single();

    if (error) {
      dbLogger.error({ error, conversationId }, 'Failed to get messages');
      throw error;
    }

    const messages = (data as { messages: Message[] } | null)?.messages ?? [];
    return messages.slice(-validLimit);
  },

  async get(conversationId: string): Promise<Conversation> {
    const { data, error } = await getSupabase()
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .single();

    if (error) {
      dbLogger.error({ error, conversationId }, 'Failed to get conversation');
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    return data as Conversation;
  },

  async clearMessages(conversationId: string): Promise<void> {
    const { error } = await getSupabase()
      .from('conversations')
      .update({
        messages: [],
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId);

    if (error) {
      dbLogger.error({ error, conversationId }, 'Failed to clear messages');
      throw error;
    }
  },
};

// --------------------------------------------
// Analytics Repository
// --------------------------------------------

export const analyticsRepo = {
  async log(
    eventType: AnalyticsEventType,
    channel: AnalyticsEvent['channel'],
    data: Record<string, unknown>,
    userId?: string
  ): Promise<void> {
    try {
      const validEventType = validateEventType(eventType);
      const validChannel = validateChannel(channel);
      const validUserId = userId ? validateUserId(userId) : undefined;

      const { error } = await getSupabase()
        .from('analytics')
        .insert({
          event_type: validEventType,
          channel: validChannel,
          data,
          user_id: validUserId,
        });

      if (error) {
        dbLogger.error({ error, eventType: validEventType }, 'Failed to log analytics event');
        // Don't throw - analytics shouldn't break the app
      }
    } catch (error) {
      // Validation or unexpected errors - log and continue
      dbLogger.warn({ error, eventType }, 'Analytics validation failed');
    }
  },

  async getStats(fromDate: Date, toDate: Date): Promise<{
    totalMessages: number;
    totalCalls: number;
    uniqueUsers: number;
    tokensByDay: { date: string; tokens: number }[];
  }> {
    const { data, error } = await getSupabase()
      .from('analytics')
      .select('event_type, user_id, data, timestamp')
      .gte('timestamp', fromDate.toISOString())
      .lte('timestamp', toDate.toISOString());

    if (error) {
      dbLogger.error({ error }, 'Failed to get analytics stats');
      throw error;
    }

    const events = (data as AnalyticsEvent[]) ?? [];
    const uniqueUsers = new Set(events.map((e) => e.user_id).filter(Boolean));

    // Group tokens by day
    const tokensByDay = events
      .filter((e) => e.event_type === 'ai_response')
      .reduce((acc, e) => {
        const date = new Date(e.timestamp).toISOString().split('T')[0];
        const eventData = e.data as { tokens?: number } | null;
        const tokens = eventData?.tokens ?? 0;
        if (!date) return acc;
        const existing = acc.find((d) => d.date === date);
        if (existing) {
          existing.tokens += tokens;
        } else {
          acc.push({ date, tokens });
        }
        return acc;
      }, [] as { date: string; tokens: number }[]);

    return {
      totalMessages: events.filter(
        (e) => e.event_type === 'message_sent' || e.event_type === 'message_received'
      ).length,
      totalCalls: events.filter(
        (e) => e.event_type === 'call_started'
      ).length,
      uniqueUsers: uniqueUsers.size,
      tokensByDay: tokensByDay.sort((a, b) => a.date.localeCompare(b.date)),
    };
  },
};
