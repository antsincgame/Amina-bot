import { Client, Account } from 'appwrite';

// Appwrite client for admin auth
const appwriteEndpoint = import.meta.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.vibecoding.by/v1';
const appwriteProjectId = import.meta.env.VITE_APPWRITE_PROJECT_ID || '69af2faa003646d3574c';

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
const BOT_URL = import.meta.env.VITE_BOT_URL ?? '';

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

async function readApiError(response: Response, fallbackMessage: string): Promise<string> {
  const payload = await response.clone().json().catch(() => null) as { error?: string } | null;
  if (payload?.error) {
    return payload.error;
  }

  const text = await response.text().catch(() => '');
  return text || fallbackMessage;
}

async function fetchBotApiJson<T>(
  path: string,
  init: RequestInit = {},
  fallbackMessage = 'Request failed',
): Promise<T> {
  const response = await fetchBotApi(path, init);
  if (!response.ok) {
    throw new Error(await readApiError(response, fallbackMessage));
  }
  return response.json() as Promise<T>;
}

// Settings API
export const settingsApi = {
  async getAll(): Promise<Settings[]> {
    try {
      const result = await fetchBotApiJson<{ data?: Settings[] }>('/api/settings', {}, 'Failed to fetch settings');
      return result.data ?? [];
    } catch {}
    return [];
  },

  async update(key: string, value: string): Promise<void> {
    await fetchBotApiJson(`/api/settings/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }, 'Failed to update setting');
  },

  async updateMany(settings: Record<string, string>): Promise<void> {
    await fetchBotApiJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }, 'Failed to update settings');
  },
};

// Prompts API
export const promptsApi = {
  async getAll(): Promise<Prompt[]> {
    try {
      const result = await fetchBotApiJson<{ data?: Prompt[] }>('/api/prompts', {}, 'Failed to fetch prompts');
      return result.data ?? [];
    } catch {}
    return [];
  },

  async create(prompt: Omit<Prompt, 'id' | 'created_at' | 'updated_at'>): Promise<Prompt> {
    const result = await fetchBotApiJson<{ data: Prompt }>('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
    }, 'Failed to create prompt');
    return result.data;
  },

  async update(id: string, updates: Partial<Omit<Prompt, 'id' | 'created_at'>>): Promise<Prompt> {
    const result = await fetchBotApiJson<{ data: Prompt }>(`/api/prompts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }, 'Failed to update prompt');
    return result.data;
  },

  async delete(id: string): Promise<void> {
    await fetchBotApiJson(`/api/prompts/${id}`, { method: 'DELETE' }, 'Failed to delete prompt');
  },

  async setActive(id: string): Promise<void> {
    await fetchBotApiJson(`/api/prompts/${id}/activate`, { method: 'POST' }, 'Failed to activate prompt');
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

    try {
      const result = await fetchBotApiJson<{ data?: AnalyticsEvent[] }>(
        `/api/analytics?${searchParams}`,
        {},
        'Failed to fetch analytics events',
      );
      return result.data ?? [];
    } catch {
      return [];
    }
  },

  async getStats(from: Date, to: Date): Promise<{
    totalMessages: number; totalCalls: number; uniqueUsers: number;
    tokensByDay: { date: string; tokens: number }[];
  }> {
    try {
      const searchParams = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      });
      return await fetchBotApiJson(`/api/stats?${searchParams}`, {}, 'Failed to fetch analytics stats');
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
      return await fetchBotApiJson('/api/status', {}, 'Failed to fetch service status');
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
    const result = await fetchBotApiJson<{ data?: NewsSite[] }>('/api/news-sites', {}, 'Failed to fetch news sites');
    return result.data ?? [];
  },

  async save(sites: NewsSite[]): Promise<void> {
    await fetchBotApiJson('/api/news-sites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sites),
    }, 'Failed to save news sites');
  },

  async testParse(site: Partial<NewsSite> & { url: string }): Promise<{
    success: boolean; error?: string;
    data: { url: string; headlines: ParsedHeadline[]; count: number; parseTimeMs?: number };
  }> {
    return fetchBotApiJson('/api/news-sites/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(site),
    }, 'Failed to test parse');
  },

  async getPresets(): Promise<{
    all: NewsSite[]; global: NewsSite[]; asia: NewsSite[];
    counts: { all: number; global: number; asia: number };
  }> {
    const result = await fetchBotApiJson<{
      data?: { all?: NewsSite[]; global?: NewsSite[]; asia?: NewsSite[] };
      counts?: { all: number; global: number; asia: number };
    }>('/api/news-sites/presets', {}, 'Failed to fetch presets');
    return {
      all: result.data?.all ?? [], global: result.data?.global ?? [], asia: result.data?.asia ?? [],
      counts: result.counts ?? { all: 0, global: 0, asia: 0 },
    };
  },

  async addPresets(group: 'all' | 'global' | 'asia' = 'all'): Promise<{ added: number; total: number; sites: NewsSite[]; group: string }> {
    const result = await fetchBotApiJson<{ data: { added: number; total: number; sites: NewsSite[]; group: string } }>('/api/news-sites/add-presets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group }),
    }, 'Failed to add presets');
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
    const result = await fetchBotApiJson<{ data?: VoiceMessage[]; total?: number }>(
      `/api/voice-messages?${sp}`,
      {},
      'Failed to fetch voice messages',
    );
    return { data: result.data ?? [], total: result.total ?? 0 };
  },

  async stats(): Promise<VoiceMessagesStats> {
    const result = await fetchBotApiJson<{ data: VoiceMessagesStats }>(
      '/api/voice-messages/stats',
      {},
      'Failed to fetch voice stats',
    );
    return result.data;
  },

  async getDownloadUrl(id: string): Promise<string> {
    const result = await fetchBotApiJson<{ data: { url: string } }>(
      `/api/voice-messages/${id}/download`,
      {},
      'Failed to get download URL',
    );
    return result.data.url;
  },

  async downloadArchive(params: { userId?: string; dateFrom?: string; dateTo?: string } = {}): Promise<Blob> {
    const response = await fetchBotApi('/api/voice-messages/archive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      throw new Error(await readApiError(response, 'Failed to create archive'));
    }
    return response.blob();
  },
};
