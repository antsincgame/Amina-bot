import { Client, Account } from 'appwrite';

// Appwrite client for admin auth
const appwriteEndpoint = import.meta.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.vibecoding.by/v1';
const appwriteProjectId = import.meta.env.VITE_APPWRITE_PROJECT_ID || '69aa2114000211b48e63';

const client = new Client()
  .setEndpoint(appwriteEndpoint)
  .setProject(appwriteProjectId);

export const account = new Account(client);

// Re-export types from shared
export type {
  Settings as Setting,
  Prompt,
  AnalyticsEvent,
  AnalyticsEventType,
} from '../../../shared/types/index.js';

import type { Settings, Prompt, AnalyticsEvent } from '../../../shared/types/index.js';

// Bot API URL
const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

export async function fetchBotApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);

  try {
    const jwt = await account.createJWT();
    if (jwt?.jwt) {
      headers.set('Authorization', `Bearer ${jwt.jwt}`);
    }
  } catch {
    // No session — proceed without auth header
  }

  return fetch(`${BOT_URL}${path}`, { ...init, headers });
}

// Settings API
export const settingsApi = {
  async getAll(): Promise<Settings[]> {
    try {
      const response = await fetch(`${BOT_URL}/api/settings`);
      if (response.ok) {
        const result = await response.json();
        return result.data ?? [];
      }
    } catch {}
    return [];
  },

  async update(key: string, value: string): Promise<void> {
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

// Prompts API
export const promptsApi = {
  async getAll(): Promise<Prompt[]> {
    try {
      const response = await fetch(`${BOT_URL}/api/prompts`);
      if (response.ok) {
        const result = await response.json();
        return result.data ?? [];
      }
    } catch {}
    return [];
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
    const response = await fetch(`${BOT_URL}/api/prompts/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to delete prompt');
    }
  },

  async setActive(id: string): Promise<void> {
    const response = await fetch(`${BOT_URL}/api/prompts/${id}/activate`, { method: 'POST' });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to activate prompt');
    }
  },
};

// Analytics API — all through bot API
export const analyticsApi = {
  async getEvents(params: {
    from?: Date; to?: Date; channel?: string; eventType?: string; limit?: number;
  }): Promise<AnalyticsEvent[]> {
    const searchParams = new URLSearchParams();
    if (params.from) searchParams.set('from', params.from.toISOString());
    if (params.to) searchParams.set('to', params.to.toISOString());
    if (params.channel) searchParams.set('channel', params.channel);
    if (params.eventType) searchParams.set('eventType', params.eventType);
    if (params.limit) searchParams.set('limit', String(params.limit));

    const response = await fetch(`${BOT_URL}/api/analytics?${searchParams}`);
    if (!response.ok) return [];
    const result = await response.json();
    return result.data ?? [];
  },

  async getStats(_from: Date, _to: Date): Promise<{
    totalMessages: number; totalCalls: number; uniqueUsers: number;
    tokensByDay: { date: string; tokens: number }[];
  }> {
    try {
      const response = await fetch(`${BOT_URL}/api/stats`);
      if (response.ok) return response.json();
    } catch {}
    return { totalMessages: 0, totalCalls: 0, uniqueUsers: 0, tokensByDay: [] };
  },
};

// Service Status API
export const statusApi = {
  async getServiceStatus(): Promise<{
    checks: Record<string, { ready: boolean; engine: string }>;
    timestamp: string;
  }> {
    try {
      const response = await fetch(`${BOT_URL}/api/status`);
      if (response.ok) return response.json();
    } catch {}
    return {
      checks: {
        admin: { ready: true, engine: 'React' },
        database: { ready: false, engine: 'Unknown' },
        telegram: { ready: false, engine: 'Bot unavailable' },
        ai: { ready: false, engine: 'Bot unavailable' },
      },
      timestamp: new Date().toISOString(),
    };
  },
};

// News Sources API
export type {
  NewsSite, ParsedHeadline, NewsSourceType, NewsSourceCategory,
  NewsSourceLanguage, NewsSourceTier, JsonFieldMapping, HtmlFieldMapping,
} from '../../../shared/types/index.js';

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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sites),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to save news sites');
    }
  },

  async testParse(site: Partial<NewsSite> & { url: string }): Promise<{
    success: boolean; error?: string;
    data: { url: string; headlines: ParsedHeadline[]; count: number; parseTimeMs?: number };
  }> {
    const response = await fetch(`${BOT_URL}/api/news-sites/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(site),
    });
    if (!response.ok) throw new Error('Failed to test parse');
    return response.json();
  },

  async getPresets(): Promise<{
    all: NewsSite[]; global: NewsSite[]; asia: NewsSite[];
    counts: { all: number; global: number; asia: number };
  }> {
    const response = await fetch(`${BOT_URL}/api/news-sites/presets`);
    if (!response.ok) throw new Error('Failed to fetch presets');
    const result = await response.json();
    return {
      all: result.data?.all ?? [], global: result.data?.global ?? [], asia: result.data?.asia ?? [],
      counts: result.counts ?? { all: 0, global: 0, asia: 0 },
    };
  },

  async addPresets(group: 'all' | 'global' | 'asia' = 'all'): Promise<{ added: number; total: number; sites: NewsSite[]; group: string }> {
    const response = await fetch(`${BOT_URL}/api/news-sites/add-presets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group }),
    });
    if (!response.ok) throw new Error('Failed to add presets');
    const result = await response.json();
    return result.data;
  },
};

// Voice Messages API
export interface VoiceMessage {
  id: string; user_id: string; file_path: string; duration: number; file_size: number;
  transcription: string | null; telegram_file_id: string | null; created_at: string;
  username?: string; first_name?: string;
}

export interface VoiceMessagesStats {
  totalCount: number; totalSize: number; totalDuration: number;
  byUser: { user_id: string; count: number; totalDuration: number }[];
}

export const voiceMessagesApi = {
  async list(params: {
    userId?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number;
  } = {}): Promise<{ data: VoiceMessage[]; total: number }> {
    const sp = new URLSearchParams();
    if (params.userId) sp.set('userId', params.userId);
    if (params.dateFrom) sp.set('dateFrom', params.dateFrom);
    if (params.dateTo) sp.set('dateTo', params.dateTo);
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.offset) sp.set('offset', String(params.offset));
    const response = await fetch(`${BOT_URL}/api/voice-messages?${sp}`);
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

  async downloadArchive(params: { userId?: string; dateFrom?: string; dateTo?: string } = {}): Promise<Blob> {
    const response = await fetch(`${BOT_URL}/api/voice-messages/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Archive failed' }));
      throw new Error(err.error || 'Failed to create archive');
    }
    return response.blob();
  },
};
