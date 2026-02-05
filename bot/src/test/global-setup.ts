/**
 * Vitest Global Setup
 * Runs BEFORE worker threads are spawned — env vars are inherited
 */
export default function globalSetup() {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.OPENROUTER_API_KEY = 'test-api-key';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
}
