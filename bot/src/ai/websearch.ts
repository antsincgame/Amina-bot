/**
 * Web Search via Perplexity API
 * Автоматический поиск в интернете когда бот не знает ответ
 * Процесс полностью прозрачен для пользователя
 */

import { config } from '../config/index.js';
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

// Самая дешёвая модель Perplexity для поиска
const CHEAPEST_MODEL = 'llama-3.1-sonar-small-128k-online';

// Модели Perplexity для поиска
const PERPLEXITY_MODELS = {
  'sonar': 'llama-3.1-sonar-small-128k-online',        // Самая дешёвая
  'sonar-medium': 'llama-3.1-sonar-large-128k-online',
  'sonar-huge': 'llama-3.1-sonar-huge-128k-online',
} as const;

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
// Search Detection
// --------------------------------------------

// Паттерны вопросов требующих актуальной информации
const REALTIME_PATTERNS = [
  // Время-зависимые вопросы
  /сегодня|сейчас|вчера|завтра|на этой неделе|в этом году/i,
  /актуальн|последн|свежи|новы|текущ/i,
  /\d{4}\s*год/i, // Вопросы про конкретный год
  
  // Информация требующая поиска
  /погода|прогноз/i,
  /курс|котировк|цена|стоимость/i,
  /новост|событи/i,
  /расписани|график/i,
  
  // Факты которые могут измениться
  /президент|премьер|министр|глава/i,
  /население|количество жителей/i,
  /рекорд|чемпион|победител/i,
  
  // Явные запросы на поиск
  /найди|поищи|погугли|загугли/i,
  /search|find|google|look up/i,
];

// Паттерны ответов AI когда он не знает
const UNCERTAINTY_PATTERNS = [
  /не знаю|не уверен|не могу сказать точно/i,
  /у меня нет.*информации/i,
  /мои данные.*устарели|данные.*ограничены/i,
  /не имею доступа.*интернет/i,
  /рекомендую.*проверить|уточни.*источник/i,
  /на момент моего обучения|по состоянию на/i,
  /i don't know|i'm not sure|cannot say for certain/i,
];

/**
 * Определяет, нужен ли веб-поиск для данного сообщения
 */
export function needsWebSearch(message: string): boolean {
  return REALTIME_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Определяет, показывает ли ответ AI что он не знает ответ
 */
export function aiShowsUncertainty(response: string): boolean {
  return UNCERTAINTY_PATTERNS.some(pattern => pattern.test(response));
}

/**
 * Выполняет веб-поиск через Perplexity API (самая дешёвая модель)
 * Результат форматируется как контекст для основной LLM
 */
export async function webSearch(
  query: string,
  options: {
    maxTokens?: number;
  } = {}
): Promise<WebSearchResult> {
  const apiKey = await getPerplexityApiKey();
  
  if (!apiKey) {
    throw Object.assign(
      new Error('Perplexity API key not configured'),
      { code: 'PERPLEXITY_NOT_CONFIGURED' }
    );
  }

  const maxTokens = options.maxTokens || 512; // Короткие ответы для экономии
  
  // Системный промпт для краткого поиска фактов
  const systemPrompt = `Найди актуальную информацию по запросу и дай краткий фактический ответ.
Отвечай только фактами, без вступлений. Если информация недоступна - скажи кратко.
Язык ответа: русский.`;

  telegramLogger.debug({ query }, 'Performing silent web search');

  try {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CHEAPEST_MODEL, // Всегда самая дешёвая модель
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        max_tokens: maxTokens,
        temperature: 0.1, // Минимальная температура для точности
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      telegramLogger.warn({ status: response.status, error: errorText }, 'Perplexity API error (silent)');
      
      if (response.status === 401) {
        throw Object.assign(new Error('Invalid Perplexity API key'), { code: 'PERPLEXITY_AUTH_ERROR' });
      }
      if (response.status === 429) {
        throw Object.assign(new Error('Perplexity rate limit'), { code: 'PERPLEXITY_RATE_LIMIT' });
      }
      if (response.status === 402) {
        throw Object.assign(new Error('Perplexity payment required'), { code: 'PERPLEXITY_PAYMENT_REQUIRED' });
      }
      
      throw Object.assign(new Error(`Perplexity error: ${response.status}`), { code: 'PERPLEXITY_ERROR' });
    }

    const data: PerplexityResponse = await response.json();
    const content = data.choices[0]?.message?.content || '';
    const citations = data.citations || [];

    telegramLogger.debug({ tokens: data.usage.total_tokens }, 'Silent web search completed');

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
    if ((error as any).code) throw error;
    telegramLogger.warn({ error }, 'Silent web search failed');
    throw Object.assign(new Error('Web search failed'), { code: 'PERPLEXITY_ERROR' });
  }
}

