/**
 * Provider Health — circuit breaker + rate budget для AI провайдеров.
 *
 * Circuit breaker:
 * - Трекает ошибки (401/403/429) per provider
 * - При N consecutive failures → provider "open" (пропускается) на cooldown период
 * - 401/403 = долгий cooldown (5 мин) — ключ мёртв
 * - 429 = короткий cooldown (60 сек) — rate limit
 * - Пользовательские запросы могут игнорировать circuit breaker (force)
 *
 * Rate budget:
 * - Трекает RPM (requests per minute) per provider
 * - Фоновые задачи дросселируются когда >70% бюджета израсходовано
 * - Пользовательские запросы всегда проходят
 */

import { aiLogger } from '../config/logger.js';

interface ProviderState {
  consecutiveFailures: number;
  lastFailureTime: number;
  lastFailureCode: string;
  cooldownUntil: number;
  requestTimestamps: number[];  // RPM tracking
}

const providers = new Map<string, ProviderState>();

// Cooldown длительности по типу ошибки
const COOLDOWN_AUTH_MS = 5 * 60 * 1000;      // 5 мин для 401/403 (мёртвый ключ)
const COOLDOWN_RATE_LIMIT_MS = 60 * 1000;    // 60 сек для 429
const COOLDOWN_SERVER_ERROR_MS = 30 * 1000;  // 30 сек для 500/502/503
const COOLDOWN_DEFAULT_MS = 15 * 1000;       // 15 сек для прочих ошибок
const FAILURES_TO_OPEN = 3;                  // Сколько подряд ошибок чтобы открыть breaker

// Rate budget — максимум RPM per provider (free tier лимиты)
const RATE_LIMITS: Record<string, number> = {
  groq: 30,
  cerebras: 30,
  openrouter: 200,
  perplexity: 20,
};
const BACKGROUND_BUDGET_RATIO = 0.5; // Фоновые задачи могут использовать не более 50% бюджета
const RPM_WINDOW_MS = 60_000;

function getState(provider: string): ProviderState {
  let state = providers.get(provider);
  if (!state) {
    state = { consecutiveFailures: 0, lastFailureTime: 0, lastFailureCode: '', cooldownUntil: 0, requestTimestamps: [] };
    providers.set(provider, state);
  }
  return state;
}

function cleanOldTimestamps(state: ProviderState): void {
  const cutoff = Date.now() - RPM_WINDOW_MS;
  state.requestTimestamps = state.requestTimestamps.filter(ts => ts > cutoff);
}

/** Классифицирует ошибку и возвращает cooldown */
function classifyError(error: string): { code: string; cooldownMs: number } {
  if (error.includes('401') || error.includes('Unauthorized'))
    return { code: '401', cooldownMs: COOLDOWN_AUTH_MS };
  if (error.includes('403') || error.includes('Forbidden') || error.includes('DOCTYPE'))
    return { code: '403', cooldownMs: COOLDOWN_AUTH_MS };
  if (error.includes('429') || error.includes('rate limit') || error.includes('Rate limit'))
    return { code: '429', cooldownMs: COOLDOWN_RATE_LIMIT_MS };
  if (error.includes('402') || error.includes('Payment'))
    return { code: '402', cooldownMs: COOLDOWN_AUTH_MS };
  if (error.includes('500') || error.includes('502') || error.includes('503'))
    return { code: '5xx', cooldownMs: COOLDOWN_SERVER_ERROR_MS };
  return { code: 'unknown', cooldownMs: COOLDOWN_DEFAULT_MS };
}

// ============================================
// Public API
// ============================================

/** Записать успешный запрос — сбрасывает circuit breaker */
export function recordSuccess(provider: string): void {
  const state = getState(provider);
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.requestTimestamps.push(Date.now());
}

/** Записать ошибку — может открыть circuit breaker */
export function recordFailure(provider: string, error: string): void {
  const state = getState(provider);
  const { code, cooldownMs } = classifyError(error);
  state.consecutiveFailures++;
  state.lastFailureTime = Date.now();
  state.lastFailureCode = code;

  // Auth ошибки открывают breaker сразу (ключ мёртв, нет смысла пробовать)
  if (code === '401' || code === '403' || code === '402') {
    state.cooldownUntil = Date.now() + cooldownMs;
    aiLogger.warn({ provider, code, cooldownMs, cooldownUntil: new Date(state.cooldownUntil).toISOString() },
      `⚡ Circuit breaker OPEN for ${provider} (auth error)`);
    return;
  }

  // Другие ошибки — открываем после N подряд
  if (state.consecutiveFailures >= FAILURES_TO_OPEN) {
    state.cooldownUntil = Date.now() + cooldownMs;
    aiLogger.warn({ provider, code, failures: state.consecutiveFailures, cooldownMs },
      `⚡ Circuit breaker OPEN for ${provider} (${state.consecutiveFailures} consecutive failures)`);
  }
}

/** Проверить доступен ли провайдер */
export function isProviderAvailable(provider: string): boolean {
  const state = providers.get(provider);
  if (!state) return true;
  if (state.cooldownUntil <= Date.now()) return true;
  return false;
}

/** Проверить есть ли бюджет для фоновой задачи */
export function hasBackgroundBudget(provider: string): boolean {
  const limit = RATE_LIMITS[provider];
  if (!limit) return true; // Неизвестный провайдер — пропускаем

  const state = getState(provider);
  cleanOldTimestamps(state);

  const used = state.requestTimestamps.length;
  const maxForBackground = Math.floor(limit * BACKGROUND_BUDGET_RATIO);

  return used < maxForBackground;
}

/** Записать запрос в rate counter */
export function trackRequest(provider: string): void {
  const state = getState(provider);
  state.requestTimestamps.push(Date.now());
}

/** Получить текущее состояние для диагностики */
export function getProviderHealthStatus(): Record<string, {
  available: boolean;
  consecutiveFailures: number;
  lastFailureCode: string;
  cooldownUntil: string | null;
  rpm: number;
  rpmLimit: number;
}> {
  const result: Record<string, any> = {};
  for (const [provider, state] of providers) {
    cleanOldTimestamps(state);
    result[provider] = {
      available: isProviderAvailable(provider),
      consecutiveFailures: state.consecutiveFailures,
      lastFailureCode: state.lastFailureCode,
      cooldownUntil: state.cooldownUntil > Date.now() ? new Date(state.cooldownUntil).toISOString() : null,
      rpm: state.requestTimestamps.length,
      rpmLimit: RATE_LIMITS[provider] ?? 0,
    };
  }
  return result;
}

/** Сбросить circuit breaker вручную (из админки) */
export function resetProvider(provider: string): void {
  providers.delete(provider);
  aiLogger.info({ provider }, 'Circuit breaker reset manually');
}

/** Сбросить все */
export function resetAll(): void {
  providers.clear();
  aiLogger.info('All circuit breakers reset');
}
