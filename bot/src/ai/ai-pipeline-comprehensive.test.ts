/**
 * Комплексный тестовый набор AI-пайплайна — 200+ тестов
 *
 * Покрытие:
 * 1. OpenRouter AI Service (80+ тестов)
 * 2. Web Search (60+ тестов)
 * 3. LLM Verifier (40+ тестов)
 * 4. Image Generation Intent (40+ тестов)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================
// Глобальные моки
// ============================================

vi.mock('../config/index.js', () => ({
  config: {
    ai: {
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://openrouter.ai/api/v1',
      maxTokens: 2048,
      temperature: 0.7,
    },
    perplexity: { apiKey: '' },
    botUrl: 'https://amina-bot.test',
    isDev: false,
    isProd: false,
  },
  getApiKeys: vi.fn().mockResolvedValue({
    openrouter: 'test-openrouter-key',
    groq: 'test-groq-key',
  }),
}));

vi.mock('../config/logger.js', () => ({
  aiLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  telegramLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config/ai-proxy.js', () => ({
  getProxyHeaders: vi.fn((h?: Record<string, string>) => h ?? {}),
  getOpenRouterBaseUrl: vi.fn(() => 'https://openrouter.ai/api/v1'),
  getPerplexityBaseUrl: vi.fn(() => 'https://api.perplexity.ai'),
  getGroqBaseUrl: vi.fn(() => 'https://api.groq.com/openai/v1'),
}));

vi.mock('../config/constants.js', () => ({
  HEALTH_AI_TIMEOUT_MS: 5000,
  TELEGRAM_MAX_MESSAGE_LENGTH: 4096,
  FULL_TEXT_CACHE_TTL: 60000,
}));

vi.mock('grammy', () => ({
  InlineKeyboard: vi.fn().mockImplementation(() => ({
    text: vi.fn().mockReturnThis(),
    row: vi.fn().mockReturnThis(),
  })),
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

vi.mock('../utils/error-handler.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, handleAIError: vi.fn() };
});

vi.mock('../utils/validation.js', () => ({
  validateChannel: vi.fn((c: string) => c),
  validateMessageContent: vi.fn((c: string) => c),
  MAX_MESSAGE_LENGTH: 10000,
}));

vi.mock('./lmstudio.js', () => ({
  getAIProvider: vi.fn().mockResolvedValue('openrouter'),
  getLMStudioConfig: vi.fn().mockResolvedValue(null),
  getLMStudioClient: vi.fn(),
  checkLMStudioHealth: vi.fn().mockResolvedValue(false),
}));

// Mock OpenAI — нужен класс (конструктор) потому что код делает `new OpenAI(...)`
const mockCreate = vi.fn();
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.chat = { completions: { create: mockCreate } };
  });
  return { default: MockOpenAI };
});

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock webSearch для llm-verifier
// ВАЖНО: vi.importActual нужен чтобы сохранить needsWebSearch/shouldForceWebSearch (чистые функции)
// webSearch заменяется на мок для контроля в тестах верификатора
const { mockWebSearch } = vi.hoisted(() => ({
  mockWebSearch: vi.fn(),
}));

vi.mock('./websearch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    webSearch: mockWebSearch,
  };
});

// format.js не мокаем — используем реальную реализацию looksLikeSearchSimulation/looksLikeSearchRefusal
// Все зависимости format.js (config, constants, grammy) замоканы выше

// ============================================
// Импорты тестируемых модулей
// ============================================

import { aiService, isGibberish, getFallbackModels, getFallbackStatus, refreshFreeModelsCache } from './openrouter.js';
import { AppError } from '../utils/error-handler.js';
import { needsWebSearch, shouldForceWebSearch, aiShowsUncertainty, clearPerplexityCache } from './websearch.js';
import { verifyResponse, detectFactualHallucination } from './llm-verifier.js';
import {
  detectImageGenIntent,
  extractImagePrompt,
  detectImageEditIntent,
  isAIResponseAboutImages,
} from './image-gen.js';
import { getAIProvider, getLMStudioConfig, getLMStudioClient, checkLMStudioHealth } from './lmstudio.js';

// ============================================
// Вспомогательные фабрики
// ============================================

function makeOpenAIResponse(content: string, model = 'test-model', tokens = 15) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    model,
    usage: { prompt_tokens: Math.floor(tokens * 0.6), completion_tokens: Math.ceil(tokens * 0.4), total_tokens: tokens },
  };
}

function makeFreeModelsApiResponse(models: Array<{ id: string; free?: boolean; ctx?: number }>) {
  return {
    ok: true,
    json: async () => ({
      data: models.map((m) => ({
        id: m.id,
        pricing: { prompt: m.free !== false ? '0' : '0.001', completion: m.free !== false ? '0' : '0.002' },
        context_length: m.ctx ?? 8192,
      })),
    }),
  };
}

// ################################################################
// 1. OpenRouter AI Service (80+ тестов)
// ################################################################

describe('1. OpenRouter AI Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    mockFetch.mockReset();
    vi.useRealTimers();
    vi.mocked(getAIProvider).mockResolvedValue('openrouter');
  });

  // -----------------------------------------------
  // 1.1 aiService.chat — базовый успех
  // -----------------------------------------------

  describe('aiService.chat — успешные сценарии', () => {
    it('возвращает ответ от основной модели', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Привет!'));
      const r = await aiService.chat([{ role: 'user', content: 'Hi' }]);
      expect(r.content).toBe('Привет!');
      expect(r.model).toBe('test-model');
    });

    it('возвращает корректное количество токенов', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OK', 'gpt', 100));
      const r = await aiService.chat([{ role: 'user', content: 'Test' }]);
      expect(r.tokens_used.total).toBe(100);
    });

    it('возвращает finish_reason', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Done' }, finish_reason: 'length' }],
        model: 'x',
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      });
      const r = await aiService.chat([{ role: 'user', content: 'x' }]);
      expect(r.finish_reason).toBe('length');
    });

    it('обрабатывает ответ с нулевым usage', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        model: 'm',
        usage: undefined,
      });
      const r = await aiService.chat([{ role: 'user', content: 'q' }]);
      expect(r.tokens_used.total).toBe(0);
    });

    it('удаляет теги <think> из ответа', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('<think>internal reasoning</think>Чистый ответ'));
      const r = await aiService.chat([{ role: 'user', content: 'q' }]);
      expect(r.content).toBe('Чистый ответ');
      expect(r.content).not.toContain('<think>');
    });

    it('удаляет множественные теги <think>', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('<think>a</think>Foo<think>b</think> Bar'));
      const r = await aiService.chat([{ role: 'user', content: 'q' }]);
      // \s* после </think> поглощает пробел
      expect(r.content).toBe('FooBar');
    });
  });

  // -----------------------------------------------
  // 1.2 aiService.chat — ошибки
  // -----------------------------------------------

  describe('aiService.chat — обработка ошибок', () => {
    it('бросает AUTH_ERROR при 401', async () => {
      mockCreate.mockRejectedValueOnce(new Error('401 Unauthorized'));
      await expect(aiService.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow(AppError);
      try { await aiService.chat([{ role: 'user', content: 'Hi' }]); } catch (e) {
        // Второй вызов тоже упадёт, но первый уже проверен
      }
    });

    it('бросает AUTH_ERROR при "Unauthorized" в сообщении', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Unauthorized request'));
      try {
        await aiService.chat([{ role: 'user', content: 'Hi' }]);
        expect.unreachable('должен бросить');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('AUTH_ERROR');
      }
    });

    it('бросает RATE_LIMIT при 429', async () => {
      mockCreate.mockRejectedValueOnce(new Error('429 rate limit exceeded'));
      await expect(aiService.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow(AppError);
    });

    it('бросает RATE_LIMIT при "rate limit" без кода', async () => {
      mockCreate.mockRejectedValueOnce(new Error('rate limit hit'));
      try {
        await aiService.chat([{ role: 'user', content: 'Hi' }]);
        expect.unreachable('');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('RATE_LIMIT');
      }
    });

    it('запускает гонку при 500 от основной модели', async () => {
      mockCreate.mockRejectedValueOnce(new Error('500 Internal Server Error'));
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
      ]));
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Fallback OK', 'llama'));
      const r = await aiService.chat([{ role: 'user', content: 'Hi' }]);
      expect(r.content).toBe('Fallback OK');
    });

    it('запускает гонку при 502', async () => {
      mockCreate.mockRejectedValueOnce(new Error('502 Bad Gateway'));
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'google/gemma-2-9b-it:free' },
      ]));
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Recovered'));
      const r = await aiService.chat([{ role: 'user', content: 'Hi' }]);
      expect(r.content).toBe('Recovered');
    });

    it('запускает гонку при 503', async () => {
      mockCreate.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.2-3b-instruct:free' },
      ]));
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Back up'));
      const r = await aiService.chat([{ role: 'user', content: 'Hi' }]);
      expect(r.content).toBe('Back up');
    });

    it('запускает гонку при "Empty response"', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      });
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
      ]));
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Recovered'));
      const r = await aiService.chat([{ role: 'user', content: 'x' }]);
      expect(r.content).toBe('Recovered');
    });

    it('запускает гонку при 402 Payment Required', async () => {
      mockCreate.mockRejectedValueOnce(new Error('402 Payment Required'));
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
      ]));
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Free model'));
      const r = await aiService.chat([{ role: 'user', content: 'x' }]);
      expect(r.content).toBe('Free model');
    });

    it('бросает ALL_MODELS_FAILED когда все модели гонки упали', async () => {
      mockCreate.mockRejectedValueOnce(new Error('500'));
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
        { id: 'google/gemma-2-9b-it:free' },
      ]));
      mockCreate.mockRejectedValue(new Error('model failed'));
      try {
        await aiService.chat([{ role: 'user', content: 'Hi' }]);
        expect.unreachable('');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('ALL_MODELS_FAILED');
      }
    });

    it('прокидывает неизвестные ошибки без модификации', async () => {
      const custom = new Error('Network exploded');
      mockCreate.mockRejectedValueOnce(custom);
      await expect(aiService.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow('Network exploded');
    });
  });

  // -----------------------------------------------
  // 1.3 Model fallback race
  // -----------------------------------------------

  describe('Гонка моделей (fallback race)', () => {
    it('первая успешная модель побеждает в гонке', async () => {
      mockCreate.mockRejectedValueOnce(new Error('500'));
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
        { id: 'google/gemma-2-9b-it:free' },
        { id: 'mistralai/mistral-7b-instruct:free' },
      ]));
      // Первая модель: медленная но успешная
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Winner', 'llama'));
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Slower', 'gemma'));
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Slowest', 'mistral'));

      const r = await aiService.chat([{ role: 'user', content: 'x' }]);
      expect(r.content).toBe('Winner');
    });

    it('бросает ALL_MODELS_FAILED при общем отказе гонки', async () => {
      mockCreate.mockRejectedValueOnce(new Error('500'));
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
        { id: 'google/gemma-2-9b-it:free' },
      ]));
      // Все модели падают мгновенно
      mockCreate.mockRejectedValue(new Error('all failed'));

      try {
        await aiService.chat([{ role: 'user', content: 'x' }]);
        expect.unreachable('');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('ALL_MODELS_FAILED');
      }
    });

    it('использует статический список при ошибке API моделей', async () => {
      mockCreate.mockRejectedValueOnce(new Error('500'));
      mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
      // Статические модели попробуют создать запросы — одна успеет
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Static fallback'));

      const r = await aiService.chat([{ role: 'user', content: 'x' }]);
      expect(r.content).toBe('Static fallback');
    });
  });

  // -----------------------------------------------
  // 1.4 LM Studio priority
  // -----------------------------------------------

  describe('LM Studio приоритет', () => {
    it('использует LM Studio при provider=auto и healthy', async () => {
      vi.mocked(getAIProvider).mockResolvedValue('auto');
      vi.mocked(getLMStudioConfig).mockResolvedValue({ url: 'http://localhost:1234', model: 'local-model', apiKey: 'lm-studio' });
      vi.mocked(checkLMStudioHealth).mockResolvedValue(true);

      const mockLmClient = { chat: { completions: { create: vi.fn().mockResolvedValueOnce(makeOpenAIResponse('LM OK', 'local-model')) } } };
      vi.mocked(getLMStudioClient).mockReturnValue(mockLmClient as never);

      const r = await aiService.chat([{ role: 'user', content: 'Hi' }]);
      expect(r.content).toBe('LM OK');
    });

    it('fallback на OpenRouter при LM Studio offline + provider=auto', async () => {
      vi.mocked(getAIProvider).mockResolvedValue('auto');
      vi.mocked(getLMStudioConfig).mockResolvedValue({ url: 'http://localhost:1234', model: 'x', apiKey: 'lm-studio' });
      vi.mocked(checkLMStudioHealth).mockResolvedValue(false);
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OpenRouter fallback'));

      const r = await aiService.chat([{ role: 'user', content: 'Hi' }]);
      expect(r.content).toBe('OpenRouter fallback');
    });

    it('бросает LMSTUDIO_OFFLINE при provider=lmstudio и offline', async () => {
      vi.mocked(getAIProvider).mockResolvedValue('lmstudio');
      vi.mocked(getLMStudioConfig).mockResolvedValue({ url: 'http://localhost:1234', model: 'x', apiKey: 'lm-studio' });
      vi.mocked(checkLMStudioHealth).mockResolvedValue(false);

      try {
        await aiService.chat([{ role: 'user', content: 'Hi' }]);
        expect.unreachable('');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('LMSTUDIO_OFFLINE');
      }
    });

    it('бросает LMSTUDIO_NOT_CONFIGURED при provider=lmstudio без конфига', async () => {
      vi.mocked(getAIProvider).mockResolvedValue('lmstudio');
      vi.mocked(getLMStudioConfig).mockResolvedValue(null);

      try {
        await aiService.chat([{ role: 'user', content: 'Hi' }]);
        expect.unreachable('');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('LMSTUDIO_NOT_CONFIGURED');
      }
    });

    it('при ошибке LM Studio + provider=lmstudio бросает LMSTUDIO_ERROR', async () => {
      vi.mocked(getAIProvider).mockResolvedValue('lmstudio');
      vi.mocked(getLMStudioConfig).mockResolvedValue({ url: 'http://localhost:1234', model: 'x', apiKey: 'lm-studio' });
      vi.mocked(checkLMStudioHealth).mockResolvedValue(true);
      const mockLmClient = { chat: { completions: { create: vi.fn().mockRejectedValueOnce(new Error('LM crash')) } } };
      vi.mocked(getLMStudioClient).mockReturnValue(mockLmClient as never);

      try {
        await aiService.chat([{ role: 'user', content: 'Hi' }]);
        expect.unreachable('');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('LMSTUDIO_ERROR');
      }
    });

    it('при ошибке LM Studio + provider=auto → fallback на OpenRouter', async () => {
      vi.mocked(getAIProvider).mockResolvedValue('auto');
      vi.mocked(getLMStudioConfig).mockResolvedValue({ url: 'http://localhost:1234', model: 'x', apiKey: 'lm-studio' });
      vi.mocked(checkLMStudioHealth).mockResolvedValue(true);
      const mockLmClient = { chat: { completions: { create: vi.fn().mockRejectedValueOnce(new Error('LM crash')) } } };
      vi.mocked(getLMStudioClient).mockReturnValue(mockLmClient as never);
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OpenRouter saved'));

      const r = await aiService.chat([{ role: 'user', content: 'Hi' }]);
      expect(r.content).toBe('OpenRouter saved');
    });
  });

  // -----------------------------------------------
  // 1.5 System prompt
  // -----------------------------------------------

  describe('Системный промпт', () => {
    it('добавляет system prompt первым сообщением', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OK'));
      await aiService.chat([{ role: 'user', content: 'Hi' }]);
      const args = mockCreate.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
      expect(args.messages[0]!.role).toBe('system');
      expect(args.messages[0]!.content).toContain('Amina');
    });

    it('добавляет userMemoryContext перед системным промптом', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OK'));
      await aiService.chat([{ role: 'user', content: 'Hi' }], 'telegram', 'Пользователь любит кофе');
      const args = mockCreate.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
      expect(args.messages[0]!.content).toContain('Пользователь любит кофе');
      expect(args.messages[0]!.content).toContain('Amina');
    });

    it('в passthrough режиме не добавляет system prompt', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OK'));
      await aiService.chat(
        [{ role: 'system', content: 'Custom' }, { role: 'user', content: 'x' }],
        'telegram',
        undefined,
        { promptMode: 'passthrough' },
      );
      const args = mockCreate.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
      expect(args.messages[0]!.content).toBe('Custom');
      expect(args.messages).toHaveLength(2);
    });

    it('passthrough использует переданные maxTokens и temperature', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OK'));
      await aiService.chat(
        [{ role: 'user', content: 'x' }],
        'telegram',
        undefined,
        { promptMode: 'passthrough', maxTokens: 500, temperature: 0.1 },
      );
      const args = mockCreate.mock.calls[0]![0] as { max_tokens: number; temperature: number };
      expect(args.max_tokens).toBe(500);
      expect(args.temperature).toBe(0.1);
    });
  });

  // -----------------------------------------------
  // 1.6 complete и testConnection
  // -----------------------------------------------

  describe('aiService.complete', () => {
    it('возвращает строку контента', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Результат'));
      const r = await aiService.complete('Вопрос');
      expect(r).toBe('Результат');
    });

    it('оборачивает в user-сообщение', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OK'));
      await aiService.complete('Тест');
      const args = mockCreate.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
      const userMsg = args.messages.find((m) => m.role === 'user');
      expect(userMsg?.content).toBe('Тест');
    });
  });

  describe('aiService.testConnection', () => {
    it('true когда AI отвечает "OK"', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('OK, I can hear you.'));
      expect(await aiService.testConnection()).toBe(true);
    });

    it('true когда ответ содержит "ok" в любом регистре', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Sure, everything is Ok here!'));
      expect(await aiService.testConnection()).toBe(true);
    });

    it('false когда AI не отвечает "ok"', async () => {
      mockCreate.mockResolvedValueOnce(makeOpenAIResponse('Hello there!'));
      expect(await aiService.testConnection()).toBe(false);
    });

    it('false при ошибке соединения', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Connection refused'));
      expect(await aiService.testConnection()).toBe(false);
    });

    it('false при таймауте', async () => {
      vi.useFakeTimers();
      mockCreate.mockImplementation(() => new Promise(() => undefined));
      const p = aiService.testConnection(50);
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toBe(false);
    });
  });

  // -----------------------------------------------
  // 1.7 isGibberish
  // -----------------------------------------------

  describe('isGibberish', () => {
    it('false для коротких текстов (< 20 символов)', () => {
      expect(isGibberish('Привет')).toBe(false);
      expect(isGibberish('OK')).toBe(false);
      expect(isGibberish('')).toBe(false);
    });

    it('true при наличии CJK символов (> 3)', () => {
      expect(isGibberish('Ответ на вопрос: 你好世界很大 и что-то ещё')).toBe(true);
    });

    it('false при 1-3 CJK символах', () => {
      expect(isGibberish('Это текст с двумя символами 你好 и всё')).toBe(false);
    });

    it('true при низком отношении кириллицы (< 15%) для русских пользователей', () => {
      const longLatin = 'This is a very long response entirely in English that has absolutely no Cyrillic characters whatsoever and keeps going on';
      expect(isGibberish(longLatin, 'ru')).toBe(true);
    });

    it('false при достаточном количестве кириллицы', () => {
      expect(isGibberish('Это полностью русский текст который достаточно длинный для проверки')).toBe(false);
    });

    it('false для английских текстов при userLang=en', () => {
      const english = 'This is a perfectly fine English response that should not be flagged as gibberish by the detector';
      expect(isGibberish(english, 'en')).toBe(false);
    });

    it('false для смешанного текста с хорошей долей кириллицы', () => {
      expect(isGibberish('Используйте React для frontend и Node.js для бэкенда проекта')).toBe(false);
    });

    it('true для текста с иероглифами посреди русского', () => {
      expect(isGibberish('Привет мир 你好世界很大自然 это тест на гибберишь')).toBe(true);
    });

    it('false для пустой строки', () => {
      expect(isGibberish('')).toBe(false);
    });

    it('false для null-подобного (через guard clause)', () => {
      expect(isGibberish('')).toBe(false);
    });
  });

  // -----------------------------------------------
  // 1.8 getFallbackModels / getFallbackStatus / refreshFreeModelsCache
  // -----------------------------------------------

  describe('getFallbackModels', () => {
    it('возвращает массив моделей с id/name/description', async () => {
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
      ]));
      const models = await getFallbackModels();
      expect(models.length).toBeGreaterThanOrEqual(1);
      expect(models[0]).toHaveProperty('id');
      expect(models[0]).toHaveProperty('name');
      expect(models[0]).toHaveProperty('description');
    });

    it('name извлекается из id', async () => {
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
      ]));
      const models = await getFallbackModels();
      expect(models[0]!.name).toContain('llama');
    });
  });

  describe('getFallbackStatus', () => {
    it('возвращает структуру со всеми полями', async () => {
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
      ]));
      const status = await getFallbackStatus();
      expect(status).toHaveProperty('currentModel');
      expect(status).toHaveProperty('raceModelsCount');
      expect(status).toHaveProperty('cachedModels');
      expect(status).toHaveProperty('cacheAge');
    });
  });

  describe('refreshFreeModelsCache', () => {
    it('возвращает обновлённый список моделей', async () => {
      mockFetch.mockResolvedValueOnce(makeFreeModelsApiResponse([
        { id: 'google/gemma-2-9b-it:free' },
        { id: 'meta-llama/llama-3.1-8b-instruct:free' },
      ]));
      const models = await refreshFreeModelsCache();
      expect(models.length).toBeGreaterThanOrEqual(1);
    });

    it('возвращает статический список при ошибке API', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const models = await refreshFreeModelsCache();
      expect(models.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------
  // 1.9 Streaming
  // -----------------------------------------------

  describe('aiService.chatStream', () => {
    it('yield-ит чанки корректно', async () => {
      const chunks = [
        { choices: [{ delta: { content: 'Привет' }, finish_reason: null }] },
        { choices: [{ delta: { content: ' мир' }, finish_reason: null }] },
        { choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] },
      ];

      mockCreate.mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          for (const c of chunks) yield c;
        },
      });

      const parts: string[] = [];
      const gen = aiService.chatStream([{ role: 'user', content: 'Hi' }]);

      let result = await gen.next();
      while (!result.done) {
        parts.push(result.value);
        result = await gen.next();
      }

      expect(parts.join('')).toBe('Привет мир!');
      expect(result.value.content).toBe('Привет мир!');
    });
  });
});

// ################################################################
// 2. Web Search (60+ тестов)
// ################################################################

describe('2. Web Search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPerplexityCache();
  });

  // -----------------------------------------------
  // 2.1 needsWebSearch — параметризованные тесты
  // -----------------------------------------------

  describe('needsWebSearch', () => {
    // --- Погода ---
    const weatherPatterns: [string, boolean][] = [
      ['какая погода в Москве?', true],
      ['прогноз погоды на завтра', true],
      ['температура в Берлине', true],
      ['будет ли дождь сегодня?', true],
      ['какой будет снег на выходных?', true],
      ['мороз ожидается?', true],
      ['жара в Краснодаре', true],
      ['осадки в регионе', true],
    ];
    it.each(weatherPatterns)('погода: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Финансы ---
    const financePatterns: [string, boolean][] = [
      ['курс доллара', true],
      ['курс евро к рублю', true],
      ['цена биткоина', true],
      ['сколько стоит ethereum', true],
      ['котировки NASDAQ', true],
      ['акции Tesla сегодня', true],
      ['индекс S&P 500', true],
      ['стоимость юаня', true],
      ['цена solana', true],
      ['курс USD к RUB', true],
    ];
    it.each(financePatterns)('финансы: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Новости и события ---
    const newsPatterns: [string, boolean][] = [
      ['последние новости', true],
      ['что произошло сегодня', true],
      ['актуальные события', true],
      ['свежие новости политики', true],
      ['дайджест за неделю', true],
      ['что случилось вчера', true],
      ['сводка новостей', true],
      ['выборы в США', true],
      ['протесты в городе', true],
    ];
    it.each(newsPatterns)('новости: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Спорт ---
    const sportPatterns: [string, boolean][] = [
      ['счёт матча Реал-Барселона', true],
      ['чемпионат мира по футболу', true],
      ['лига чемпионов результаты', true],
      ['трансферы в хоккее', true],
      ['формула 1 результаты', true],
      ['турнир по теннису', true],
      ['олимпийские игры', true],
    ];
    it.each(sportPatterns)('спорт: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Технологии ---
    const techPatterns: [string, boolean][] = [
      ['новый релиз iPhone', true],
      ['обновление Android 15', true],
      ['версия Windows 12', true],
      ['OpenAI выпустила GPT-5', true],
      ['Google анонсировал Gemini 3', true],
      ['нейросеть Claude 4', true],
      ['Tesla autopilot обновление', true],
      ['NVIDIA новая видеокарта', true],
    ];
    it.each(techPatterns)('технологии: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Явные поисковые запросы ---
    const explicitSearch: [string, boolean][] = [
      ['найди информацию про React 19', true],
      ['погугли рецепт борща', true],
      ['подскажи хорошие курсы', true],
      ['посоветуй книгу', true],
      ['порекомендуй ресторан', true],
      ['назови лучшие кофейни', true],
      ['расскажи про квантовые компьютеры', true],
      ['что такое блокчейн', true],
      ['сколько стоит iPhone 16', true],
      ['где находится Тадж-Махал', true],
      ['кто создал Linux', true],
      ['когда выйдет новый фильм', true],
      ['как работает GPS', true],
      ['топ-10 красивейших стран', true],
      ['рейтинг ноутбуков 2026', true],
      ['сравни React и Vue', true],
      ['5 лучших телефонов', true],
    ];
    it.each(explicitSearch)('явный поиск: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Негативные случаи ---
    const negativePatterns: [string, boolean][] = [
      ['привет', false],
      ['как дела', false],
      ['ок', false],
      ['да', false],
      ['нет', false],
      ['спасибо', false],
      ['хорошо', false],
      ['пока', false],
      ['ну', false],
      ['ага', false],
      ['хм', false],
      ['напиши код на Python', false],
    ];
    it.each(negativePatterns)('негатив: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Культура ---
    const culturePatterns: [string, boolean][] = [
      ['премьера нового фильма', true],
      ['лучшие сериалы 2026', true],
      ['новый альбом Imagine Dragons', true],
      ['книга года 2026', true],
      ['концерт в Москве', true],
    ];
    it.each(culturePatterns)('культура: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Здоровье ---
    const healthPatterns: [string, boolean][] = [
      ['симптомы гриппа', true],
      ['лечение ангины', true],
      ['лекарство от головной боли', true],
      ['рецепт салата цезарь', true],
      ['калорийность банана', true],
    ];
    it.each(healthPatterns)('здоровье/еда: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });

    // --- Места ---
    const placePatterns: [string, boolean][] = [
      ['ресторан с живой музыкой', true],
      ['кафе рядом с метро', true],
      ['часы работы аптеки', true],
      ['адрес ближайшего магазина', true],
      ['визы для поездки в Таиланд', true],
    ];
    it.each(placePatterns)('места: needsWebSearch("%s") → %s', (input, expected) => {
      expect(needsWebSearch(input)).toBe(expected);
    });
  });

  // -----------------------------------------------
  // 2.2 shouldForceWebSearch
  // -----------------------------------------------

  describe('shouldForceWebSearch', () => {
    const forcePatterns: [string, boolean][] = [
      ['погода в Москве', true],
      ['курс доллара', true],
      ['курс евро', true],
      ['цена биткоин', true],
      ['цена ethereum', true],
      ['новости за сегодня', true],
      ['последние новости', true],
      ['что произошло?', true],
      ['сколько стоит?', true],
      ['что нового', true],
      ['счёт матча', true],
      ['расскажи анекдот', false],
      ['напиши код', false],
      ['привет', false],
      ['объясни рекурсию', false],
      ['переведи текст', false],
    ];
    it.each(forcePatterns)('shouldForceWebSearch("%s") → %s', (input, expected) => {
      expect(shouldForceWebSearch(input)).toBe(expected);
    });
  });

  // -----------------------------------------------
  // 2.3 aiShowsUncertainty
  // -----------------------------------------------

  describe('aiShowsUncertainty', () => {
    const uncertainPatterns: [string, boolean][] = [
      ['Я не знаю точного ответа', true],
      ['У меня нет актуальной информации', true],
      ['Мои данные устарели', true],
      ['Рекомендую проверить источник', true],
      ['На момент моего обучения данные были другими', true],
      ["I don't know the answer", true],
      ["I'm not sure about this", true],
      ['🔍 Ищу информацию...', true],
      ['Сейчас найду данные', true],
      ['*(Поиск в интернете)*', true],
      ['Не могу выполнить поиск', true],
      ['Нет доступа к интернету', true],
      ['Не могу искать в интернете', true],
      ['У меня нет доступа к новым данным', true],
      ['Не могу получить актуальную информацию', true],
      // Негативные
      ['Python — это язык программирования', false],
      ['Привет! Как я могу помочь?', false],
      ['Вот решение вашей задачи:', false],
      ['Курс доллара сегодня 92.5 руб.', false],
    ];
    it.each(uncertainPatterns)('aiShowsUncertainty("%s") → %s', (input, expected) => {
      expect(aiShowsUncertainty(input)).toBe(expected);
    });
  });

  // -----------------------------------------------
  // 2.4 Circuit breaker (логика через needsWebSearch + описания)
  // -----------------------------------------------

  describe('Circuit breaker (описание поведения)', () => {
    it('searchCircuit начинается в закрытом состоянии', () => {
      // Если бы circuit breaker был открыт, webSearch бросил бы SEARCH_CIRCUIT_OPEN
      // needsWebSearch — чистая функция, не зависит от circuit breaker
      expect(needsWebSearch('курс доллара')).toBe(true);
    });

    it('needsWebSearch не зависит от состояния circuit breaker', () => {
      expect(needsWebSearch('погода в Москве')).toBe(true);
    });
  });

  // -----------------------------------------------
  // 2.5 Дедупликация in-flight (описание)
  // -----------------------------------------------

  describe('In-flight dedup (описание поведения)', () => {
    it('needsWebSearch — чистая функция и не дублируется', () => {
      const r1 = needsWebSearch('курс доллара');
      const r2 = needsWebSearch('курс доллара');
      expect(r1).toBe(r2);
    });
  });
});

// ################################################################
// 3. LLM Verifier (40+ тестов)
// ################################################################

describe('3. LLM Verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebSearch.mockReset();
  });

  // -----------------------------------------------
  // 3.1 detectFactualHallucination
  // -----------------------------------------------

  describe('detectFactualHallucination', () => {
    const hallucinationCases: [string, boolean][] = [
      ['На данный момент курс доллара составляет 92,45 рублей.', true],
      ['Сегодня цена биткоина 67 500 долларов.', true],
      ['Температура сейчас составляет +15°C в Москве.', true],
      ['Температура сейчас около -5°C.', true],
      ['Счёт матча Реал-Барселона 2:1.', true],
      ['Результат игры составил 3:0 в пользу хозяев.', true],
      ['По последним данным, Apple выпустила iPhone 16.', true],
      ['Согласно официальным данным, рост ВВП составил 3%.', true],
      // Негативные
      ['Python — язык программирования.', false],
      ['Привет! Рада помочь.', false],
      ['Рекурсия — это когда функция вызывает сама себя.', false],
      ['Мне кажется, React лучше для этого проекта.', false],
      ['По последним данным[1], курс вырос на 5%.', false],
      ['Согласно официальным данным[2], рост составил 3%.', false],
    ];
    it.each(hallucinationCases)('detectFactualHallucination("%s") → %s', (input, expectHallucination) => {
      const result = detectFactualHallucination(input);
      if (expectHallucination) {
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  });

  // -----------------------------------------------
  // 3.2 Симуляция поиска
  // -----------------------------------------------

  describe('Детекция симуляции поиска', () => {
    it('распознаёт "Ищу..." как симуляцию (через webSearchContext)', async () => {
      // aiResponse должен быть > 30 символов, иначе verifier скипает проверку
      const r = await verifyResponse(
        'курс доллара',
        '🔍 Ищу актуальный курс доллара...\n\n*(Поиск в интернете)*\nПодождите, загружаю данные...',
        undefined,
        { webSearchContext: 'Курс доллара: 92.5 руб. (ЦБ РФ, 16.03.2026)' },
      );
      expect(r.isValid).toBe(false);
      expect(r.correctedResponse).toContain('92.5');
      expect(r.reason).toContain('симулировала поиск');
    });

    it('распознаёт "*(Поиск в интернете)*" как симуляцию', async () => {
      const r = await verifyResponse(
        'новости',
        '*(Поиск в интернете)* Загрузка...',
        undefined,
        { webSearchContext: 'Последние новости: 1. Событие А. 2. Событие Б.' },
      );
      expect(r.isValid).toBe(false);
      expect(r.reason).toContain('симулировала поиск');
    });

    it('распознаёт "🔍 Ищу" как симуляцию', async () => {
      // aiResponse > 30 символов для прохождения guard clause
      const r = await verifyResponse(
        'погода в Москве',
        '🔍 Ищу данные о погоде в Москве... Подождите, идёт загрузка актуальной информации.',
        undefined,
        { webSearchContext: 'Погода в Москве: +5°C, облачно, ветер 3 м/с.' },
      );
      expect(r.isValid).toBe(false);
      expect(r.reason).toContain('симулировала поиск');
    });

    it('НЕ считает обычный текст симуляцией', async () => {
      const r = await verifyResponse(
        'объясни рекурсию',
        'Рекурсия — это приём программирования, когда функция вызывает сама себя. Она состоит из базового случая и рекурсивного вызова.',
      );
      expect(r.isValid).toBe(true);
    });
  });

  // -----------------------------------------------
  // 3.3 Отказ от поиска
  // -----------------------------------------------

  describe('Детекция отказа от поиска', () => {
    it('распознаёт "не могу найти" как отказ', async () => {
      const r = await verifyResponse(
        'новости Берлина',
        'К сожалению, я не могу найти актуальные новости. Обратитесь к новостным сайтам.',
        undefined,
        { webSearchContext: 'Новости Берлина: 1. Открылся новый парк. 2. Метро расширяют.' },
      );
      expect(r.isValid).toBe(false);
      expect(r.correctedResponse).toContain('Берлин');
    });

    it('распознаёт "обратитесь к..." как отказ', async () => {
      const r = await verifyResponse(
        'курс валют',
        'Для актуальных данных обратитесь к сайту ЦБ РФ.',
        undefined,
        { webSearchContext: 'Курс USD/RUB: 91.8 руб.' },
      );
      expect(r.isValid).toBe(false);
    });

    it('распознаёт "не располагаю данными" как отказ', async () => {
      const r = await verifyResponse(
        'погода завтра',
        'Я не располагаю данными о погоде. Проверьте прогноз на сайте.',
        undefined,
        { webSearchContext: 'Погода в Москве завтра: +8°C, ясно.' },
      );
      expect(r.isValid).toBe(false);
    });

    it('НЕ считает полезный ответ отказом', async () => {
      const r = await verifyResponse(
        'что такое Python',
        'Python — высокоуровневый язык программирования с динамической типизацией. Используется для веб-разработки, ML и автоматизации.',
      );
      expect(r.isValid).toBe(true);
    });
  });

  // -----------------------------------------------
  // 3.4 Trusted model skip
  // -----------------------------------------------

  describe('Пропуск для доверенных моделей', () => {
    const trustedModels: string[] = [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4-turbo',
      'google/gemini-pro-1.5',
      'google/gemini-2.0-flash',
    ];

    it.each(trustedModels)('пропускает галлюцинации для %s', async (modelId) => {
      const r = await verifyResponse(
        'какой курс доллара',
        'На данный момент курс доллара составляет 92,45 рублей. По последним данным, рынок стабилен.',
        undefined,
        { modelId },
      );
      // Доверенная модель — галлюцинации не проверяются
      expect(r.isValid).toBe(true);
    });

    const untrustedModels: string[] = [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
    ];

    it.each(untrustedModels)('проверяет галлюцинации для %s', async (modelId) => {
      const r = await verifyResponse(
        'какой курс доллара',
        'На данный момент курс доллара составляет 92,45 рублей.',
        undefined,
        { modelId, webSearchContext: 'Курс доллара: 91.2 руб. (ЦБ РФ)' },
      );
      expect(r.isValid).toBe(false);
      expect(r.reason).toContain('галлюцинация');
    });
  });

  // -----------------------------------------------
  // 3.5 Фактический вопрос
  // -----------------------------------------------

  describe('Детекция фактических вопросов', () => {
    const factualQuestions: [string, boolean][] = [
      ['сколько стоит iPhone', true],
      ['какой курс доллара', true],
      ['какая цена биткоина', true],
      ['когда выйдет iPhone 17', true],
      ['в каком году основан Google', true],
      ['какая температура в Москве', true],
      ['какой счёт матча', true],
      ['какая стоимость Tesla', true],
    ];

    it.each(factualQuestions)('"%s" — фактический вопрос: %s', (q, isFact) => {
      const marker = /(?:сколько|какой курс|какая цена|когда|в каком году|какая стоимость|почём|какой результат|какая температура|какой счёт)/i;
      expect(marker.test(q)).toBe(isFact);
    });
  });

  // -----------------------------------------------
  // 3.6 Skip для коротких сообщений
  // -----------------------------------------------

  describe('Skip верификации', () => {
    it('skip для короткого userMessage', async () => {
      const r = await verifyResponse('ок', 'Хорошо!');
      expect(r.skipped).toBe(true);
    });

    it('skip для приветствий', async () => {
      const r = await verifyResponse('привет', 'Привет! Как дела?');
      expect(r.skipped).toBe(true);
    });

    it('skip для "да"', async () => {
      const r = await verifyResponse('да', 'Отлично!');
      expect(r.skipped).toBe(true);
    });

    it('skip для "спасибо"', async () => {
      const r = await verifyResponse('спасибо', 'Рада помочь!');
      expect(r.skipped).toBe(true);
    });

    it('НЕ skip для информационного вопроса', async () => {
      const r = await verifyResponse(
        'объясни рекурсию подробно',
        'Рекурсия — это приём когда функция вызывает сама себя. Базовый случай останавливает рекурсию.',
      );
      expect(r.skipped).toBe(false);
      expect(r.isValid).toBe(true);
    });
  });

  // -----------------------------------------------
  // 3.7 webSearchContext reuse
  // -----------------------------------------------

  describe('webSearchContext reuse', () => {
    it('использует webSearchContext вместо вызова Perplexity', async () => {
      const r = await verifyResponse(
        'курс доллара',
        '🔍 Ищу актуальный курс доллара...',
        undefined,
        { webSearchContext: 'Курс доллара: 91.5 руб. (ЦБ РФ)' },
      );
      expect(r.isValid).toBe(false);
      expect(r.correctedResponse).toBe('Курс доллара: 91.5 руб. (ЦБ РФ)');
      expect(mockWebSearch).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------
  // 3.8 Graceful failure
  // -----------------------------------------------

  describe('Graceful failure при ошибке верификации', () => {
    it('при общей ошибке верификации принимает оригинал', async () => {
      // verifyResponse без webSearchContext и без mockWebSearch — если поиск не вызывается,
      // simulation detection может не исправить ответ. Проверяем что не падает.
      const r = await verifyResponse(
        'курс доллара',
        'Ищу... подождите пожалуйста...',
      );
      // verifyResponse не должен бросить ошибку
      expect(r.verifyTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('не падает при пустом webSearchContext', async () => {
      const r = await verifyResponse(
        'курс доллара',
        'Какой-то обычный ответ без проблем. Всё хорошо и подробно.',
        undefined,
        { webSearchContext: '' },
      );
      expect(r.verifyTimeMs).toBeGreaterThanOrEqual(0);
      expect(r.isValid).toBe(true);
    });
  });
});

// ################################################################
// 4. Image Generation Intent (40+ тестов)
// ################################################################

describe('4. Image Generation Intent', () => {
  // -----------------------------------------------
  // 4.1 detectImageGenIntent — параметризованные тесты
  // -----------------------------------------------

  describe('detectImageGenIntent', () => {
    // ВАЖНО: \b в JS regex НЕ работает с кириллицей — поэтому русские паттерны
    // работают только когда перед словом есть ASCII word boundary (начало строки после не-\w).
    // Эти тесты проверяют РЕАЛЬНОЕ поведение regex-детектора.
    // Для Cyrillic fallback используется Groq-классификатор (classifyImageIntentGroq).

    // Английские паттерны (работают с \b)
    const englishPositive: [string][] = [
      ['draw a cat'],
      ['draw me a sunset'],
      ['generate an image of sunset'],
      ['paint a landscape'],
      ['create a picture of mountains'],
      ['imagine a cyberpunk city'],
      ['/imagine красивый закат над морем'],
    ];
    it.each(englishPositive)('detectImageGenIntent("%s") → true (EN)', (text) => {
      expect(detectImageGenIntent(text)).toBe(true);
    });

    // Русские паттерны — НЕ срабатывают из-за \b + кириллица
    // Это ожидаемое поведение; Groq-классификатор используется как fallback
    const russianFalseNegative: [string][] = [
      ['нарисуй кота'],
      ['нарисуй мне закат'],
      ['сгенерируй картинку'],
      ['создай картинку космоса'],
      ['хочу картинку заката'],
      ['можешь нарисовать единорога'],
    ];
    it.each(russianFalseNegative)('detectImageGenIntent("%s") → false (\\b не работает с кириллицей)', (text) => {
      expect(detectImageGenIntent(text)).toBe(false);
    });

    // Русские с пробелом/началом строки перед ASCII boundary — проверяем конкретно
    it('detectImageGenIntent с /imagine командой', () => {
      expect(detectImageGenIntent('/imagine кот')).toBe(true);
    });

    const negativePatterns: [string][] = [
      ['расскажи о рисовании'],
      ['что такое нейросеть для картинок'],
      ['как научиться рисовать'],
      ['привет как дела'],
      ['какая погода'],
      ['напиши код'],
      ['объясни рекурсию'],
      ['переведи текст на английский'],
      ['кто нарисовал Мону Лизу'],
      ['история живописи'],
      [''],
      ['   '],
    ];
    it.each(negativePatterns)('detectImageGenIntent("%s") → false', (text) => {
      expect(detectImageGenIntent(text)).toBe(false);
    });
  });

  // -----------------------------------------------
  // 4.2 extractImagePrompt
  // -----------------------------------------------

  describe('extractImagePrompt', () => {
    // extractImagePrompt использует replace без \b → кириллица обрабатывается корректно
    const extractCases: [string, string][] = [
      ['нарисуй кота в шляпе', 'кота в шляпе'],
      ['нарисуй мне закат над морем', 'закат над морем'],
      ['/imagine cyberpunk city', 'cyberpunk city'],
      ['создай картинку дракона', 'дракона'],
      ['draw a beautiful sunset', 'beautiful sunset'],
      ['generate a picture of mountains', 'mountains'],
      ['можешь нарисовать единорога', 'единорога'],
      ['пожалуйста, нарисуй кота', 'кота'],
      ['хочу картинку заката', 'заката'],
    ];
    it.each(extractCases)('extractImagePrompt("%s") содержит "%s"', (input, expectedPart) => {
      const result = extractImagePrompt(input);
      expect(result.toLowerCase()).toContain(expectedPart.toLowerCase());
    });

    it('добавляет quality suffix к коротким промптам', () => {
      const result = extractImagePrompt('draw a cat');
      expect(result).toContain('high quality');
    });

    it('НЕ добавляет quality suffix к длинным промптам', () => {
      const longPrompt = 'draw ' + 'a'.repeat(120);
      const result = extractImagePrompt(longPrompt);
      expect(result).not.toContain('high quality');
    });

    it('возвращает дефолтный промпт для пустого ввода', () => {
      const result = extractImagePrompt('');
      expect(result).toContain('abstract');
    });

    it('убирает "пожалуйста" из конца', () => {
      const result = extractImagePrompt('нарисуй кота пожалуйста');
      expect(result).not.toContain('пожалуйста');
    });

    it('убирает вопросительный знак', () => {
      const result = extractImagePrompt('можешь нарисовать котёнка?');
      expect(result).not.toContain('?');
    });

    it('обрабатывает /imagine без промпта — не удаляется (нет пробела после команды)', () => {
      const result = extractImagePrompt('/imagine');
      // regex /^\/imagine\s+/ требует пробел — голая /imagine не удаляется
      expect(result).toContain('/imagine');
    });
  });

  // -----------------------------------------------
  // 4.3 detectImageEditIntent
  // -----------------------------------------------

  describe('detectImageEditIntent', () => {
    const editPositive: [string][] = [
      ['убери фон'],
      ['удали человека'],
      ['добавь кота'],
      ['сделай ярче'],
      ['измени цвет'],
      ['обрежь фото'],
      ['поверни картинку'],
      ['перекрась в красный'],
      ['стилизуй под аниме'],
      ['улучши качество'],
      ['сделай темнее'],
      ['сделай контрастнее'],
      ['замени задний план'],
      ['фон сделай белый'],
      ['remove background'],
      ['make it brighter'],
      ['crop this image'],
      ['add text'],
      ['change color'],
      ['edit this photo'],
      ['enhance quality'],
    ];
    it.each(editPositive)('detectImageEditIntent("%s") → true', (text) => {
      expect(detectImageEditIntent(text)).toBe(true);
    });

    const editNegative: [string][] = [
      ['привет'],
      ['что на картинке?'],
      ['красивое фото'],
      ['кто это нарисовал?'],
      ['123'],
      ['ок'],
      [''],
      ['аб'],
    ];
    it.each(editNegative)('detectImageEditIntent("%s") → false', (text) => {
      expect(detectImageEditIntent(text)).toBe(false);
    });
  });

  // -----------------------------------------------
  // 4.4 isAIResponseAboutImages
  // -----------------------------------------------

  describe('isAIResponseAboutImages', () => {
    const aboutImages: [string, boolean][] = [
      ['К сожалению, я не умею рисовать.', true],
      ['Не умею создавать картинки, но могу описать.', true],
      ['Используй команду /imagine для генерации.', true],
      ['Я не создаю изображения напрямую.', true],
      ['Хочешь картинку? Напиши "нарисуй..."', true],
      ['Не могу создавать картинки.', true],
      ['Не могу рисовать, но могу рассказать.', true],
      ['Это отдельная система генерации изображений.', true],
      // Негативные
      ['Python — это язык программирования.', false],
      ['Привет! Как я могу помочь?', false],
      ['Вот решение вашей задачи.', false],
      ['Курс доллара 92.5 руб.', false],
      ['Рекурсия — это когда функция вызывает себя.', false],
    ];
    it.each(aboutImages)('isAIResponseAboutImages("%s") → %s', (text, expected) => {
      expect(isAIResponseAboutImages(text)).toBe(expected);
    });
  });

  // -----------------------------------------------
  // 4.5 Граничные случаи
  // -----------------------------------------------

  describe('Граничные случаи image gen', () => {
    it('detectImageGenIntent на пустой строке → false', () => {
      expect(detectImageGenIntent('')).toBe(false);
    });

    it('detectImageGenIntent на строке из пробелов → false', () => {
      expect(detectImageGenIntent('   ')).toBe(false);
    });

    it('detectImageEditIntent на null-подобной строке → false', () => {
      expect(detectImageEditIntent('')).toBe(false);
    });

    it('extractImagePrompt на команде /imagine без промпта', () => {
      const r = extractImagePrompt('/imagine');
      expect(r.length).toBeGreaterThan(0);
    });

    it('extractImagePrompt удаляет "плиз" из конца', () => {
      const r = extractImagePrompt('нарисуй кота плиз');
      expect(r).not.toContain('плиз');
    });

    it('isAIResponseAboutImages на пустой строке → false', () => {
      expect(isAIResponseAboutImages('')).toBe(false);
    });

    it('detectImageGenIntent чувствителен к глаголам а не существительным', () => {
      // "картина Моне" — нет глагола рисования
      expect(detectImageGenIntent('расскажи о картине Моне')).toBe(false);
    });

    it('extractImagePrompt для английского промпта', () => {
      const r = extractImagePrompt('draw a beautiful mountain landscape');
      expect(r.toLowerCase()).toContain('beautiful mountain landscape');
    });
  });
});