/**
 * Выполняет поиск и форматирует результат для пользователя (для команды /search)
 */
export async function searchAndFormat(query: string): Promise<string> {
  const result = await webSearch(query);
  
  let formattedResponse = result.answer;
  
  // Добавляем источники если есть
  if (result.citations.length > 0) {
    formattedResponse += '\n\n📚 **Источники:**\n';
    result.citations.slice(0, 3).forEach((citation, index) => {
      const shortUrl = citation.length > 50 ? citation.substring(0, 47) + '...' : citation;
      formattedResponse += `${index + 1}. ${shortUrl}\n`;
    });
  }
  
  return formattedResponse;
}

/**
 * Получает контекст из интернета для основной LLM (прозрачно для пользователя)
 * Возвращает строку контекста или пустую строку если поиск не нужен/не удался
 */
export async function getSearchContext(query: string): Promise<string> {
  // Проверяем, включён ли поиск
  const enabled = await isWebSearchEnabled();
  if (!enabled) return '';
  
  // Проверяем, нужен ли поиск для этого запроса
  if (!needsWebSearch(query)) return '';
  
  try {
    const result = await webSearch(query);
    
    // Форматируем как скрытый контекст для LLM
    return `\n\n[АКТУАЛЬНАЯ ИНФОРМАЦИЯ ИЗ ИНТЕРНЕТА]
${result.answer}
[/АКТУАЛЬНАЯ ИНФОРМАЦИЯ]

Используй эту информацию в своём ответе естественно, не упоминая что это "информация из интернета". Просто отвечай как будто ты это знаешь.`;
  } catch (error) {
    // Молча игнорируем ошибки поиска - основная LLM ответит без интернета
    telegramLogger.debug({ error }, 'Search context failed, continuing without');
    return '';
  }
}

/**
 * Дополняет ответ AI если он показывает неуверенность
 * Возвращает улучшенный ответ или оригинальный если поиск не помог
 */
export async function enhanceResponseIfNeeded(
  originalQuery: string,
  aiResponse: string
): Promise<{ response: string; wasEnhanced: boolean }> {
  // Проверяем, включён ли поиск
  const enabled = await isWebSearchEnabled();
  if (!enabled) return { response: aiResponse, wasEnhanced: false };
  
  // Проверяем, показывает ли AI неуверенность
  if (!aiShowsUncertainty(aiResponse)) {
    return { response: aiResponse, wasEnhanced: false };
  }
  
  telegramLogger.info({ query: originalQuery }, 'AI showed uncertainty, searching...');
  
  try {
    const searchResult = await webSearch(originalQuery);
    
    // Если поиск дал результат - возвращаем его напрямую
    if (searchResult.answer && searchResult.answer.length > 50) {
      return { 
        response: searchResult.answer, 
        wasEnhanced: true 
      };
    }
  } catch (error) {
    telegramLogger.debug({ error }, 'Enhancement search failed');
  }
  
  return { response: aiResponse, wasEnhanced: false };
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
