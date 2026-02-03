import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// --------------------------------------------
// Environment Schema Validation
// --------------------------------------------

const envSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required'),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3-haiku'),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_KEY: z.string().min(1, 'SUPABASE_SERVICE_KEY is required'),

  // Voximplant
  VOXIMPLANT_ACCOUNT_ID: z.string().optional(),
  VOXIMPLANT_API_KEY: z.string().optional(),
  VOXIMPLANT_APP_ID: z.string().optional(),
  VOXIMPLANT_APP_NAME: z.string().optional(),

  // Voice Models
  VOSK_MODEL_PATH: z.string().default('./models/vosk-model-small-ru-0.22'),
  SILERO_MODEL_PATH: z.string().default('./models/silero_tts'),

  // Server
  PORT: z.string().default('3000').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Webhook
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

export const config = {
  // Environment
  isDev: env.NODE_ENV === 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  // Server
  server: {
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
  },

  // Telegram Bot
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN,
    webhook: {
      url: env.WEBHOOK_URL,
      secret: env.WEBHOOK_SECRET,
    },
  },

  // OpenRouter AI
  ai: {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL,
    baseUrl: 'https://openrouter.ai/api/v1',
    maxTokens: 2048,
    temperature: 0.7,
  },

  // Supabase Database
  db: {
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  },

  // Voximplant Voice
  voximplant: {
    accountId: process.env['VOXIMPLANT_ACCOUNT_ID'] ?? '',
    apiKey: process.env['VOXIMPLANT_API_KEY'] ?? '',
    appId: process.env['VOXIMPLANT_APP_ID'] ?? '',
    appName: process.env['VOXIMPLANT_APP_NAME'] ?? 'amina-bot',
    enabled: Boolean(process.env['VOXIMPLANT_ACCOUNT_ID'] && process.env['VOXIMPLANT_API_KEY']),
  },

  // Voice Models (self-hosted)
  voice: {
    stt: {
      modelPath: env.VOSK_MODEL_PATH,
      sampleRate: 16000,
      language: 'ru',
    },
    tts: {
      modelPath: env.SILERO_MODEL_PATH,
      speaker: 'xenia',
      sampleRate: 48000,
      language: 'ru',
    },
  },
} as const;

export type Config = typeof config;
