/**
 * Tests for Web Search Service (Perplexity)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../config/index.js', () => ({
  config: {
    perplexity: { apiKey: '' },
  },
}));

vi.mock('../config/logger.js', () => ({
  telegramLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db/supabase.js', () => ({
  settingsRepo: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  needsWebSearch,
  aiShowsUncertainty,
  isWebSearchEnabled,
  getSearchContext,
  enhanceResponseIfNeeded,
  clearPerplexityCache,
} from './websearch.js';
import { settingsRepo } from '../db/supabase.js';

describe('Web Search Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPerplexityCache();
  });

  // ============================================
  // needsWebSearch — pattern matching
  // ============================================

  describe('needsWebSearch', () => {
    it('should detect weather queries', () => {
      expect(needsWebSearch('какая погода в Москве?')).toBe(true);
      expect(needsWebSearch('прогноз погоды на завтра')).toBe(true);
    });

    it('should detect currency/price queries', () => {
      expect(needsWebSearch('курс доллара сегодня')).toBe(true);
      expect(needsWebSearch('цена биткоин')).toBe(true);
      expect(needsWebSearch('сколько стоит ethereum?')).toBe(true);
    });

    it('should detect news/current events', () => {
      expect(needsWebSearch('последние новости')).toBe(true);
      expect(needsWebSearch('что произошло сегодня?')).toBe(true);
      expect(needsWebSearch('актуальные события')).toBe(true);
    });

    it('should detect explicit search requests', () => {
      expect(needsWebSearch('найди информацию про React 19')).toBe(true);
      expect(needsWebSearch('погугли это')).toBe(true);
    });

    it('should NOT trigger on general questions', () => {
      expect(needsWebSearch('расскажи анекдот')).toBe(false);
      expect(needsWebSearch('напиши код на Python')).toBe(false);
      expect(needsWebSearch('объясни что такое ООП')).toBe(false);
    });

    it('should detect year-specific questions', () => {
      expect(needsWebSearch('что случилось в 2024 году?')).toBe(true);
    });

    it('should detect time-relative questions', () => {
      expect(needsWebSearch('что сейчас происходит?')).toBe(true);
      expect(needsWebSearch('что было вчера?')).toBe(true);
    });
  });

  // ============================================
  // aiShowsUncertainty — AI response analysis
  // ============================================

  describe('aiShowsUncertainty', () => {
    it('should detect uncertainty in Russian', () => {
      expect(aiShowsUncertainty('Я не знаю точного ответа на этот вопрос')).toBe(true);
      expect(aiShowsUncertainty('У меня нет актуальной информации об этом')).toBe(true);
      expect(aiShowsUncertainty('Мои данные устарели и могут быть неверны')).toBe(true);
      expect(aiShowsUncertainty('Рекомендую проверить этот факт')).toBe(true);
    });

    it('should detect uncertainty in English', () => {
      expect(aiShowsUncertainty("I don't know the exact answer")).toBe(true);
      expect(aiShowsUncertainty("I'm not sure about this")).toBe(true);
    });

    it('should NOT flag confident responses', () => {
      expect(aiShowsUncertainty('Python — это язык программирования')).toBe(false);
      expect(aiShowsUncertainty('Вот пример кода для решения задачи')).toBe(false);
    });
  });

  // ============================================
  // isWebSearchEnabled — setting check
  // ============================================

  describe('isWebSearchEnabled', () => {
    it('should return true when enabled in settings', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('true');

      const result = await isWebSearchEnabled();
      expect(result).toBe(true);
    });

    it('should return false when disabled', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('false');

      const result = await isWebSearchEnabled();
      expect(result).toBe(false);
    });

    it('should return false when setting is missing', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce(null);

      const result = await isWebSearchEnabled();
      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      vi.mocked(settingsRepo.get).mockRejectedValueOnce(new Error('DB error'));

      const result = await isWebSearchEnabled();
      expect(result).toBe(false);
    });
  });

  // ============================================
  // getSearchContext — transparent web search
  // ============================================

  describe('getSearchContext', () => {
    it('should return empty string when search is disabled', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('false');

      const result = await getSearchContext('курс доллара');
      expect(result).toBe('');
    });

    it('should return empty string for non-search queries', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('true');

      const result = await getSearchContext('расскажи анекдот');
      expect(result).toBe('');
    });

    it('should return empty string on search failure', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValue('true');
      // No perplexity key configured
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('true'); // web_search_enabled
      
      const result = await getSearchContext('курс доллара');
      // Should gracefully fail and return ''
      expect(result).toBe('');
    });
  });

  // ============================================
  // enhanceResponseIfNeeded
  // ============================================

  describe('enhanceResponseIfNeeded', () => {
    it('should not enhance confident responses', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('true');

      const result = await enhanceResponseIfNeeded(
        'что такое Python?',
        'Python — это язык программирования'
      );

      expect(result.wasEnhanced).toBe(false);
      expect(result.response).toBe('Python — это язык программирования');
    });

    it('should not enhance when search is disabled', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('false');

      const result = await enhanceResponseIfNeeded(
        'курс доллара',
        'Я не знаю актуального курса'
      );

      expect(result.wasEnhanced).toBe(false);
    });
  });
});
