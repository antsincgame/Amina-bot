/**
 * Web Search via Perplexity API
 * Даёт боту доступ к интернету для поиска актуальной информации
 */

import { config, getApiKeys } from '../config/index.js';
import { settingsRepo } from '../db/supabase.js';
import { telegramLogger } from '../config/logger.js';

// --------------------------------------------
// Types
// --------------------------------------------

interface PerplexityResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  citations?: string[];
}

export interface WebSearchResult {
  answer: string;
  citations: string[];
  model: string;
  tokens_used: {
    prompt: number;
    completion: number;
    total: number;
  };
}

// --------------------------------------------
// Configuration
// --------------------------------------------

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

// Модели Perplexity для поиска
const PERPLEXITY_MODELS = {
  // Быстрые и дешёвые (рекомендуется для поиска)
  'sonar': 'llama-3.1-sonar-small-128k-online',
  'sonar-medium': 'llama-3.1-sonar-large-128k-online',
  'sonar-huge': 'llama-3.1-sonar-huge-128k-online',
} as const;

// Триггеры для автоматического поиска
const SEARCH_TRIGGERS = [
  // Русские
  'найди', 'поищи', 'погугли', 'загугли', 'поиск', 'искать',
  'что такое', 'кто такой', 'кто такая', 'когда', 'где находится',
  'актуальн', 'сегодня', 'сейчас', 'последн', 'новост', 'свежи',
  'курс', 'погода', 'цена', 'стоимость', 'расписание',
  // Английские
  'search', 'find', 'google', 'look up', 'what is', 'who is',
  'latest', 'current', 'today', 'news', 'price', 'weather',
];

// --------------------------------------------
// API Key Management
// --------------------------------------------

let cachedPerplexityKey: string | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 60 * 1000; // 1 минута

async function getPerplexityApiKey(): Promise<string> {
  // Сначала проверяем env
  if (config.perplexity?.apiKey) {
    return config.perplexity.apiKey;
  }

  // Проверяем кэш
  const now = Date.now();
  if (cachedPerplexityKey && now - cacheLoadedAt < CACHE_TTL) {
    return cachedPerplexityKey;
  }

  // Загружаем из БД
  try {
    const key = await settingsRepo.get('perplexity_api_key');
    cachedPerplexityKey = key || '';
    cacheLoadedAt = now;
    return cachedPerplexityKey;
  } catch {
    return '';
  }
}

// --------------------------------------------
// Search Functions
// --------------------------------------------

/**
 * Определяет, нужен ли веб-поиск для данного сообщения
 */
export function needsWebSearch(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return SEARCH_TRIGGERS.some(trigger => lowerMessage.includes(trigger));
}

/**
 * Выполняет веб-поиск через Perplexity API
 */
export async function webSearch(
  query: string,
  options: {
    systemPrompt?: string;
    maxTokens?: number;
    model?: keyof typeof PERPLEXITY_MODELS;
  } = {}
): Promise<WebSearchResult> {
  const apiKey = await getPerplexityApiKey();
  
  if (!apiKey) {
    throw Object.assign(
      new Error('Perplexity API key not configured'),
      { code: 'PERPLEXITY_NOT_CONFIGURED' }
    );
  }

  const model = PERPLEXITY_MODELS[options.model || 'sonar'];
  const maxTokens = options.maxTokens || 1024;
  
  const systemPrompt = options.systemPrompt || 
    `Ты полезный AI-ассистент с доступом к интернету. Отвечай кратко и по делу на русском языке.
Всегда указывай источники информации. Если информация устарела или недоступна, честно скажи об этом.`;

  telegramLogger.info({ query, model }, 'Performing web search');

  try {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        max_tokens: maxTokens,
        temperature: 0.2, // Низкая температура для точных фактов
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      telegramLogger.error({ status: response.status, error: errorText }, 'Perplexity API error');
      
      if (response.status === 401) {
        throw Object.assign(
          new Error('Invalid Perplexity API key'),
          { code: 'PERPLEXITY_AUTH_ERROR' }
        );
      }
      if (response.status === 429) {
        throw Object.assign(
          new Error('Perplexity rate limit exceeded'),
          { code: 'PERPLEXITY_RATE_LIMIT' }
        );
      }
      if (response.status === 402) {
        throw Object.assign(
          new Error('Perplexity payment required'),
          { code: 'PERPLEXITY_PAYMENT_REQUIRED' }
        );
      }
      
      throw Object.assign(
        new Error(`Perplexity API error: ${response.status}`),
        { code: 'PERPLEXITY_ERROR' }
      );
    }

    const data: PerplexityResponse = await response.json();
    const content = data.choices[0]?.message?.content || '';
    const citations = data.citations || [];

    telegramLogger.info(
      { tokens: data.usage.total_tokens, citationsCount: citations.length },
      'Web search completed'
    );

    return {
      answer: content,
      citations,
      model: data.model,
      tokens_used: {
        prompt: data.usage.prompt_tokens,
        completion: data.usage.completion_tokens,
        total: data.usage.total_tokens,
      },
    };
  } catch (error) {
    if ((error as any).code) {
      throw error; // Re-throw our custom errors
    }
    
    telegramLogger.error({ error }, 'Web search failed');
    throw Object.assign(
      new Error('Web search failed'),
      { code: 'PERPLEXITY_ERROR' }
    );
  }
}

/**
 * Выполняет поиск и форматирует результат для пользователя
 */
export async function searchAndFormat(query: string): Promise<string> {
  const result = await webSearch(query);
  
  let formattedResponse = result.answer;
  
  // Добавляем источники если есть
  if (result.citations.length > 0) {
    formattedResponse += '\n\n📚 **Источники:**\n';
    result.citations.slice(0, 5).forEach((citation, index) => {
      // Укорачиваем URL для читаемости
      const shortUrl = citation.length > 50 
        ? citation.substring(0, 47) + '...' 
        : citation;
      formattedResponse += `${index + 1}. ${shortUrl}\n`;
    });
  }
  
  return formattedResponse;
}

/**
 * Проверяет, включён ли веб-поиск
 */
export async function isWebSearchEnabled(): Promise<boolean> {
  try {
    const enabled = await settingsRepo.get('web_search_enabled');
    return enabled === 'true';
  } catch {
    return false; // По умолчанию выключен
  }
}

/**
 * Очистить кэш API ключа
 */
export function clearPerplexityCache(): void {
  cachedPerplexityKey = null;
  cacheLoadedAt = 0;
}
