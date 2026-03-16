/**
 * Tests for OpenRouter AI Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies BEFORE importing the module
vi.mock('../config/index.js', () => ({
  config: {
    ai: {
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://openrouter.ai/api/v1',
      maxTokens: 2048,
      temperature: 0.7,
    },
    isDev: false,
    isProd: false,
  },
  getApiKeys: vi.fn().mockResolvedValue({
    openrouter: 'test-openrouter-key',
    groq: 'test-groq-key',
  }),
}));

vi.mock('../config/logger.js', () => ({
  aiLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db/index.js', () => ({
  settingsRepo: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    getMany: vi.fn().mockResolvedValue({}),
  },
  promptsRepo: {
    getActive: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../utils/validation.js', () => ({
  validateChannel: vi.fn((c: string) => c),
  validateMessageContent: vi.fn((c: string) => c),
  MAX_MESSAGE_LENGTH: 10000,
}));

vi.mock('../utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    handleAIError: vi.fn(),
  };
});

// Mock OpenAI
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
}));

// Mock fetch for fetchFreeModels
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { aiService, getFallbackModels, getFallbackStatus, refreshFreeModelsCache } from './openrouter.js';
import { AppError } from '../utils/error-handler.js';

describe('OpenRouter AI Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  describe('aiService.chat', () => {
    it('should return response from primary model on success', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const result = await aiService.chat([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Hello!');
      expect(result.model).toBe('test-model');
      expect(result.tokens_used.total).toBe(15);
    });

    it('should throw AppError on 401 (auth error)', async () => {
      mockCreate.mockRejectedValueOnce(new Error('401 Unauthorized'));

      try {
        await aiService.chat([{ role: 'user', content: 'Hi' }]);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('AUTH_ERROR');
      }
    });

    it('should throw AppError on 429 (rate limit)', async () => {
      mockCreate.mockRejectedValueOnce(new Error('429 rate limit exceeded'));

      await expect(
        aiService.chat([{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow(AppError);
    });

    it('should include system prompt in messages', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await aiService.chat([{ role: 'user', content: 'Hi' }]);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].role).toBe('system');
      expect(callArgs.messages[1].content).toBe('Hi');
    });

    it('should support passthrough mode for internal tasks', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '[]' }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
      });

      await aiService.chat(
        [
          { role: 'system', content: 'Return JSON only' },
          { role: 'user', content: 'Translate this batch' },
        ],
        'telegram',
        undefined,
        {
          promptMode: 'passthrough',
          maxTokens: 111,
          temperature: 0.2,
        },
      );

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: 'system', content: 'Return JSON only' },
        { role: 'user', content: 'Translate this batch' },
      ]);
      expect(callArgs.max_tokens).toBe(111);
      expect(callArgs.temperature).toBe(0.2);
    });

    it('should handle empty response from AI', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      });

      // Empty response triggers race
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'free-model:free', pricing: { prompt: '0', completion: '0' }, context_length: 8000 },
          ],
        }),
      });

      // Race model also fails
      mockCreate.mockRejectedValueOnce(new Error('Empty response'));

      await expect(
        aiService.chat([{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow();
    });
  });

  describe('aiService.complete', () => {
    it('should return content string', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Result' }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });

      const result = await aiService.complete('Say hi');
      expect(result).toBe('Result');
    });
  });

  describe('aiService.testConnection', () => {
    it('should return true when AI responds with OK', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'OK, I can hear you.' }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      });

      const result = await aiService.testConnection();
      expect(result).toBe(true);
    });

    it('should return false when AI fails', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await aiService.testConnection();
      expect(result).toBe(false);
    });

    it('should return false when readiness check exceeds timeout', async () => {
      vi.useFakeTimers();
      mockCreate.mockImplementationOnce(() => new Promise(() => undefined));

      const resultPromise = aiService.testConnection(50);
      await vi.advanceTimersByTimeAsync(50);

      await expect(resultPromise).resolves.toBe(false);
    });
  });

  describe('getFallbackModels', () => {
    it('should return list of free models', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'model-a:free', pricing: { prompt: '0', completion: '0' }, context_length: 8000 },
            { id: 'model-b', pricing: { prompt: '0.001', completion: '0.002' }, context_length: 4096 },
          ],
        }),
      });

      const models = await getFallbackModels();
      expect(models.length).toBeGreaterThanOrEqual(1);
      expect(models[0]).toHaveProperty('id');
      expect(models[0]).toHaveProperty('name');
    });
  });
});
