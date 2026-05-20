import OpenAI from 'openai';
import { config, getApiKeys } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { getProxyHeaders } from '../config/ai-proxy.js';
import { settingsRepo } from '../db/index.js';
import type { AIResponse, AIMessage } from '../../../shared/types/index.js';
import { AppError } from '../utils/error-handler.js';
import { SingleCache } from '../utils/cache.js';
import {
  getAIProvider,
  getLMStudioConfig,
  getLMStudioClient,
  checkLMStudioHealth,
  isLMStudioCircuitOpen,
  recordLMStudioFailure,
  recordLMStudioSuccess,
  type AIProvider,
} from './lmstudio.js';
import { HEALTH_AI_TIMEOUT_MS } from '../config/constants.js';
import { buildPersonaSystemPrompt } from './persona.js';
import * as providerHealth from './provider-health.js';
import { getActivePromptContent } from './self-core-kernel.js';
import { getTelephonyRuntimeConfig } from '../features/telephony/service/telephony-runtime-config.js';

// --------------------------------------------
// Динамический поиск бесплатных моделей через OpenRouter API
// --------------------------------------------

const RUSSIAN_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'meta-llama/llama-3.1-8b-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-2-9b-it:free',
  'google/gemma-3-4b-it:free',
  'google/gemma-3-12b-it:free',
  'google/gemma-3-27b-it:free',
  'google/gemma-3n-e2b-it:free',
  'google/gemma-3n-e4b-it:free',
  'mistralai/mistral-7b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'microsoft/phi-3-mini-128k-instruct:free',
  'microsoft/phi-4-mini-instruct:free',
  'qwen/qwen3-8b:free',
  'qwen/qwen3-14b:free',
  'qwen/qwen3-30b-a3b:free',
  'qwen/qwen3-32b:free',
  'qwen/qwen3.5-35b-a3b:free',
  'deepseek/deepseek-r1-0528:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  'nvidia/llama-3.1-nemotron-70b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
]);

const BLOCKED_MODEL_PATTERNS = [
  'yi-', 'baichuan', 'sakura', 'japanese', 'chinese',
];

function isRussianCapable(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (BLOCKED_MODEL_PATTERNS.some(p => lower.includes(p))) return false;
  if (RUSSIAN_CAPABLE_MODELS.has(modelId)) return true;
  if (lower.includes('llama') || lower.includes('gemma') || lower.includes('mistral') || lower.includes('phi')
    || lower.includes('qwen') || lower.includes('deepseek') || lower.includes('dolphin') || lower.includes('nemotron')
    || lower.includes('hermes') || lower.includes('command') || lower.includes('nous')) return true;
  return false;
}

const STATIC_FREE_MODELS = [...RUSSIAN_CAPABLE_MODELS];

const freeModelsCache = new SingleCache<string[]>(5 * 60 * 1000); // 5 минут
let inFlightFreeModels: Promise<string[]> | null = null;

/**
 * Динамически получает список бесплатных моделей от OpenRouter
 * Кэширует на 5 минут для оптимизации
 */
