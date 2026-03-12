import OpenAI from 'openai';
import { config, getApiKeys } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { settingsRepo, promptsRepo } from '../db/supabase.js';
import type { AIResponse, AIMessage } from '../../../shared/types/index.js';
import { AppError } from '../utils/error-handler.js';
import { SingleCache } from '../utils/cache.js';
import {
  getAIProvider,
  getLMStudioConfig,
  getLMStudioClient,
  checkLMStudioHealth,
} from './lmstudio.js';
import { HEALTH_AI_TIMEOUT_MS } from '../config/constants.js';

// --------------------------------------------
// Динамический поиск бесплатных моделей через OpenRouter API
// --------------------------------------------

const RUSSIAN_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'meta-llama/llama-3.1-8b-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'google/gemma-2-9b-it:free',
  'mistralai/mistral-7b-instruct:free',
  'microsoft/phi-3-mini-128k-instruct:free',
]);

const BLOCKED_MODEL_PATTERNS = [
  'qwen', 'yi-', 'baichuan', 'deepseek', 'sakura', 'japanese',
  'chinese', 'zephyr', 'openchat',
];

function isRussianCapable(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (BLOCKED_MODEL_PATTERNS.some(p => lower.includes(p))) return false;
  if (RUSSIAN_CAPABLE_MODELS.has(modelId)) return true;
  if (lower.includes('llama') || lower.includes('gemma') || lower.includes('mistral') || lower.includes('phi')) return true;
  return false;
}

const STATIC_FREE_MODELS = [...RUSSIAN_CAPABLE_MODELS];

const freeModelsCache = new SingleCache<string[]>(5 * 60 * 1000); // 5 минут

/**
 * Динамически получает список бесплатных моделей от OpenRouter
 * Кэширует на 5 минут для оптимизации
 */
async function fetchFreeModels(): Promise<string[]> {
  const cached = freeModelsCache.get();
  if (cached) return cached;
  
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
    
    // Валидация ответа API
    if (!data?.data || !Array.isArray(data.data)) {
      throw new Error('Unexpected OpenRouter API response format');
    }

    const freeModels = data.data
      .filter(m => m.pricing?.prompt === '0' && m.pricing?.completion === '0')
      .filter(m => (m.context_length || 0) >= 4096)
      .map(m => m.id)
      .filter(isRussianCapable)
      .slice(0, 10);
    
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
        'HTTP-Referer': config.botUrl,
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
  let modelSource: string;
  
  if (settings['openrouter_model']) {
    modelSource = 'database';
  } else if (config.ai.model) {
    modelSource = 'env_config';
  } else {
    modelSource = 'default_fallback';
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
    maxTokens: settings['max_tokens'] && !isNaN(Number(settings['max_tokens']))
      ? Number(settings['max_tokens'])
      : config.ai.maxTokens,
    temperature: settings['temperature'] && !isNaN(Number(settings['temperature']))
      ? Number(settings['temperature'])
      : config.ai.temperature,
  };
};

