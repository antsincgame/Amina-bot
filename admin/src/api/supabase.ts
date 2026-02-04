import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Environment variables (set in Render Dashboard)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Validate environment variables
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Render Dashboard.'
  );
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);

// Re-export types from shared (single source of truth)
export type {
  Settings as Setting,
  Prompt,
  AnalyticsEvent,
  AnalyticsEventType,
} from '../../../shared/types/index.js';

// Import types for internal use
import type { Settings, Prompt, AnalyticsEvent } from '../../../shared/types/index.js';

// Settings API
export const settingsApi = {
  async getAll(): Promise<Settings[]> {
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
    return (data ?? []) as AnalyticsEvent[];
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

// Service Status API (calls bot backend)
export const statusApi = {
  async getServiceStatus(): Promise<{
    checks: Record<string, { ready: boolean; engine: string }>;
    timestamp: string;
  }> {
    // In production, this would call the bot API
    // For now, return mock data that admin can display
    const botUrl = import.meta.env.VITE_BOT_URL || '';
    
    if (botUrl) {
      try {
        const response = await fetch(`${botUrl}/api/status`);
        if (response.ok) {
          return response.json();
        }
      } catch {
        // Bot not reachable, return degraded status
      }
    }

    // Fallback: check what we can from admin side
    return {
      checks: {
        admin: { ready: true, engine: 'React' },
        database: { ready: true, engine: 'Supabase' },
        telegram: { ready: false, engine: 'Unknown' },
        ai: { ready: false, engine: 'Unknown' },
        voximplant: { ready: false, engine: 'Unknown' },
      },
      timestamp: new Date().toISOString(),
    };
  },
};
