import OpenAI from 'openai';
import { config, getApiKeys } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { settingsRepo, promptsRepo } from '../db/supabase.js';
import type { AIRequest, AIResponse, AIMessage } from '../../../shared/types/index.js';
import { validateChannel, validateMessageContent, MAX_MESSAGE_LENGTH } from '../utils/validation.js';
import { handleAIError, AppError } from '../utils/error-handler.js';

// --------------------------------------------
// Динамический поиск бесплатных моделей через OpenRouter API
// --------------------------------------------

// Статический fallback (если API недоступен)
const STATIC_FREE_MODELS = [
  'meta-llama/llama-3.2-3b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'qwen/qwen-2-7b-instruct:free',
  'huggingfaceh4/zephyr-7b-beta:free',
  'openchat/openchat-7b:free',
];

// Кэш динамических бесплатных моделей
let cachedFreeModels: string[] | null = null;
let freeModelsCacheTime: number = 0;
const FREE_MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 минут

/**
 * Динамически получает список бесплатных моделей от OpenRouter
 * Кэширует на 5 минут для оптимизации
 */
async function fetchFreeModels(): Promise<string[]> {
  const now = Date.now();
  
  // Возвращаем кэш если свежий
  if (cachedFreeModels && (now - freeModelsCacheTime) < FREE_MODELS_CACHE_TTL) {
    return cachedFreeModels;
  }
  
  try {
    const keys = await getApiKeys();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 сек таймаут
    
    let response: Response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${keys.openrouter}` },
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
    
    // Фильтруем бесплатные модели (pricing = 0)
    const freeModels = data.data
      .filter(m => m.pricing.prompt === '0' && m.pricing.completion === '0')
      .filter(m => (m.context_length || 0) >= 4096) // Минимум 4K контекст
      .map(m => m.id)
      .slice(0, 15); // Максимум 15 моделей для гонки
    
    if (freeModels.length > 0) {
      cachedFreeModels = freeModels;
      freeModelsCacheTime = now;
      aiLogger.info({ count: freeModels.length }, '🆓 Fetched free models from OpenRouter');
      return freeModels;
    }
    
    throw new Error('No free models found');
  } catch (error) {
    aiLogger.warn({ error }, 'Failed to fetch free models, using static list');
    return STATIC_FREE_MODELS;
  }
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

// Таймаут для гонки моделей (чтобы не превысить 30 сек Render)
const RACE_TIMEOUT_MS = 15000;

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
    throw new Error('OPENROUTER_API_KEY не задан. Укажите его в Render или в админке.');
  }

  // Пересоздаём клиент если ключ изменился
  if (!openai || currentApiKey !== apiKey) {
    openai = new OpenAI({
      apiKey: apiKey,
      baseURL: config.ai.baseUrl,
      timeout: 30000,
      defaultHeaders: {
        'HTTP-Referer': 'https://amina-bot.render.com',
        'X-Title': 'Amina AI Bot',
      },
    });
    currentApiKey = apiKey;
    aiLogger.info('OpenRouter client initialized/updated');
  }
  return openai;
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

/** Кеш промпта (меняется редко — TTL 5 минут) */
let cachedPrompt: { content: string; channel: string; ts: number } | null = null;
const PROMPT_CACHE_TTL = 5 * 60 * 1000;

const getAIConfig = async (channel: 'telegram' | 'voice'): Promise<AIConfig> => {
  // === ОПТИМИЗАЦИЯ: settings (уже кешированы) + prompt параллельно ===
  const now = Date.now();
  const promptCached = cachedPrompt && cachedPrompt.channel === channel
    && now - cachedPrompt.ts < PROMPT_CACHE_TTL;

  const [settings, prompt] = await Promise.all([
    settingsRepo.getMany([
      'openrouter_model',
      'custom_model_override',
      'max_tokens',
      'temperature',
    ]),
    promptCached
      ? Promise.resolve({ content: cachedPrompt!.content } as { content: string })
      : promptsRepo.getActive(channel).then(p => {
          if (p) {
            cachedPrompt = { content: p.content, channel, ts: now };
          }
          return p;
        }),
  ]);

  // Priority: custom_model_override > openrouter_model > config default
  let model = settings['openrouter_model'] ?? config.ai.model ?? 'openrouter/free';
  let modelSource = 'database';
  
  if (!settings['openrouter_model']) {
    modelSource = settings['openrouter_model'] ? 'database' : (config.ai.model ? 'env_config' : 'default_fallback');
  }
  
  if (settings['custom_model_override'] && settings['custom_model_override'].trim()) {
    model = settings['custom_model_override'].trim();
    modelSource = 'custom_override';
    aiLogger.info({ model, source: modelSource }, 'Using custom_model_override');
  }

  aiLogger.debug({ 
    model, 
    source: modelSource,
    dbModel: settings['openrouter_model'],
    envModel: config.ai.model,
  }, 'AI config loaded');

  return {
    model,
    systemPrompt: prompt?.content ?? getDefaultSystemPrompt(),
    maxTokens: settings['max_tokens'] ? Number(settings['max_tokens']) : config.ai.maxTokens,
    temperature: settings['temperature'] ? Number(settings['temperature']) : config.ai.temperature,
  };
};

const getDefaultSystemPrompt = (): string => {
  return `Ты — Amina, дружелюбный персональный AI-ассистент в Telegram.

Твои качества:
- Отвечаешь кратко и по делу
- Используешь понятный язык, обращаешься по имени если оно известно
- Помогаешь решать задачи пользователя
- Если не знаешь ответ — честно говоришь об этом
- Адаптируешь стиль к времени суток (утро — бодро, вечер — спокойно)

Твои возможности:
1. 💬 Текстовые ответы — вопросы, тексты, переводы, объяснения
2. 🎤 Голосовые сообщения — расшифровка и ответ
3. 📷 Анализ фото — описание что на изображении
4. 🌐 Поиск в интернете — автоматический поиск актуальной информации
5. ⏰ Напоминания — отдельная система создаёт напоминания
6. 🎨 Генерация картинок — отдельная система (FLUX.1-schnell)
7. 📌 Заметки — /note для сохранения, /notes для просмотра
8. ✅ Задачи (to-do) — /todo для добавления, /done для выполнения
9. ☀️ Утренний дайджест — ежедневная сводка (погода, задачи, новости)
10. 🔊 Голосовые ответы — озвучка текста по запросу

Команды (подсказывай когда уместно):
/help, /imagine, /search, /note, /notes, /todo, /todos, /done, /reminders, /digest, /clear

ВАЖНО:
- Напоминания, картинки, заметки создают ОТДЕЛЬНЫЕ системы — ты НЕ создаёшь их сама
- Если пользователь просит "напомни..." или "нарисуй..." — система перехватит ДО тебя
- Для заметок подскажи "запомни ..." или /note, для задач — /todo
- Если в контексте указано время/день — используй для уместных приветствий

ПОИСК В ИНТЕРНЕТЕ:
- Поиск выполняется АВТОМАТИЧЕСКИ — тебе НЕ нужно имитировать процесс поиска
- НИКОГДА не пиши "Ищу...", "Поиск в интернете...", "Сейчас найду..." — это выглядит фейково
- Если в контексте есть "ДАННЫЕ ИЗ ИНТЕРНЕТА" — сразу используй их в ответе
- Если данных из интернета нет — отвечай из своих знаний, без имитации поиска
- Отвечай сразу по существу, без вступительных фраз о процессе поиска

Отвечай на том языке, на котором к тебе обращаются.`;
};

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
    userMemoryContext?: string
  ): Promise<AIResponse> {
    // === ОПТИМИЗАЦИЯ: config + client параллельно ===
    const [aiConfig, client] = await Promise.all([
      getAIConfig(channel),
      getClient(),
    ]);

    // Build system prompt with memory context
    let systemPrompt = aiConfig.systemPrompt;
    if (userMemoryContext) {
      systemPrompt = `${userMemoryContext}\n\n${aiConfig.systemPrompt}`;
    }

    // Add system prompt
    const fullMessages: AIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // Хелпер для запроса к одной модели
    const tryModel = async (model: string): Promise<AIResponse & { usedModel: string }> => {
      const response = await client.chat.completions.create({
        model,
        messages: fullMessages,
        max_tokens: aiConfig.maxTokens,
        temperature: aiConfig.temperature,
      });

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new Error('Empty response from AI');
      }

      return {
        content: choice.message.content,
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

    // === ШАГ 1: Пробуем основную модель ===
    aiLogger.debug(
      { model: aiConfig.model, messageCount: messages.length },
      'Trying primary model'
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

      // Проверяем критические ошибки — для них НЕ делаем fallback
      if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        throw new AppError('AUTH_ERROR', 'Неверный API ключ OpenRouter. Проверьте OPENROUTER_API_KEY.', primaryError);
      }
      
      // 402 (Payment Required) ТЕПЕРЬ запускает гонку бесплатных моделей!
      // Раньше это была критическая ошибка, но бесплатные модели могут помочь

      // Проверяем, нужна ли гонка моделей (включая 402!)
      const needsRace = RACE_ERROR_PATTERNS.some(pattern => 
        errorMessage.toLowerCase().includes(pattern.toLowerCase())
      );

      if (!needsRace) {
        // Rate limit — не поможет гонка, просто ждать
        if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
          throw new AppError('RATE_LIMIT', 'Превышен лимит запросов. Подождите минуту.', primaryError);
        }
        throw primaryError;
      }
      
      aiLogger.info({ originalError: errorMessage }, '🔄 Will try free models race');
    }

    // === ШАГ 2: Динамическая гонка бесплатных моделей ===
    // Принудительно обновляем список: модель упала → кэш может быть устаревшим
    const freeModels = await refreshFreeModelsCache();
    
    aiLogger.info(
      { modelsCount: freeModels.length, timeoutMs: RACE_TIMEOUT_MS, models: freeModels.slice(0, 5) },
      '🏁 Starting dynamic free models race'
    );

    // Таймаут-промис для ограничения гонки (с cleanup)
    let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      raceTimeoutId = setTimeout(() => {
        reject(new AppError('RACE_TIMEOUT', 'Превышено время ожидания ответа от моделей'));
      }, RACE_TIMEOUT_MS);
    });

    // Запускаем модели параллельно (максимум первые 7 для экономии rate limit)
    const modelsToTry = freeModels.slice(0, 7);
    const racePromises = modelsToTry.map(async (model) => {
      try {
        const result = await tryModel(model);
        aiLogger.debug({ model }, 'Model responded in race');
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        aiLogger.debug({ model, error: msg }, 'Model failed in race');
        throw error; // Promise.any игнорирует отклонённые
      }
    });

    try {
      // Promise.any с таймаутом — возвращает первый успешный результат или таймаут
      const winner = await Promise.race([
        Promise.any(racePromises),
        timeoutPromise,
      ]);
      
      // Очищаем таймаут после успешного завершения
      if (raceTimeoutId) clearTimeout(raceTimeoutId);
      
      aiLogger.info(
        { winner: winner.usedModel, tokens: winner.tokens_used.total },
        '🏆 Race winner! Saving as new default model'
      );

      // Трекаем переключение
      lastFallbackSwitch = {
        reason: `Race winner: ${winner.usedModel} (primary ${aiConfig.model} failed)`,
        time: new Date(),
        fromModel: aiConfig.model,
        toModel: winner.usedModel,
      };

      // Сохраняем победителя как новую основную модель
      settingsRepo.set('openrouter_model', winner.usedModel).catch((err) => {
        aiLogger.warn({ error: err }, 'Failed to save race winner model');
      });

      return winner;
    } catch (raceError) {
      // Очищаем таймаут при ошибке
      if (raceTimeoutId) clearTimeout(raceTimeoutId);
      
      // Проверяем таймаут
      if (raceError instanceof AppError && raceError.code === 'RACE_TIMEOUT') {
        aiLogger.error({ timeoutMs: RACE_TIMEOUT_MS }, '⏰ Race timeout — all models too slow');
        throw raceError;
      }

      // Все модели упали
      aiLogger.error(
        { modelsCount: modelsToTry.length, triedModels: modelsToTry },
        '💀 All free models failed in race'
      );

      throw new AppError(
        'ALL_MODELS_FAILED',
        `Все ${modelsToTry.length} бесплатных моделей недоступны. Попробуйте позже.`,
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
    const [aiConfig, client] = await Promise.all([
      getAIConfig(channel),
      getClient(),
    ]);

    const fullMessages: AIMessage[] = [
      { role: 'system', content: aiConfig.systemPrompt },
      ...messages,
    ];

    aiLogger.debug(
      { model: aiConfig.model, messageCount: messages.length },
      'Starting streaming chat'
    );

    try {
      const stream = await client.chat.completions.create({
        model: aiConfig.model,
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

      return {
        content: fullContent,
        model: aiConfig.model,
        tokens_used: { prompt: 0, completion: 0, total: 0 }, // Not available in streaming
        finish_reason: finishReason,
      };
    } catch (error) {
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
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: `Bearer ${keys.openrouter}`,
        },
      });

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
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.complete('Say "OK" if you can hear me.');
      return response.toLowerCase().includes('ok');
    } catch {
      return false;
    }
  },
};

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
  const cacheAge = cachedFreeModels ? Math.round((Date.now() - freeModelsCacheTime) / 1000) : -1;
  
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
  cachedFreeModels = null;
  freeModelsCacheTime = 0;
  return await fetchFreeModels();
}
