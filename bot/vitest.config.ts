import { defineConfig } from 'vitest/config';

// Set env vars at config time — inherited by worker threads
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'fatal';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.OPENROUTER_API_KEY = 'test-api-key';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
    setupFiles: ['./src/test/setup.ts'],
    globalSetup: ['./src/test/global-setup.ts'],
  },
});
