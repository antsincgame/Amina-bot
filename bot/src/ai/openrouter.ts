import OpenAI from 'openai';
import { config, getApiKeys } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { settingsRepo, promptsRepo } from '../db/supabase.js';
import type { AIRequest, AIResponse, AIMessage } from '../../../shared/types/index.js';
import { validateChannel, validateMessageContent, MAX_MESSAGE_LENGTH } from '../utils/validation.js';
import { handleAIError } from '../utils/error-handler.js';

// --------------------------------------------
// FREE_MODELS — 3 самых стабильных бесплатных модели
// Уменьшено для экономии rate limit OpenRouter
// --------------------------------------------

const FREE_MODELS = [
  'meta-llama/llama-3.2-3b-instruct:free',      // Llama 3.2 3B — самая стабильная
  'mistralai/mistral-7b-instruct:free',         // Mistral 7B — проверенная
  'google/gemma-2-9b-it:free',                  // Gemma 2 9B — Google backup
];

// Таймаут для гонки моделей (чтобы не превысить 30 сек Render)
const RACE_TIMEOUT_MS = 15000;

// Ошибки при которых нужен параллельный fallback
const RACE_ERROR_PATTERNS = [
  'Provider returned error',
  'Empty response',
  'No endpoints found',
  '503',
  '502',
  '500',
  '400',
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

const getAIConfig = async (channel: 'telegram' | 'voice'): Promise<AIConfig> => {
  // Get settings from database
  const settings = await settingsRepo.getMany([
    'openrouter_model',
    'custom_model_override',
    'max_tokens',
    'temperature',
  ]);

  // Get active prompt for channel
  const prompt = await promptsRepo.getActive(channel);

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
  return `Ты — Amina, дружелюбный AI-ассистент. 
  
Твои качества:
- Отвечаешь кратко и по делу
- Используешь понятный язык
- Помогаешь решать задачи пользователя
- Если не знаешь ответ — честно говоришь об этом

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
    const aiConfig = await getAIConfig(channel);
    const client = await getClient();

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
        const detailedError = new Error(
          `AUTH_ERROR: Неверный API ключ OpenRouter. Проверьте OPENROUTER_API_KEY.`
        );
        (detailedError as any).code = 'AUTH_ERROR';
        throw detailedError;
      }
      
      if (errorMessage.includes('402') || errorMessage.includes('Payment Required')) {
        const detailedError = new Error(
          `PAYMENT_REQUIRED: Пополните баланс на OpenRouter или выберите бесплатную модель.`
        );
        (detailedError as any).code = 'PAYMENT_REQUIRED';
        throw detailedError;
      }

      // Проверяем, нужна ли гонка моделей
      const needsRace = RACE_ERROR_PATTERNS.some(pattern => 
        errorMessage.toLowerCase().includes(pattern.toLowerCase())
      );

      if (!needsRace) {
        // Rate limit — не поможет гонка, просто ждать
        if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
          const detailedError = new Error(
            `RATE_LIMIT: Превышен лимит запросов. Подождите минуту.`
          );
          (detailedError as any).code = 'RATE_LIMIT';
          throw detailedError;
        }
        throw primaryError;
      }
    }

    // === ШАГ 2: Гонка 3 бесплатных моделей с таймаутом ===
    aiLogger.info(
      { modelsCount: FREE_MODELS.length, timeoutMs: RACE_TIMEOUT_MS },
      '🏁 Starting model race — first to respond wins'
    );

    // Таймаут-промис для ограничения гонки
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('RACE_TIMEOUT: Превышено время ожидания ответа от моделей'));
      }, RACE_TIMEOUT_MS);
    });

    // Запускаем модели параллельно
    const racePromises = FREE_MODELS.map(async (model) => {
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
      const errorMsg = raceError instanceof Error ? raceError.message : String(raceError);
      
      // Проверяем таймаут
      if (errorMsg.includes('RACE_TIMEOUT')) {
        aiLogger.error({ timeoutMs: RACE_TIMEOUT_MS }, '⏰ Race timeout — all models too slow');
        const detailedError = new Error(
          `RACE_TIMEOUT: Все модели отвечают слишком долго. Попробуйте позже.`
        );
        (detailedError as any).code = 'RACE_TIMEOUT';
        throw detailedError;
      }

      // Все модели упали
      aiLogger.error(
        { modelsCount: FREE_MODELS.length },
        '💀 All models failed in race'
      );

      const detailedError = new Error(
        `ALL_MODELS_FAILED: Все ${FREE_MODELS.length} бесплатных моделей недоступны. Попробуйте позже.`
      );
      (detailedError as any).code = 'ALL_MODELS_FAILED';
      (detailedError as any).triedModels = FREE_MODELS;
      throw detailedError;
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
    const client = await getClient();

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
 * Get list of race models for admin panel (10 free models)
 */
export function getFallbackModels(): Array<{ id: string; name: string; description: string }> {
  return FREE_MODELS.map((id) => ({
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
}> {
  const currentModel = await settingsRepo.get('openrouter_model');
  return {
    currentModel: currentModel || 'meta-llama/llama-3.2-3b-instruct:free',
    lastSwitchReason: lastFallbackSwitch.reason,
    lastSwitchTime: lastFallbackSwitch.time?.toISOString() || null,
    raceModelsCount: FREE_MODELS.length,
  };
}
