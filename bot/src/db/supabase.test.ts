import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase client
const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  upsert: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  lte: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn(),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabase),
}));

// Import after mocking
import { settingsRepo, promptsRepo, conversationsRepo, analyticsRepo } from './supabase.js';

describe('Settings Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get', () => {
    it('should return setting value when key exists', async () => {
      // Arrange
      mockSupabase.single.mockResolvedValue({
        data: { value: 'test_value' },
        error: null,
      });

      // Act
      const result = await settingsRepo.get('test_key');

      // Assert
      expect(result).toBe('test_value');
      expect(mockSupabase.from).toHaveBeenCalledWith('settings');
      expect(mockSupabase.eq).toHaveBeenCalledWith('key', 'test_key');
    });

    it('should return null when key does not exist', async () => {
      // Arrange
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116' },
      });

      // Act
      const result = await settingsRepo.get('nonexistent_key');

      // Assert
      expect(result).toBeNull();
    });

    it('should throw error on database error', async () => {
      // Arrange
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { code: 'DB_ERROR', message: 'Database error' },
      });

      // Act & Assert
      await expect(settingsRepo.get('test_key')).rejects.toThrow();
    });
  });

  describe('set', () => {
    it('should upsert setting value', async () => {
      // Arrange
      mockSupabase.upsert = vi.fn().mockReturnThis();
      mockSupabase.single.mockResolvedValue({ data: null, error: null });

      // Act
      await settingsRepo.set('test_key', 'new_value');

      // Assert
      expect(mockSupabase.from).toHaveBeenCalledWith('settings');
      expect(mockSupabase.upsert).toHaveBeenCalled();
    });
  });

  describe('getAll', () => {
    it('should return all settings ordered by key', async () => {
      // Arrange
      const settings = [
        { id: '1', key: 'key1', value: 'value1' },
        { id: '2', key: 'key2', value: 'value2' },
      ];
      mockSupabase.order.mockResolvedValue({ data: settings, error: null });

      // Act
      const result = await settingsRepo.getAll();

      // Assert
      expect(result).toEqual(settings);
      expect(mockSupabase.order).toHaveBeenCalledWith('key');
    });
  });
});

describe('Prompts Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getActive', () => {
    it('should return active prompt for channel', async () => {
      // Arrange
      const prompt = {
        id: '1',
        name: 'Test Prompt',
        content: 'Test content',
        is_active: true,
        channel: 'telegram',
      };
      mockSupabase.single.mockResolvedValue({ data: prompt, error: null });

      // Act
      const result = await promptsRepo.getActive('telegram');

      // Assert
      expect(result).toEqual(prompt);
      expect(mockSupabase.eq).toHaveBeenCalledWith('is_active', true);
    });

    it('should return null when no active prompt exists', async () => {
      // Arrange
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116' },
      });

      // Act
      const result = await promptsRepo.getActive('telegram');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should create new prompt and return it', async () => {
      // Arrange
      const newPrompt = {
        name: 'New Prompt',
        content: 'Content',
        is_active: false,
        channel: 'all' as const,
      };
      const createdPrompt = { id: '123', ...newPrompt };
      mockSupabase.single.mockResolvedValue({ data: createdPrompt, error: null });

      // Act
      const result = await promptsRepo.create(newPrompt);

      // Assert
      expect(result).toEqual(createdPrompt);
      expect(mockSupabase.insert).toHaveBeenCalledWith(newPrompt);
    });
  });
});

describe('Conversations Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrCreate', () => {
    it('should return existing conversation if found', async () => {
      // Arrange
      const existingConv = {
        id: '123',
        user_id: 'user1',
        channel: 'telegram',
        messages: [],
        metadata: {},
      };
      mockSupabase.single.mockResolvedValue({ data: existingConv, error: null });

      // Act
      const result = await conversationsRepo.getOrCreate(
        'user1',
        'telegram',
        { telegram_chat_id: 123 }
      );

      // Assert
      expect(result).toEqual(existingConv);
    });
  });
});

describe('Analytics Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('log', () => {
    it('should insert analytics event without throwing', async () => {
      // Arrange
      mockSupabase.insert = vi.fn().mockResolvedValue({ error: null });

      // Act & Assert - should not throw
      await expect(
        analyticsRepo.log('message_received', 'telegram', { test: true }, 'user1')
      ).resolves.not.toThrow();
    });

    it('should not throw on insert error (analytics should not break app)', async () => {
      // Arrange
      mockSupabase.insert = vi.fn().mockResolvedValue({
        error: { message: 'Insert failed' },
      });

      // Act & Assert - should not throw even on error
      await expect(
        analyticsRepo.log('error', 'telegram', { error: 'test' })
      ).resolves.not.toThrow();
    });
  });
});
