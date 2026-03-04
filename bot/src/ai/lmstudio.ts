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
const HEALTH_CHECK_TIMEOUT_MS = 8_000;
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

  const cfg: LMStudioConfig = {
    url: url.endsWith('/v1') ? url : `${url.replace(/\/+$/, '')}/v1`,
    model: settings['lmstudio_model']?.trim() || '',
    apiKey: settings['lmstudio_api_key']?.trim() || DEFAULT_API_KEY,
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

export async function checkLMStudioHealth(cfg: LMStudioConfig): Promise<boolean> {
  const cached = healthCache.get();
  if (cached !== null) return cached;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const modelsUrl = cfg.url.endsWith('/v1')
      ? `${cfg.url}/models`
      : `${cfg.url}/v1/models`;

    let response: Response;
    try {
      response = await fetch(modelsUrl, {
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const alive = response.ok;
    healthCache.set(alive);
    aiLogger.debug({ url: cfg.url, alive }, 'LM Studio health check');
    return alive;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    aiLogger.debug({ url: cfg.url, error: msg }, 'LM Studio health check failed');
    healthCache.set(false);
    return false;
  }
}

export async function fetchLMStudioModels(cfg: LMStudioConfig): Promise<LMStudioModel[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  const modelsUrl = cfg.url.endsWith('/v1')
    ? `${cfg.url}/models`
    : `${cfg.url}/v1/models`;

  try {
    let response: Response;
    try {
      response = await fetch(modelsUrl, {
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
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
