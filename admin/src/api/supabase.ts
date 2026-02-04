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

// Bot API URL
const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

// Settings API - uses bot backend (has service_role access)
export const settingsApi = {
  async getAll(): Promise<Settings[]> {
    // Try bot API first (more reliable)
    try {
      const response = await fetch(`${BOT_URL}/api/settings`);
      if (response.ok) {
        const result = await response.json();
        return result.data ?? [];
      }
    } catch {
      // Fall back to direct Supabase
    }
    
    // Fallback to Supabase
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .order('key');

    if (error) throw error;
    return data ?? [];
  },

  async update(key: string, value: string): Promise<void> {
    // Use bot API (has service_role access, bypasses RLS)
    const response = await fetch(`${BOT_URL}/api/settings/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to update setting');
    }
  },

  async updateMany(settings: Record<string, string>): Promise<void> {
    // Use bot API (has service_role access, bypasses RLS)
    const response = await fetch(`${BOT_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to update settings');
    }
  },
};

// Prompts API - uses bot backend (has service_role access)
export const promptsApi = {
  async getAll(): Promise<Prompt[]> {
    // Try bot API first
    try {
      const response = await fetch(`${BOT_URL}/api/prompts`);
      if (response.ok) {
        const result = await response.json();
        return result.data ?? [];
      }
    } catch {
      // Fall back to direct Supabase
    }
    
    // Fallback
    const { data, error } = await supabase
      .from('prompts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  },

  async create(prompt: Omit<Prompt, 'id' | 'created_at' | 'updated_at'>): Promise<Prompt> {
    const response = await fetch(`${BOT_URL}/api/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to create prompt');
    }
    
    const result = await response.json();
    return result.data;
  },

  async update(id: string, updates: Partial<Omit<Prompt, 'id' | 'created_at'>>): Promise<Prompt> {
    const response = await fetch(`${BOT_URL}/api/prompts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to update prompt');
    }
    
    const result = await response.json();
    return result.data;
  },

  async delete(id: string): Promise<void> {
    const response = await fetch(`${BOT_URL}/api/prompts/${id}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to delete prompt');
    }
  },

  async setActive(id: string): Promise<void> {
    const response = await fetch(`${BOT_URL}/api/prompts/${id}/activate`, {
      method: 'POST',
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to activate prompt');
    }
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
      },
      timestamp: new Date().toISOString(),
    };
  },
};
