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
  /на момент написания(?!.*\[\d+\])/i,
  /по состоянию на \d{1,2}\s+\w+\s+\d{4}/i,  // Конкретная дата "по состоянию на"
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
  searchContext?: string
): Promise<VerifyResult> {
  const startTime = Date.now();

  // Не верифицируем очень короткие ответы и бытовые сообщения
  if (aiResponse.length < 30 || userMessage.length < 5) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }

  if (/^(привет|здравствуй|ок|да|нет|спасибо|хорошо|ладно|пока|ты как|как дела)\s*[.!?]*$/i.test(userMessage.trim())) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }

  try {
    // === Проверка 1: Симуляция поиска ===
    if (looksLikeSearchSimulation(aiResponse)) {
      aiLogger.warn(
        { userMessage: userMessage.substring(0, 80), responseSnippet: aiResponse.substring(0, 100) },
        '🚨 Verifier: search simulation detected → replacing with real search'
      );

      const corrected = await replaceWithRealSearch(userMessage);
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

    // === Проверка 2: Отказ использовать данные / отказ от поиска ===
    // Проверяем ВСЕГДА (не только при наличии searchContext) — LLM может отказать
    // и когда данные были предоставлены, и когда она должна была использовать свои знания
    if (looksLikeSearchRefusal(aiResponse)) {
      const hasSearchData = !!searchContext;
      aiLogger.warn(
        { userMessage: userMessage.substring(0, 80), responseSnippet: aiResponse.substring(0, 100), hasSearchData },
        '🚨 Verifier: search refusal detected → replacing with real search'
      );

      const corrected = await replaceWithRealSearch(userMessage);
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

    // === Проверка 3: Фактические галлюцинации ===
    // Только для информационных запросов где нужен поиск
    if (needsWebSearch(userMessage) && !searchContext) {
      const hasHallucination = detectFactualHallucination(aiResponse);
      if (hasHallucination) {
        aiLogger.warn(
          { userMessage: userMessage.substring(0, 80), reason: hasHallucination },
          '🚨 Verifier: factual hallucination detected → fact-checking via Perplexity'
        );

        const factChecked = await factCheckViaPerplexity(userMessage, aiResponse);
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
// Correction Helpers
// ============================================

/**
 * Заменяет симулированный/отказный ответ на реальные данные из Perplexity.
 * Вызывает Perplexity напрямую и возвращает форматированный результат.
 */
async function replaceWithRealSearch(userMessage: string): Promise<string | null> {
  try {
    const searchResult = await webSearch(userMessage);

    if (searchResult.answer && searchResult.answer.length > 30) {
      let result = searchResult.answer;

      // Добавляем источники если есть
      if (searchResult.citations.length > 0) {
        result += '\n\n📚 Источники:\n';
        searchResult.citations.slice(0, 5).forEach((url, i) => {
          result += `${i + 1}. ${url.length > 70 ? url.substring(0, 67) + '...' : url}\n`;
        });
      }

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

    if (searchResult.answer && searchResult.answer.length > 50) {
      let result = searchResult.answer;

      if (searchResult.citations.length > 0) {
        result += '\n\n📚 Источники:\n';
        searchResult.citations.slice(0, 5).forEach((url, i) => {
          result += `${i + 1}. ${url.length > 70 ? url.substring(0, 67) + '...' : url}\n`;
        });
      }

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

// ============================================
// Legacy exports (для обратной совместимости)
// ============================================

/** @deprecated Верификация теперь всегда включена */
export function clearVerifyCache(): void {
  // no-op — верификация всегда включена
}
