import OpenAI from 'openai';
import { aiLogger } from '../config/logger.js';
import { settingsRepo } from '../db/index.js';
import { SingleCache } from '../utils/cache.js';

export type AIProvider = 'auto' | 'lmstudio' | 'openrouter' | 'cerebras' | 'groq';

interface LMStudioConfig {
  url: string;
  model: string;
  apiKey: string;
}

interface LMStudioModel {
  id: string;
  name: string;
  owned_by: string;
}

export interface LMStudioDirectProbeResult {
  healthy: boolean;
  status: number;
  error: string | null;
  endpoint: 'native' | 'openai' | null;
  timeout: boolean;
}

const HEALTH_CACHE_TTL_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
// Допускаем не более 1 пропущенного heartbeat (интервал по умолчанию 30с в tunnel.ps1/sh/js).
// Раньше было 180_000 — это позволяло боту до 3 минут считать LM Studio живой
// после того как туннель уже умер, и слать туда запросы, которые уходили в таймаут.
const HEARTBEAT_VALID_MS = 75_000;
const CONFIG_CACHE_TTL_MS = 60_000;
const DEFAULT_API_KEY = 'lm-studio';

const healthCache = new SingleCache<boolean>(HEALTH_CACHE_TTL_MS);
const configCache = new SingleCache<LMStudioConfig>(CONFIG_CACHE_TTL_MS);

const RETRY_BACKOFF_MS = [500, 1000, 2000] as const;
const MAX_CONSECUTIVE_FAILURES = 3;

// --------------------------------------------
// Circuit Breaker — защита от шторма таймаутов
// --------------------------------------------
// После CIRCUIT_THRESHOLD ошибок за CIRCUIT_WINDOW_MS
// LM Studio отключается на CIRCUIT_COOLDOWN_MS.
// Через cooldown допускается один «half-open» запрос:
// успех → закрываем, неудача → снова cooldown.

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_WINDOW_MS = 60_000;       // 1 мин
const CIRCUIT_COOLDOWN_MS = 3 * 60_000; // 3 мин

type CircuitState = 'closed' | 'open' | 'half-open';

let circuitState: CircuitState = 'closed';
let circuitOpenedAt = 0;
let recentFailures: number[] = [];
// В half-open пропускаем строго ОДИН probe-запрос. Без флага десятки параллельных
// вызовов могли одновременно перейти из 'open' в 'half-open' и все уйти в LM Studio,
// перегружая мёртвый туннель.
let halfOpenProbeInFlight = false;
// Момент выдачи half-open пробы. Нужен как deadline-аренда: если вызывающий код
// получил пробу (isLMStudioCircuitOpen()→false), но НЕ вызвал recordSuccess/Failure
// (например, конфиг/модель отсутствуют или health-check упал на пути к запросу —
// см. openrouter.ts:670-677), флаг halfOpenProbeInFlight раньше залипал в true
// НАВСЕГДА и LM Studio блокировался до ручного reload. Теперь аренда истекает.
let halfOpenProbeStartedAt = 0;
// Чуть больше таймаута клиента LM Studio (60с) — к этому моменту реальная проба
// гарантированно завершилась бы и вызвала record*. Если нет — аренду освобождаем.
const HALF_OPEN_PROBE_TIMEOUT_MS = 70_000;

function grantHalfOpenProbe(): void {
  halfOpenProbeInFlight = true;
  halfOpenProbeStartedAt = Date.now();
}

function pruneOldFailures(): void {
  const cutoff = Date.now() - CIRCUIT_WINDOW_MS;
  recentFailures = recentFailures.filter(ts => ts > cutoff);
}

