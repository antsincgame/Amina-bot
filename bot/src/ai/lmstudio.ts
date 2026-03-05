import OpenAI from 'openai';
import { aiLogger } from '../config/logger.js';
import { settingsRepo } from '../db/supabase.js';
import { SingleCache } from '../utils/cache.js';

type AIProvider = 'auto' | 'lmstudio' | 'openrouter';

interface LMStudioConfig {
  url: string;
  model: string;
  apiKey: string;
}

interface LMStudioModel {
  id: string;
  name: string;
  owned_by: string;
}

const HEALTH_CACHE_TTL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 25_000;
const CONFIG_CACHE_TTL_MS = 60_000;
const DEFAULT_API_KEY = 'lm-studio';

const healthCache = new SingleCache<boolean>(HEALTH_CACHE_TTL_MS);
const configCache = new SingleCache<LMStudioConfig>(CONFIG_CACHE_TTL_MS);

let lmStudioClient: OpenAI | null = null;
let currentLmStudioUrl = '';
let currentLmStudioKey = '';

export async function getAIProvider(): Promise<AIProvider> {
  const value = await settingsRepo.get('ai_provider');
  if (value === 'lmstudio' || value === 'openrouter') return value;
  return 'auto';
}

export async function getLMStudioConfig(): Promise<LMStudioConfig | null> {
  const cached = configCache.get();
  if (cached) return cached;

  const settings = await settingsRepo.getMany([
    'lmstudio_url',
    'lmstudio_model',
    'lmstudio_api_key',
  ]);

  const url = settings['lmstudio_url']?.trim();
  if (!url) return null;

  const dbApiKey = settings['lmstudio_api_key']?.trim();
  const envApiKey = process.env.LMSTUDIO_API_KEY?.trim();
  const apiKey = envApiKey || dbApiKey || DEFAULT_API_KEY;

  const cfg: LMStudioConfig = {
    url: url.endsWith('/v1') ? url : `${url.replace(/\/+$/, '')}/v1`,
    model: settings['lmstudio_model']?.trim() || '',
    apiKey,
  };

  configCache.set(cfg);
  return cfg;
}

export function getLMStudioClient(cfg: LMStudioConfig): OpenAI {
  if (lmStudioClient && currentLmStudioUrl === cfg.url && currentLmStudioKey === cfg.apiKey) {
    return lmStudioClient;
  }

  lmStudioClient = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.url,
    timeout: 60_000,
  });
  currentLmStudioUrl = cfg.url;
  currentLmStudioKey = cfg.apiKey;
  aiLogger.info({ url: cfg.url }, 'LM Studio client initialized');
  return lmStudioClient;
}

const HEALTH_CHECK_HEADERS: Record<string, string> = {
  'User-Agent': 'Amina-Bot/1.0 (LM-Studio-Health)',
  Accept: 'application/json',
};

export async function checkLMStudioHealth(cfg: LMStudioConfig): Promise<boolean> {
  const cached = healthCache.get();
  if (cached !== null) return cached;

  const modelsUrl = cfg.url.endsWith('/v1')
    ? `${cfg.url}/models`
    : `${cfg.url}/v1/models`;

  const doFetch = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const headers: Record<string, string> = {
      ...HEALTH_CHECK_HEADERS,
      ...(cfg.apiKey && cfg.apiKey !== DEFAULT_API_KEY
        ? { Authorization: `Bearer ${cfg.apiKey}` }
        : {}),
    };

    try {
      const response = await fetch(modelsUrl, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const alive = response.ok;
      if (!alive) {
        aiLogger.info(
          { url: cfg.url, status: response.status, statusText: response.statusText },
          'LM Studio health check: non-OK response'
        );
      }
      if (alive) healthCache.set(true);
      return alive;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  };

  try {
    const alive = await doFetch();
    if (alive) healthCache.set(true);
    aiLogger.debug({ url: cfg.url, alive }, 'LM Studio health check');
    return alive;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && error.name === 'AbortError';
    aiLogger.info(
      { url: cfg.url, error: msg, timeout: isAbort },
      'LM Studio health check failed (Render may not reach Cloudflare tunnel)'
    );
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const retry = await doFetch();
      if (retry) {
        healthCache.set(true);
        aiLogger.info({ url: cfg.url }, 'LM Studio health check succeeded on retry');
      }
      return retry;
    } catch (retryErr) {
      return false;
    }
  }
}

export async function fetchLMStudioModels(cfg: LMStudioConfig): Promise<LMStudioModel[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  const modelsUrl = cfg.url.endsWith('/v1')
    ? `${cfg.url}/models`
    : `${cfg.url}/v1/models`;

  const headers: Record<string, string> = {
    ...HEALTH_CHECK_HEADERS,
    ...(cfg.apiKey && cfg.apiKey !== DEFAULT_API_KEY
      ? { Authorization: `Bearer ${cfg.apiKey}` }
      : {}),
  };

  try {
    let response: Response;
    try {
      response = await fetch(modelsUrl, {
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`LM Studio API error: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{ id: string; owned_by?: string }>;
    };

    if (!data?.data || !Array.isArray(data.data)) {
      throw new Error('Unexpected LM Studio API response format');
    }

    return data.data.map(m => ({
      id: m.id,
      name: m.id.split('/').pop()?.replace(/-/g, ' ') ?? m.id,
      owned_by: m.owned_by ?? 'local',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    aiLogger.error({ url: cfg.url, error: msg }, 'Failed to fetch LM Studio models');
    throw error;
  }
}

export function clearLMStudioCache(): void {
  healthCache.clear();
  configCache.clear();
  lmStudioClient = null;
  currentLmStudioUrl = '';
  currentLmStudioKey = '';
  aiLogger.info('LM Studio caches cleared');
}
