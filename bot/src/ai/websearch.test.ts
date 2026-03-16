/**
 * Tests for Web Search Service (Perplexity)
 * 
 * Покрытие:
 * - needsWebSearch: все категории паттернов + ложноположительные
 * - shouldForceWebSearch: обязательный поиск
 * - aiShowsUncertainty: детекция неуверенности AI
 * - isWebSearchEnabled: настройки из БД
 * - getSearchContext / enhanceResponseIfNeeded: интеграция
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

vi.mock('../db/index.js', () => ({
  settingsRepo: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  needsWebSearch,
  shouldForceWebSearch,
  aiShowsUncertainty,
  isWebSearchEnabled,
  getSearchContext,
  enhanceResponseIfNeeded,
  clearPerplexityCache,
} from './websearch.js';
import { settingsRepo } from '../db/index.js';

describe('Web Search Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPerplexityCache();
  });

  // ============================================
  // needsWebSearch — comprehensive pattern tests
  // ============================================

  describe('needsWebSearch', () => {
    // --- Время-зависимые ---
    it('should detect time-dependent queries', () => {
      expect(needsWebSearch('что происходит сегодня?')).toBe(true);
      expect(needsWebSearch('новости за вчера')).toBe(true);
      expect(needsWebSearch('что будет завтра?')).toBe(true);
      expect(needsWebSearch('события на этой неделе')).toBe(true);
      expect(needsWebSearch('что сейчас происходит?')).toBe(true);
    });

    // --- Погода ---
    it('should detect weather queries', () => {
      expect(needsWebSearch('какая погода в Москве?')).toBe(true);
      expect(needsWebSearch('прогноз погоды на завтра')).toBe(true);
      expect(needsWebSearch('температура в Берлине')).toBe(true);
      expect(needsWebSearch('будет ли дождь?')).toBe(true);
    });

    // --- Финансы ---
    it('should detect currency/price queries', () => {
      expect(needsWebSearch('курс доллара сегодня')).toBe(true);
      expect(needsWebSearch('цена биткоин')).toBe(true);
      expect(needsWebSearch('сколько стоит ethereum?')).toBe(true);
      expect(needsWebSearch('котировки NASDAQ')).toBe(true);
    });

    // --- Новости ---
    it('should detect news/current events', () => {
      expect(needsWebSearch('последние новости')).toBe(true);
      expect(needsWebSearch('что произошло сегодня?')).toBe(true);
      expect(needsWebSearch('актуальные события')).toBe(true);
      expect(needsWebSearch('свежие новости')).toBe(true);
    });

    // --- Явные запросы ---
    it('should detect explicit search requests', () => {
      expect(needsWebSearch('найди информацию про React 19')).toBe(true);
      expect(needsWebSearch('погугли это')).toBe(true);
      expect(needsWebSearch('подскажи хорошие курсы')).toBe(true);
    });

    // --- Новые паттерны (назови/посоветуй/рекомендуй) ---
    it('should detect recommendation queries', () => {
      expect(needsWebSearch('назови лучшие кофейни города')).toBe(true);
      expect(needsWebSearch('посоветуй хороший ресторан')).toBe(true);
      expect(needsWebSearch('порекомендуй фильм')).toBe(true);
      expect(needsWebSearch('подбери мне ноутбук')).toBe(true);
      expect(needsWebSearch('предложи варианты')).toBe(true);
    });

    // --- Рейтинги и обзоры ---
    it('should detect rating/review queries', () => {
      expect(needsWebSearch('лучшие телефоны 2026')).toBe(true);
      expect(needsWebSearch('топ-10 книг')).toBe(true);
      expect(needsWebSearch('рейтинг лучших ноутбуков')).toBe(true);
      expect(needsWebSearch('сравни iPhone и Samsung')).toBe(true);
    });

    // --- Места и заведения ---
    it('should detect place/venue queries', () => {
      expect(needsWebSearch('кафе рядом с вокзалом')).toBe(true);
      expect(needsWebSearch('где ближайшая аптека')).toBe(true);
      expect(needsWebSearch('кофейня в центре')).toBe(true);
      expect(needsWebSearch('ресторан с живой музыкой')).toBe(true);
    });

    // --- Факты о мире ---
    it('should detect factual queries', () => {
      expect(needsWebSearch('кто президент Франции?')).toBe(true);
      expect(needsWebSearch('население Берлина')).toBe(true);
      expect(needsWebSearch('расскажи про новый ChatGPT')).toBe(true);
    });

    // --- Спорт ---
    it('should detect sports queries', () => {
      expect(needsWebSearch('счёт матча Реал - Барселона')).toBe(true);
      expect(needsWebSearch('чемпионат мира по футболу')).toBe(true);
    });

    // --- Здоровье ---
    it('should detect health queries', () => {
      expect(needsWebSearch('симптомы гриппа')).toBe(true);
      expect(needsWebSearch('лечение ангины')).toBe(true);
    });

    // --- Вопросы "какой/какая" (теперь с контекстом) ---
    it('should detect "какой" with context but NOT without', () => {
      expect(needsWebSearch('какой сейчас курс доллара')).toBe(true);
      expect(needsWebSearch('какая сегодня погода')).toBe(true);
      expect(needsWebSearch('какой текущий рейтинг')).toBe(true);
    });

    // --- НЕ должно триггерить ---
    it('should NOT trigger on casual conversation', () => {
      expect(needsWebSearch('привет')).toBe(false);
      expect(needsWebSearch('как дела')).toBe(false);
      expect(needsWebSearch('ок')).toBe(false);
      expect(needsWebSearch('спасибо')).toBe(false);
      expect(needsWebSearch('да')).toBe(false);
      expect(needsWebSearch('нет')).toBe(false);
    });

    it('should NOT trigger on pure programming requests', () => {
      expect(needsWebSearch('напиши код на Python')).toBe(false);
      // "объясни что такое ООП" matches /что\s*(такое)/ — это нормально,
      // бот обогатит ответ поисковым контекстом
    });

    it('should NOT trigger on very short messages', () => {
      expect(needsWebSearch('ну')).toBe(false);
      expect(needsWebSearch('ага')).toBe(false);
      expect(needsWebSearch('хм')).toBe(false);
    });

    // --- Year-specific ---
    it('should detect year-specific questions', () => {
      expect(needsWebSearch('что случилось в 2024 году?')).toBe(true);
      expect(needsWebSearch('события 2026 года')).toBe(true);
    });
  });

  // ============================================
  // shouldForceWebSearch — mandatory search
  // ============================================

  describe('shouldForceWebSearch', () => {
    it('should force search for weather', () => {
      expect(shouldForceWebSearch('погода в Москве')).toBe(true);
    });

    it('should force search for currency rates', () => {
      expect(shouldForceWebSearch('курс доллара')).toBe(true);
      expect(shouldForceWebSearch('курс евро')).toBe(true);
    });

    it('should force search for crypto prices', () => {
      expect(shouldForceWebSearch('цена биткоин')).toBe(true);
      expect(shouldForceWebSearch('цена ethereum')).toBe(true);
    });

    it('should force search for news', () => {
      expect(shouldForceWebSearch('новости за сегодня')).toBe(true);
      expect(shouldForceWebSearch('последние новости')).toBe(true);
      expect(shouldForceWebSearch('что произошло?')).toBe(true);
    });

    it('should NOT force search for general questions', () => {
      expect(shouldForceWebSearch('расскажи анекдот')).toBe(false);
      expect(shouldForceWebSearch('напиши код')).toBe(false);
      expect(shouldForceWebSearch('привет')).toBe(false);
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

    it('should detect search simulation patterns', () => {
      expect(aiShowsUncertainty('🔍 Ищу информацию...')).toBe(true);
      expect(aiShowsUncertainty('Сейчас найду данные для вас')).toBe(true);
      expect(aiShowsUncertainty('*(Поиск в интернете)*')).toBe(true);
      expect(aiShowsUncertainty('Не могу выполнить поиск')).toBe(true);
    });

    it('should detect refusal patterns', () => {
      expect(aiShowsUncertainty('Нет доступа к интернету')).toBe(true);
      expect(aiShowsUncertainty('Не могу искать в интернете')).toBe(true);
      expect(aiShowsUncertainty('У меня нет доступа к новым данным')).toBe(true);
    });

    it('should NOT flag confident responses', () => {
      expect(aiShowsUncertainty('Python — это язык программирования')).toBe(false);
      expect(aiShowsUncertainty('Вот пример кода для решения задачи')).toBe(false);
      expect(aiShowsUncertainty('Привет! Как я могу помочь?')).toBe(false);
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

    it('should auto-detect from API key when setting is missing', async () => {
      // First call: web_search_enabled → null
      vi.mocked(settingsRepo.get).mockResolvedValueOnce(null);
      // Second call: perplexity_api_key → null (inside getPerplexityApiKey)
      vi.mocked(settingsRepo.get).mockResolvedValueOnce(null);

      const result = await isWebSearchEnabled();
      // No API key → false
      expect(result).toBe(false);
    });

    it('should return false on DB error', async () => {
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
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('true');

      const result = await getSearchContext('курс доллара');
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
        'Python — это язык программирования, созданный Гвидо ван Россумом. Он используется для веб-разработки, машинного обучения, автоматизации и многих других задач.'
      );

      expect(result.wasEnhanced).toBe(false);
    });

    it('should not enhance when search is disabled', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('false');

      const result = await enhanceResponseIfNeeded(
        'курс доллара',
        'Я не знаю актуального курса'
      );

      expect(result.wasEnhanced).toBe(false);
    });

    it('should not enhance casual messages', async () => {
      vi.mocked(settingsRepo.get).mockResolvedValueOnce('true');

      const result = await enhanceResponseIfNeeded(
        'привет',
        'Привет! Как дела?'
      );

      expect(result.wasEnhanced).toBe(false);
    });
  });
});