/** Зафиксировать ошибку запроса к LM Studio */
export function recordLMStudioFailure(): void {
  recentFailures.push(Date.now());
  if (recentFailures.length > 100) recentFailures.splice(0, recentFailures.length - 100);
  pruneOldFailures();

  if (circuitState === 'half-open') {
    circuitState = 'open';
    circuitOpenedAt = Date.now();
    halfOpenProbeInFlight = false;
    halfOpenProbeStartedAt = 0;
    aiLogger.warn('⚡ LM Studio circuit breaker: half-open → OPEN (проба не удалась)');
    return;
  }

  if (circuitState === 'closed' && recentFailures.length >= CIRCUIT_THRESHOLD) {
    circuitState = 'open';
    circuitOpenedAt = Date.now();
    aiLogger.warn(
      { failures: recentFailures.length, windowMs: CIRCUIT_WINDOW_MS, cooldownMs: CIRCUIT_COOLDOWN_MS },
      `⚡ LM Studio circuit breaker: OPEN — ${recentFailures.length} ошибок за ${CIRCUIT_WINDOW_MS / 1000}с, пауза ${CIRCUIT_COOLDOWN_MS / 1000}с`,
    );
  }
}

/** Зафиксировать успех запроса к LM Studio */
export function recordLMStudioSuccess(): void {
  if (circuitState !== 'closed') {
    aiLogger.info('✅ LM Studio circuit breaker: → CLOSED (запрос успешен)');
  }
  circuitState = 'closed';
  recentFailures = [];
  halfOpenProbeInFlight = false;
  halfOpenProbeStartedAt = 0;
}

/** Проверить, заблокирован ли LM Studio circuit breaker'ом */
export function isLMStudioCircuitOpen(): boolean {
  if (circuitState === 'closed') return false;

  if (circuitState === 'open') {
    const elapsed = Date.now() - circuitOpenedAt;
    if (elapsed >= CIRCUIT_COOLDOWN_MS) {
      circuitState = 'half-open';
      grantHalfOpenProbe();
      aiLogger.info('🔄 LM Studio circuit breaker: OPEN → half-open (cooldown истёк, проба №1)');
      return false; // допускаем строго один запрос
    }
    return true; // ещё в cooldown
  }

  // half-open: пропускаем один probe за раз. Аренда пробы истекает по таймауту —
  // иначе «потерянная» проба (без последующего record*) залипала бы навсегда.
  if (halfOpenProbeInFlight && Date.now() - halfOpenProbeStartedAt < HALF_OPEN_PROBE_TIMEOUT_MS) {
    return true;
  }
  if (halfOpenProbeInFlight) {
    aiLogger.warn('⚠️ LM Studio circuit breaker: half-open проба истекла без результата — выдаём новую');
  }
  grantHalfOpenProbe();
  return false;
}

/** Состояние для логов/админки */
export function getLMStudioCircuitStatus(): {
  state: CircuitState;
  recentFailures: number;
  cooldownRemainingSec: number;
} {
  pruneOldFailures();
  const remaining = circuitState === 'open'
    ? Math.max(0, Math.ceil((CIRCUIT_COOLDOWN_MS - (Date.now() - circuitOpenedAt)) / 1000))
    : 0;
  return { state: circuitState, recentFailures: recentFailures.length, cooldownRemainingSec: remaining };
}

let lmStudioClient: OpenAI | null = null;
let currentLmStudioUrl = '';
let currentLmStudioKey = '';
let consecutiveFailures = 0;

export async function getAIProvider(): Promise<AIProvider> {
  const value = await settingsRepo.get('ai_provider');
  if (value === 'lmstudio' || value === 'openrouter' || value === 'cerebras' || value === 'groq') return value;
  return 'auto';
}

