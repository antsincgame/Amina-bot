import OpenAI from 'openai';
import { config } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { settingsRepo, promptsRepo } from '../db/supabase.js';
import type { AIRequest, AIResponse, AIMessage } from '../../../shared/types/index.js';
import { validateChannel, validateMessageContent, MAX_MESSAGE_LENGTH } from '../utils/validation.js';
import { handleAIError } from '../utils/error-handler.js';

// --------------------------------------------
// OpenRouter Client
// --------------------------------------------

let openai: OpenAI | null = null;

const getClient = (): OpenAI => {
  if (!openai) {
    openai = new OpenAI({
      apiKey: config.ai.apiKey,
      baseURL: config.ai.baseUrl,
      timeout: 30000, // 30 second timeout
      defaultHeaders: {
        'HTTP-Referer': 'https://amina-bot.render.com',
        'X-Title': 'Amina AI Bot',
      },
    });
    aiLogger.info('OpenRouter client initialized');
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
    'max_tokens',
    'temperature',
  ]);

  // Get active prompt for channel
  const prompt = await promptsRepo.getActive(channel);

  return {
    model: settings['openrouter_model'] ?? config.ai.model ?? 'openrouter/free',
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
    channel: 'telegram' | 'voice' = 'telegram'
  ): Promise<AIResponse> {
    const aiConfig = await getAIConfig(channel);
    const client = getClient();

    // Add system prompt
    const fullMessages: AIMessage[] = [
      { role: 'system', content: aiConfig.systemPrompt },
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
      aiLogger.error({ error }, 'AI request failed');
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
    const client = getClient();

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
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: `Bearer ${config.ai.apiKey}`,
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
