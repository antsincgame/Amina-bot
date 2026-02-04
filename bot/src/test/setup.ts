/**
 * Vitest Setup File
 * 
 * Настройка тестового окружения
 */

import { vi, beforeAll, afterAll, afterEach } from 'vitest';

// Mock environment variables
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent'; // Отключить логи в тестах
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.OPENROUTER_API_KEY = 'test-api-key';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
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