export async function getLMStudioConfig(): Promise<LMStudioConfig | null> {
  const cached = configCache.get();
  if (cached) return cached;

  const settings = await settingsRepo.getMany([
    'lmstudio_url',
    'lmstudio_model',
    'lmstudio_api_key',
  ]);

  const url = settings['lmstudio_url']?.trim();
  if (!url) return null;

  const dbApiKey = settings['lmstudio_api_key']?.trim();
  const envApiKey = process.env.LMSTUDIO_API_KEY?.trim();
  const apiKey = envApiKey || dbApiKey || DEFAULT_API_KEY;

  // Сначала срезаем любые завершающие слэши и /v1 (в любом регистре, с/без слэша),
  // затем добавляем ровно один /v1 — иначе при URL `.../v1/` получим `.../v1/v1`.
  const baseUrl = normalizeLMStudioBaseUrl(url);
  const cfg: LMStudioConfig = {
    url: `${baseUrl}/v1`,
    model: settings['lmstudio_model']?.trim() || '',
    apiKey,
  };

  configCache.set(cfg);
  return cfg;
}

export function getLMStudioClient(cfg: LMStudioConfig): OpenAI {
  if (lmStudioClient && currentLmStudioUrl === cfg.url && currentLmStudioKey === cfg.apiKey) {
    return lmStudioClient;
  }

  lmStudioClient = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.url,
    timeout: 60_000,
  });
  currentLmStudioUrl = cfg.url;
  currentLmStudioKey = cfg.apiKey;
  aiLogger.debug({ url: cfg.url }, 'LM Studio client initialized');
  return lmStudioClient;
}

const HEALTH_CHECK_HEADERS: Record<string, string> = {
  'User-Agent': 'Amina-Bot/1.0 (LM-Studio-Health)',
  Accept: 'application/json',
};

function normalizeLMStudioBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function getModelsUrl(cfg: LMStudioConfig, useNativeApi: boolean): string {
  const base = cfg.url.replace(/\/v1\/?$/, '');
  if (useNativeApi) {
    return `${base}/api/v1/models`;
  }
  return cfg.url.endsWith('/v1') ? `${cfg.url}/models` : `${cfg.url}/v1/models`;
}

function getProbeHeaders(apiKey: string, userAgent: string): Record<string, string> {
  return {
    ...buildLMStudioHeaders(apiKey),
    'User-Agent': userAgent,
  };
}

function getProbeEndpoint(useNativeApi: boolean): 'native' | 'openai' {
  return useNativeApi ? 'native' : 'openai';
}

function buildLMStudioHeaders(apiKey?: string): Record<string, string> {
  return {
    ...HEALTH_CHECK_HEADERS,
    ...(apiKey && apiKey !== DEFAULT_API_KEY
      ? { Authorization: `Bearer ${apiKey}` }
      : {}),
  };
}

function parseLMStudioModelsPayload(json: unknown): LMStudioModel[] | null {
  const openaiData = json as { data?: Array<{ id: string; owned_by?: string }> };
  if (openaiData?.data && Array.isArray(openaiData.data)) {
    return openaiData.data.map((model) => ({
      id: model.id,
      name: model.id.split('/').pop()?.replace(/-/g, ' ') ?? model.id,
      owned_by: model.owned_by ?? 'local',
    }));
  }

  const nativeData = json as { models?: Array<{ key: string; display_name?: string }> };
  if (nativeData?.models && Array.isArray(nativeData.models)) {
    return nativeData.models.map((model) => ({
      id: model.key,
      name: model.display_name ?? model.key.split('/').pop()?.replace(/-/g, ' ') ?? model.key,
      owned_by: 'local',
    }));
  }

  return null;
}

const HEARTBEAT_KEY = 'lmstudio_url_updated_at';
const HEARTBEAT_URL_KEY = 'lmstudio_url_heartbeat_url';

export async function recordHeartbeat(url?: string): Promise<void> {
  await settingsRepo.set(HEARTBEAT_KEY, new Date().toISOString());
  if (url) {
    await settingsRepo.set(HEARTBEAT_URL_KEY, normalizeLMStudioBaseUrl(url));
  }
}

