/**
 * Web Search via Perplexity API
 * Агрессивный движок поиска в интернете.
 * Бот АКТИВНО ищет информацию — при любых вопросах требующих актуальных данных.
 * 
 * Принцип: лучше поискать лишний раз, чем ответить устаревшей информацией.
 */

import { config } from '../config/index.js';
import { settingsRepo } from '../db/supabase.js';
import { telegramLogger } from '../config/logger.js';
import { SingleCache } from '../utils/cache.js';

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

// Значения по умолчанию для токенов поиска
const DEFAULT_SEARCH_MAX_TOKENS = 1200;
const DEFAULT_NEWS_MAX_TOKENS = 2000;
const DEFAULT_DIGEST_MAX_TOKENS = 4000;

// Модели Perplexity с ценами ($/1M токенов) — обновлено февраль 2026
interface PerplexityModel {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  requestFee: number;
  online: boolean;
}

const PERPLEXITY_MODELS: PerplexityModel[] = [
  { id: 'sonar', name: 'Sonar', inputPrice: 1.00, outputPrice: 1.00, requestFee: 5.00, online: true },
  { id: 'sonar-pro', name: 'Sonar Pro', inputPrice: 3.00, outputPrice: 15.00, requestFee: 6.00, online: true },
  { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', inputPrice: 2.00, outputPrice: 8.00, requestFee: 6.00, online: true },
];

function getCheapestOnlineModel(): string {
  const DEFAULT_FALLBACK_MODEL = 'sonar';
  const onlineModels = PERPLEXITY_MODELS.filter(m => m.online);
  if (onlineModels.length === 0) return PERPLEXITY_MODELS[0]?.id ?? DEFAULT_FALLBACK_MODEL;
  const estimateCost = (m: PerplexityModel) => {
    const tokenCost = (250 * m.inputPrice / 1_000_000) + (250 * m.outputPrice / 1_000_000);
    return tokenCost + m.requestFee / 1000;
  };
  onlineModels.sort((a, b) => estimateCost(a) - estimateCost(b));
  return onlineModels[0]!.id;
}

function getModelInfo(modelId: string): PerplexityModel | undefined {
  return PERPLEXITY_MODELS.find(m => m.id === modelId);
}

// --------------------------------------------
// API Key & Config Management
// --------------------------------------------

// Кэши (SingleCache вместо ручных переменных)
const perplexityKeyCache = new SingleCache<string>(60_000);
const perplexityModelCache = new SingleCache<string>(60_000);
const searchMaxTokensCache = new SingleCache<number>(60_000);

async function getPerplexityApiKey(): Promise<string> {
  if (config.perplexity?.apiKey) return config.perplexity.apiKey;
  const cached = perplexityKeyCache.get();
  if (cached) return cached;
  try {
    const key = await settingsRepo.get('perplexity_api_key');
    if (key) perplexityKeyCache.set(key);
    return key || '';
  } catch { return ''; }
}

async function getSelectedModel(): Promise<string> {
  const cached = perplexityModelCache.get();
  if (cached) return cached;
  try {
    const model = await settingsRepo.get('perplexity_model');
    const validModel = PERPLEXITY_MODELS.find(m => m.id === model);
    const result = validModel ? validModel.id : getCheapestOnlineModel();
    perplexityModelCache.set(result);
    return result;
  } catch { return getCheapestOnlineModel(); }
}

async function getSearchMaxTokens(): Promise<number> {
  const cached = searchMaxTokensCache.get();
  if (cached !== null) return cached;
  try {
    const val = await settingsRepo.get('web_search_max_tokens');
    const parsed = val ? parseInt(val, 10) : NaN;
    const result = (!isNaN(parsed) && parsed >= 200 && parsed <= 8000) ? parsed : DEFAULT_SEARCH_MAX_TOKENS;
    searchMaxTokensCache.set(result);
    return result;
  } catch { return DEFAULT_SEARCH_MAX_TOKENS; }
}

// --------------------------------------------
// Search Detection — РАСШИРЕННЫЕ ПАТТЕРНЫ
// --------------------------------------------

// Паттерны вопросов ОДНОЗНАЧНО требующих поиска (высокий приоритет)
const REALTIME_PATTERNS = [
  // === Время-зависимые вопросы ===
  /сегодня|сейчас|вчера|завтра|на этой неделе|в этом месяце|в этом году/i,
  /актуальн|последн|свежи|новы|текущ|нынешн/i,
  /\d{4}\s*год/i,
  /на данный момент|в настоящее время|в наше время/i,
  
  // === Погода ===
  /погода|прогноз|температур|осадк|ветер|дождь|снег|мороз|жара/i,
  
  // === Финансы ===
  /курс|котировк|цена|стоимость|тариф/i,
  /доллар|евро|рубл|юань|фунт|йена|usd|eur|rub|cny/i,
  /биткоин|bitcoin|btc|эфир|ethereum|eth|крипт|солана|solana|ton|тон/i,
  /акци|stock|nasdaq|s&p|dow jones|индекс|биржа|рынок/i,
  
  // === Новости и события ===
  /новост|событи|сводк|дайджест|что.{0,10}произош|что.{0,10}случил/i,
  /скандал|протест|конфликт|война|ситуаци[яи]\s*(в|на|с)\s/i,
  /выбор[ыа]|референдум|голосован/i,
  /заявил|объявил|сообщил|анонсир/i,
  
  // === Явные запросы на поиск ===
  /найди|поищи|погугли|загугли|проверь|узнай|подскажи/i,
  /назови|перечисли|посоветуй|порекомендуй|рекомендуй|предложи|подбери/i,
  /лучши[еёх]|топ[\s-]?\d|рейтинг|обзор|сравни|сравнени/i,
  /search|find|google|look up|what is the current/i,
  /расскажи\s*(про|о|об)\s/i,
  /что\s*(такое|значит|означает)\s/i,
  /как\s*(работает|устроен|действует|называется)\s/i,
  /сколько\s*(стоит|весит|длит|зараб|живёт|лет|км|метр)/i,
  /где\s*(находит|расположен|можно|купить|найти|есть|взять)/i,
  /кто\s*(такой|такая|такие|создал|изобрёл|основал|написал)/i,
  /когда\s*(будет|был[аои]?|состоит|начн[её]т|закончи|выйд|вышл)/i,
  /какой|какая|какие|каков/i,
  /почему|зачем|отчего/i,
  
  // === Факты о мире ===
  /президент|премьер|министр|глава|губернатор|мэр|лидер/i,
  /население|жителей|площадь|столица|валюта|территори/i,
  /рекорд|чемпион|победител|лауреат|призёр/i,
  
  // === Спорт ===
  /матч|игра|счёт|трансфер|лига чемпион|чемпионат|турнир|олимпи/i,
  /футбол|хокке|баскетбол|теннис|формула|гонк/i,
  
  // === Технологии ===
  /релиз|обновлени|версия|вышл[аои]|запуск/i,
  /iphone|android|ios|windows|macos|linux/i,
  /openai|google|microsoft|apple|meta|nvidia|tesla/i,
  /искусственн.{0,5}интеллект|нейросет|chatgpt|gpt-?[45]|gemini|claude/i,
  
  // === Культура и развлечения ===
  /фильм|кино|сериал|сезон|серия|премьера/i,
  /музык|альбом|песн|клип|концерт/i,
  /книг[аиу]|автор|писател/i,
  
  // === Расписание и графики ===
  /расписани|график|рейс|поезд|автобус|самолёт/i,
  /работает\s*(ли|до|с|сегодня)|часы\s*работы|режим\s*работы/i,
  
  // === Здоровье ===
  /симптом|лечени|лекарств|препарат|болезн|диагноз/i,
  
  // === Еда и рецепты ===
  /рецепт|калорийность|ингредиент|приготовить/i,
  
  // === Путешествия ===
  /виз[аы]|загранпаспорт|перелёт|отел[ьи]|тур(?:ы|изм)|достопримечательност/i,
  
  // === Места и заведения ===
  /кафе|кофейн[яиь]|ресторан|бар[ыу]?\b|пиццери|магазин|торгов|аптек|клиник|салон|парикмахер/i,
  /адрес|телефон|контакт|номер\s*телефон/i,
];

// Паттерны для ПРИНУДИТЕЛЬНОГО поиска — LLM не может ответить без актуальных данных
const FORCE_SEARCH_PATTERNS = [
  /погода/i,
  /курс\s*(доллар|евро|рубл|usd|eur)/i,
  /цена\s*(биткоин|bitcoin|btc|эфир|ethereum|eth)/i,
  /новости\s*(за\s*)?(сегодня|вчера|неделю)/i,
  /что\s*(произошло|случилось|нового)/i,
  /последние\s*новости/i,
  /сколько\s*стоит/i,
  /счёт\s*(матча|игры)/i,
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
  // Погода ([\wа-яёА-ЯЁ]+ для поддержки кириллицы)
  {
    pattern: /погода/i,
    enhancer: (q) => {
      const match = q.match(/погода\s*(?:в\s+)?([\wа-яёА-ЯЁ]+)?/i);
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
  // Новости / сводка новостей
  {
    pattern: /новост|сводк|событи|что.*произошло|что.*случилось/i,
    enhancer: (q) => {
      const today = new Date();
      const dateStr = today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      // Ищем название города — только после предлога "в"
      const cityMatch = q.match(/\bв\s+([А-ЯЁ][а-яё]{2,})/);
      const city = cityMatch ? cityMatch[1]! : '';
      const cityPart = city ? ` в ${city} и регионе` : '';
      const isYesterday = /вчера/i.test(q);
      const timePart = isYesterday ? 'за вчера' : `за сегодня (${dateStr})`;
      
      // Извлекаем тему: "новости про ИИ" → "ИИ", "новости о вайбкодинге" → "вайбкодинге"
      // Ищем: "про/о/об/по/на тему" + текст ИЛИ тему после "новости" если нет города
      const topicMatch = q.match(/(?:про|о|об|по теме|на тему|по)\s+(.+?)(?:\s*за\s|\s*в\s+[А-ЯЁ]|\s*$)/i);
      
      // Также ловим конструкции типа "новости ИИ", "последние новости AI"
      const topicAfterNewsMatch = !topicMatch 
        ? q.match(/новост\S*\s+(?:про\s+|о\s+|об\s+)?(.+?)(?:\s+за\s|\s+сегодня|\s+вчера|\s*$)/i)
        : null;
      
      const topic = topicMatch?.[1]?.trim() || topicAfterNewsMatch?.[1]?.trim() || '';
      
      // Фильтруем "мусорные" темы (предлоги, местоимения)
      const isValidTopic = topic.length > 1 && !/^(за|в|на|по|с|к|у|и|или|из|от)$/i.test(topic);
      const topicPart = isValidTopic ? ` по теме: ${topic}` : '';
      
      if (topicPart) {
        return `Последние новости и события${topicPart} ${timePart}. Найди конкретные свежие материалы именно по этой теме. Минимум 5 пунктов с подробностями.`;
      }
      
      return `Последние новости и события${cityPart} ${timePart}. Дай подробную сводку: основные события, происшествия, погода, важные решения. Минимум 5 пунктов.`;
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
  
  // Не добавляем "актуальная информация" к коротким запросам —
  // это превращало "ты как" в поиск новостей
  return query;
}

// Паттерны ответов AI когда он не знает или симулирует поиск
const UNCERTAINTY_PATTERNS = [
  /не знаю|не уверен|не могу сказать точно/i,
  /у меня нет.*информации/i,
  /мои данные.*устарели|данные.*ограничены/i,
  /не имею доступа.*интернет/i,
  /рекомендую.*проверить|уточни.*источник/i,
  /на момент моего обучения|по состоянию на/i,
  /i don't know|i'm not sure|cannot say for certain/i,
  // Симуляция поиска — LLM притворяется что ищет (частая проблема бесплатных моделей)
  /ищу\.\.\.|поиск в интернете|сейчас найду|сейчас поищу/i,
  /\*\(поиск/i,
  /🔍\s*ищу/i,
  // Отказ от поиска — LLM говорит "не могу искать"
  /не могу выполнить поиск/i,
  /не могу искать/i,
  /нет доступа к.*интернет/i,
  /не умею искать/i,
  /у меня нет.*доступа.*новым данным/i,
  /не могу.*получить.*актуальн/i,
];

/**
 * Определяет, нужен ли веб-поиск для данного сообщения (расширенная детекция)
 */
export function needsWebSearch(message: string): boolean {
  // Игнорируем очень короткие сообщения (приветствия, "ок", "да/нет")
  if (message.length < 5) return false;
  
  // Игнорируем чисто эмоциональные / бытовые сообщения
  if (/^(привет|здравствуй|ок|да|нет|спасибо|хорошо|ладно|пока|ты как|как дела)\s*[.!?]*$/i.test(message.trim())) {
    return false;
  }
  
  return REALTIME_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Определяет, ОБЯЗАТЕЛЕН ли поиск (LLM не может ответить без интернета)
 */
export function shouldForceWebSearch(message: string): boolean {
  return FORCE_SEARCH_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Определяет, показывает ли ответ AI что он не знает ответ
 */
export function aiShowsUncertainty(response: string): boolean {
  return UNCERTAINTY_PATTERNS.some(pattern => pattern.test(response));
}

/**
 * Выполняет веб-поиск через Perplexity API
 * Использует настраиваемые токены из админки + модель
 */
export async function webSearch(
  query: string,
  options: {
    maxTokens?: number;
    forDigest?: boolean;
  } = {}
): Promise<WebSearchResult> {
  const apiKey = await getPerplexityApiKey();
  
  if (!apiKey) {
    throw Object.assign(
      new Error('Perplexity API key not configured'),
      { code: 'PERPLEXITY_NOT_CONFIGURED' }
    );
  }

  // Для новостных/сводочных запросов нужно больше токенов
  const isNewsQuery = /новост|сводк|событи|дайджест/i.test(query);

  // Определяем токены: опции > настройки из админки > дефолт
  let maxTokens: number;
  if (options.maxTokens) {
    maxTokens = options.maxTokens;
  } else if (options.forDigest) {
    maxTokens = DEFAULT_DIGEST_MAX_TOKENS;
  } else {
    const configuredTokens = await getSearchMaxTokens();
    maxTokens = isNewsQuery
      ? Math.max(configuredTokens, DEFAULT_NEWS_MAX_TOKENS) // Для новостей минимум 2000
      : configuredTokens;
  }
  
  const selectedModel = await getSelectedModel();
  const modelInfo = getModelInfo(selectedModel);
  const enhancedQuery = enhanceSearchQuery(query);
  
  // Системный промпт — для дайджеста строго по Беларуси, для обычных — общий
  const isBelarusQuery = /беларус|минск|гродно|брест|витебск|могилёв|гомель|belta|ont\.by|tvr\.by/i.test(query);
  const systemPrompt = isNewsQuery
    ? (isBelarusQuery
      ? `Ты — белорусский новостной ассистент. Ищи ТОЛЬКО новости Республики Беларусь.

ПРАВИЛА:
1. Ищи КОНКРЕТНЫЕ белорусские события с датами и подробностями
2. Каждая новость — отдельный пункт с развёрнутым описанием (2-4 предложения)
3. Указывай дату и источник (belta.by, ont.by, sb.by, и др.)
4. Минимум 5-7 пунктов БЕЛОРУССКИХ новостей
5. Если запрос про город — ищи МЕСТНЫЕ городские + областные новости
6. ЗАПРЕЩЕНО включать новости России, Украины, США, ЕС, мира — ТОЛЬКО Беларусь!
7. Если не можешь найти белорусские новости — так и скажи, НЕ подменяй мировыми
8. Формат: нумерованный список с подробностями. Язык: русский.
9. Давай МАКСИМАЛЬНО подробные и развёрнутые ответы о жизни ВНУТРИ Беларуси.`
      : `Ты — новостной ассистент. Найди РЕАЛЬНЫЕ АКТУАЛЬНЫЕ новости и события.

ПРАВИЛА:
1. Ищи КОНКРЕТНЫЕ события с датами — НЕ общие описания
2. Каждая новость — отдельный пункт с подробным описанием
3. Указывай дату и источник каждого события
4. Минимум 5-7 пунктов реальных новостей
5. Если про город — местные + региональные новости
6. Формат: нумерованный список с подробностями. Язык: русский.
7. Давай МАКСИМАЛЬНО подробные и развёрнутые ответы.`)
    : `Ты — поисковый ассистент с доступом в интернет. Найди АКТУАЛЬНУЮ информацию.

ПРАВИЛА:
1. Цены/курсы — ТОЧНАЯ ЦИФРА + дата + источник
2. Погода — ТЕКУЩИЕ данные: температура, осадки, ветер, влажность, ощущается как
3. Новости — СЕГОДНЯШНИЕ события с подробностями
4. Факты — проверенные данные с источниками
5. НЕ давай определения из Wikipedia когда спрашивают актуальное
6. Отвечай ПОДРОБНО и РАЗВЁРНУТО с фактами
7. Если спрашивают цену — дай цену, а не описание
8. Формат: структурированный, с фактами. Язык: русский.`;

  telegramLogger.info(
    { originalQuery: query.substring(0, 80), enhancedQuery: enhancedQuery.substring(0, 100), model: selectedModel, maxTokens }, 
    'Performing web search via Perplexity API'
  );

  // Таймаут: 35 сек для дайджеста (больше данных), 25 сек для обычных запросов
  const controller = new AbortController();
  const timeoutMs = options.forDigest ? 35000 : 25000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: enhancedQuery },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unable to read error body');
      telegramLogger.error(
        { status: response.status, error: errorText.substring(0, 500), model: selectedModel, query: query.substring(0, 50) }, 
        'Perplexity API error'
      );
      
      if (response.status === 401) {
        throw Object.assign(new Error(`Invalid Perplexity API key: ${errorText.substring(0, 100)}`), { code: 'PERPLEXITY_AUTH_ERROR' });
      }
      if (response.status === 429) {
        throw Object.assign(new Error(`Perplexity rate limit: ${errorText.substring(0, 100)}`), { code: 'PERPLEXITY_RATE_LIMIT' });
      }
      if (response.status === 402) {
        throw Object.assign(new Error(`Perplexity payment required: ${errorText.substring(0, 100)}`), { code: 'PERPLEXITY_PAYMENT_REQUIRED' });
      }
      
      throw Object.assign(new Error(`Perplexity HTTP ${response.status}: ${errorText.substring(0, 200)}`), { code: 'PERPLEXITY_ERROR' });
    }

    const data = await response.json() as PerplexityResponse;
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const tokenCost = modelInfo 
      ? (usage.prompt_tokens * modelInfo.inputPrice / 1_000_000) + 
        (usage.completion_tokens * modelInfo.outputPrice / 1_000_000)
      : 0;
    const requestCost = modelInfo ? modelInfo.requestFee / 1000 : 0;
    const totalCost = tokenCost + requestCost;

    telegramLogger.info({ 
      tokens: usage.total_tokens, 
      model: selectedModel,
      maxTokensUsed: maxTokens,
      answerLength: content.length,
      citations: citations.length,
      totalCostUSD: totalCost.toFixed(6),
    }, 'Web search completed successfully');

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
    if (error instanceof Error && error.name === 'AbortError') {
      telegramLogger.warn({ query, timeout: 25000 }, 'Web search timeout');
      throw Object.assign(new Error('Web search timeout'), { code: 'PERPLEXITY_TIMEOUT' });
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = String((error as { code: unknown }).code);
      if (code.startsWith('PERPLEXITY_')) throw error;
    }
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
  
  // Инлайн citations: [1] → кликабельная Markdown-ссылка
  if (result.citations.length > 0) {
    formattedResponse = formattedResponse.replace(/\[(\d+)\]/g, (match, numStr: string) => {
      const index = parseInt(numStr, 10) - 1;
      if (index >= 0 && index < result.citations.length) {
        return `[${numStr}](${result.citations[index]!})`;
      }
      return match;
    });
    // Убираем дублирующий раздел "📚 Источники:" если Perplexity добавил
    formattedResponse = formattedResponse.replace(/\n*📚\s*Источники:[\s\S]*$/, '');
  }
  
  return formattedResponse;
}

/**
 * Получает контекст из интернета для основной LLM (прозрачно для пользователя)
 * АГРЕССИВНАЯ стратегия: ищет при любых вопросах требующих актуальных данных
 */
export async function getSearchContext(query: string): Promise<string> {
  const enabled = await isWebSearchEnabled();
  if (!enabled) return '';
  
  // Проверяем по расширенным паттернам
  if (!needsWebSearch(query)) return '';
  
  try {
    const result = await webSearch(query);
    
    // Карта ссылок для LLM
    const citationsMap = result.citations.length > 0
      ? `\n\nКАРТА ИСТОЧНИКОВ:\n${result.citations.map((url, i) => `[${i + 1}] ${url}`).join('\n')}`
      : '';

    return `\n\n=== ДАННЫЕ ИЗ ИНТЕРНЕТА (${new Date().toLocaleDateString('ru-RU')}) ===
${result.answer}${citationsMap}
=== КОНЕЦ ДАННЫХ ===

ИНСТРУКЦИЯ ПО ДАННЫМ ИЗ ИНТЕРНЕТА:
- Данные УЖЕ найдены — используй их НАПРЯМУЮ в ответе
- ЗАПРЕЩЕНО: "Ищу...", "Поиск...", "Сейчас найду" — поиск ЗАВЕРШЁН
- Сохраняй ссылки [N] на источники — они будут автоматически превращены в кликабельные
- Цифры (цены, курсы, температура) — приводи ТОЧНО из данных
- Перескажи живо, эмоционально, своими словами
- Если данные содержат числа — обязательно включи их в ответ`;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errCode = (error as { code?: string }).code ?? 'UNKNOWN';
    telegramLogger.warn({ error: errMsg, code: errCode, query: query.substring(0, 50) }, 'Search context failed');
    return '';
  }
}

/**
 * Дополняет ответ AI если он показывает неуверенность.
 * Более агрессивная стратегия: ищет и когда AI не уверен, и когда
 * запрос явно требует актуальных данных но AI их не предоставил.
 */
export async function enhanceResponseIfNeeded(
  originalQuery: string,
  aiResponse: string
): Promise<{ response: string; wasEnhanced: boolean }> {
  const enabled = await isWebSearchEnabled();
  if (!enabled) return { response: aiResponse, wasEnhanced: false };
  
  // Не запускаем для бытовых / эмоциональных сообщений
  if (!needsWebSearch(originalQuery)) {
    return { response: aiResponse, wasEnhanced: false };
  }
  
  // Ищем если AI неуверен ИЛИ ответ подозрительно короткий для информационного запроса
  const isUncertain = aiShowsUncertainty(aiResponse);
  const isTooShort = aiResponse.length < 100 && shouldForceWebSearch(originalQuery);
  
  if (!isUncertain && !isTooShort) {
    return { response: aiResponse, wasEnhanced: false };
  }
  
  telegramLogger.info(
    { query: originalQuery, reason: isUncertain ? 'uncertainty' : 'too_short' }, 
    'Enhancing response with web search'
  );
  
  try {
    const searchResult = await webSearch(originalQuery);
    
    if (searchResult.answer && searchResult.answer.length > 50) {
      let enhanced = searchResult.answer;
      if (searchResult.citations.length > 0) {
        enhanced += '\n\n📚 Источники:\n';
        searchResult.citations.slice(0, 3).forEach((c, i) => {
          enhanced += `${i + 1}. ${c.length > 60 ? c.substring(0, 57) + '...' : c}\n`;
        });
      }
      return { response: enhanced, wasEnhanced: true };
    }
  } catch (error) {
    telegramLogger.debug({ error }, 'Enhancement search failed');
  }
  
  return { response: aiResponse, wasEnhanced: false };
}

/**
 * Проверяет, включён ли веб-поиск.
 * 
 * Логика:
 * 1. Если в БД явно задано web_search_enabled = 'false' → выключен
 * 2. Если в БД явно задано web_search_enabled = 'true' → включён
 * 3. Если настройка НЕ задана → авто-определение: включён если Perplexity API ключ существует
 *    (раньше по умолчанию был выключен, что приводило к тому что поиск не работал
 *     даже при настроенном ключе — LLM симулировала поиск вместо реального)
 */
export async function isWebSearchEnabled(): Promise<boolean> {
  try {
    const enabled = await settingsRepo.get('web_search_enabled');
    
    // Явно выключен в настройках
    if (enabled === 'false') return false;
    
    // Явно включён в настройках
    if (enabled === 'true') return true;
    
    // Настройка не задана → авто-определение по наличию API ключа
    const apiKey = await getPerplexityApiKey();
    return !!apiKey;
  } catch (error) {
    telegramLogger.warn({ error }, 'Failed to check web_search_enabled, defaulting to false');
    return false;
  }
}

/**
 * Очистить кэш API ключа, модели и токенов
 */
export function clearPerplexityCache(): void {
  perplexityKeyCache.clear();
  perplexityModelCache.clear();
  searchMaxTokensCache.clear();
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
