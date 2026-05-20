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

// TTL-кеш для Perplexity-результатов (5 минут, макс. 50 записей)
const VERIFY_CACHE_TTL = 5 * 60 * 1000;
const VERIFY_CACHE_MAX_SIZE = 50;
const verifyCache = new Map<string, { result: string | null; ts: number }>();

/**
 * Нормализует пользовательский запрос для ключа кэша: нижний регистр, схлопнутые
 * пробелы, без хвостовой пунктуации. Раньше ключом была сырая строка, поэтому
 * «Какой курс?» / «какой курс» / «Какой курс??» давали разные ключи → near-zero
 * hit rate и лишние вызовы Perplexity на по сути один и тот же вопрос.
 */
function normalizeVerifyKey(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?!.,;:\s]+$/u, '');
}

function getFromVerifyCache(query: string): string | null | undefined {
  const entry = verifyCache.get(query);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > VERIFY_CACHE_TTL) {
    verifyCache.delete(query);
    return undefined;
  }
  return entry.result;
}

function setVerifyCache(query: string, result: string | null): void {
  if (verifyCache.size >= VERIFY_CACHE_MAX_SIZE) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of verifyCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey) verifyCache.delete(oldestKey);
  }
  verifyCache.set(query, { result, ts: Date.now() });
}

const MAX_CITATIONS_DISPLAY = 5;
const MAX_URL_DISPLAY_LENGTH = 70;
const MIN_SEARCH_ANSWER_LENGTH = 30;
const MIN_FACTCHECK_ANSWER_LENGTH = 50;

