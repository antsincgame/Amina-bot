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
    // Call bot API for real status
    try {
      const response = await fetch(`${BOT_URL}/api/status`);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Bot not reachable
    }

    // Fallback when bot is unavailable
    return {
      checks: {
        admin: { ready: true, engine: 'React' },
        database: { ready: true, engine: 'Supabase' },
        telegram: { ready: false, engine: 'Bot unavailable' },
        ai: { ready: false, engine: 'Bot unavailable' },
      },
      timestamp: new Date().toISOString(),
    };
  },
};

// News Sources API (для дайджеста — парсинг новостей с сайтов)
// Re-export shared types
export type { NewsSite, ParsedHeadline, NewsSourceType, NewsSourceCategory, NewsSourceLanguage, JsonFieldMapping } from '../../../shared/types/index.js';

// Import for internal use
import type { NewsSite, ParsedHeadline } from '../../../shared/types/index.js';

export const newsSourcesApi = {
  async getAll(): Promise<NewsSite[]> {
    const response = await fetch(`${BOT_URL}/api/news-sites`);
    if (!response.ok) throw new Error('Failed to fetch news sites');
    const result = await response.json();
    return result.data ?? [];
  },

  async save(sites: NewsSite[]): Promise<void> {
    const response = await fetch(`${BOT_URL}/api/news-sites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sites),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to save news sites');
    }
  },

  async testParse(url: string): Promise<{
    success: boolean;
    error?: string;
    data: { url: string; headlines: ParsedHeadline[]; count: number; parseTimeMs?: number };
  }> {
    const response = await fetch(`${BOT_URL}/api/news-sites/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) throw new Error('Failed to test parse');
    return response.json();
  },

  async getPresets(): Promise<NewsSite[]> {
    const response = await fetch(`${BOT_URL}/api/news-sites/presets`);
    if (!response.ok) throw new Error('Failed to fetch presets');
    const result = await response.json();
    return result.data ?? [];
  },

  async addPresets(): Promise<{ added: number; total: number; sites: NewsSite[] }> {
    const response = await fetch(`${BOT_URL}/api/news-sites/add-presets`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Failed to add presets');
    const result = await response.json();
    return result.data;
  },
};

// Voice Messages API
export interface VoiceMessage {
  id: string;
  user_id: string;
  file_path: string;
  duration: number;
  file_size: number;
  transcription: string | null;
  telegram_file_id: string | null;
  created_at: string;
  username?: string;
  first_name?: string;
}

export interface VoiceMessagesStats {
  totalCount: number;
  totalSize: number;
  totalDuration: number;
  byUser: { user_id: string; count: number; totalDuration: number }[];
}

export const voiceMessagesApi = {
  async list(params: {
    userId?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ data: VoiceMessage[]; total: number }> {
    const searchParams = new URLSearchParams();
    if (params.userId) searchParams.set('userId', params.userId);
    if (params.dateFrom) searchParams.set('dateFrom', params.dateFrom);
    if (params.dateTo) searchParams.set('dateTo', params.dateTo);
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.offset) searchParams.set('offset', String(params.offset));

    const response = await fetch(`${BOT_URL}/api/voice-messages?${searchParams}`);
    if (!response.ok) throw new Error('Failed to fetch voice messages');
    const result = await response.json();
    return { data: result.data ?? [], total: result.total ?? 0 };
  },

  async stats(): Promise<VoiceMessagesStats> {
    const response = await fetch(`${BOT_URL}/api/voice-messages/stats`);
    if (!response.ok) throw new Error('Failed to fetch voice stats');
    const result = await response.json();
    return result.data;
  },

  async getDownloadUrl(id: string): Promise<string> {
    const response = await fetch(`${BOT_URL}/api/voice-messages/${id}/download`);
    if (!response.ok) throw new Error('Failed to get download URL');
    const result = await response.json();
    return result.data.url;
  },

  async downloadArchive(params: {
    userId?: string;
    dateFrom?: string;
    dateTo?: string;
  } = {}): Promise<Blob> {
    const response = await fetch(`${BOT_URL}/api/voice-messages/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Archive failed' }));
      throw new Error(err.error || 'Failed to create archive');
    }
    return response.blob();
  },
};
