/**
 * Tests for User Memory Module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDocumentMock = vi.fn();
const updateDocumentMock = vi.fn();
const listDocumentsMock = vi.fn();
const createDocumentMock = vi.fn();

vi.mock('../config/index.js', () => ({
  config: {
    appwrite: {
      databaseId: 'test-db',
    },
  },
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

vi.mock('../db/appwrite.js', () => ({
  getAppwrite: () => ({
    getDocument: getDocumentMock,
    updateDocument: updateDocumentMock,
    listDocuments: listDocumentsMock,
    createDocument: createDocumentMock,
  }),
}));

import {
  memoryContextBuilder,
  memoryExtractor,
  userMemoryRepo,
  userProfileRepo,
  type UserProfile,
} from './user-memory.js';
import { aiService } from '../ai/openrouter.js';

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
    getDocumentMock.mockReset();
    updateDocumentMock.mockReset();
    listDocumentsMock.mockReset();
    createDocumentMock.mockReset();
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
      expect(context).toContain('Всего взаимодействий: 1');
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

describe('userMemoryRepo cache invalidation', () => {
  beforeEach(() => {
    getDocumentMock.mockResolvedValue({ user_id: '123456' });
    updateDocumentMock.mockResolvedValue(undefined);
  });

  it('invalidates prompt cache after update', async () => {
    const invalidateSpy = vi.spyOn(memoryContextBuilder, 'invalidateCache');

    await userMemoryRepo.update('memory-1', { is_active: false });

    expect(updateDocumentMock).toHaveBeenCalledWith(
      'test-db',
      'amina_user_memory',
      'memory-1',
      expect.objectContaining({
        is_active: false,
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith('123456');
  });
});

describe('memoryExtractor.extractFacts — stated vs inferred', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDocumentsMock.mockReset();
    createDocumentMock.mockReset();
    updateDocumentMock.mockReset();
    // Нет существующих записей → без дедупа/лимита
    listDocumentsMock.mockResolvedValue({ documents: [], total: 0 });
    createDocumentMock.mockResolvedValue({ $id: 'mem-new', user_id: '123456' });
  });

  const memoryCreatePayload = (): Record<string, unknown> => {
    const call = createDocumentMock.mock.calls.find((c) => c[1] === 'amina_user_memory');
    if (!call) throw new Error('no amina_user_memory createDocument call');
    return call[3] as Record<string, unknown>;
  };

  it('сохраняет ЯВНО заявленный факт как подтверждённый (source=message, supersede)', async () => {
    vi.mocked(aiService.complete).mockResolvedValueOnce('Пользователя зовут Иван');

    await memoryExtractor.extractFacts('123456', 'Меня зовут Иван', 'Приятно познакомиться, Иван!');

    const payload = memoryCreatePayload();
    expect(payload.source).toBe('message');
    expect(payload.confidence).toBe(0.95);
    expect(payload.memory_type).toBe('fact');
  });

  it('сохраняет предпочтение с типом preference', async () => {
    vi.mocked(aiService.complete).mockResolvedValueOnce('Пользователь предпочитает краткие ответы');

    await memoryExtractor.extractFacts('123456', 'Я предпочитаю краткие ответы', 'Поняла, буду краткой.');

    const payload = memoryCreatePayload();
    expect(payload.source).toBe('message');
    expect(payload.memory_type).toBe('preference');
  });

  it('сохраняет догадку как inference/0.75', async () => {
    vi.mocked(aiService.complete).mockResolvedValueOnce('Пользователь, вероятно, интересуется котами');

    await memoryExtractor.extractFacts(
      '123456',
      'Сегодня видел рыжего кота во дворе, такой милый, долго на него смотрел',
      'Коты и правда чудесные!',
    );

    const payload = memoryCreatePayload();
    expect(payload.source).toBe('inference');
    expect(payload.confidence).toBe(0.75);
  });
});

describe('userMemoryRepo.add — supersedence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDocumentsMock.mockReset();
    createDocumentMock.mockReset();
    updateDocumentMock.mockReset();
    createDocumentMock.mockResolvedValue({ $id: 'mem-new', user_id: '123456' });
    updateDocumentMock.mockResolvedValue(undefined);
  });

  it('деактивирует устаревший факт той же темы при supersede', async () => {
    listDocumentsMock.mockResolvedValue({
      documents: [
        { $id: 'old-name', content: 'Пользователя зовут Игорь', is_pinned: false, is_active: true },
        { $id: 'unrelated', content: 'Пользователь работает программистом', is_pinned: false, is_active: true },
      ],
      total: 2,
    });

    await userMemoryRepo.add('123456', 'fact', 'Пользователя зовут Иван', {
      source: 'message', confidence: 0.95, supersede: true,
    });

    // Деактивирован только старый факт про имя, не про работу
    const deactivatedIds = updateDocumentMock.mock.calls
      .filter((c) => (c[3] as Record<string, unknown>).is_active === false)
      .map((c) => c[2]);
    expect(deactivatedIds).toContain('old-name');
    expect(deactivatedIds).not.toContain('unrelated');
    expect(createDocumentMock).toHaveBeenCalledTimes(1);
  });

  it('не деактивирует ничего без флага supersede', async () => {
    listDocumentsMock.mockResolvedValue({
      documents: [
        { $id: 'old-name', content: 'Пользователя зовут Игорь', is_pinned: false, is_active: true },
      ],
      total: 1,
    });

    await userMemoryRepo.add('123456', 'fact', 'Пользователя зовут Иван', {
      source: 'message', confidence: 0.95,
    });

    const deactivated = updateDocumentMock.mock.calls.filter(
      (c) => (c[3] as Record<string, unknown>).is_active === false,
    );
    expect(deactivated).toHaveLength(0);
  });
});
