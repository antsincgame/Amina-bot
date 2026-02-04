import { z } from 'zod';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// --------------------------------------------
// Environment Schema Validation
// --------------------------------------------

const envSchema = z.object({
  // Supabase — ЕДИНСТВЕННЫЕ обязательные в Render (без них бот не подключится к БД)
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_KEY: z.string().min(1, 'SUPABASE_SERVICE_KEY is required'),

  // Всё остальное можно задать в админке (API Ключи)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3-haiku'),
  GROQ_API_KEY: z.string().optional(),

  // Server
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Webhook (optional)
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),
});

// --------------------------------------------
// Parse and Validate Environment
// --------------------------------------------

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
};

// --------------------------------------------
// Configuration Object
// --------------------------------------------

const env = parseEnv();

// Токен Telegram: env или БД (устанавливается при старте в index.ts)
let resolvedTelegramToken: string = env.TELEGRAM_BOT_TOKEN || '';

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
    logLevel: env.LOG_LEVEL,
  },

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

  /** Установить токен Telegram (при старте из БД) */
  setTelegramToken(token: string): void {
    resolvedTelegramToken = token;
  },

  // OpenRouter AI — может быть переопределён из админки
  ai: {
    apiKey: env.OPENROUTER_API_KEY || '', // Может быть пустым, загрузится из БД
    model: env.OPENROUTER_MODEL || 'openrouter/free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxTokens: 2048,
    temperature: 0.7,
  },

  // Groq — может быть переопределён из админки
  groq: {
    apiKey: env.GROQ_API_KEY || '', // Может быть пустым, загрузится из БД
    baseUrl: 'https://api.groq.com/openai/v1',
  },

  // Supabase Database — только эти 2 обязательны в Render
  db: {
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  },
};

export type Config = typeof config;

// --------------------------------------------
// Dynamic API Keys (from database with env fallback)
// --------------------------------------------

// Кэш для API ключей из БД
let cachedApiKeys: {
  openrouter: string;
  groq: string;
  loadedAt: number;
} | null = null;

const API_KEYS_CACHE_TTL = 60 * 1000; // 1 минута

/**
 * Получить API ключи (приоритет: env → БД)
 * Используется для динамической загрузки ключей из админки
 */
export async function getApiKeys(): Promise<{ openrouter: string; groq: string }> {
  // Если в env уже заданы ключи — используем их
  if (config.ai.apiKey && config.groq.apiKey) {
    return {
      openrouter: config.ai.apiKey,
      groq: config.groq.apiKey,
    };
  }

  // Проверяем кэш
  const now = Date.now();
  if (cachedApiKeys && now - cachedApiKeys.loadedAt < API_KEYS_CACHE_TTL) {
    return {
      openrouter: cachedApiKeys.openrouter || config.ai.apiKey,
      groq: cachedApiKeys.groq || config.groq.apiKey,
    };
  }

  // Загружаем из БД (ленивый импорт чтобы избежать циклических зависимостей)
  try {
    const { settingsRepo } = await import('../db/supabase.js');
    const keys = await settingsRepo.getMany(['openrouter_api_key', 'groq_api_key']);
    
    cachedApiKeys = {
      openrouter: keys['openrouter_api_key'] || '',
      groq: keys['groq_api_key'] || '',
      loadedAt: now,
    };

    return {
      openrouter: cachedApiKeys.openrouter || config.ai.apiKey,
      groq: cachedApiKeys.groq || config.groq.apiKey,
    };
  } catch {
    // Если БД недоступна — используем env
    return {
      openrouter: config.ai.apiKey,
      groq: config.groq.apiKey,
    };
  }
}

/**
 * Сбросить кэш API ключей (вызывать после обновления в админке)
 */
export function clearApiKeysCache(): void {
  cachedApiKeys = null;
}
