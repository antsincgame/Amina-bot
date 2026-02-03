import { createClient } from '@supabase/supabase-js';

// Environment variables (set in Netlify)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Types
export interface Setting {
  id: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface Prompt {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  channel: 'telegram' | 'voice' | 'all';
  created_at: string;
  updated_at: string;
}

export interface AnalyticsEvent {
  id: string;
  event_type: string;
  data: Record<string, unknown>;
  user_id: string | null;
  channel: string;
  timestamp: string;
}

// Settings API
export const settingsApi = {
  async getAll(): Promise<Setting[]> {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .order('key');

    if (error) throw error;
    return data ?? [];
  },

  async update(key: string, value: string): Promise<void> {
    const { error } = await supabase
      .from('settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    if (error) throw error;
  },

  async updateMany(settings: Record<string, string>): Promise<void> {
    const updates = Object.entries(settings).map(([key, value]) => ({
      key,
      value,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from('settings')
      .upsert(updates, { onConflict: 'key' });

    if (error) throw error;
  },
};

// Prompts API
export const promptsApi = {
  async getAll(): Promise<Prompt[]> {
    const { data, error } = await supabase
      .from('prompts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  },

  async create(prompt: Omit<Prompt, 'id' | 'created_at' | 'updated_at'>): Promise<Prompt> {
    const { data, error } = await supabase
      .from('prompts')
      .insert(prompt)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: Partial<Omit<Prompt, 'id' | 'created_at'>>): Promise<Prompt> {
    const { data, error } = await supabase
      .from('prompts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase
      .from('prompts')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  async setActive(id: string): Promise<void> {
    // Deactivate all
    await supabase
      .from('prompts')
      .update({ is_active: false })
      .eq('is_active', true);

    // Activate selected
    const { error } = await supabase
      .from('prompts')
      .update({ is_active: true })
      .eq('id', id);

    if (error) throw error;
  },
};

// Analytics API
export const analyticsApi = {
  async getEvents(params: {
    from?: Date;
    to?: Date;
    channel?: string;
    eventType?: string;
    limit?: number;
  }): Promise<AnalyticsEvent[]> {
    let query = supabase
      .from('analytics')
      .select('*')
      .order('timestamp', { ascending: false });

    if (params.from) {
      query = query.gte('timestamp', params.from.toISOString());
    }
    if (params.to) {
      query = query.lte('timestamp', params.to.toISOString());
    }
    if (params.channel) {
      query = query.eq('channel', params.channel);
    }
    if (params.eventType) {
      query = query.eq('event_type', params.eventType);
    }
    if (params.limit) {
      query = query.limit(params.limit);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  },

  async getStats(from: Date, to: Date): Promise<{
    totalMessages: number;
    totalCalls: number;
    uniqueUsers: number;
    tokensByDay: { date: string; tokens: number }[];
  }> {
    const { data, error } = await supabase
      .from('analytics')
      .select('event_type, user_id, data, timestamp')
      .gte('timestamp', from.toISOString())
      .lte('timestamp', to.toISOString());

    if (error) throw error;

    const events = data ?? [];
    const uniqueUsers = new Set(events.map((e) => e.user_id).filter(Boolean));

    // Group tokens by day
    const tokensByDay = events
      .filter((e) => e.event_type === 'ai_response')
      .reduce((acc, e) => {
        const date = new Date(e.timestamp).toISOString().split('T')[0];
        const tokens = (e.data as { tokens?: number })?.tokens ?? 0;
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
        (e) => e.event_type === 'message_received' || e.event_type === 'message_sent'
      ).length,
      totalCalls: events.filter((e) => e.event_type === 'call_started').length,
      uniqueUsers: uniqueUsers.size,
      tokensByDay: tokensByDay.sort((a, b) => a.date.localeCompare(b.date)),
    };
  },
};
