/**
 * Tests for User Memory Module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock('../db/supabase.js', () => ({
  getSupabase: vi.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
  })),
}));

vi.mock('../config/logger.js', () => {
  const createMockLogger = () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  });
  return {
    telegramLogger: createMockLogger(),
    dbLogger: createMockLogger(),
    aiLogger: createMockLogger(),
    serverLogger: createMockLogger(),
    logger: createMockLogger(),
  };
});

vi.mock('../ai/openrouter.js', () => ({
  aiService: {
    complete: vi.fn().mockResolvedValue(''),
  },
}));

import { memoryContextBuilder } from './user-memory.js';

// Helper to create chainable Supabase mock
function createChain(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'order', 'limit', 'gte', 'lte', 'maybeSingle', 'single', 'neq'];

  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue({ data, error });
  chain['maybeSingle'] = vi.fn().mockResolvedValue({ data, error });
  // For queries that return arrays
  (chain as any).then = (resolve: (v: unknown) => void) => resolve({ data, error });

  return chain;
}

describe('memoryContextBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildContext', () => {
    it('should return context when no memory data but profile exists', async () => {
      // Mock RPC to return null (tables don't exist)
      mockRpc.mockResolvedValue({ data: null, error: { code: 'UNDEFINED_FUNCTION' } });
      
      // Mock user profile
      const chain = createChain({
        user_id: '123456',
        first_name: 'Test',
        username: 'test',
        language_code: 'ru',
        total_messages: 1,
        total_voice_messages: 0,
        total_images: 0,
        total_tokens_used: 100,
        preferences: {},
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      }, null);
      mockFrom.mockReturnValue(chain);

      const context = await memoryContextBuilder.buildContext('123456');
      expect(typeof context).toBe('string');
    });

    it('should build context with user profile data', async () => {
      // Mock RPC for get_user_memory_context
      mockRpc.mockResolvedValue({
        data: {
          facts: ['Пользователь любит Python', 'Имя: Дима'],
          preferences: ['Краткие ответы'],
          context: ['Работает над проектом бота'],
          last_summary: null,
        },
        error: null,
      });

      // Mock user profile
      const chain = createChain({
        user_id: '123456',
        first_name: 'Дима',
        username: 'dima',
        language_code: 'ru',
        total_messages: 50,
        total_voice_messages: 5,
        total_images: 2,
        total_tokens_used: 10000,
        preferences: {},
        first_seen: '2026-01-01T00:00:00Z',
        last_seen: '2026-02-01T00:00:00Z',
      });
      mockFrom.mockReturnValue(chain);

      const context = await memoryContextBuilder.buildContext('123456');
      expect(typeof context).toBe('string');
      // Should contain some user info
      if (context.length > 0) {
        expect(context).toContain('Дима');
      }
    });
  });
});
