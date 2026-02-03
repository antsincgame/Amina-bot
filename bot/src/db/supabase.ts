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

// --------------------------------------------
// Database Types for Supabase
// --------------------------------------------

interface Database {
  public: {
    Tables: {
      settings: {
        Row: Settings;
        Insert: Omit<Settings, 'id'>;
        Update: Partial<Omit<Settings, 'id'>>;
      };
      prompts: {
        Row: Prompt;
        Insert: Omit<Prompt, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Prompt, 'id' | 'created_at'>>;
      };
      conversations: {
        Row: Conversation;
        Insert: Omit<Conversation, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Conversation, 'id' | 'created_at'>>;
      };
      analytics: {
        Row: AnalyticsEvent;
        Insert: Omit<AnalyticsEvent, 'id' | 'timestamp'>;
        Update: never;
      };
    };
  };
}

// --------------------------------------------
// Supabase Client Singleton
// --------------------------------------------

let supabase: SupabaseClient<Database> | null = null;

export const getSupabase = (): SupabaseClient<Database> => {
  if (!supabase) {
    supabase = createClient<Database>(config.db.url, config.db.serviceKey, {
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
// Settings Repository
// --------------------------------------------

export const settingsRepo = {
  async get(key: string): Promise<string | null> {
    const { data, error } = await getSupabase()
      .from('settings')
      .select('value')
      .eq('key', key)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      dbLogger.error({ error, key }, 'Failed to get setting');
      throw error;
    }

    return data?.value ?? null;
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

    return data ?? [];
  },

  async getMany(keys: string[]): Promise<Record<string, string>> {
    const { data, error } = await getSupabase()
      .from('settings')
      .select('key, value')
      .in('key', keys);

    if (error) {
      dbLogger.error({ error, keys }, 'Failed to get settings');
      throw error;
    }

    return (data ?? []).reduce(
      (acc, { key, value }) => ({ ...acc, [key]: value }),
      {} as Record<string, string>
    );
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

    return data;
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

    return data ?? [];
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

    return data;
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

    return data;
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
    // Deactivate all prompts first
    await getSupabase()
      .from('prompts')
      .update({ is_active: false })
      .eq('is_active', true);

    // Activate the selected one
    const { error } = await getSupabase()
      .from('prompts')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      dbLogger.error({ error, id }, 'Failed to set active prompt');
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
    // Try to find existing conversation
    const { data: existing } = await getSupabase()
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('channel', channel)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      return existing;
    }

    // Create new conversation
    const { data, error } = await getSupabase()
      .from('conversations')
      .insert({
        user_id: userId,
        channel,
        messages: [],
        metadata,
      })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId, channel }, 'Failed to create conversation');
      throw error;
    }

    return data;
  },

  async addMessage(conversationId: string, message: Message): Promise<void> {
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

    const messages = [...(conv?.messages ?? []), message];

    // Update with new message
    const { error } = await getSupabase()
      .from('conversations')
      .update({
        messages,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId);

    if (error) {
      dbLogger.error({ error, conversationId }, 'Failed to add message');
      throw error;
    }
  },

  async getMessages(conversationId: string, limit = 20): Promise<Message[]> {
    const { data, error } = await getSupabase()
      .from('conversations')
      .select('messages')
      .eq('id', conversationId)
      .single();

    if (error) {
      dbLogger.error({ error, conversationId }, 'Failed to get messages');
      throw error;
    }

    const messages = data?.messages ?? [];
    return messages.slice(-limit);
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
    const { error } = await getSupabase()
      .from('analytics')
      .insert({
        event_type: eventType,
        channel,
        data,
        user_id: userId,
      });

    if (error) {
      dbLogger.error({ error, eventType }, 'Failed to log analytics event');
      // Don't throw - analytics shouldn't break the app
    }
  },

  async getStats(fromDate: Date, toDate: Date): Promise<{
    totalMessages: number;
    totalCalls: number;
    uniqueUsers: number;
  }> {
    const { data, error } = await getSupabase()
      .from('analytics')
      .select('event_type, user_id')
      .gte('timestamp', fromDate.toISOString())
      .lte('timestamp', toDate.toISOString());

    if (error) {
      dbLogger.error({ error }, 'Failed to get analytics stats');
      throw error;
    }

    const events = data ?? [];
    const uniqueUsers = new Set(events.map((e) => e.user_id).filter(Boolean));

    return {
      totalMessages: events.filter(
        (e) => e.event_type === 'message_sent' || e.event_type === 'message_received'
      ).length,
      totalCalls: events.filter(
        (e) => e.event_type === 'call_started'
      ).length,
      uniqueUsers: uniqueUsers.size,
    };
  },
};