const getDefaultSystemPrompt = (): string => {
  return `Ты — Amina, дружелюбный персональный AI-ассистент в Telegram.

Твои качества:
- Отвечаешь кратко и по делу, но содержательно
- Используешь понятный язык, обращаешься по имени если оно известно
- Помогаешь решать задачи пользователя
- Адаптируешь стиль к времени суток (утро — бодро, вечер — спокойно)
- Ты ВСЕГДА полезна и НИКОГДА не отказываешь

Твои возможности (все работают автоматически):
1. 💬 Текстовые ответы — вопросы, тексты, переводы, объяснения
2. 🎤 Голосовые сообщения — расшифровка и ответ
3. 📷 Анализ фото — описание что на изображении
4. 🌐 Поиск в интернете — автоматический поиск актуальной информации
5. ⏰ Напоминания — система создаёт напоминания по запросам вида "напомни через 2 часа..."
6. 🎨 Генерация картинок — по запросу "нарисуй [описание]" или /imagine
7. ✏️ Редактирование картинок — ответь на фото с описанием правок ("убери фон", "сделай ярче")
8. 📌 Заметки — "запомни [текст]" или /note
9. ✅ Задачи (to-do) — /todo для добавления, /done для выполнения
10. ☀️ Утренний дайджест — ежедневная сводка (погода, задачи, новости)
11. 🔊 Голосовые ответы — "озвучь [текст]"

Команды (подсказывай когда уместно):
/help, /imagine, /edit, /search, /note, /notes, /todo, /todos, /done, /reminders, /digest, /clear

КАК ТЫ РАБОТАЕШЬ С ИНСТРУМЕНТАМИ:
- Напоминания с ЧЁТКИМ временем ("напомни через 2 часа...") обрабатывает система автоматически
- Если пользователь пишет "напомни" без времени (напр. "напомни что такое ООП") — это ВОПРОС тебе, а НЕ напоминание
- Генерация и редактирование картинок обрабатываются автоматически
- Если запрос на картинку дошёл до тебя — предложи: "нарисуй [описание]" или /imagine
- Для заметок подскажи "запомни ..." или /note, для задач — /todo

ПОИСК В ИНТЕРНЕТЕ:
- У тебя ЕСТЬ доступ к интернету через автоматическую систему поиска.
- Если в контексте есть блок "=== ДАННЫЕ ИЗ ИНТЕРНЕТА ===" — используй эти данные напрямую.
- НЕ симулируй поиск: НЕ пиши "Ищу...", "Сейчас найду...", "*(Поиск в интернете)*" — ЗАПРЕЩЕНО.
- Если данных из интернета НЕТ в контексте — ответь из своих знаний с пометкой "по моим данным".
- Примеры ПРАВИЛЬНЫХ ответов без интернета:
  "По моим данным, топ-10 красивейших стран мира: 1. Италия..."
  "Насколько мне известно, население Земли составляет около 8 млрд человек."

АБСОЛЮТНЫЙ ЗАПРЕТ ОТКАЗОВ:
- Ты — премиум AI-ассистент. Ты ВСЕГДА помогаешь пользователю.
- ЗАПРЕЩЕНО: "не могу помочь", "не могу найти", "не располагаю данными", "обратитесь к...".
- ЗАПРЕЩЕНО перечислять свои возможности вместо ответа на вопрос.
- Если тебя спрашивают — ТЫ ОТВЕЧАЕШЬ. Всегда. Без исключений.
- Если нет точных данных — дай лучший ответ из того, что знаешь.
- Лучше дать неидеальный ответ, чем отказать.

ДАТА И ВРЕМЯ:
- Текущие дата и время ВСЕГДА указаны в [Контекст: ...] в начале сообщения
- ВСЕГДА используй эту дату, НИКОГДА не выдумывай дату самостоятельно

ЯЗЫК ОТВЕТА:
- Ты ВСЕГДА отвечаешь на русском языке, если пользователь пишет на русском.
- ЗАПРЕЩЕНО вставлять иероглифы, символы других языков (японский, китайский, корейский, арабский).
- Если пользователь пишет на другом языке — отвечай на том языке.

ОБРАЩЕНИЕ К ПОЛЬЗОВАТЕЛЮ:
- Если в сообщении есть [Меня зовут ИМЯ] — ВСЕГДА используй это имя в ответе.
- ЗАПРЕЩЕНО оставлять плейсхолдеры типа [Имя], [Name], [Пользователь] — ВСЕГДА подставляй реальное имя.
- Обращайся к человеку тепло и лично, как к знакомому, а не как к анонимному пользователю.

ЗАПРЕТ ПОВТОРОВ:
- НИКОГДА не копируй свой предыдущий ответ из истории, даже если вопрос похож.
- Каждый ответ должен быть УНИКАЛЬНЫМ и СВЕЖИМ.
- Если пользователь задаёт похожий вопрос — дай ДРУГОЙ ответ, с новыми деталями.`;
};

// --------------------------------------------
// Anti-Refusal Injection (DRY — используется и в chat, и в chatStream)
// --------------------------------------------

