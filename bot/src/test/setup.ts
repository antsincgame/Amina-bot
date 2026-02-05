/**
 * Vitest Setup File
 * 
 * Настройка тестового окружения
 */

import { vi, beforeAll, afterAll, afterEach } from 'vitest';

// Set env vars IMMEDIATELY (before any module imports parse them)
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'fatal';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.OPENROUTER_API_KEY = 'test-api-key';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

beforeAll(() => {
  // Env vars already set above
});

// Clear all mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});

// Cleanup after all tests
afterAll(() => {
  vi.restoreAllMocks();
});

// Mock console to prevent noise in tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'debug').mockImplementation(() => {});

// Keep console.error for debugging
// vi.spyOn(console, 'error').mockImplementation(() => {});
