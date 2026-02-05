/**
 * Tests for Supabase Repositories
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();

const mockSupabaseClient = {
  from: mockFrom,
  rpc: mockRpc,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabaseClient),
}));

// Config is loaded from env vars set in test/setup.ts — no need to mock

vi.mock('../config/logger.js', () => ({
  dbLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../utils/validation.js', () => ({
  validateUserId: vi.fn((id: string) => id),
  validateChannel: vi.fn((ch: string) => ch),
  validateEventType: vi.fn((et: string) => et),
  validateLimit: vi.fn((l: number) => l),
  checkArraySize: vi.fn(),
  MAX_CONVERSATION_MESSAGES: 1000,
}));

vi.mock('../utils/error-handler.js', () => ({
  isNotFoundError: vi.fn((err: { code?: string }) => err?.code === 'PGRST116'),
  handleSupabaseError: vi.fn(),
}));

import { settingsRepo, promptsRepo, conversationsRepo, analyticsRepo } from './supabase.js';

// Helper to create chainable Supabase mock
function createQueryChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'order', 'limit', 'gte', 'lte', 'single'];
  
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  
  // Terminal methods return the result
  chain['single'] = vi.fn().mockResolvedValue(finalResult);
  // For non-single queries, make the chain resolve
  (chain as any).then = (resolve: (v: unknown) => void) => resolve(finalResult);

  return chain;
}

describe('Settings Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('settingsRepo.get', () => {
    it('should return value for existing key', async () => {
      const chain = createQueryChain({ data: { value: 'test-value' }, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await settingsRepo.get('test-key');
      expect(result).toBe('test-value');
      expect(mockFrom).toHaveBeenCalledWith('settings');
    });

    it('should return null for not found key', async () => {
      const chain = createQueryChain({ data: null, error: { code: 'PGRST116' } });
      mockFrom.mockReturnValue(chain);

      const result = await settingsRepo.get('missing-key');
      expect(result).toBeNull();
    });

    it('should throw on database error', async () => {
      const chain = createQueryChain({ data: null, error: { code: 'INTERNAL', message: 'DB error' } });
      mockFrom.mockReturnValue(chain);

      await expect(settingsRepo.get('key')).rejects.toThrow();
    });
  });

  describe('settingsRepo.set', () => {
    it('should upsert value', async () => {
      const chain = createQueryChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await expect(settingsRepo.set('key', 'value')).resolves.toBeUndefined();
      expect(mockFrom).toHaveBeenCalledWith('settings');
    });

    it('should throw on database error', async () => {
      const chain = createQueryChain({ data: null, error: { code: 'INTERNAL', message: 'DB error' } });
      mockFrom.mockReturnValue(chain);

      // Override upsert to return error
      chain.upsert = vi.fn().mockResolvedValue({ data: null, error: { code: 'INTERNAL', message: 'DB error' } });

      await expect(settingsRepo.set('key', 'value')).rejects.toThrow();
    });
  });

  describe('settingsRepo.getMany', () => {
    it('should return map of key-value pairs', async () => {
      const chain = createQueryChain({
        data: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
        error: null,
      });
      // Override to not use single()
      chain.in = vi.fn().mockResolvedValue({
        data: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      const result = await settingsRepo.getMany(['a', 'b']);
      expect(result).toEqual({ a: '1', b: '2' });
    });
  });
});

describe('Conversations Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('conversationsRepo.addMessage', () => {
    it('should use RPC for atomic append', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      const message = {
        role: 'user' as const,
        content: 'Hello',
        timestamp: new Date().toISOString(),
      };

      await conversationsRepo.addMessage('conv-123', message);
      expect(mockRpc).toHaveBeenCalledWith('append_conversation_message', {
        conversation_id: 'conv-123',
        new_message: message,
      });
    });

    it('should fallback to read-modify-write when RPC fails', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'FUNCTION_NOT_FOUND' } });

      // Mock fallback: get messages then update
      const getChain = createQueryChain({ data: { messages: [] }, error: null });
      const updateChain = createQueryChain({ data: null, error: null });
      
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return getChain; // select
        return updateChain; // update
      });

      const message = {
        role: 'user' as const,
        content: 'Hello',
        timestamp: new Date().toISOString(),
      };

      await conversationsRepo.addMessage('conv-123', message);
    });
  });

  describe('conversationsRepo.clearMessages', () => {
    it('should reset messages to empty array', async () => {
      const chain = createQueryChain({ data: null, error: null });
      chain.update = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockResolvedValue({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await conversationsRepo.clearMessages('conv-123');
      expect(mockFrom).toHaveBeenCalledWith('conversations');
    });
  });
});

describe('Analytics Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('analyticsRepo.log', () => {
    it('should insert analytics event without throwing', async () => {
      const chain = createQueryChain({ data: null, error: null });
      chain.insert = vi.fn().mockResolvedValue({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      // Should not throw even if insert fails
      await expect(
        analyticsRepo.log('message_received', 'telegram', { userId: '123' })
      ).resolves.toBeUndefined();
    });

    it('should not throw on database error (fire-and-forget)', async () => {
      const chain = createQueryChain({ data: null, error: { code: 'ERR', message: 'fail' } });
      chain.insert = vi.fn().mockResolvedValue({ data: null, error: { code: 'ERR', message: 'fail' } });
      mockFrom.mockReturnValue(chain);

      await expect(
        analyticsRepo.log('error', 'telegram', { error: 'test' })
      ).resolves.toBeUndefined();
    });
  });

  describe('analyticsRepo.getStats', () => {
    it('should aggregate events by type', async () => {
      const events = [
        { event_type: 'message_received', user_id: '1', data: {}, timestamp: '2026-01-01T00:00:00Z' },
        { event_type: 'message_received', user_id: '2', data: {}, timestamp: '2026-01-01T01:00:00Z' },
        { event_type: 'ai_response', user_id: '1', data: { tokens: 100 }, timestamp: '2026-01-01T00:00:00Z' },
      ];

      const chain = createQueryChain({ data: events, error: null });
      chain.gte = vi.fn().mockReturnValue(chain);
      chain.lte = vi.fn().mockResolvedValue({ data: events, error: null });
      mockFrom.mockReturnValue(chain);

      const stats = await analyticsRepo.getStats(
        new Date('2026-01-01'),
        new Date('2026-01-02')
      );

      expect(stats.totalMessages).toBe(2);
      expect(stats.uniqueUsers).toBe(2);
      expect(stats.tokensByDay).toHaveLength(1);
    });
  });
});
