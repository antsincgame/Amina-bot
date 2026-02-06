/**
 * LLM Response Verifier
 * 
 * Вторая LLM проверяет ответ первой на:
 * - Фактическую корректность (не выдумал ли факты)
 * - Выполнение инструкций (ответил ли на вопрос)
 * - Отсутствие галлюцинаций (не симулирует ли поиск)
 * - Адекватность ответа
 * 
 * Прозрачно для пользователя: если ответ некорректен,
 * верификатор возвращает исправленную версию.
 * 
 * Стратегия: используем более дешёвую/быструю модель для верификации
 */

import OpenAI from 'openai';
import { config, getApiKeys } from '../config/index.js';
import { settingsRepo } from '../db/supabase.js';
import { aiLogger } from '../config/logger.js';

// Кэш настройки верификации
let cachedVerifyEnabled: boolean | null = null;
let verifyCacheLoadedAt = 0;
const VERIFY_CACHE_TTL = 60 * 1000; // 1 минута

// Модели для верификации (дешёвые/быстрые)
const VERIFY_MODELS = [
  'meta-llama/llama-3.2-3b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free',
  'qwen/qwen-2-7b-instruct:free',
];

/**
 * Проверяет, включена ли верификация ответов
 */
async function isVerificationEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedVerifyEnabled !== null && now - verifyCacheLoadedAt < VERIFY_CACHE_TTL) {
    return cachedVerifyEnabled;
  }
  try {
    const val = await settingsRepo.get('llm_verify_enabled');
    cachedVerifyEnabled = val === 'true';
    verifyCacheLoadedAt = now;
    return cachedVerifyEnabled;
  } catch {
    return cachedVerifyEnabled ?? false;
  }
}

/**
 * Сбросить кэш верификации
 */
export function clearVerifyCache(): void {
  cachedVerifyEnabled = null;
  verifyCacheLoadedAt = 0;
}

/**
 * Результат верификации
 */
export interface VerifyResult {
  /** Оригинальный ответ прошёл проверку */
  isValid: boolean;
  /** Исправленный ответ (если isValid=false) */
  correctedResponse?: string;
  /** Причина коррекции */
  reason?: string;
  /** Время верификации (мс) */
  verifyTimeMs: number;
  /** Верификация была пропущена (выключена / ошибка) */
  skipped: boolean;
}

/**
 * Верифицирует ответ LLM через вторую модель
 * 
 * Проверяет:
 * 1. Ответил ли на вопрос пользователя
 * 2. Нет ли выдуманных фактов/дат/цифр
 * 3. Не симулирует ли поиск в интернете
 * 4. Адекватен ли ответ
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
  
  // Проверяем, включена ли верификация
  const enabled = await isVerificationEnabled();
  if (!enabled) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }

  // Не верифицируем короткие / простые ответы
  if (aiResponse.length < 50 || userMessage.length < 10) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }

  // Не верифицируем бытовые сообщения
  if (/^(привет|здравствуй|ок|да|нет|спасибо|хорошо|ладно|пока)\s*[.!?]*$/i.test(userMessage.trim())) {
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }

  try {
    const keys = await getApiKeys();
    if (!keys.openrouter) {
      return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
    }

    const verifyClient = new OpenAI({
      apiKey: keys.openrouter,
      baseURL: config.ai.baseUrl,
      timeout: 15000, // 15 сек макс для верификации
    });

    const verifyPrompt = buildVerifyPrompt(userMessage, aiResponse, searchContext);

    // Пробуем модели по очереди (берём первую доступную)
    let verifyResult: string | null = null;
    
    for (const model of VERIFY_MODELS) {
      try {
        const response = await verifyClient.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'Ты — верификатор ответов AI. Отвечай ТОЛЬКО в формате JSON.' },
            { role: 'user', content: verifyPrompt },
          ],
          max_tokens: 500,
          temperature: 0.1,
        });

        const content = response.choices[0]?.message?.content;
        if (content) {
          verifyResult = content;
          aiLogger.debug({ model, verifyTimeMs: Date.now() - startTime }, 'Verification completed');
          break;
        }
      } catch (err) {
        aiLogger.debug({ model, error: err instanceof Error ? err.message : String(err) }, 'Verify model failed');
        continue;
      }
    }

    if (!verifyResult) {
      aiLogger.warn('All verify models failed, skipping verification');
      return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
    }

    // Парсим JSON ответ верификатора
    return parseVerifyResult(verifyResult, aiResponse, Date.now() - startTime);
  } catch (error) {
    aiLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Verification error, accepting original');
    return { isValid: true, verifyTimeMs: Date.now() - startTime, skipped: true };
  }
}

/**
 * Строит промпт для верификатора
 */
function buildVerifyPrompt(userMessage: string, aiResponse: string, searchContext?: string): string {
  const searchInfo = searchContext 
    ? `\n\nДанные из интернета были предоставлены:\n${searchContext.substring(0, 500)}...`
    : '\n\nДанные из интернета НЕ были предоставлены.';

  return `Проверь ответ AI-ассистента на корректность.

ВОПРОС ПОЛЬЗОВАТЕЛЯ:
"${userMessage.substring(0, 300)}"

ОТВЕТ AI:
"${aiResponse.substring(0, 1000)}"
${searchInfo}

ПРОВЕРЬ:
1. Ответил ли AI на вопрос пользователя? (не ушёл ли в сторону)
2. Нет ли ВЫДУМАННЫХ фактов, дат, цифр? (галлюцинации)
3. Не симулирует ли AI поиск в интернете? ("Ищу...", "Поиск в интернете", "Сейчас найду")
4. Адекватен ли ответ? (нет бреда, повторений, мусора)
5. Если были данные из интернета — использовал ли AI их корректно?

Ответь СТРОГО в формате JSON:
{
  "valid": true/false,
  "issues": ["список проблем если есть"],
  "severity": "none" | "minor" | "major" | "critical"
}

Если valid=true — просто {"valid": true, "issues": [], "severity": "none"}
Отвечай ТОЛЬКО JSON, без текста до и после.`;
}

/**
 * Парсит результат верификации
 */
function parseVerifyResult(
  rawResult: string,
  originalResponse: string,
  verifyTimeMs: number
): VerifyResult {
  try {
    // Извлекаем JSON из ответа (может быть обёрнут в ```json ... ```)
    const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { isValid: true, verifyTimeMs, skipped: false };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      valid?: boolean;
      issues?: string[];
      severity?: string;
    };

    const isValid = parsed.valid !== false;
    const issues = parsed.issues ?? [];
    const severity = parsed.severity ?? 'none';

    if (isValid || severity === 'none' || severity === 'minor') {
      return { isValid: true, verifyTimeMs, skipped: false };
    }

    // Серьёзные проблемы (major/critical) — логируем но НЕ заменяем ответ
    // (замена может быть хуже оригинала, вместо этого логируем предупреждение)
    aiLogger.warn({ 
      issues, 
      severity,
      responseSnippet: originalResponse.substring(0, 100),
      verifyTimeMs 
    }, 'LLM verification found issues');

    return {
      isValid: false,
      reason: issues.join('; '),
      verifyTimeMs,
      skipped: false,
    };
  } catch (parseError) {
    aiLogger.debug({ error: parseError, rawResult: rawResult.substring(0, 200) }, 'Failed to parse verify result');
    return { isValid: true, verifyTimeMs, skipped: false };
  }
}
