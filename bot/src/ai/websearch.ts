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

// Модели Perplexity с ценами ($/1M токенов) — обновлено февраль 2026
// Источник: https://docs.perplexity.ai/docs/getting-started/pricing
interface PerplexityModel {
  id: string;
  name: string;
  inputPrice: number;  // $ per 1M tokens
  outputPrice: number; // $ per 1M tokens
  requestFee: number;  // $ per 1K requests (low context)
  online: boolean;     // Имеет доступ в интернет
}

const PERPLEXITY_MODELS: PerplexityModel[] = [
  // Новые названия моделей (февраль 2026)
  // Sonar — самая дешёвая, быстрая, для простых запросов
  { id: 'sonar', name: 'Sonar', inputPrice: 1.00, outputPrice: 1.00, requestFee: 5.00, online: true },
  // Sonar Pro — для сложных запросов, больше цитат
  { id: 'sonar-pro', name: 'Sonar Pro', inputPrice: 3.00, outputPrice: 15.00, requestFee: 6.00, online: true },
  // Sonar Reasoning Pro — с рассуждением
  { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', inputPrice: 2.00, outputPrice: 8.00, requestFee: 6.00, online: true },
];

/**
 * Получить самую дешёвую online-модель
 * Учитывает и стоимость токенов, и request fee
 */
function getCheapestOnlineModel(): string {
  const onlineModels = PERPLEXITY_MODELS.filter(m => m.online);
  
  // Примерно 500 токенов на запрос (250 input + 250 output)
  // Считаем общую стоимость: tokens + request_fee/1000
  const estimateCost = (m: PerplexityModel) => {
    const tokenCost = (250 * m.inputPrice / 1_000_000) + (250 * m.outputPrice / 1_000_000);
    const requestCost = m.requestFee / 1000; // за 1 запрос
    return tokenCost + requestCost;
  };
  
  onlineModels.sort((a, b) => estimateCost(a) - estimateCost(b));
  
  const cheapest = onlineModels[0];
  const cost = estimateCost(cheapest);
  telegramLogger.debug({ model: cheapest.id, costPerRequest: cost.toFixed(6) }, 'Selected cheapest model');
  
  return cheapest.id;
}

/**
 * Получить информацию о модели по ID
 */
function getModelInfo(modelId: string): PerplexityModel | undefined {
  return PERPLEXITY_MODELS.find(m => m.id === modelId);
}

// --------------------------------------------
// API Key Management
// --------------------------------------------

let cachedPerplexityKey: string | null = null;
let cachedPerplexityModel: string | null = null;
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

/**
 * Получить выбранную модель из настроек
 * По умолчанию: самая дешёвая (sonar)
 */
async function getSelectedModel(): Promise<string> {
  // Проверяем кэш
  const now = Date.now();
  if (cachedPerplexityModel && now - cacheLoadedAt < CACHE_TTL) {
    return cachedPerplexityModel;
  }

  // Загружаем из БД
  try {
    const model = await settingsRepo.get('perplexity_model');
    // Проверяем что модель валидна
    const validModel = PERPLEXITY_MODELS.find(m => m.id === model);
    cachedPerplexityModel = validModel ? model : getCheapestOnlineModel();
    return cachedPerplexityModel;
  } catch {
    return getCheapestOnlineModel();
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
  
  // Криптовалюты и акции
  /биткоин|bitcoin|btc|эфир|ethereum|eth|крипт/i,
  /акци|stock|nasdaq|s&p|dow jones/i,
];

// --------------------------------------------
// Query Enhancement — улучшение коротких запросов
// --------------------------------------------

interface QueryType {
  pattern: RegExp;
  enhancer: (query: string) => string;
}

const QUERY_ENHANCERS: QueryType[] = [
  // Цены криптовалют
  {
    pattern: /цена\s*(биткоин|bitcoin|btc|эфир|ethereum|eth|крипт)/i,
    enhancer: (q) => {
      const match = q.match(/биткоин|bitcoin|btc|эфир|ethereum|eth/i);
      const crypto = match ? match[0].toUpperCase() : 'BTC';
      return `Какая текущая цена ${crypto} в долларах США прямо сейчас? Укажи точную цену.`;
    },
  },
  // Курсы валют
  {
    pattern: /курс\s*(доллар|евро|рубл|usd|eur|rub)/i,
    enhancer: (q) => {
      const match = q.match(/доллар|евро|рубл|usd|eur|rub/i);
      const currency = match ? match[0] : 'доллара';
      return `Какой актуальный курс ${currency} к рублю сегодня? Укажи точный курс.`;
    },
  },
  // Погода
  {
    pattern: /погода\s*(в\s+)?(\w+)?/i,
    enhancer: (q) => {
      const match = q.match(/погода\s*(?:в\s+)?(\w+)?/i);
      const city = match?.[1] || 'Москве';
      return `Какая погода в ${city} сейчас? Температура, осадки, ветер.`;
    },
  },
  // Акции
  {
    pattern: /цена\s*акци|акци.*цена|stock\s*price/i,
    enhancer: (q) => {
      const match = q.match(/акци[ийя]?\s+(\w+)|(\w+)\s+акци/i);
      const company = match?.[1] || match?.[2] || 'компании';
      return `Какая текущая цена акций ${company} на бирже сегодня?`;
    },
  },
  // Стоимость товаров
  {
    pattern: /сколько\s*стоит|стоимость|цена/i,
    enhancer: (q) => {
      // Если запрос очень короткий, добавляем контекст
      if (q.length < 20) {
        return `${q} — актуальная цена сегодня в России`;
      }
      return q;
    },
  },
];

/**
 * Улучшает короткий запрос для более точного поиска
 * Превращает "Цена биткоин?" в "Какая текущая цена BTC в долларах США прямо сейчас?"
 */
function enhanceSearchQuery(query: string): string {
  // Пробуем найти подходящий enhancer
  for (const { pattern, enhancer } of QUERY_ENHANCERS) {
    if (pattern.test(query)) {
      const enhanced = enhancer(query);
      telegramLogger.debug({ original: query, enhanced }, 'Query enhanced for search');
      return enhanced;
    }
  }
  
  // Если запрос очень короткий (< 15 символов), добавляем контекст
  if (query.length < 15) {
    return `${query} — актуальная информация сегодня`;
  }
  
  return query;
}

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
 * Выполняет веб-поиск через Perplexity API
 * Использует модель выбранную в админке (или самую дешёвую по умолчанию)
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
  
  // Получаем модель из настроек админки
  const selectedModel = await getSelectedModel();
  const modelInfo = getModelInfo(selectedModel);
  
  // Улучшаем запрос для более точного поиска
  const enhancedQuery = enhanceSearchQuery(query);
  
  // Системный промпт для краткого поиска фактов
  // ВАЖНО: Явно указываем что нужна АКТУАЛЬНАЯ информация, не общие описания
  const systemPrompt = `Ты — поисковый ассистент. Твоя задача — найти АКТУАЛЬНУЮ информацию ПРЯМО СЕЙЧАС.

ПРАВИЛА:
1. Для вопросов о ценах/курсах — дай ТОЧНУЮ ЦИФРУ с источником
2. Для погоды — дай ТЕКУЩИЕ показатели (температура, осадки)
3. Для новостей — дай СЕГОДНЯШНИЕ события
4. НЕ давай общие описания или определения из Wikipedia
5. Если спрашивают "цена биткоин" — нужна ЦЕНА В ДОЛЛАРАХ, не что такое биткоин

Формат ответа: кратко, только факты, без вступлений.
Язык: русский.`;

  telegramLogger.debug(
    { originalQuery: query, enhancedQuery, model: selectedModel, pricePerMToken: modelInfo?.inputPrice }, 
    'Performing web search'
  );

  // Таймаут для поиска (15 секунд)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: selectedModel, // Динамически выбранная модель из админки
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: enhancedQuery }, // Используем улучшенный запрос
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
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];

    // Защита от отсутствия usage
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Рассчитываем примерную стоимость (токены + request fee)
    const tokenCost = modelInfo 
      ? (usage.prompt_tokens * modelInfo.inputPrice / 1_000_000) + 
        (usage.completion_tokens * modelInfo.outputPrice / 1_000_000)
      : 0;
    const requestCost = modelInfo ? modelInfo.requestFee / 1000 : 0;
    const totalCost = tokenCost + requestCost;

    telegramLogger.debug({ 
      tokens: usage.total_tokens, 
      model: selectedModel,
      tokenCostUSD: tokenCost.toFixed(6),
      requestFeeUSD: requestCost.toFixed(6),
      totalCostUSD: totalCost.toFixed(6),
    }, 'Web search completed');

    return {
      answer: content,
      citations,
      model: data.model,
      tokens_used: {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
      },
    };
  } catch (error) {
    // Обработка таймаута
    if (error instanceof DOMException && error.name === 'AbortError') {
      telegramLogger.warn({ query }, 'Web search timeout (15s)');
      throw Object.assign(new Error('Web search timeout'), { code: 'PERPLEXITY_TIMEOUT' });
    }
    
    if (typeof error === 'object' && error !== null && 'code' in error) throw error;
    telegramLogger.warn({ error }, 'Silent web search failed');
    throw Object.assign(new Error('Web search failed'), { code: 'PERPLEXITY_ERROR' });
  } finally {
    clearTimeout(timeoutId);
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
    // ВАЖНО: Чёткие инструкции как использовать данные поиска
    return `\n\n=== ДАННЫЕ ИЗ ИНТЕРНЕТА (${new Date().toLocaleDateString('ru-RU')}) ===
${result.answer}
=== КОНЕЦ ДАННЫХ ===

ИНСТРУКЦИЯ: Это актуальные данные из интернета. 
- Если там есть ЦИФРЫ (цены, курсы, температура) — используй их напрямую
- Отвечай кратко и по делу, используя эти данные
- НЕ упоминай "по данным поиска" или "согласно интернету"
- Просто дай ответ как будто ты это знаешь`;
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
 * Очистить кэш API ключа и модели
 */
export function clearPerplexityCache(): void {
  cachedPerplexityKey = null;
  cachedPerplexityModel = null;
  cacheLoadedAt = 0;
}

/**
 * Получить информацию о текущей модели поиска (для админки)
 */
export async function getSearchModelInfo(): Promise<{ 
  model: string; 
  name: string; 
  priceInput: number; 
  priceOutput: number;
  requestFee: number;
  estimatedCostPer100Searches: number;
}> {
  const model = await getSelectedModel();
  const info = getModelInfo(model);
  
  if (!info) {
    return {
      model,
      name: 'Unknown',
      priceInput: 0,
      priceOutput: 0,
      requestFee: 0,
      estimatedCostPer100Searches: 0,
    };
  }
  
  // Примерно 500 токенов на поиск (250 input + 250 output)
  const tokenCostPerSearch = (250 * info.inputPrice / 1_000_000) + (250 * info.outputPrice / 1_000_000);
  const requestCostPerSearch = info.requestFee / 1000;
  const totalCostPerSearch = tokenCostPerSearch + requestCostPerSearch;
  
  return {
    model: info.id,
    name: info.name,
    priceInput: info.inputPrice,
    priceOutput: info.outputPrice,
    requestFee: info.requestFee,
    estimatedCostPer100Searches: totalCostPerSearch * 100,
  };
}

/**
 * Получить список всех доступных моделей (сортировка по стоимости)
 */
export function getAvailableModels(): PerplexityModel[] {
  const estimateCost = (m: PerplexityModel) => {
    const tokenCost = (250 * m.inputPrice / 1_000_000) + (250 * m.outputPrice / 1_000_000);
    return tokenCost + m.requestFee / 1000;
  };
  
  return [...PERPLEXITY_MODELS].sort((a, b) => estimateCost(a) - estimateCost(b));
}
