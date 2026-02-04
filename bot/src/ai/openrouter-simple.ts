import OpenAI from 'openai';
import { config } from '../config/index-simple.js';
import { aiLogger } from '../config/logger-simple.js';

// --------------------------------------------
// Simple OpenRouter Client (No Database)
// --------------------------------------------

interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AIResponse {
  content: string;
  model: string;
  tokens_used: {
    prompt: number;
    completion: number;
    total: number;
  };
  finish_reason: string;
}

let openai: OpenAI | null = null;

const getClient = (): OpenAI => {
  if (!openai) {
    openai = new OpenAI({
      apiKey: config.ai.apiKey,
      baseURL: config.ai.baseUrl,
      defaultHeaders: {
        'HTTP-Referer': 'https://amina-bot.render.com',
        'X-Title': 'Amina AI Bot',
      },
    });
    aiLogger.info('OpenRouter client initialized');
  }
  return openai;
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
  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const client = getClient();

    // Add system prompt if not present
    const fullMessages: AIMessage[] =
      messages[0]?.role === 'system'
        ? messages
        : [{ role: 'system', content: getDefaultSystemPrompt() }, ...messages];

    aiLogger.debug(
      { model: config.ai.model, messageCount: messages.length },
      'Sending chat request'
    );

    try {
      const response = await client.chat.completions.create({
        model: config.ai.model,
        messages: fullMessages,
        max_tokens: config.ai.maxTokens,
        temperature: config.ai.temperature,
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
   * Simple single-message response
   */
  async complete(userMessage: string): Promise<string> {
    const response = await this.chat([{ role: 'user', content: userMessage }]);
    return response.content;
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

export type { AIMessage, AIResponse };
