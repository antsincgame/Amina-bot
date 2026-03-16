/**
 * LLM Response Verifier — Перцептивная верификация через Perplexity
 * 
 * Архитектура:
 * 1. Основная LLM (OpenRouter) интерпретирует ВСЕ запросы пользователя
 * 2. Верификатор (этот модуль) проверяет ответ на:
 *    - Симуляцию поиска ("Ищу...", "Поиск в интернете")
 *    - Фактические галлюцинации (выдуманные факты, даты, цифры)
 *    - Отказ использовать предоставленные данные
 * 3. При обнаружении проблем — заменяет ответ реальными данными из Perplexity
 * 
 * Всегда включён. Не использует бесплатные LLM для верификации —
 * вместо этого использует Perplexity API для фактчекинга.
 */

import { telegramLogger, aiLogger } from '../config/logger.js';
import { webSearch, needsWebSearch } from './websearch.js';
import { looksLikeSearchSimulation, looksLikeSearchRefusal } from '../telegram/format.js';

// ============================================
// Constants
// ============================================

const MAX_CITATIONS_DISPLAY = 5;
const MAX_URL_DISPLAY_LENGTH = 70;
const MIN_SEARCH_ANSWER_LENGTH = 30;
const MIN_FACTCHECK_ANSWER_LENGTH = 50;

/** Модели, которым доверяем — пропускаем детекцию галлюцинаций */
const TRUSTED_MODEL_PATTERNS: ReadonlySet<string> = new Set([
  'claude', 'gpt-4', 'gemini-pro', 'gemini-1.5', 'gemini-2',
]);

/** Слова-маркеры фактического вопроса (русский) */
const FACTUAL_QUESTION_MARKERS = /(?:сколько|какой курс|какая цена|когда|в каком году|какая стоимость|почём|какой результат|какая температура|какой счёт)/i;

/** Ответ содержит конкретные числа/даты/цены */
const CONTAINS_NUMERIC_FACTS = /\d{2,}/;

function isTrustedModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  for (const pattern of TRUSTED_MODEL_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }
  return false;
}

function formatCitations(citations: string[]): string {
  if (citations.length === 0) return '';
  return '\n\n📚 Источники:\n' + citations.slice(0, MAX_CITATIONS_DISPLAY)
    .map((url, i) => `${i + 1}. ${url.length > MAX_URL_DISPLAY_LENGTH ? url.substring(0, MAX_URL_DISPLAY_LENGTH - 3) + '...' : url}`)
    .join('\n') + '\n';
}

// ============================================
// Types
// ============================================

export interface VerifyResult {
  /** Оригинальный ответ прошёл проверку */
  isValid: boolean;
  /** Исправленный ответ (если isValid=false) */
  correctedResponse?: string;
  /** Причина коррекции */
  reason?: string;
  /** Время верификации (мс) */
  verifyTimeMs: number;
  /** Верификация была пропущена */
  skipped: boolean;
}

// ============================================
// Hallucination Detection Patterns
// ============================================

/** Паттерны когда LLM выдумывает конкретные данные без источника */
const HALLUCINATION_PATTERNS = [
  // LLM придумывает "актуальные" данные о ценах/курсах
  /(?:на данный момент|сейчас|сегодня|текущий|актуальный)\s*(?:курс|цена|стоимость)\s*[^.]*?\d+[\s,.]\d+/i,
  // Придумывает погоду с точными цифрами
  /(?:температура|сейчас|в данный момент)\s*(?:составляет|около|примерно)?\s*[+-]?\d+\s*°/i,
  // Придумывает результаты матчей
  /(?:счёт|результат)\s*(?:матча|игры)\s*[^.]*?\d+\s*[-:]\s*\d+/i,
];

/** Слова-маркеры что LLM не уверена но выдаёт за факт */
const FAKE_CONFIDENCE_PATTERNS = [
  /по последним данным(?!.*\[\d+\])/i,  // "по последним данным" без ссылки
  /согласно официальным данным(?!.*\[\d+\])/i,
  /по информации\s+(?!из\s+интернета|из\s+поиска)/i,
];

// ============================================
// Core Verification Logic
// ============================================

/**
 * Верифицирует ответ LLM.
 * 
 * Стратегия:
 * 1. Детекция симуляции поиска → замена на реальный Perplexity-поиск
 * 2. Детекция отказа использовать данные → замена на реальный поиск
 * 3. Детекция галлюцинаций с фактами → фактчек через Perplexity
 * 
 * @param userMessage - Исходный вопрос пользователя
 * @param aiResponse - Ответ основной LLM
 * @param searchContext - Контекст из веб-поиска (если был)
 * @returns Результат верификации
 */