async function isHeartbeatRecent(expectedUrl?: string): Promise<boolean> {
  const raw = await settingsRepo.get(HEARTBEAT_KEY);
  if (!raw) return false;

  if (expectedUrl) {
    const heartbeatUrl = await settingsRepo.get(HEARTBEAT_URL_KEY);
    if (!heartbeatUrl) return false;
    if (normalizeLMStudioBaseUrl(heartbeatUrl) !== normalizeLMStudioBaseUrl(expectedUrl)) {
      return false;
    }
  }

  try {
    const ts = new Date(raw).getTime();
    return Date.now() - ts < HEARTBEAT_VALID_MS;
  } catch {
    return false;
  }
}

export async function getHeartbeatAt(): Promise<string | null> {
  const raw = await settingsRepo.get(HEARTBEAT_KEY);
  return raw && typeof raw === 'string' ? raw.trim() || null : null;
}

export async function getHeartbeatUrl(): Promise<string | null> {
  const raw = await settingsRepo.get(HEARTBEAT_URL_KEY);
  return raw && typeof raw === 'string' ? raw.trim() || null : null;
}

export interface LMStudioHealthStatus {
  healthy: boolean;
  source: 'heartbeat' | 'direct' | null;
  heartbeatAt: string | null;
}

export async function getLMStudioHealthStatus(cfg: LMStudioConfig): Promise<LMStudioHealthStatus> {
  const heartbeatAt = await getHeartbeatAt();
  const viaHeartbeat = await isHeartbeatRecent(cfg.url);

  if (viaHeartbeat) {
    healthCache.set(true);
    aiLogger.debug({ url: cfg.url }, 'LM Studio healthy via heartbeat');
    return { healthy: true, source: 'heartbeat', heartbeatAt };
  }

  const cached = healthCache.get();
  if (cached !== null) {
    return { healthy: cached, source: cached ? 'direct' : null, heartbeatAt };
  }

  const direct = await checkLMStudioHealthDirect(cfg);
  return { healthy: direct, source: direct ? 'direct' : null, heartbeatAt };
}

export async function checkLMStudioHealth(cfg: LMStudioConfig): Promise<boolean> {
  const status = await getLMStudioHealthStatus(cfg);
  return status.healthy;
}

export async function probeLMStudioDirect(
  cfg: LMStudioConfig,
  options?: { timeoutMs?: number; userAgent?: string },
): Promise<LMStudioDirectProbeResult> {
  const timeoutMs = options?.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const userAgent = options?.userAgent ?? 'Amina-Bot/1.0 (LM-Studio-Health)';
  const headers = getProbeHeaders(cfg.apiKey, userAgent);

  let lastResult: LMStudioDirectProbeResult = {
    healthy: false,
    status: 0,
    error: null,
    endpoint: null,
    timeout: false,
  };

  for (const useNativeApi of [true, false]) {
    const endpoint = getProbeEndpoint(useNativeApi);
    try {
      const response = await fetch(getModelsUrl(cfg, useNativeApi), {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        return {
          healthy: true,
          status: response.status,
          error: null,
          endpoint,
          timeout: false,
        };
      }

      lastResult = {
        healthy: false,
        status: response.status,
        error: null,
        endpoint,
        timeout: false,
      };
    } catch (error) {
      lastResult = {
        healthy: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
        endpoint,
        timeout: error instanceof Error && error.name === 'AbortError',
      };
    }
  }

  return lastResult;
}

async function checkLMStudioHealthDirect(cfg: LMStudioConfig): Promise<boolean> {
  // Heartbeat уже проверен в getLMStudioHealthStatus() — здесь только direct probe + cache
  const cached = healthCache.get();
  if (cached !== null) return cached;

  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt - 1]));
    }

    const result = await probeLMStudioDirect(cfg, {
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      userAgent: 'Amina-Bot/1.0 (LM-Studio-Health)',
    });

    if (result.healthy) {
      healthCache.set(true);
      consecutiveFailures = 0;
      const msg = attempt === 0
        ? 'LM Studio health check succeeded'
        : `LM Studio health check succeeded on retry #${attempt}`;
      aiLogger.info({ url: cfg.url, endpoint: result.endpoint, attempt }, msg);
      return true;
    }

    if (result.status > 0) {
      aiLogger.debug(
        { url: cfg.url, status: result.status, endpoint: result.endpoint, attempt },
        'LM Studio health check: non-OK response',
      );
    } else if (result.error) {
      aiLogger.debug(
        { url: cfg.url, error: result.error, timeout: result.timeout, endpoint: result.endpoint, attempt },
        'LM Studio health check failed (Server may not reach Cloudflare tunnel)',
      );
    }
  }

  consecutiveFailures++;
  healthCache.set(false);

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    aiLogger.warn(
      { url: cfg.url, consecutiveFailures },
      'LM Studio unreachable after consecutive failures — clearing client cache for fresh reconnect',
    );
    lmStudioClient = null;
    currentLmStudioUrl = '';
    currentLmStudioKey = '';
    consecutiveFailures = 0;
  }

  return false;
}

