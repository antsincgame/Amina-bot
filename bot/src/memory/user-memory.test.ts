/**
 * Tests for User Memory Module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  memoryContextBuilder,
  userMemoryRepo,
  userProfileRepo,
  type UserProfile,
} from './user-memory.js';

function buildProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'profile-1',
    user_id: '123456',
    username: 'test',
    first_name: 'Test',
    last_name: undefined,
    language_code: 'ru',
    total_messages: 0,
    total_voice_messages: 0,
    total_images: 0,
    total_tokens_used: 0,
    first_seen_at: '2026-01-01T00:00:00Z',
    last_seen_at: '2026-01-01T00:00:00Z',
    last_message_at: undefined,
    preferences: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('memoryContextBuilder', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    memoryContextBuilder.invalidateCache('123456');
    memoryContextBuilder.invalidateCache('999888');
  });

  describe('buildContext', () => {
    it('returns profile-driven context when memory is empty', async () => {
      vi.spyOn(userProfileRepo, 'getOrCreate').mockResolvedValue(
        buildProfile({
          user_id: '123456',
          total_messages: 1,
        }),
      );
      vi.spyOn(userMemoryRepo, 'getContextForPrompt').mockResolvedValue('');

      const context = await memoryContextBuilder.buildContext('123456');

      expect(context).toContain('Имя: Test');
      expect(context).toContain('Всего сообщений: 1');
      expect(context).toContain('ОБЯЗАТЕЛЬНО используй имя пользователя "Test"');
      expect(context).not.toContain('ЧТО ТЫ ЗНАЕШЬ');
    });

    it('includes persisted memory context when it exists', async () => {
      vi.spyOn(userProfileRepo, 'getOrCreate').mockResolvedValue(
        buildProfile({
          user_id: '999888',
          first_name: 'Дима',
          username: 'dima',
          total_messages: 50,
          first_seen_at: '2026-01-01T00:00:00Z',
        }),
      );
      vi.spyOn(userMemoryRepo, 'getContextForPrompt').mockResolvedValue(
        'Пользователь любит Python\nПредпочитает краткие ответы',
      );

      const context = await memoryContextBuilder.buildContext('999888');

      expect(context).toContain('Имя: Дима');
      expect(context).toContain('ЧТО ТЫ ЗНАЕШЬ О ДИМА');
      expect(context).toContain('Пользователь любит Python');
      expect(context).toContain('Предпочитает краткие ответы');
    });
  });
});