async function fetchFreeModelsInner(): Promise<string[]> {
  try {
    const keys = await getApiKeys();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 сек таймаут
    
    let response: Response;
    try {
      response = await fetch(`${config.ai.baseUrl}/models`, {
        headers: getProxyHeaders({ 'Authorization': `Bearer ${keys.openrouter}` }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }
    
    const data = await response.json() as {
      data: Array<{
        id: string;
        pricing: { prompt: string; completion: string };
        context_length?: number;
      }>;
    };
    
    // Валидация ответа API
    if (!data?.data || !Array.isArray(data.data)) {
      throw new Error('Unexpected OpenRouter API response format');
    }

    const freeModels = data.data
      .filter(m => m.pricing?.prompt === '0' && m.pricing?.completion === '0')
      .filter(m => (m.context_length || 0) >= 4096)
      .map(m => m.id)
      .filter(isRussianCapable)
      .slice(0, 29);
    
    if (freeModels.length > 0) {
      freeModelsCache.set(freeModels);
      aiLogger.info({ count: freeModels.length }, '🆓 Fetched free models from OpenRouter');
      return freeModels;
    }
    
    throw new Error('No free models found');
  } catch (error) {
    aiLogger.warn({ error }, 'Failed to fetch free models, using static list');
    return STATIC_FREE_MODELS;
  }
}

async function fetchFreeModels(): Promise<string[]> {
  const cached = freeModelsCache.get();
  if (cached) return cached;

  if (inFlightFreeModels) return inFlightFreeModels;

  inFlightFreeModels = fetchFreeModelsInner().finally(() => {
    inFlightFreeModels = null;
  });
  return inFlightFreeModels;
}

/**
 * Получить бесплатные модели (динамически или статически)
 */
async function getFreeModels(): Promise<string[]> {
  try {
    return await fetchFreeModels();
  } catch {
    return STATIC_FREE_MODELS;
  }
}

// Таймаут для гонки моделей (ужать гонку; серверный REQUEST_TIMEOUT_MS задаётся отдельно)
const RACE_TIMEOUT_MS = 15000;

// Groq бесплатные модели для чата (30 RPM free tier)
const GROQ_CHAT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'qwen/qwen3-32b',
  'openai/gpt-oss-120b',
];

// Cerebras модели — сверхбыстрый инференс (1000-3000 tok/s)
// https://inference-docs.cerebras.ai/models/overview
const CEREBRAS_CHAT_MODELS = [
  'qwen-3-235b-a22b-instruct-2507',  // Qwen3 235B MoE — flagship (~1400 tok/s)
  'gpt-oss-120b',                      // OpenAI GPT-OSS 120B — reasoning (~3000 tok/s)
  'zai-glm-4.7',                       // Z.ai GLM 4.7 355B — reasoning, философия (~1000 tok/s)
  'llama3.1-8b',                       // Llama 3.1 8B — быстрая (~2200 tok/s)
];

/**
 * Варп-маршруты: Cerebras → Groq — первый fallback перед OpenRouter
 * Псайкер Амина находит путь к свободным нейронкам через Имматериум
 */
async function tryWarpRoutes(
  messages: AIMessage[],
  aiConfig: { model: string; maxTokens: number; temperature: number },
): Promise<(AIResponse & { usedModel: string }) | null> {
  const keys = await getApiKeys();
  const chatMessages = messages as OpenAI.ChatCompletionMessageParam[];

  const tryModel = async (provider: string, baseURL: string, apiKey: string, model: string, headers: Record<string, string>, signal?: AbortSignal): Promise<AIResponse & { usedModel: string }> => {
    providerHealth.trackRequest(provider);
    const client = new OpenAI({ apiKey, baseURL, timeout: 8000, defaultHeaders: headers });
    const completion = await client.chat.completions.create({
      model,
      messages: chatMessages,
      max_tokens: aiConfig.maxTokens,
      temperature: aiConfig.temperature,
    }, signal ? { signal } : undefined);
    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response');
    providerHealth.recordSuccess(provider);
    return {
      content,
      model: `${provider}/${model}`,
      tokens_used: {
        prompt: completion.usage?.prompt_tokens ?? 0,
        completion: completion.usage?.completion_tokens ?? 0,
        total: completion.usage?.total_tokens ?? 0,
      },
      finish_reason: completion.choices?.[0]?.finish_reason ?? 'unknown',
      usedModel: `${provider}/${model}`,
    };
  };

  // Собираем все доступные варп-маршруты, пропуская мёртвые провайдеры (circuit breaker)
  const candidates: Array<{ provider: string; baseURL: string; apiKey: string; model: string; headers: Record<string, string> }> = [];

  if (keys.cerebras && providerHealth.isProviderAvailable('cerebras')) {
    for (const m of CEREBRAS_CHAT_MODELS) candidates.push({ provider: 'cerebras', baseURL: config.cerebras.baseUrl, apiKey: keys.cerebras, model: m, headers: getProxyHeaders() });
  } else if (keys.cerebras) {
    aiLogger.warn({ provider: 'cerebras' }, 'Cerebras has key but circuit-broken — skipped in warp routes');
  } else {
    aiLogger.warn({ provider: 'cerebras' }, 'Cerebras: no API key');
  }
  if (keys.groq && providerHealth.isProviderAvailable('groq')) {
    for (const m of GROQ_CHAT_MODELS) candidates.push({ provider: 'groq', baseURL: config.groq.baseUrl, apiKey: keys.groq, model: m, headers: getProxyHeaders() });
  } else if (keys.groq) {
    aiLogger.warn({ provider: 'groq' }, 'Groq has key but circuit-broken — skipped in warp routes');
  } else {
    aiLogger.warn({ provider: 'groq' }, 'Groq: no API key');
  }

  if (candidates.length === 0) {
    aiLogger.error('No warp route API keys configured or all providers circuit-broken');
    return null;
  }

  aiLogger.info({ count: candidates.length }, '🔮 Warp routes: racing all candidates');

  // Отменяем проигравших, как только появился победитель. Раньше все кандидаты
  // (Cerebras/Groq) доезжали до конца даже после победы первого — это жгло RPM-бюджет
  // именно тех бесплатных провайдеров, которые мы пытаемся беречь.
  const raceAbort = new AbortController();
  try {
    const winner = await Promise.any(
      candidates.map(async (c) => {
        try {
          const result = await tryModel(c.provider, c.baseURL, c.apiKey, c.model, c.headers, raceAbort.signal);
          aiLogger.info({ model: result.usedModel, tokens: result.tokens_used.total }, '🔮 Warp route winner');
          return result;
        } catch (error) {
          // Отменённые после победы запросы — не реальный сбой провайдера.
          // Не записываем их в circuit breaker, иначе один успех «ронял» бы
          // здоровые маршруты ложными failure'ами.
          if (raceAbort.signal.aborted) throw error;
          const msg = error instanceof Error ? error.message : String(error);
          providerHealth.recordFailure(c.provider, msg);
          aiLogger.debug({ model: `${c.provider}/${c.model}`, error: msg }, 'Warp candidate failed');
          throw error;
        }
      })
    );
    return winner;
  } catch {
    aiLogger.error('All warp routes exhausted — the Astronomican grows dim');
    return null;
  } finally {
    raceAbort.abort();
  }
}

// Ошибки при которых нужен параллельный fallback (включая 402!)
const RACE_ERROR_PATTERNS = [
  'Provider returned error',
  'Empty response',
  'No endpoints found',
  '503',
  '502',
  '500',
  '400',
  '402',  // ← ДОБАВЛЕНО: Payment Required тоже запускает гонку бесплатных
  'Payment Required',
  'temporarily unavailable',
  'overloaded',
];

// Трекер последнего переключения
let lastFallbackSwitch: {
  reason: string | null;
  time: Date | null;
  fromModel: string | null;
  toModel: string | null;
} = {
  reason: null,
  time: null,
  fromModel: null,
  toModel: null,
};

// --------------------------------------------
// OpenRouter Client (dynamic API key)
// --------------------------------------------

let openai: OpenAI | null = null;
let currentApiKey: string = '';

/**
 * Получить OpenRouter клиент с актуальным API ключом
 * Ключ берётся: env → БД (админка)
 */
const getClient = async (): Promise<OpenAI> => {
  const keys = await getApiKeys();
  const apiKey = keys.openrouter;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY не задан. Укажите его в переменных окружения или в админке.');
  }

  // Пересоздаём клиент если ключ изменился
  if (!openai || currentApiKey !== apiKey) {
    openai = new OpenAI({
      apiKey: apiKey,
      baseURL: config.ai.baseUrl,
      timeout: 30000,
      defaultHeaders: getProxyHeaders({
        'HTTP-Referer': config.botUrl,
        'X-Title': 'Amina AI Bot',
      }),
    });
    currentApiKey = apiKey;
    aiLogger.info('OpenRouter client initialized/updated');
  }
  return openai;
};

// --------------------------------------------
// Cerebras Client (основной провайдер, если выбран)
// --------------------------------------------

let cerebrasClient: OpenAI | null = null;
let currentCerebrasKey: string = '';

const getCerebrasClient = async (): Promise<OpenAI> => {
  const keys = await getApiKeys();
  const apiKey = keys.cerebras;
  if (!apiKey) {
    throw new Error('CEREBRAS_API_KEY не задан. Укажите в переменных окружения или в админке.');
  }
  if (!cerebrasClient || currentCerebrasKey !== apiKey) {
    cerebrasClient = new OpenAI({
      apiKey,
      baseURL: config.cerebras.baseUrl,
      timeout: 30000,
      defaultHeaders: getProxyHeaders(),
    });
    currentCerebrasKey = apiKey;
    aiLogger.info('Cerebras client initialized/updated');
  }
  return cerebrasClient;
};

// --------------------------------------------
// Groq Chat Client (основной провайдер, если выбран)
// --------------------------------------------

let groqChatClient: OpenAI | null = null;
let currentGroqChatKey: string = '';

const getGroqChatClient = async (): Promise<OpenAI> => {
  const keys = await getApiKeys();
  const apiKey = keys.groq;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY не задан. Укажите в переменных окружения или в админке.');
  }
  if (!groqChatClient || currentGroqChatKey !== apiKey) {
    groqChatClient = new OpenAI({
      apiKey,
      baseURL: config.groq.baseUrl,
      timeout: 30000,
      defaultHeaders: getProxyHeaders(),
    });
    currentGroqChatKey = apiKey;
    aiLogger.info('Groq chat client initialized/updated');
  }
  return groqChatClient;
};

