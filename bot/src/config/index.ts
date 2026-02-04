import { z } from 'zod';
import * as dotenv from 'dotenv';

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

  // Groq (for free Whisper transcription)
  GROQ_API_KEY: z.string().optional(),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_KEY: z.string().min(1, 'SUPABASE_SERVICE_KEY is required'),

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
    model: env.OPENROUTER_MODEL || 'openrouter/free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxTokens: 2048,
    temperature: 0.7,
  },

  // Groq (free Whisper transcription)
  groq: {
    apiKey: env.GROQ_API_KEY,
    baseUrl: 'https://api.groq.com/openai/v1',
  },

  // Supabase Database
  db: {
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  },
} as const;

export type Config = typeof config;