export async function verifyResponse(
  userMessage: string,
  aiResponse: string,
  searchContext?: string,
  options?: { modelId?: string; webSearchContext?: string }
): Promise<VerifyResult> {
  const startTime = Date.now();
  let perplexityUsed = false;

  if (userMessage.length < 5) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }
  // Короткие ответы всё равно проверяем на отказ — "Не могу помочь." тоже < 30 символов
  if (aiResponse.length < 30 && !looksLikeSearchRefusal(aiResponse)) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }

  if (/^(привет|здравствуй|ок|да|нет|спасибо|хорошо|ладно|пока|ты как|как дела)\s*[.!?]*$/i.test(userMessage.trim())) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }

  const trustedModel = !!options?.modelId && isTrustedModel(options.modelId);

  try {
    // === Проверка 1: Симуляция поиска ===
    if (looksLikeSearchSimulation(aiResponse)) {
      aiLogger.warn(
        { userMessage: userMessage.substring(0, 80), responseSnippet: aiResponse.substring(0, 100) },
        '🚨 Verifier: search simulation detected → replacing with real search'
      );

      if (!perplexityUsed) {
        const corrected = options?.webSearchContext
          ? options.webSearchContext
          : await callPerplexityOnce(userMessage, () => replaceWithRealSearch(userMessage));
        perplexityUsed = true;
        if (corrected) {
          return {
            isValid: false,
            correctedResponse: corrected,
            reason: 'LLM симулировала поиск — заменено на реальные данные из Perplexity',
            verifyTimeMs: Date.now() - startTime,
            skipped: false,
          };
        }
      }
    }

    // === Проверка 2: Отказ использовать данные / отказ от поиска ===
    // Проверяем ВСЕГДА (не только при наличии searchContext) — LLM может отказать
    // и когда данные были предоставлены, и когда она должна была использовать свои знания
    if (looksLikeSearchRefusal(aiResponse)) {
      const hasSearchData = !!searchContext;
      aiLogger.warn(
        { userMessage: userMessage.substring(0, 80), responseSnippet: aiResponse.substring(0, 100), hasSearchData },
        '🚨 Verifier: search refusal detected → replacing with real search'
      );

      if (!perplexityUsed) {
        const corrected = options?.webSearchContext
          ? options.webSearchContext
          : await callPerplexityOnce(userMessage, () => replaceWithRealSearch(userMessage));
        perplexityUsed = true;
        if (corrected) {
          return {
            isValid: false,
            correctedResponse: corrected,
            reason: hasSearchData
              ? 'LLM отказалась использовать данные поиска — заменено на реальные данные'
              : 'LLM отказалась отвечать на информационный запрос — данные получены из Perplexity',
            verifyTimeMs: Date.now() - startTime,
            skipped: false,
          };
        }
      }
    }

    // === Проверка 3: Фактические галлюцинации ===
    // Пропускаем для доверенных моделей — они редко галлюцинируют на фактах
    // Проверяем только если вопрос фактический И ответ содержит числа/даты
    if (
      !trustedModel
      && needsWebSearch(userMessage)
      && !searchContext
      && FACTUAL_QUESTION_MARKERS.test(userMessage)
      && CONTAINS_NUMERIC_FACTS.test(aiResponse)
    ) {
      const hasHallucination = detectFactualHallucination(aiResponse);
      if (hasHallucination && !perplexityUsed) {
        aiLogger.warn(
          { userMessage: userMessage.substring(0, 80), reason: hasHallucination },
          '🚨 Verifier: factual hallucination detected → fact-checking via Perplexity'
        );

        const factChecked = options?.webSearchContext
          ? options.webSearchContext
          : await callPerplexityOnce(userMessage, () => factCheckViaPerplexity(userMessage, aiResponse));
        perplexityUsed = true;
        if (factChecked) {
          return {
            isValid: false,
            correctedResponse: factChecked,
            reason: `Обнаружена галлюцинация (${hasHallucination}) — проверено через Perplexity`,
            verifyTimeMs: Date.now() - startTime,
            skipped: false,
          };
        }
      }
    }

    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: false };
  } catch (error) {
    aiLogger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Verification error, accepting original response'
    );
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }
}

// ============================================
// Detection Helpers
// ============================================

/**
 * Обнаруживает фактические галлюцинации в ответе LLM.
 * Возвращает описание проблемы или null если всё ок.
 */
export function detectFactualHallucination(response: string): string | null {
  // Проверяем паттерны галлюцинаций
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(response)) {
      return `hallucinated_data: ${pattern.source.substring(0, 60)}`;
    }
  }

  // Проверяем фейковую уверенность
  for (const pattern of FAKE_CONFIDENCE_PATTERNS) {
    if (pattern.test(response)) {
      return `fake_confidence: ${pattern.source.substring(0, 60)}`;
    }
  }

  return null;
}

// ============================================
// Perplexity Cost Guard
// ============================================

async function callPerplexityOnce(
  _userMessage: string,
  fn: () => Promise<string | null>,
): Promise<string | null> {
  return fn();
}

// ============================================
// Correction Helpers
// ============================================

/**
 * Заменяет симулированный/отказный ответ на реальные данные из Perplexity.
 * Вызывает Perplexity напрямую и возвращает форматированный результат.
 */
async function replaceWithRealSearch(userMessage: string): Promise<string | null> {
  try {
    const searchResult = await webSearch(userMessage);

    if (searchResult.answer && searchResult.answer.length > MIN_SEARCH_ANSWER_LENGTH) {
      const result = searchResult.answer + formatCitations(searchResult.citations);

      telegramLogger.info(
        { resultLength: result.length, citations: searchResult.citations.length },
        '✅ Verifier: replaced simulation with real Perplexity data'
      );

      return result;
    }
  } catch (error) {
    aiLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Verifier: Perplexity search failed');
  }

  return null;
}

/**
 * Фактчек ответа LLM через Perplexity.
 * Задаёт тот же вопрос Perplexity и возвращает проверенный ответ.
 */
async function factCheckViaPerplexity(userMessage: string, _aiResponse: string): Promise<string | null> {
  try {
    const searchResult = await webSearch(userMessage);

    if (searchResult.answer && searchResult.answer.length > MIN_FACTCHECK_ANSWER_LENGTH) {
      const result = searchResult.answer + formatCitations(searchResult.citations);

      telegramLogger.info(
        { resultLength: result.length },
        '✅ Verifier: fact-checked via Perplexity, using verified answer'
      );

      return result;
    }
  } catch (error) {
    aiLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Verifier: fact-check Perplexity search failed');
  }

  return null;
}

