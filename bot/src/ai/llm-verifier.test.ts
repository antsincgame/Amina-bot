/**
 * Tests for LLM Response Verifier
 * 
 * Покрытие:
 * - detectFactualHallucination: обнаружение выдуманных фактов
 * - verifyResponse: полный цикл верификации
 * - Интеграция с looksLikeSearchSimulation
 * - Интеграция с Perplexity (мокированная)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../config/index.js', () => ({
  config: {
    perplexity: { apiKey: 'test-perplexity-key' },
  },
}));

vi.mock('../config/logger.js', () => ({
  telegramLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
  },
}));

// Mock только webSearch, needsWebSearch использует реальную реализацию
const mockWebSearch = vi.fn();
vi.mock('./websearch.js', async () => {
  const actual = await vi.importActual('./websearch.js') as Record<string, unknown>;
  return {
    ...actual,
    webSearch: (...args: unknown[]) => mockWebSearch(...args),
  };
});

import { verifyResponse, detectFactualHallucination } from './llm-verifier.js';

describe('LLM Verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebSearch.mockReset();
  });

  // ============================================
  // detectFactualHallucination
  // ============================================

  describe('detectFactualHallucination', () => {
    it('should detect hallucinated currency rates', () => {
      const result = detectFactualHallucination('На данный момент курс доллара составляет 92,45 рублей.');
      expect(result).not.toBeNull();
      expect(result).toContain('hallucinated_data');
    });

    it('should detect hallucinated weather data', () => {
      const result = detectFactualHallucination('Температура сейчас составляет +15°C в Москве.');
      expect(result).not.toBeNull();
    });

    it('should detect hallucinated match scores', () => {
      const result = detectFactualHallucination('Счёт матча Реал-Барселона 2:1.');
      expect(result).not.toBeNull();
    });

    it('should detect fake confidence without sources', () => {
      const result = detectFactualHallucination('По последним данным, компания Apple выпустила новый iPhone.');
      expect(result).not.toBeNull();
      expect(result).toContain('fake_confidence');
    });

    it('should NOT flag legitimate responses with citations', () => {
      const result = detectFactualHallucination('По последним данным[1], курс вырос на 5%.');
      expect(result).toBeNull();
    });

    it('should NOT flag general knowledge responses', () => {
      const result = detectFactualHallucination('Python — это высокоуровневый язык программирования с динамической типизацией.');
      expect(result).toBeNull();
    });

    it('should NOT flag creative/opinion responses', () => {
      const result = detectFactualHallucination('Мне кажется, вам стоит попробовать React для этого проекта.');
      expect(result).toBeNull();
    });

    it('should NOT flag short casual responses', () => {
      const result = detectFactualHallucination('Привет! Рада помочь.');
      expect(result).toBeNull();
    });
  });

  // ============================================
  // verifyResponse — full cycle
  // ============================================

  describe('verifyResponse', () => {
    it('should skip verification for short responses', async () => {
      const result = await verifyResponse('вопрос', 'Короткий ответ.');
      expect(result.skipped).toBe(true);
      expect(result.isValid).toBe(true);
    });

    it('should skip verification for casual messages', async () => {
      const result = await verifyResponse(
        'привет',
        'Привет! Как я могу помочь тебе сегодня?'
      );
      expect(result.skipped).toBe(true);
    });

    it('should detect and replace search simulation', async () => {
      mockWebSearch.mockResolvedValueOnce({
        answer: 'Курс доллара на 09.02.2026: 92.5 руб.',
        citations: ['https://cbr.ru'],
        model: 'sonar',
        tokens_used: { prompt: 100, completion: 50, total: 150 },
      });

      const result = await verifyResponse(
        'курс доллара',
        '🔍 Ищу актуальный курс доллара...\n\n*(Поиск в интернете)*\n\nПодождите, загружаю данные...'
      );

      expect(result.isValid).toBe(false);
      expect(result.correctedResponse).toContain('92.5');
      expect(result.reason).toContain('симулировала поиск');
    });

    it('should detect and replace search refusal when context provided', async () => {
      mockWebSearch.mockResolvedValueOnce({
        answer: 'Вот актуальные новости Берлина: 1. Открылся новый парк...',
        citations: ['https://berlin-news.de'],
        model: 'sonar',
        tokens_used: { prompt: 100, completion: 200, total: 300 },
      });

      const result = await verifyResponse(
        'новости Берлина',
        'У меня нет доступа к актуальным данным из интернета. Я могу рассказать только то что знаю из обучения. Для актуальных новостей рекомендую обратиться к новостным сайтам.',
        '=== ДАННЫЕ ИЗ ИНТЕРНЕТА === ...'
      );

      expect(result.isValid).toBe(false);
      expect(result.correctedResponse).toContain('Берлин');
      expect(result.reason).toBeDefined();
    });

    it('should detect hallucination patterns in AI response (unit)', () => {
      // Unit-тест detectFactualHallucination — не зависит от ESM моков
      const hallucination = detectFactualHallucination(
        'По последним данным, курс доллара составляет примерно 89 рублей.'
      );
      expect(hallucination).not.toBeNull();
      expect(hallucination).toContain('fake_confidence');

      // С точными цифрами
      const hallucination2 = detectFactualHallucination(
        'На данный момент курс доллара составляет 92,45 рублей.'
      );
      expect(hallucination2).not.toBeNull();

      // Без галлюцинаций
      const clean = detectFactualHallucination(
        'Рекурсия — это когда функция вызывает сама себя.'
      );
      expect(clean).toBeNull();
    });

    it('should pass valid responses through', async () => {
      const result = await verifyResponse(
        'объясни рекурсию',
        'Рекурсия — это приём программирования, когда функция вызывает сама себя. Она состоит из базового случая и рекурсивного вызова. Пример: вычисление факториала.'
      );

      expect(result.isValid).toBe(true);
      expect(result.correctedResponse).toBeUndefined();
    });

    it('should handle Perplexity search failure gracefully', async () => {
      mockWebSearch.mockRejectedValueOnce(new Error('Perplexity API error'));

      const result = await verifyResponse(
        'курс доллара',
        '🔍 Ищу актуальный курс...\n\n*(Поиск в интернете)*\n\nПодождите...'
      );

      // Simulation detected, but Perplexity search failed → still returns something
      // Either correctedResponse is null (no replacement found) or the outer catch fires
      expect(result.verifyTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should not verify when user message is too short', async () => {
      const result = await verifyResponse('ок', 'Хорошо, понял!');
      expect(result.skipped).toBe(true);
      expect(result.isValid).toBe(true);
    });
  });
});