export async function fetchLMStudioModels(cfg: LMStudioConfig): Promise<LMStudioModel[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  const tryFetch = async (url: string): Promise<LMStudioModel[]> => {
    const response = await fetch(url, {
      headers: buildLMStudioHeaders(cfg.apiKey),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`LM Studio API error: ${response.status}`);
    const json = (await response.json()) as unknown;
    const models = parseLMStudioModelsPayload(json);
    if (!models) throw new Error('Unexpected LM Studio API response format');
    return models;
  };

  try {
    try {
      return await tryFetch(getModelsUrl(cfg, true));
    } catch (error) {
      aiLogger.debug({ error: error instanceof Error ? error.message : String(error) }, 'LM Studio native API failed, falling back to OpenAI API');
      return await tryFetch(getModelsUrl(cfg, false));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    aiLogger.error({ url: cfg.url, error: msg }, 'Failed to fetch LM Studio models');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Проверяет tunnel endpoint без Authorization.
 * 200 требует валидный JSON формата LM Studio/OpenAI, 401/403 считаем защищённым,
 * но живым LM Studio API. Это не раскрывает LMSTUDIO_API_KEY внешнему URL.
 */
export async function probeLMStudioTunnelUrl(tunnelUrl: string): Promise<boolean> {
  const cfg: LMStudioConfig = {
    url: `${normalizeLMStudioBaseUrl(tunnelUrl)}/v1`,
    model: '',
    apiKey: DEFAULT_API_KEY,
  };

  for (const useNative of [true, false]) {
    try {
      const response = await fetch(getModelsUrl(cfg, useNative), {
        headers: buildLMStudioHeaders(),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 401 || response.status === 403) {
        return true;
      }

      if (!response.ok) {
        continue;
      }

      const json = (await response.json()) as unknown;
      if (parseLMStudioModelsPayload(json)?.length) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * Прямая проверка доступности LM Studio через tunnel URL.
 * Обходит heartbeat и кэш — реально делает HTTP-запрос к tunnel.
 * Таймаут 10 с, без retry — для быстрого ответа в /api/tunnel/register.
 */
export async function checkLMStudioReachable(cfg: LMStudioConfig): Promise<boolean> {
  const REACHABLE_TIMEOUT_MS = 10_000;

  for (const useNative of [true, false]) {
    const url = getModelsUrl(cfg, useNative);
    try {
      const response = await fetch(url, {
        headers: buildLMStudioHeaders(cfg.apiKey),
        signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS),
      });
      if (response.ok) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function clearLMStudioCache(): void {
  healthCache.clear();
  configCache.clear();
  lmStudioClient = null;
  currentLmStudioUrl = '';
  currentLmStudioKey = '';
  // Сбрасываем circuit breaker при ручной очистке
  circuitState = 'closed';
  recentFailures = [];
  halfOpenProbeInFlight = false;
  halfOpenProbeStartedAt = 0;
  aiLogger.debug('LM Studio caches + circuit breaker cleared');
}