// --------------------------------------------
// Dynamic Configuration from Database
// --------------------------------------------

interface AIConfig {
  model: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

export interface AIChatOptions {
  promptMode?: 'default' | 'passthrough';
  maxTokens?: number;
  temperature?: number;
  providerOverride?: AIProvider;
  modelOverride?: string;
  fallbackStrategy?: 'race' | 'sequential' | 'off';
  fallbackModelLimit?: number;
  /** user = пользовательский запрос (всегда проходит), background = фоновая задача (дросселируется) */
  priority?: 'user' | 'background';
}

/**
 * Получить модель для прямого провайдера (Cerebras / Groq).
 * Приоритет: настройка в БД → первая модель из списка.
 */
async function getDirectProviderModel(provider: 'cerebras' | 'groq'): Promise<string> {
  const settingKey = provider === 'cerebras' ? 'cerebras_model' : 'groq_model';
  const dbModel = await settingsRepo.get(settingKey);
  if (dbModel?.trim()) return dbModel.trim();
  // Fallback на env
  const envModel = provider === 'cerebras' ? config.cerebras.model : config.groq.model;
  if (envModel?.trim()) return envModel.trim();
  const defaultModels = provider === 'cerebras' ? CEREBRAS_CHAT_MODELS : GROQ_CHAT_MODELS;
  return defaultModels[0] ?? 'qwen-3-235b-a22b-instruct-2507';
}

/**
 * Получить клиент и модель для прямого провайдера.
 */
async function getDirectProviderClientAndModel(
  provider: 'cerebras' | 'groq',
): Promise<{ client: OpenAI; model: string; providerName: string }> {
  const client = provider === 'cerebras' ? await getCerebrasClient() : await getGroqChatClient();
  const model = await getDirectProviderModel(provider);
  return { client, model, providerName: provider };
}

const getAIConfig = async (
  channel: 'telegram' | 'voice',
  options?: { includePrompt?: boolean; modelOverride?: string },
): Promise<AIConfig> => {
  const includePrompt = options?.includePrompt ?? true;

  const [settings, additionalPrompt] = await Promise.all([
    settingsRepo.getMany([
      'openrouter_model',
      'custom_model_override',
      'max_tokens',
      'temperature',
    ]),
    includePrompt
      ? getActivePromptContent(channel)
      : Promise.resolve(''),
  ]);

  let model =
    options?.modelOverride?.trim()
    || settings['openrouter_model']
    || config.ai.model
    || 'openrouter/free';
  let modelSource: string;

  if (options?.modelOverride?.trim()) {
    modelSource = 'options_override';
  } else if (settings['openrouter_model']) {
    modelSource = 'database';
  } else if (config.ai.model) {
    modelSource = 'env_config';
  } else {
    modelSource = 'default_fallback';
  }
  
  if (!options?.modelOverride?.trim() && settings['custom_model_override'] && settings['custom_model_override'].trim()) {
    model = settings['custom_model_override'].trim();
    modelSource = 'custom_override';
    aiLogger.debug({ model, source: modelSource }, 'Using custom_model_override');
  }

  const promptContent = includePrompt
    ? await buildPersonaSystemPrompt({ channel, modelId: model })
    : '';
  aiLogger.debug({
    model,
    source: modelSource,
    dbModel: settings['openrouter_model'],
    envModel: config.ai.model,
  }, 'AI config loaded');

  return {
    model,
    systemPrompt: includePrompt
      ? [
          promptContent,
          additionalPrompt.trim()
            ? `=== ДОПОЛНИТЕЛЬНАЯ КАНАЛЬНАЯ ИНСТРУКЦИЯ ===\n${additionalPrompt}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : '',
    maxTokens: settings['max_tokens'] && !isNaN(Number(settings['max_tokens']))
      ? Number(settings['max_tokens'])
      : config.ai.maxTokens,
    temperature: settings['temperature'] && !isNaN(Number(settings['temperature']))
      ? Number(settings['temperature'])
      : config.ai.temperature,
  };
};

async function resolveExecutionPlan(
  channel: 'telegram' | 'voice',
  options?: AIChatOptions,
): Promise<{ provider: AIProvider; modelOverride?: string }> {
  let provider = options?.providerOverride;
  let modelOverride = options?.modelOverride?.trim() || undefined;

  if (channel === 'voice' && (!provider || !modelOverride)) {
    const telephonyConfig = await getTelephonyRuntimeConfig();
    if (!modelOverride && telephonyConfig.openrouterModel) {
      modelOverride = telephonyConfig.openrouterModel;
    }
    if (!provider && telephonyConfig.aiProvider !== 'inherit') {
      provider = telephonyConfig.aiProvider;
    }
    if (!provider && modelOverride) {
      provider = 'openrouter';
    }
  }

  return {
    provider: provider ?? await getAIProvider(),
    modelOverride,
  };
}

// Поддерживаем оба распространённых варианта тегов рассуждений:
// <think>...</think> (DeepSeek-R1, Qwen3) и <thinking>...</thinking> (Anthropic-стиль).
// Также убираем «висячий» открывающий тег без закрывающего (модель оборвалась в reasoning).
const THINKING_TAG_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi;
const DANGLING_THINKING_RE = /<think(?:ing)?>[\s\S]*$/i;

function stripThinkingTags(text: string): string {
  const cleaned = text
    .replace(THINKING_TAG_RE, '')
    .replace(DANGLING_THINKING_RE, '')
    .trim();
  return cleaned || text;
}

// --------------------------------------------
// AI Service
// --------------------------------------------

export const aiService = {
  /**
   * Generate AI response for messages
   * При ошибке основной модели — запускаем гонку 10 бесплатных моделей параллельно
   */
  async chat(
    messages: AIMessage[],
    channel: 'telegram' | 'voice' = 'telegram',
    userMemoryContext?: string,
    options?: AIChatOptions,
  ): Promise<AIResponse> {
    const promptMode = options?.promptMode ?? 'default';
    const priority = options?.priority ?? 'user';
    const executionPlan = await resolveExecutionPlan(channel, options);

    // Фоновые задачи проверяют бюджет провайдера — если >50% RPM использовано, пропускаем
    if (priority === 'background') {
      const providerName = executionPlan.provider;
      if (providerName === 'cerebras' || providerName === 'groq') {
        if (!providerHealth.hasBackgroundBudget(providerName)) {
          throw new AppError('RATE_BUDGET_EXHAUSTED', `Background task throttled: ${providerName} rate budget >50%`);
        }
      }
    }

    const aiConfig = await getAIConfig(channel, {
      includePrompt: promptMode === 'default',
      modelOverride: executionPlan.modelOverride,
    });
    const maxTokens = options?.maxTokens ?? aiConfig.maxTokens;
    const temperature = options?.temperature ?? aiConfig.temperature;
    const fallbackStrategy = options?.fallbackStrategy ?? 'race';
    const fallbackModelLimit = options?.fallbackModelLimit ?? 7;

    const fullMessages: AIMessage[] = promptMode === 'passthrough'
      ? messages
      : (() => {
          let systemPrompt = aiConfig.systemPrompt;
          if (userMemoryContext) {
            systemPrompt = `${userMemoryContext}\n\n${systemPrompt}`;
          }

          return [
            { role: 'system', content: systemPrompt },
            ...messages,
          ];
        })();

    const tryWithClient = async (
      client: OpenAI,
      model: string,
      signal?: AbortSignal,
    ): Promise<AIResponse & { usedModel: string }> => {
      const response = await client.chat.completions.create({
        model,
        messages: fullMessages,
        max_tokens: maxTokens,
        temperature,
      }, signal ? { signal } : undefined);

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new Error('Empty response from AI');
      }

      return {
        content: stripThinkingTags(choice.message.content),
        model: response.model,
        tokens_used: {
          prompt: response.usage?.prompt_tokens ?? 0,
          completion: response.usage?.completion_tokens ?? 0,
          total: response.usage?.total_tokens ?? 0,
        },
        finish_reason: choice.finish_reason ?? 'unknown',
        usedModel: model,
      };
    };

    const provider = executionPlan.provider;
    // === ШАГ 0: LM Studio (если provider = auto | lmstudio) ===
    if (provider === 'lmstudio' || provider === 'auto') {
      // Circuit breaker: в auto-режиме пропускаем LM Studio если circuit открыт
      const circuitOpen = isLMStudioCircuitOpen();
      if (circuitOpen && provider === 'auto') {
        aiLogger.debug('LM Studio circuit breaker open — пропускаем, идём на OpenRouter');
      } else {
        const lmConfig = await getLMStudioConfig();

        if (lmConfig && lmConfig.model) {
          const healthy = await checkLMStudioHealth(lmConfig);

          if (healthy) {
            try {
              const lmClient = getLMStudioClient(lmConfig);
              aiLogger.debug(
                { model: lmConfig.model, provider: 'lmstudio' },
                'Trying LM Studio'
              );
              const result = await tryWithClient(lmClient, lmConfig.model);
              recordLMStudioSuccess();
              aiLogger.info(
                { model: result.model, tokens: result.tokens_used.total, provider: 'lmstudio' },
                'LM Studio response received'
              );
              return result;
            } catch (lmError) {
              const msg = lmError instanceof Error ? lmError.message : String(lmError);
              recordLMStudioFailure();
              aiLogger.warn({ error: msg, model: lmConfig.model }, 'LM Studio request failed');

              if (provider === 'lmstudio') {
                throw new AppError('LMSTUDIO_ERROR', `LM Studio ошибка: ${msg}`, lmError);
              }
              aiLogger.debug('Falling back to OpenRouter (auto mode)');
            }
          } else if (provider === 'lmstudio') {
            throw new AppError('LMSTUDIO_OFFLINE', 'LM Studio недоступна. Проверьте туннель и сервер.');
          } else {
            aiLogger.debug('LM Studio offline, falling back to OpenRouter (auto mode)');
          }
        } else if (provider === 'lmstudio') {
          throw new AppError('LMSTUDIO_NOT_CONFIGURED', 'LM Studio не настроена. Укажите URL и модель в админке.');
        }
      }
    }

    // === ШАГ 0.5: Cerebras / Groq как основной провайдер ===
    if (provider === 'cerebras' || provider === 'groq') {
      // Circuit breaker: если провайдер мёртв — сразу на OpenRouter
      if (!providerHealth.isProviderAvailable(provider)) {
        aiLogger.warn({ provider }, `${provider} circuit-broken — skipping to OpenRouter`);
      } else {
        try {
          const direct = await getDirectProviderClientAndModel(provider);
          aiLogger.debug({ model: direct.model, provider: direct.providerName }, `Trying ${provider} as primary provider`);
          providerHealth.trackRequest(provider);

          const result = await tryWithClient(direct.client, direct.model);
          providerHealth.recordSuccess(provider);
          aiLogger.info(
            { model: result.model, tokens: result.tokens_used.total, provider: direct.providerName },
            `${provider} primary response received`
          );
          return result;
        } catch (directError) {
          const errorMessage = directError instanceof Error ? directError.message : String(directError);
          providerHealth.recordFailure(provider, errorMessage);
          aiLogger.warn({ error: errorMessage, provider }, `${provider} primary failed`);

          // Если провайдер всё ещё доступен (не circuit-broken) — пробуем fallback модели
          if (providerHealth.isProviderAvailable(provider)) {
            const directModels = provider === 'cerebras' ? CEREBRAS_CHAT_MODELS : GROQ_CHAT_MODELS;
            const directClient = provider === 'cerebras' ? await getCerebrasClient() : await getGroqChatClient();
            const usedFirst = await getDirectProviderModel(provider);

            for (const fallbackModel of directModels) {
              if (fallbackModel === usedFirst) continue;
              try {
                aiLogger.debug({ model: fallbackModel, provider }, `Trying ${provider} fallback model`);
                providerHealth.trackRequest(provider);
                const result = await tryWithClient(directClient, fallbackModel);
                providerHealth.recordSuccess(provider);
                aiLogger.info({ model: result.model, tokens: result.tokens_used.total, provider }, `${provider} fallback model OK`);
                return result;
              } catch (fbErr) {
                const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
                providerHealth.recordFailure(provider, msg);
                aiLogger.debug({ model: fallbackModel, provider, error: msg }, `${provider} fallback model failed`);
              }
            }
          }

          aiLogger.warn({ provider }, `All ${provider} models failed — falling back to warp routes`);
        }
      }
    }

    // === ШАГ 1: Warp routes (Cerebras → Groq) — быстрый fallback до OpenRouter ===
    // Бесплатные быстрые провайдеры проверяются первыми, OpenRouter — крайний fallback
    if (provider !== 'cerebras' && provider !== 'groq') {
      // Пропускаем если уже пробовали как основной провайдер
      const warpResult = await tryWarpRoutes(fullMessages, aiConfig);
      if (warpResult) {
        aiLogger.info(
          { model: warpResult.usedModel, tokens: warpResult.tokens_used.total },
          '🔮 Warp route succeeded before OpenRouter fallback',
        );
        return warpResult;
      }
      aiLogger.info('🔮 Warp routes exhausted — falling back to OpenRouter');
    }

    // === ШАГ 2: OpenRouter — основная модель (крайний fallback) ===
    const client = await getClient();

    const tryModel = async (model: string, signal?: AbortSignal): Promise<AIResponse & { usedModel: string }> =>
      tryWithClient(client, model, signal);

    aiLogger.debug(
      { model: aiConfig.model, messageCount: messages.length, provider: 'openrouter' },
      'Trying primary OpenRouter model'
    );

    try {
      const result = await tryModel(aiConfig.model);
      aiLogger.info(
        { model: result.model, tokens: result.tokens_used.total },
        'Primary model response received'
      );
      return result;
    } catch (primaryError) {
      const errorMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      aiLogger.warn({ error: errorMessage, model: aiConfig.model }, 'Primary model failed');

      if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        throw new AppError('AUTH_ERROR', 'Неверный API ключ OpenRouter. Проверьте OPENROUTER_API_KEY.', primaryError);
      }

      const needsRace = RACE_ERROR_PATTERNS.some(pattern =>
        errorMessage.toLowerCase().includes(pattern.toLowerCase())
      );

      if (!needsRace && !errorMessage.includes('429') && !errorMessage.toLowerCase().includes('rate limit')) {
        throw primaryError;
      }

      if (fallbackStrategy === 'off') {
        throw new AppError('SERVER_ERROR', 'Основная AI модель временно недоступна. Повторите позже.', primaryError);
      }

      aiLogger.info({ originalError: errorMessage, fallbackStrategy }, '🔄 Will try free models fallback');
    }

    // === ШАГ 3: Динамический fallback бесплатных моделей OpenRouter (крайний) ===
    // Принудительно обновляем список: модель упала → кэш может быть устаревшим
    const freeModels = await refreshFreeModelsCache();

    aiLogger.info(
      { modelsCount: freeModels.length, timeoutMs: RACE_TIMEOUT_MS, models: freeModels.slice(0, fallbackModelLimit), fallbackStrategy },
      '🏁 Starting dynamic free models fallback'
    );

    const modelsToTry = freeModels.slice(0, fallbackModelLimit);

    const finalizeWinner = (winner: AIResponse & { usedModel: string }) => {
      lastFallbackSwitch = {
        reason: `${fallbackStrategy === 'sequential' ? 'Sequential' : 'Race'} fallback: ${winner.usedModel} (primary ${aiConfig.model} failed)`,
        time: new Date(),
        fromModel: aiConfig.model,
        toModel: winner.usedModel,
      };

      return winner;
    };

    const runSequentialFallback = async (): Promise<AIResponse & { usedModel: string }> => {
      let lastError: unknown;

      for (const model of modelsToTry) {
        try {
          const result = await Promise.race([
            tryModel(model),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new AppError('RACE_TIMEOUT', `Превышено время ожидания ответа от модели ${model}`));
              }, RACE_TIMEOUT_MS);
            }),
          ]);
          aiLogger.info({ model }, 'Sequential fallback model succeeded');
          return finalizeWinner(result);
        } catch (error) {
          lastError = error;
          const msg = error instanceof Error ? error.message : String(error);
          aiLogger.warn({ model, error: msg }, 'Sequential fallback model failed');
        }
      }

      throw new AppError(
        'ALL_MODELS_FAILED',
        `Все ${modelsToTry.length} бесплатных моделей недоступны. Попробуйте позже.`,
        lastError,
      );
    };

    let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const raceAbort = new AbortController();

    try {
      if (fallbackStrategy === 'sequential') {
        return await runSequentialFallback();
      }

      // Таймаут-промис для ограничения гонки (с cleanup)
      const timeoutPromise = new Promise<never>((_, reject) => {
        raceTimeoutId = setTimeout(() => {
          raceAbort.abort();
          reject(new AppError('RACE_TIMEOUT', 'Превышено время ожидания ответа от моделей'));
        }, RACE_TIMEOUT_MS);
      });

      const racePromises = modelsToTry.map(async (model) => {
        try {
          const result = await tryModel(model, raceAbort.signal);
          aiLogger.debug({ model }, 'Model responded in race');
          return result;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (!raceAbort.signal.aborted) {
            aiLogger.debug({ model, error: msg }, 'Model failed in race');
          }
          throw error;
        }
      });

      const winner = await Promise.race([
        Promise.any(racePromises),
        timeoutPromise,
      ]);

      if (raceTimeoutId) clearTimeout(raceTimeoutId);
      // Отменяем проигравшие запросы — экономим токены/лимиты OpenRouter
      raceAbort.abort();

      aiLogger.info(
        { winner: winner.usedModel, tokens: winner.tokens_used.total },
        '🏆 Race winner used as fallback (NOT saved as default)'
      );

      return finalizeWinner(winner);
    } catch (raceError) {
      if (raceTimeoutId) clearTimeout(raceTimeoutId);
      raceAbort.abort();

      // Warp routes уже были проверены на ШАГ 1 — дальше падать нечем
      const reason = (raceError instanceof AppError && raceError.code === 'RACE_TIMEOUT')
        ? 'timeout' : 'all_failed';
      aiLogger.error(
        { modelsCount: modelsToTry.length, reason, fallbackStrategy },
        `💀 All providers exhausted: warp routes (step 1) + OpenRouter (step 2/3)`,
      );

      throw new AppError(
        'ALL_MODELS_FAILED',
        `Все провайдеры недоступны (Cerebras, Groq, OpenRouter). Попробуйте позже.`,
        raceError,
      );
    }
  },

  /**
   * Generate streaming AI response
   */
  async *chatStream(
    messages: AIMessage[],
    channel: 'telegram' | 'voice' = 'telegram'
  ): AsyncGenerator<string, AIResponse> {
    const executionPlan = await resolveExecutionPlan(channel);
    const aiConfig = await getAIConfig(channel, { modelOverride: executionPlan.modelOverride });

    const fullMessages: AIMessage[] = [
      { role: 'system', content: aiConfig.systemPrompt },
      ...messages,
    ];

    let streamClient: OpenAI;
    let streamModel: string;
    let usingLmStudio = false;

    const provider = executionPlan.provider;
    if (provider === 'lmstudio' || provider === 'auto') {
      const circuitOpen = isLMStudioCircuitOpen();
      if (circuitOpen && provider === 'auto') {
        streamClient = await getClient();
        streamModel = aiConfig.model;
      } else {
        const lmConfig = await getLMStudioConfig();
        if (lmConfig?.model) {
          const healthy = await checkLMStudioHealth(lmConfig);
          if (healthy) {
            streamClient = getLMStudioClient(lmConfig);
            streamModel = lmConfig.model;
            usingLmStudio = true;
          } else if (provider === 'lmstudio') {
            throw new AppError('LMSTUDIO_OFFLINE', 'LM Studio недоступна.');
          } else {
            streamClient = await getClient();
            streamModel = aiConfig.model;
          }
        } else if (provider === 'lmstudio') {
          throw new AppError('LMSTUDIO_NOT_CONFIGURED', 'LM Studio не настроена.');
        } else {
          streamClient = await getClient();
          streamModel = aiConfig.model;
        }
      }
    } else if (provider === 'cerebras' || provider === 'groq') {
      if (!providerHealth.isProviderAvailable(provider)) {
        // Circuit-broken — fallback на OpenRouter
        aiLogger.warn({ provider }, `${provider} circuit-broken in stream — falling back to OpenRouter`);
        streamClient = await getClient();
        streamModel = aiConfig.model;
      } else {
        const direct = await getDirectProviderClientAndModel(provider);
        streamClient = direct.client;
        streamModel = direct.model;
      }
    } else {
      streamClient = await getClient();
      streamModel = aiConfig.model;
    }

    aiLogger.debug(
      { model: streamModel, messageCount: messages.length },
      'Starting streaming chat'
    );

    try {
      const stream = await streamClient.chat.completions.create({
        model: streamModel,
        messages: fullMessages,
        max_tokens: aiConfig.maxTokens,
        temperature: aiConfig.temperature,
        stream: true,
      });

      let fullContent = '';
      let finishReason = 'unknown';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          yield delta;
        }
        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      // Учитываем успех/неуспех LM Studio для circuit breaker, иначе streaming-ошибки
      // не размыкают/не закрывают цепь и расходятся с метриками chat().
      if (usingLmStudio) {
        recordLMStudioSuccess();
      }

      return {
        content: stripThinkingTags(fullContent),
        model: streamModel,
        tokens_used: { prompt: 0, completion: 0, total: 0 },
        finish_reason: finishReason,
      };
    } catch (error) {
      if (usingLmStudio) {
        recordLMStudioFailure();
      }
      aiLogger.error({ error }, 'Streaming AI request failed');
      throw error;
    }
  },

  /**
   * Simple single-message response
   */
  async complete(
    userMessage: string,
    channel: 'telegram' | 'voice' = 'telegram'
  ): Promise<string> {
    const response = await this.chat(
      [{ role: 'user', content: userMessage }],
      channel
    );
    return response.content;
  },

  /**
   * Get available models from OpenRouter
   */
  async getModels(): Promise<{ id: string; name: string }[]> {
    try {
      const keys = await getApiKeys();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      let response: Response;
      try {
        response = await fetch(`${config.ai.baseUrl}/models`, {
          headers: getProxyHeaders({
            Authorization: `Bearer ${keys.openrouter}`,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = (await response.json()) as { data: { id: string; name: string }[] };
      return data.data.map((m) => ({ id: m.id, name: m.name }));
    } catch (error) {
      aiLogger.error({ error }, 'Failed to fetch models');
      throw error;
    }
  },

  /**
   * Test AI connection
   */
  async testConnection(timeoutMs = HEALTH_AI_TIMEOUT_MS): Promise<boolean> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`AI readiness timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const response = await Promise.race([
        this.chat(
          [{ role: 'user', content: 'Say "OK".' }],
          'telegram',
          undefined,
          { promptMode: 'passthrough', maxTokens: 10, fallbackStrategy: 'off' },
        ),
        timeoutPromise,
      ]);
      return response.content.toLowerCase().includes('ok');
    } catch {
      return false;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  },
};

// ============================================
// Gibberish / Language Quality Detection
// ============================================

const CJK_RANGE = /[\u3000-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
const CYRILLIC_RE = /[а-яёА-ЯЁ]/g;

/**
 * Проверяет, содержит ли ответ подозрительную мешанину языков.
 * Возвращает true если ответ — gibberish (не должен отправляться пользователю).
 */
export function isGibberish(text: string, userLang: 'ru' | 'en' | 'other' = 'ru'): boolean {
  if (!text || text.length < 20) return false;

  if (CJK_RANGE.test(text)) {
    const cjkCount = [...text].filter(ch => CJK_RANGE.test(ch)).length;
    if (cjkCount > 3) return true;
  }

  if (userLang === 'ru') {
    const cyrillicMatches = text.match(CYRILLIC_RE);
    const cyrillicRatio = (cyrillicMatches?.length ?? 0) / text.replace(/\s/g, '').length;
    if (cyrillicRatio < 0.15 && text.length > 50) return true;
  }

  return false;
}

// ============================================
// Exported Fallback Helper Functions
// ============================================

/**
 * Get list of race models for admin panel (динамический или статический)
 */
export async function getFallbackModels(): Promise<Array<{ id: string; name: string; description: string }>> {
  const models = await getFreeModels();
  return models.map((id) => ({
    id,
    name: id.split('/').pop()?.replace(':free', '') || id,
    description: `Бесплатная модель: ${id}`,
  }));
}

/**
 * Get current fallback/race status
 */
export async function getFallbackStatus(): Promise<{
  currentModel: string;
  lastSwitchReason: string | null;
  lastSwitchTime: string | null;
  raceModelsCount: number;
  cachedModels: string[];
  cacheAge: number;
}> {
  const currentModel = await settingsRepo.get('openrouter_model');
  const models = await getFreeModels();
  const cacheAge = freeModelsCache.age();
  
  return {
    currentModel: currentModel || 'meta-llama/llama-3.2-3b-instruct:free',
    lastSwitchReason: lastFallbackSwitch.reason,
    lastSwitchTime: lastFallbackSwitch.time?.toISOString() || null,
    raceModelsCount: models.length,
    cachedModels: models,
    cacheAge, // секунды с последнего обновления кэша (-1 если нет кэша)
  };
}

/**
 * Принудительно обновить кэш бесплатных моделей
 */
export async function refreshFreeModelsCache(): Promise<string[]> {
  freeModelsCache.clear();
  return await fetchFreeModels();
}
