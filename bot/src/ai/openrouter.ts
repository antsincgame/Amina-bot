import OpenAI from 'openai';
import { config, getApiKeys } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { settingsRepo, promptsRepo } from '../db/supabase.js';
import type { AIRequest, AIResponse, AIMessage } from '../../../shared/types/index.js';
import { validateChannel, validateMessageContent, MAX_MESSAGE_LENGTH } from '../utils/validation.js';
import { handleAIError } from '../utils/error-handler.js';

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

    aiLogger.debug(
      { model: aiConfig.model, messageCount: messages.length },
      'Sending chat request'
    );

    try {
      const response = await client.chat.completions.create({
        model: aiConfig.model,
        messages: fullMessages,
        max_tokens: aiConfig.maxTokens,
        temperature: aiConfig.temperature,
      });

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new Error('Empty response from AI');
      }

      const result: AIResponse = {
        content: choice.message.content,
        model: response.model,
        tokens_used: {
          prompt: response.usage?.prompt_tokens ?? 0,
          completion: response.usage?.completion_tokens ?? 0,
          total: response.usage?.total_tokens ?? 0,
        },
        finish_reason: choice.finish_reason ?? 'unknown',
      };

      aiLogger.info(
        { model: result.model, tokens: result.tokens_used.total },
        'AI response received'
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      aiLogger.error({ error, model: aiConfig.model }, 'AI request failed');
      
      // Create detailed error for user
      if (errorMessage.includes('No endpoints found') || errorMessage.includes('404')) {
        const detailedError = new Error(
          `MODEL_NOT_FOUND: Модель "${aiConfig.model}" не найдена на OpenRouter. ` +
          `Измените модель в админке: https://amina-admin.onrender.com/settings`
        );
        (detailedError as any).code = 'MODEL_NOT_FOUND';
        (detailedError as any).model = aiConfig.model;
        throw detailedError;
      }
      
      if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        const detailedError = new Error(
          `AUTH_ERROR: Неверный API ключ OpenRouter. Проверьте OPENROUTER_API_KEY в Render.`
        );
        (detailedError as any).code = 'AUTH_ERROR';
        throw detailedError;
      }
      
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        const detailedError = new Error(
          `RATE_LIMIT: Превышен лимит запросов к OpenRouter. Подождите немного.`
        );
        (detailedError as any).code = 'RATE_LIMIT';
        throw detailedError;
      }
      
      if (errorMessage.includes('500') || errorMessage.includes('502') || errorMessage.includes('503')) {
        const detailedError = new Error(
          `SERVER_ERROR: OpenRouter временно недоступен. Попробуйте позже.`
        );
        (detailedError as any).code = 'SERVER_ERROR';
        throw detailedError;
      }
      
      throw error;
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