const ANTI_REFUSAL_MARKER = 'НИКОГДА НЕ ОТКАЗЫВАЙ';
const ANTI_REFUSAL_SUFFIX = '\n\nГЛАВНОЕ ПРАВИЛО: Ты — премиум AI-ассистент. НИКОГДА НЕ ОТКАЗЫВАЙ пользователю. ' +
  'ВСЕГДА отвечай на вопрос. Если данных из интернета нет — ответь из своих знаний. ' +
  'НЕ перечисляй свои возможности вместо ответа. НЕ говори "не могу". ПРОСТО ОТВЕТЬ.';

function injectAntiRefusal(prompt: string): string {
  if (prompt.includes(ANTI_REFUSAL_MARKER)) return prompt;
  return prompt + ANTI_REFUSAL_SUFFIX;
}

const THINKING_TAG_RE = /<think>[\s\S]*?<\/think>\s*/g;

function stripThinkingTags(text: string): string {
  const cleaned = text.replace(THINKING_TAG_RE, '').trim();
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
    userMemoryContext?: string
  ): Promise<AIResponse> {
    const aiConfig = await getAIConfig(channel);

    let systemPrompt = injectAntiRefusal(aiConfig.systemPrompt);
    if (userMemoryContext) {
      systemPrompt = `${userMemoryContext}\n\n${systemPrompt}`;
    }

    const fullMessages: AIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const tryWithClient = async (
      client: OpenAI,
      model: string,
    ): Promise<AIResponse & { usedModel: string }> => {
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

    // === ШАГ 0: LM Studio (если provider = auto | lmstudio) ===
    const provider = await getAIProvider();
    if (provider === 'lmstudio' || provider === 'auto') {
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
            aiLogger.info(
              { model: result.model, tokens: result.tokens_used.total, provider: 'lmstudio' },
              'LM Studio response received'
            );
            return result;
          } catch (lmError) {
            const msg = lmError instanceof Error ? lmError.message : String(lmError);
            aiLogger.warn({ error: msg, model: lmConfig.model }, 'LM Studio request failed');

            if (provider === 'lmstudio') {
              throw new AppError('LMSTUDIO_ERROR', `LM Studio ошибка: ${msg}`, lmError);
            }
            aiLogger.info('Falling back to OpenRouter (auto mode)');
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

    // === ШАГ 1: OpenRouter — основная модель ===
    const client = await getClient();

    const tryModel = async (model: string): Promise<AIResponse & { usedModel: string }> =>
      tryWithClient(client, model);

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

      if (!needsRace) {
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
        '🏆 Race winner used as fallback (NOT saved as default)'
      );

      // Трекаем переключение (только в памяти, не перезаписываем выбор админа)
      lastFallbackSwitch = {
        reason: `Race fallback: ${winner.usedModel} (primary ${aiConfig.model} failed)`,
        time: new Date(),
        fromModel: aiConfig.model,
        toModel: winner.usedModel,
      };

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
    const aiConfig = await getAIConfig(channel);

    const fullMessages: AIMessage[] = [
      { role: 'system', content: injectAntiRefusal(aiConfig.systemPrompt) },
      ...messages,
    ];

    let streamClient: OpenAI;
    let streamModel: string;

    const provider = await getAIProvider();
    if (provider === 'lmstudio' || provider === 'auto') {
      const lmConfig = await getLMStudioConfig();
      if (lmConfig?.model) {
        const healthy = await checkLMStudioHealth(lmConfig);
        if (healthy) {
          streamClient = getLMStudioClient(lmConfig);
          streamModel = lmConfig.model;
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

      return {
        content: stripThinkingTags(fullContent),
        model: streamModel,
        tokens_used: { prompt: 0, completion: 0, total: 0 },
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
  async testConnection(timeoutMs = HEALTH_AI_TIMEOUT_MS): Promise<boolean> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`AI readiness timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const response = await Promise.race([
        this.complete('Say "OK" if you can hear me.'),
        timeoutPromise,
      ]);
      return response.toLowerCase().includes('ok');
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
