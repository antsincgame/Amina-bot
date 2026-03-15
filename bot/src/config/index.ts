import { z } from 'zod';
import * as dotenv from 'dotenv';

// Load environment variables
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botRoot = resolve(__dirname, '../..');

// Load .env
dotenv.config({ path: resolve(botRoot, '.env') });
// Load .env.test with override ONLY in test environments
if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: resolve(botRoot, '.env.test'), override: true });
}

// --------------------------------------------
// Environment Schema Validation
// --------------------------------------------

const envSchema = z.object({
  // DB backend switch: 'supabase' | 'appwrite'
  DB_BACKEND: z.enum(['supabase', 'appwrite']).default('supabase'),

  // Supabase — если не заданы, бот стартует без БД
  SUPABASE_URL: z.string().url().default('https://placeholder.supabase.co'),
  SUPABASE_SERVICE_KEY: z.string().default('placeholder'),

  // Appwrite (required when DB_BACKEND=appwrite)
  APPWRITE_ENDPOINT: z.string().url().default('https://appwrite.vibecoding.by/v1'),
  APPWRITE_PROJECT_ID: z.string().default('69af2faa003646d3574c'),
  APPWRITE_API_KEY: z.string().default(''),
  APPWRITE_DATABASE_ID: z.string().default('amina'),

  // Всё остальное можно задать в админке (API Ключи)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3-haiku'),
  GROQ_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(), // Для веб-поиска

  // Server
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),
  TZ: z.string().default('UTC'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Webhook (optional — empty string or missing treated as undefined)
  WEBHOOK_URL: z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().url().optional(),
  ),
  WEBHOOK_SECRET: z.string().optional(),
  LMSTUDIO_TUNNEL_TOKEN: z.string().optional(),

  // URLs для CORS, HTTP-Referer, ссылок в сообщениях (опционально)
  ADMIN_URL: z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().url().optional(),
  ),
  BOT_URL: z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().url().optional(),
  ),

  // LiraX telephony (optional — can also be set via admin panel settings)
  LIRAX_URL: z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().url().optional(),
  ),
  LIRAX_TOKEN: z.string().optional(),
  LIRAX_WEBHOOK_TOKEN: z.string().optional(),
  LIRAX_DEFAULT_EXT: z.string().optional(),
});

// --------------------------------------------
// Parse and Validate Environment
// --------------------------------------------

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = JSON.stringify(result.error.flatten().fieldErrors);

    if (process.env.NODE_ENV === 'test') {
      throw new Error(`Invalid env vars: ${errors}`);
    }

    if (process.env.NODE_ENV === 'production') {
      const backend = process.env.DB_BACKEND || 'supabase';
      if (backend === 'supabase' && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)) {
        throw new Error(
          `FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required in production (DB_BACKEND=supabase). ` +
          `Validation errors: ${errors}`
        );
      }
      if (backend === 'appwrite' && !process.env.APPWRITE_API_KEY) {
        throw new Error(
          `FATAL: APPWRITE_API_KEY is required in production (DB_BACKEND=appwrite). ` +
          `Validation errors: ${errors}`
        );
      }
    }

    const fallback = envSchema.safeParse({
      ...process.env,
      SUPABASE_URL: process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || 'placeholder',
    });
    if (fallback.success) return fallback.data;

    throw new Error(
      `FATAL: environment configuration is invalid and fallback failed. ` +
      `Set SUPABASE_URL and SUPABASE_SERVICE_KEY. Errors: ${errors}`
    );
  }

  return result.data;
};

// --------------------------------------------
// Configuration Object
// --------------------------------------------

const env = parseEnv();

// Токен Telegram: env или БД (устанавливается при старте в index.ts)
let resolvedTelegramToken: string = env.TELEGRAM_BOT_TOKEN || '';

import { getOpenRouterBaseUrl, getGroqBaseUrl, getPerplexityBaseUrl } from './ai-proxy.js';

// --------------------------------------------
// Static Config (from environment)
// --------------------------------------------

