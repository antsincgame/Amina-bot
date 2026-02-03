import { vi } from 'vitest';

// Mock environment variables
process.env.TELEGRAM_BOT_TOKEN = 'test_bot_token';
process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test_service_key';
process.env.NODE_ENV = 'test';

// Mock pino logger
vi.mock('pino', () => ({
  default: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));