/**
 * Модели с высоким доверием — снижаем чувствительность галлюцинационного детектора,
 * но НЕ отключаем его полностью. Даже лучшие модели могут выдавать устаревшие
 * курсы/погоду/цены с уверенным тоном.
 */
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
    // Применяем ко ВСЕМ моделям для real-time вопросов (курсы, погода, цены, счёт).
    // Для trusted-моделей применяем только при наличии явных галлюцинационных паттернов
    // (FAKE_CONFIDENCE_PATTERNS). Для остальных — дополнительно проверяем HALLUCINATION_PATTERNS.
    if (
      needsWebSearch(userMessage)
      && !searchContext
      && FACTUAL_QUESTION_MARKERS.test(userMessage)
      && CONTAINS_NUMERIC_FACTS.test(aiResponse)
    ) {
      const hasHallucination = detectFactualHallucination(aiResponse, trustedModel);
      if (hasHallucination && !perplexityUsed) {
        aiLogger.warn(
          { userMessage: userMessage.substring(0, 80), reason: hasHallucination, trustedModel },
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
 *
 * Для trusted-моделей проверяем только FAKE_CONFIDENCE_PATTERNS —
 * они характерны для ситуаций когда любая модель утверждает актуальные
 * данные без источника. HALLUCINATION_PATTERNS для trusted-моделей пропускаем:
 * крупные модели точнее форматируют числа и реже бьют в явные паттерны.
 *
 * @returns строку-причину если галлюцинация найдена, null если всё ок.
 */
export function detectFactualHallucination(response: string, trustedModel = false): string | null {
  // Для НЕ-trusted моделей проверяем все паттерны включая числовые
  if (!trustedModel) {
    for (const pattern of HALLUCINATION_PATTERNS) {
      if (pattern.test(response)) {
        return `hallucinated_data: ${pattern.source.substring(0, 60)}`;
      }
    }
  }

  // Fake confidence — проверяем для ВСЕХ моделей
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
  const cacheKey = `search:${normalizeVerifyKey(userMessage)}`;
  const cached = getFromVerifyCache(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const searchResult = await webSearch(userMessage);

    if (searchResult.answer && searchResult.answer.length > MIN_SEARCH_ANSWER_LENGTH) {
      const result = searchResult.answer + formatCitations(searchResult.citations);

      telegramLogger.info(
        { resultLength: result.length, citations: searchResult.citations.length },
        '✅ Verifier: replaced simulation with real Perplexity data'
      );

      setVerifyCache(cacheKey, result);
      return result;
    }
  } catch (error) {
    aiLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Verifier: Perplexity search failed');
  }

  setVerifyCache(cacheKey, null);
  return null;
}

/** Извлекает значимые числа из текста (>=2 цифр) для сравнения */
function extractSignificantNumbers(text: string): string[] {
  const matches = text.match(/\d[\d\s,.]*\d/g) ?? [];
  return matches.map(m => m.replace(/[\s,]/g, '').replace(/\.(\d{3})/g, '$1'));
}

/**
 * Фактчек ответа LLM через Perplexity с мягким сравнением.
 *
 * Алгоритм:
 * 1. Запрашиваем Perplexity по тому же вопросу.
 * 2. Если ключевые числа из LLM-ответа совпадают с числами из Perplexity — ответ достоверен,
 *    возвращаем null (оставляем LLM-ответ).
 * 3. Если числа расходятся — возвращаем Perplexity-ответ как замену.
 */
async function factCheckViaPerplexity(userMessage: string, aiResponse: string): Promise<string | null> {
  const cacheKey = `factcheck:${normalizeVerifyKey(userMessage)}`;
  const cached = getFromVerifyCache(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const searchResult = await webSearch(userMessage);

    if (!searchResult.answer || searchResult.answer.length < MIN_FACTCHECK_ANSWER_LENGTH) {
      setVerifyCache(cacheKey, null);
      return null;
    }

    const perplexityNumbers = extractSignificantNumbers(searchResult.answer);
    const aiNumbers = extractSignificantNumbers(aiResponse);

    // Если у Perplexity есть числа и хотя бы одно совпадает с LLM — ответ актуален
    if (perplexityNumbers.length > 0 && aiNumbers.length > 0) {
      const hasOverlap = perplexityNumbers.some(n => aiNumbers.includes(n));
      if (hasOverlap) {
        telegramLogger.info(
          { perplexityNumbers: perplexityNumbers.slice(0, 5), aiNumbers: aiNumbers.slice(0, 5) },
          '✅ Verifier: LLM numbers match Perplexity — keeping original response'
        );
        setVerifyCache(cacheKey, null);
        return null;
      }
    }

    const result = searchResult.answer + formatCitations(searchResult.citations);
    telegramLogger.info(
      { resultLength: result.length, perplexityNumbers: perplexityNumbers.slice(0, 5), aiNumbers: aiNumbers.slice(0, 5) },
      '✅ Verifier: numbers diverge — replacing with Perplexity-verified answer'
    );

    setVerifyCache(cacheKey, result);
    return result;
  } catch (error) {
    aiLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Verifier: fact-check Perplexity search failed');
  }

  return null;
}

// ============================================
// Telephony Safety — лёгкий синхронный verifier
// ============================================

export interface TelephonyVerifyResult {
  /** true — ответ безопасен, false — нужен fallback */
  isSafe: boolean;
  /** Причина если isSafe=false */
  reason?: string;
}

/**
 * Лёгкий верификатор для realtime-телефонии.
 *
 * Без веб-поиска и внешних вызовов — только regex и структурные проверки.
 * Latency: < 1 мс (синхронный).
 *
 * Проверяет:
 * 1. Пустой/слишком короткий ответ
 * 2. Симуляцию поиска (LLM говорит "ищу..." вслух)
 * 3. Отказ от ответа (LLM говорит "не могу" вслух)
 * 4. Явные числовые утверждения которых не было в сценарии (цены, курсы и т.п.)
 */
export function verifyTelephonyReply(
  replyText: string,
  scenarioContext: string,
): TelephonyVerifyResult {
  if (!replyText || replyText.trim().length < 3) {
    return { isSafe: false, reason: 'empty_reply' };
  }

  if (looksLikeSearchSimulation(replyText)) {
    return { isSafe: false, reason: 'search_simulation' };
  }

  if (looksLikeSearchRefusal(replyText)) {
    return { isSafe: false, reason: 'search_refusal' };
  }

  // Если в ответе есть числа (>=4 цифр), которых нет в сценарии — потенциальная галлюцинация
  const scenarioNumbers = new Set(
    (scenarioContext.match(/\d{2,}/g) ?? []).map(n => n.trim()),
  );
  const replyNumbers = (replyText.match(/\d{2,}/g) ?? []).map(n => n.trim());
  const unsupportedNumbers = replyNumbers.filter(
    n => !scenarioNumbers.has(n) && n.length >= 4,
  );

  if (unsupportedNumbers.length > 2) {
    return {
      isSafe: false,
      reason: `unsupported_numeric_claims: ${unsupportedNumbers.slice(0, 3).join(', ')}`,
    };
  }

  return { isSafe: true };
}

// ============================================
// Общий channel-aware policy layer
// ============================================

export type VerifierChannel = 'telegram' | 'voice' | 'digest' | 'postcall';

export interface ChannelPolicyResult {
  passed: boolean;
  reasons: string[];
}

/**
 * Агрессивные persona-нарушения: LLM называет себя тем, чем не является.
 * Проверяются для всех каналов.
 */
const PERSONA_VIOLATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bя\s+(просто\s+)?(языковая\s+модель|чат-?бот|ассистент\s+ИИ|artificial\s+intelligence)\b/i,
  /\bя\s+не\s+(живой|настоящий|реальный|человек)\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bкак\s+языковая\s+модель\b/i,
  /\bi\s+am\s+just\s+an\s+ai\b/i,
];

/**
 * Агрессивное самоуверенное описание без данных (только для digest и postcall).
 * LLM говорит "по официальным данным" / "согласно последним сведениям" без источника.
 */
const UNSOURCED_AUTHORITY_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:по\s+официальным\s+данным|согласно\s+официальным\s+(?:источникам|данным))(?!\s*\[)/i,
  /(?:источники\s+сообщают|инсайдеры\s+утверждают)(?!\s*\[|\s*«)/i,
];

/**
 * Проверяет ответ через channel-specific policy.
 * Синхронный (без I/O), < 1 мс.
 *
 * Использовать как последний барьер перед отправкой пользователю
 * во всех каналах: telegram, voice, digest, postcall.
 */
export function checkChannelPolicy(
  response: string,
  channel: VerifierChannel,
): ChannelPolicyResult {
  const reasons: string[] = [];

  if (!response || response.trim().length < 2) {
    return { passed: false, reasons: ['empty_response'] };
  }

  // Persona-нарушения проверяем везде, кроме system
  if (PERSONA_VIOLATION_PATTERNS.some((p) => p.test(response))) {
    reasons.push('persona_violation: LLM раскрывает AI-природу вместо образа техножрицы');
  }

  if (channel === 'voice') {
    if (looksLikeSearchSimulation(response)) {
      reasons.push('voice_search_simulation: голосовой ответ симулирует поиск');
    }
    if (response.length > 800) {
      reasons.push(`voice_too_long: ответ ${response.length} символов — слишком длинный для телефонии`);
    }
    if (/[#*_`[\]]/u.test(response)) {
      reasons.push('voice_markdown: голосовой ответ содержит Markdown-разметку');
    }
  }

  if (channel === 'digest' || channel === 'postcall') {
    if (UNSOURCED_AUTHORITY_PATTERNS.some((p) => p.test(response))) {
      reasons.push('unsourced_authority_claim: ответ содержит утверждения из "официальных источников" без ссылки');
    }
  }

  return { passed: reasons.length === 0, reasons };
}