export const config = {
  // Environment
  isDev: env.NODE_ENV === 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  // Server
  server: {
    port: env.PORT,
    host: env.HOST,
    timeZone: env.TZ,
    logLevel: env.LOG_LEVEL,
  },

  /** URL админки (для CORS, ссылок в сообщениях). По умолчанию Render. */
  adminUrl: env.ADMIN_URL ?? 'https://amina-admin.onrender.com',

  /** URL бота (для HTTP-Referer, webhook LiraX). По умолчанию Render. */
  botUrl: env.BOT_URL ?? env.WEBHOOK_URL ?? 'https://amina-bot.onrender.com',

  // Telegram Bot — token из env или админки
  telegram: {
    get token(): string {
      return resolvedTelegramToken;
    },
    webhook: {
      url: env.WEBHOOK_URL,
      secret: env.WEBHOOK_SECRET,
    },
  },

  tunnel: {
    token: env.LMSTUDIO_TUNNEL_TOKEN || '',
  },

  /** Установить токен Telegram (при старте из БД) */
  setTelegramToken(token: string): void {
    resolvedTelegramToken = token;
  },

  // OpenRouter AI — может быть переопределён из админки
  ai: {
    apiKey: env.OPENROUTER_API_KEY || '', // Может быть пустым, загрузится из БД
    model: env.OPENROUTER_MODEL || 'openrouter/free',
    baseUrl: getOpenRouterBaseUrl(),
    maxTokens: 2048,
    temperature: 0.7,
  },

  // Groq — может быть переопределён из админки
  groq: {
    apiKey: env.GROQ_API_KEY || '', // Может быть пустым, загрузится из БД
    baseUrl: getGroqBaseUrl(),
  },

  // Perplexity — для веб-поиска (доступ в интернет)
  perplexity: {
    apiKey: env.PERPLEXITY_API_KEY || '', // Может быть пустым, загрузится из БД
    baseUrl: getPerplexityBaseUrl(),
  },

  // Database backend
  dbBackend: env.DB_BACKEND as 'supabase' | 'appwrite',

  // Supabase Database — только эти 2 обязательны в Render
  db: {
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  },

  // Appwrite Database
  appwrite: {
    endpoint: env.APPWRITE_ENDPOINT,
    projectId: env.APPWRITE_PROJECT_ID,
    apiKey: env.APPWRITE_API_KEY,
    databaseId: env.APPWRITE_DATABASE_ID,
  },
};

export type Config = typeof config;

// --------------------------------------------
// Dynamic API Keys (from database with env fallback)
// --------------------------------------------

// Кэш для API ключей из БД (SingleCache не используем — здесь ленивый импорт и struct)
import { SingleCache } from '../utils/cache.js';

const apiKeysCache = new SingleCache<{ openrouter: string; groq: string }>(60_000);

/**
 * Получить API ключи (приоритет: env → БД)
 */
export async function getApiKeys(): Promise<{ openrouter: string; groq: string }> {
  // Если в env уже заданы ключи — используем их
  if (config.ai.apiKey && config.groq.apiKey) {
    return { openrouter: config.ai.apiKey, groq: config.groq.apiKey };
  }

  // Проверяем кэш
  const cached = apiKeysCache.get();
  if (cached) {
    return {
      openrouter: cached.openrouter || config.ai.apiKey,
      groq: cached.groq || config.groq.apiKey,
    };
  }

  // Загружаем из БД (ленивый импорт чтобы избежать циклических зависимостей)
  try {
    const dbModule = config.dbBackend === 'appwrite'
      ? await import('../db/appwrite.js')
      : await import('../db/supabase.js');
    const keys = await dbModule.settingsRepo.getMany(['openrouter_api_key', 'groq_api_key']);

    const result = {
      openrouter: keys['openrouter_api_key'] || '',
      groq: keys['groq_api_key'] || '',
    };
    apiKeysCache.set(result);

    return {
      openrouter: config.ai.apiKey || result.openrouter,
      groq: config.groq.apiKey || result.groq,
    };
  } catch {
    return { openrouter: config.ai.apiKey, groq: config.groq.apiKey };
  }
}

/** Сбросить кэш API ключей (вызывать после обновления в админке) */
export function clearApiKeysCache(): void {
  apiKeysCache.clear();
}
