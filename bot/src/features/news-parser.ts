/**
 * News Parser — парсинг заголовков новостей с настроенных сайтов
 *
 * Поддерживаемые типы источников:
 * - RSS/Atom фиды (автообнаружение, стандартные пути, прямые URL)
 * - JSON API (HackerNews Algolia, Dev.to, Qiita и др.)
 * - HTML scraping (GitHub Trending, CSDN, TLDR и др.)
 *
 * Категории: ai_tech, city_local, community, asia_tech
 * Языки: ru, en, zh, ja, ko
 */

import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { settingsRepo } from '../db/supabase.js';
import { appLogger } from '../config/logger.js';
import type {
  NewsSite,
  ParsedHeadline,
  NewsSourceCategory,
  NewsSourceLanguage,
  JsonFieldMapping,
} from '../../../shared/types/index.js';

// Re-export shared types
export type { NewsSite, ParsedHeadline } from '../../../shared/types/index.js';

// ===== Константы =====

const SETTINGS_KEY = 'digest_news_sites';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HEADLINES_PER_SITE = 15;
const MIN_TITLE_LENGTH = 10;
const MAX_TITLE_LENGTH = 300;
const MAX_NEWS_AGE_HOURS = 48;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RSS_PATHS = ['/feed', '/rss', '/rss.xml', '/feed/rss', '/atom.xml', '/feed/atom', '/index.xml', '/rss/all', '/rss/new'];

const ARTICLE_URL_PATTERNS = [
  /\/\d{4}\/\d{2}\//,
  /\/\d{4}\/\d{2}\/\d{2}\//,
  /\/news\/\w+\//,
  /\/incidents\//,
  /\/society\//,
  /\/auto\//,
  /\/sport\//,
  /\/kultura\//,
  /\/ekonomika\//,
  /\.html$/,
  /\/\w+\/\d{5,}-/,
  /\/\w+\/\d{5,}$/,
];

const DIRECT_FEED_PATTERNS = [
  /\/rss\/?$/i,
  /\/rss\/\w+\/?$/i,
  /\/feed\/?$/i,
  /\/feed\/\w+\/?$/i,
  /\/atom\.xml$/i,
  /\/rss\.xml$/i,
  /\/index\.xml$/i,
  /\/feed\.xml$/i,
];

const SKIP_LINK_PATTERNS = [
  /читать далее/i,
  /подробнее/i,
  /все новости/i,
  /загрузить ещ[её]/i,
  /показать ещ[её]/i,
  /^все$/i,
  /^ещ[её]$/i,
  /^назад$/i,
  /^далее$/i,
  /^next$/i,
  /^prev$/i,
  /^главная$/i,
  /^home$/i,
];

// ===== Пресетные AI/Tech источники =====

export const DEFAULT_AI_TECH_SOURCES: NewsSite[] = [
  // --- AI Labs & Research ---
  {
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'arXiv cs.AI',
    url: 'https://rss.arxiv.org/rss/cs.AI',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
    filterKeywords: ['LLM', 'language model', 'code generation', 'agent', 'transformer', 'GPT', 'diffusion', 'multimodal', 'RAG', 'fine-tuning', 'RLHF', 'benchmark'],
  },
  // --- Developer Communities ---
  {
    name: 'Hacker News (VibeCoding)',
    url: 'https://hn.algolia.com/api/v1/search_by_date?query=vibecoding+OR+%22vibe+coding%22+OR+%22AI+coding%22+OR+cursor+OR+copilot&tags=story',
    enabled: true,
    type: 'json_api',
    category: 'community',
    language: 'en',
    jsonMapping: {
      itemsPath: 'hits',
      titleField: 'title',
      urlField: 'url|story_url',
      dateField: 'created_at',
    },
  },
  {
    name: 'Dev.to (AI)',
    url: 'https://dev.to/api/articles?tag=ai&top=7',
    enabled: true,
    type: 'json_api',
    category: 'community',
    language: 'en',
    jsonMapping: {
      itemsPath: '',
      titleField: 'title',
      urlField: 'url',
      dateField: 'published_at',
    },
  },
  {
    name: 'Reddit r/LocalLLaMA',
    url: 'https://www.reddit.com/r/LocalLLaMA/new/.rss',
    enabled: true,
    type: 'rss',
    category: 'community',
    language: 'en',
  },
  {
    name: 'GitHub Trending',
    url: 'https://github.com/trending',
    enabled: true,
    type: 'html_scrape',
    category: 'ai_tech',
    language: 'en',
  },
  // --- Tech Blogs ---
  {
    name: 'Simon Willison',
    url: 'https://simonwillison.net/atom/entries/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'MarkTechPost',
    url: 'https://www.marktechpost.com/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'TLDR AI',
    url: 'https://tldr.tech/ai/archives',
    enabled: true,
    type: 'html_scrape',
    category: 'ai_tech',
    language: 'en',
  },
  // --- China (через RSSHub) ---
  {
    name: '机器之心 (Synced)',
    url: 'https://rsshub.app/wechat/mp/jiqizhixin',
    enabled: true,
    type: 'rss',
    category: 'asia_tech',
    language: 'zh',
    filterKeywords: ['AI', '大模型', '编程', '代码', 'LLM', 'GPT', '智能', '算法', 'Copilot', 'Agent', '开源'],
  },
  {
    name: '量子位 (QbitAI)',
    url: 'https://rsshub.app/wechat/mp/QbitAI',
    enabled: true,
    type: 'rss',
    category: 'asia_tech',
    language: 'zh',
    filterKeywords: ['AI', '大模型', '编程', '代码', 'LLM', 'GPT', '智能', 'DeepSeek', 'Qwen'],
  },
  {
    name: '新智元 (AI Era)',
    url: 'https://rsshub.app/wechat/mp/aiera',
    enabled: true,
    type: 'rss',
    category: 'asia_tech',
    language: 'zh',
  },
  // --- Japan ---
  {
    name: 'Zenn.dev (AI)',
    url: 'https://zenn.dev/topics/ai/feed',
    enabled: true,
    type: 'rss',
    category: 'asia_tech',
    language: 'ja',
  },
  {
    name: 'Qiita (AI)',
    url: 'https://qiita.com/api/v2/items?query=title:AI+OR+title:LLM+OR+title:ChatGPT&per_page=15',
    enabled: true,
    type: 'json_api',
    category: 'asia_tech',
    language: 'ja',
    jsonMapping: {
      itemsPath: '',
      titleField: 'title',
      urlField: 'url',
      dateField: 'created_at',
    },
  },
  // --- International Aggregators ---
  {
    name: 'Tech in Asia',
    url: 'https://www.techinasia.com/feed',
    enabled: true,
    type: 'rss',
    category: 'asia_tech',
    language: 'en',
  },
  {
    name: 'InfoQ China',
    url: 'https://www.infoq.cn/feed',
    enabled: true,
    type: 'rss',
    category: 'asia_tech',
    language: 'zh',
    filterKeywords: ['AI', '大模型', '编程', '代码', 'LLM', 'Copilot', '智能'],
  },
];

// ===== Получение/сохранение сайтов =====

export async function getConfiguredSites(): Promise<NewsSite[]> {
  try {
    const raw = await settingsRepo.get(SETTINGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is NewsSite =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as NewsSite).name === 'string' &&
        typeof (s as NewsSite).url === 'string' &&
        typeof (s as NewsSite).enabled === 'boolean',
    );
  } catch (err) {
    appLogger.warn({ error: err }, 'Failed to parse digest_news_sites setting');
    return [];
  }
}

export async function saveConfiguredSites(sites: NewsSite[]): Promise<void> {
  await settingsRepo.set(SETTINGS_KEY, JSON.stringify(sites));
}

// ===== Утилиты =====

function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      return null;
    }
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]/g, ' ')
    .trim();
}

function isArticleUrl(url: string, siteOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    const originHost = new URL(siteOrigin).hostname.replace(/^www\./, '');
    if (!parsed.hostname.endsWith(originHost)) return false;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    return ARTICLE_URL_PATTERNS.some(p => p.test(parsed.pathname));
  } catch {
    return false;
  }
}

function isSkipText(text: string): boolean {
  return SKIP_LINK_PATTERNS.some(p => p.test(text));
}

function parsePubDate(dateStr: string): Date | undefined {
  if (!dateStr?.trim()) return undefined;
  try {
    const date = new Date(dateStr.trim());
    if (isNaN(date.getTime())) return undefined;
    return date;
  } catch {
    return undefined;
  }
}

function isNewsRecent(pubDate: Date | undefined): boolean {
  if (!pubDate) return true;
  const ageMs = Date.now() - pubDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  return ageHours <= MAX_NEWS_AGE_HOURS;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-zа-яёїіє\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Проверить соответствие заголовка ключевым словам (case-insensitive)
 */
function matchesKeywords(title: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true;
  const titleLower = title.toLowerCase();
  return keywords.some(kw => titleLower.includes(kw.toLowerCase()));
}

function addHeadline(
  headlines: ParsedHeadline[],
  seenTitles: Set<string>,
  title: string,
  url: string,
  options?: {
    pubDate?: Date;
    category?: NewsSourceCategory;
    language?: NewsSourceLanguage;
    filterKeywords?: string[];
  },
): boolean {
  if (headlines.length >= MAX_HEADLINES_PER_SITE) return false;
  if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return false;
  if (isSkipText(title)) return false;
  if (!isNewsRecent(options?.pubDate)) return false;
  if (!matchesKeywords(title, options?.filterKeywords)) return false;

  const titleNormalized = normalizeTitle(title);
  if (seenTitles.has(titleNormalized)) return false;

  seenTitles.add(titleNormalized);
  headlines.push({
    title,
    url,
    source: '',
    pubDate: options?.pubDate?.toISOString(),
    category: options?.category,
    language: options?.language,
  });
  return true;
}

// ===== Fetch с таймаутом =====

async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== JSON API Parser =====

/**
 * Извлечь значение по вложенному пути: "hits.items" → obj.hits.items
 */
function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Извлечь URL из объекта с поддержкой fallback (pipe-separated): "url|story_url"
 */
function extractUrl(item: Record<string, unknown>, urlField: string): string | null {
  const fields = urlField.split('|');
  for (const field of fields) {
    const value = item[field.trim()];
    if (typeof value === 'string' && value.startsWith('http')) return value;
  }
  return null;
}

/**
 * Парсинг JSON API ответа
 */
function parseJsonApiResponse(
  data: unknown,
  mapping: JsonFieldMapping,
  baseUrl: string,
  options?: { category?: NewsSourceCategory; language?: NewsSourceLanguage; filterKeywords?: string[] },
): ParsedHeadline[] {
  const items = getNestedValue(data, mapping.itemsPath);
  if (!Array.isArray(items)) {
    appLogger.warn({ baseUrl, itemsPath: mapping.itemsPath }, 'JSON API: items not found at path');
    return [];
  }

  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();

  for (const item of items) {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
    if (!item || typeof item !== 'object') continue;

    const record = item as Record<string, unknown>;
    const title = cleanTitle(String(record[mapping.titleField] ?? ''));
    const url = extractUrl(record, mapping.urlField);
    const pubDate = mapping.dateField ? parsePubDate(String(record[mapping.dateField] ?? '')) : undefined;

    if (!url) continue;

    addHeadline(headlines, seenTitles, title, url, {
      pubDate,
      category: options?.category,
      language: options?.language,
      filterKeywords: options?.filterKeywords,
    });
  }

  return headlines;
}

async function parseJsonApi(site: NewsSite): Promise<ParsedHeadline[]> {
  if (!site.jsonMapping) {
    appLogger.warn({ url: site.url }, 'JSON API site missing jsonMapping config');
    return [];
  }

  const response = await fetchWithTimeout(site.url, 12_000);
  if (!response.ok) {
    throw new Error(`JSON API HTTP ${response.status}: ${site.url}`);
  }

  const data: unknown = await response.json();
  const headlines = parseJsonApiResponse(data, site.jsonMapping, site.url, {
    category: site.category,
    language: site.language,
    filterKeywords: site.filterKeywords,
  });

  appLogger.info({ url: site.url, count: headlines.length }, 'JSON API parsed');
  return headlines;
}

// ===== GitHub Trending Parser =====

function parseGitHubTrending(html: string): ParsedHeadline[] {
  const $ = load(html);
  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();

  $('article.Box-row').each((_i: number, el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;

    const $el = $(el);
    const repoLink = $el.find('h2 a').first();
    const href = repoLink.attr('href');
    const repoName = cleanTitle(repoLink.text()).replace(/\s+/g, '');
    const description = cleanTitle($el.find('p').first().text());

    if (!href || !repoName) return;

    const url = `https://github.com${href}`;
    const title = description
      ? `${repoName}: ${description}`
      : repoName;

    addHeadline(headlines, seenTitles, title, url, {
      category: 'ai_tech',
      language: 'en',
    });
  });

  appLogger.info({ count: headlines.length }, 'GitHub Trending parsed');
  return headlines;
}

// ===== TLDR AI Archives Parser =====

function parseTldrArchives(html: string, baseUrl: string): ParsedHeadline[] {
  const $ = load(html);
  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();

  $('a[href*="/ai/"]').each((_i: number, el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
    const $el = $(el);
    const title = cleanTitle($el.text());
    const href = $el.attr('href') ?? '';
    const url = normalizeUrl(href, baseUrl);

    if (!url) return;

    addHeadline(headlines, seenTitles, title, url, {
      category: 'ai_tech',
      language: 'en',
    });
  });

  appLogger.info({ count: headlines.length }, 'TLDR AI Archives parsed');
  return headlines;
}

// ===== RSS/Atom парсинг =====

function parseRssFeed(
  xml: string,
  baseUrl: string,
  options?: { category?: NewsSourceCategory; language?: NewsSourceLanguage; filterKeywords?: string[] },
): ParsedHeadline[] {
  const $ = load(xml, { xml: true });
  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();

  // RSS 2.0
  $('item').each((_i: number, el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
    const $item = $(el);
    const title = cleanTitle($item.find('title').first().text());
    let link = $item.find('link').first().text().trim();
    if (!link) link = $item.find('link').first().attr('href') ?? '';

    const pubDateStr = $item.find('pubDate').first().text()
      || $item.find('dc\\:date').first().text()
      || $item.find('date').first().text();
    const pubDate = parsePubDate(pubDateStr);

    const url = normalizeUrl(link, baseUrl);
    if (url) addHeadline(headlines, seenTitles, title, url, { pubDate, ...options });
  });

  // Atom
  if (headlines.length === 0) {
    $('entry').each((_i: number, el: AnyNode) => {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
      const $entry = $(el);
      const title = cleanTitle($entry.find('title').first().text());
      const link = $entry.find('link[href]').first().attr('href') ?? '';
      const pubDateStr = $entry.find('published').first().text()
        || $entry.find('updated').first().text();
      const pubDate = parsePubDate(pubDateStr);

      const url = normalizeUrl(link, baseUrl);
      if (url) addHeadline(headlines, seenTitles, title, url, { pubDate, ...options });
    });
  }

  return headlines;
}

async function tryRssFeed(
  siteUrl: string,
  options?: { category?: NewsSourceCategory; language?: NewsSourceLanguage; filterKeywords?: string[] },
): Promise<ParsedHeadline[] | null> {
  const origin = new URL(siteUrl).origin;

  for (const path of RSS_PATHS) {
    try {
      const feedUrl = origin + path;
      const response = await fetchWithTimeout(feedUrl, 5000);
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();

      if (
        contentType.includes('xml') ||
        contentType.includes('rss') ||
        contentType.includes('atom') ||
        text.trimStart().startsWith('<?xml') ||
        text.includes('<rss') ||
        text.includes('<feed')
      ) {
        const headlines = parseRssFeed(text, origin, options);
        if (headlines.length > 0) {
          appLogger.info({ feedUrl, count: headlines.length }, 'RSS feed parsed');
          return headlines;
        }
      }
    } catch {
      // пробуем следующий путь
    }
  }

  return null;
}

function isDirectFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return DIRECT_FEED_PATTERNS.some(p => p.test(parsed.pathname));
  } catch {
    return false;
  }
}

async function tryDirectFeed(
  feedUrl: string,
  options?: { category?: NewsSourceCategory; language?: NewsSourceLanguage; filterKeywords?: string[] },
): Promise<ParsedHeadline[] | null> {
  try {
    const response = await fetchWithTimeout(feedUrl, 8000);
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (
      contentType.includes('xml') ||
      contentType.includes('rss') ||
      contentType.includes('atom') ||
      contentType.includes('text/plain') ||
      text.trimStart().startsWith('<?xml') ||
      text.includes('<rss') ||
      text.includes('<feed')
    ) {
      const headlines = parseRssFeed(text, feedUrl, options);
      if (headlines.length > 0) {
        appLogger.info({ feedUrl, count: headlines.length }, 'Direct RSS feed parsed');
        return headlines;
      }
    }

    // JSON Feed fallback
    if (contentType.includes('json') || text.trimStart().startsWith('{')) {
      try {
        const json = JSON.parse(text) as { items?: Array<{ title?: string; url?: string; external_url?: string }> };
        if (json.items && Array.isArray(json.items)) {
          const headlines: ParsedHeadline[] = [];
          const seenTitles = new Set<string>();
          for (const item of json.items) {
            if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
            const title = cleanTitle(item.title ?? '');
            const url = item.url ?? item.external_url ?? '';
            if (url) addHeadline(headlines, seenTitles, title, url, options);
          }
          if (headlines.length > 0) {
            appLogger.info({ feedUrl, count: headlines.length }, 'JSON Feed parsed');
            return headlines;
          }
        }
      } catch {
        // не JSON
      }
    }
  } catch (err) {
    appLogger.debug({ error: err, feedUrl }, 'Direct feed fetch failed');
  }
  return null;
}

// ===== HTML парсинг =====

function parseHtmlContent(
  html: string,
  siteUrl: string,
  origin: string,
  options?: { category?: NewsSourceCategory; language?: NewsSourceLanguage; filterKeywords?: string[] },
): ParsedHeadline[] {
  // Специальные парсеры
  if (siteUrl.includes('github.com/trending')) {
    return parseGitHubTrending(html);
  }
  if (siteUrl.includes('tldr.tech')) {
    return parseTldrArchives(html, origin);
  }

  const $ = load(html);
  $('nav, footer, script, style, noscript, iframe, .ad, .ads, .advertisement, .banner, .sidebar, .widget, .menu, .navigation, header').remove();

  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();

  // Стратегия A: ссылки внутри h1-h3
  $('h1 a, h2 a, h3 a').each((_i: number, _el: AnyNode) => {
    const $el = $(_el);
    const title = cleanTitle($el.text());
    const href = $el.attr('href');
    const url = normalizeUrl(href ?? '', origin);
    if (url && !seenUrls.has(url)) {
      if (addHeadline(headlines, seenTitles, title, url, options)) {
        seenUrls.add(url);
      }
    }
  });

  // Стратегия B: ссылки, оборачивающие h1-h3
  $('a h1, a h2, a h3').each((_i: number, _el: AnyNode) => {
    const $heading = $(_el);
    const $link = $heading.closest('a');
    const title = cleanTitle($heading.text());
    const href = $link.attr('href');
    const url = normalizeUrl(href ?? '', origin);
    if (url && !seenUrls.has(url)) {
      if (addHeadline(headlines, seenTitles, title, url, options)) {
        seenUrls.add(url);
      }
    }
  });

  // Стратегия C: standalone h2/h3 без ссылки → ищем ближайшую
  $('h2, h3').each((_i: number, _el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
    const $heading = $(_el);
    const title = cleanTitle($heading.text());

    if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
    if (isSkipText(title)) return;
    if (seenTitles.has(normalizeTitle(title))) return;

    const innerLink = $heading.find('a').attr('href');
    if (innerLink) return;

    const parentLink = $heading.closest('a').attr('href');
    if (parentLink) {
      const url = normalizeUrl(parentLink, origin);
      if (url && !seenUrls.has(url)) {
        if (addHeadline(headlines, seenTitles, title, url, options)) seenUrls.add(url);
      }
      return;
    }

    const $parent = $heading.parent();
    const siblingLink = $parent.find('a').filter((_: number, a: AnyNode) => {
      const href = $(a).attr('href');
      if (!href) return false;
      const resolved = normalizeUrl(href, origin);
      return resolved !== null && !seenUrls.has(resolved);
    }).first().attr('href');

    if (siblingLink) {
      const url = normalizeUrl(siblingLink, origin);
      if (url && !seenUrls.has(url)) {
        if (addHeadline(headlines, seenTitles, title, url, options)) seenUrls.add(url);
      }
      return;
    }

    const $grandParent = $parent.parent();
    const gpLink = $grandParent.find('a').filter((_: number, a: AnyNode) => {
      const href = $(a).attr('href');
      if (!href) return false;
      const resolved = normalizeUrl(href, origin);
      return resolved !== null && isArticleUrl(resolved, origin) && !seenUrls.has(resolved);
    }).first().attr('href');

    if (gpLink) {
      const url = normalizeUrl(gpLink, origin);
      if (url && !seenUrls.has(url)) {
        if (addHeadline(headlines, seenTitles, title, url, options)) seenUrls.add(url);
      }
    }
  });

  // Стратегия D: все ссылки с «статейным» URL и длинным текстом
  if (headlines.length < 5) {
    $('a[href]').each((_i: number, _el: AnyNode) => {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
      const $el = $(_el);
      const title = cleanTitle($el.text());
      const href = $el.attr('href') ?? '';

      if (!title || title.length < 25 || title.length > MAX_TITLE_LENGTH) return;
      if (isSkipText(title)) return;

      const url = normalizeUrl(href, origin);
      if (!url || seenUrls.has(url)) return;
      if (!isArticleUrl(url, origin)) return;

      if (addHeadline(headlines, seenTitles, title, url, options)) seenUrls.add(url);
    });
  }

  appLogger.info({ siteUrl, headlinesFound: headlines.length }, 'News site parsed (HTML)');
  return headlines.slice(0, MAX_HEADLINES_PER_SITE);
}

// ===== Главный парсер одного сайта =====

export async function parseNewsFromSite(site: NewsSite): Promise<ParsedHeadline[]>;
export async function parseNewsFromSite(siteUrl: string): Promise<ParsedHeadline[]>;
export async function parseNewsFromSite(siteOrUrl: NewsSite | string): Promise<ParsedHeadline[]> {
  const site: NewsSite = typeof siteOrUrl === 'string'
    ? { name: '', url: siteOrUrl, enabled: true }
    : siteOrUrl;

  const siteUrl = site.url;
  const parseOptions = {
    category: site.category,
    language: site.language,
    filterKeywords: site.filterKeywords,
  };

  // JSON API — специальный путь
  if (site.type === 'json_api') {
    return parseJsonApi(site);
  }

  // HTML scrape — специальный путь
  if (site.type === 'html_scrape') {
    const response = await fetchWithTimeout(siteUrl, 12_000);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const html = await response.text();
    const origin = new URL(siteUrl).origin;
    return parseHtmlContent(html, siteUrl, origin, parseOptions);
  }

  // RSS (по умолчанию) — оригинальная каскадная логика
  const origin = new URL(siteUrl).origin;

  // Шаг 0: прямой RSS URL
  if (isDirectFeedUrl(siteUrl)) {
    const directHeadlines = await tryDirectFeed(siteUrl, parseOptions);
    if (directHeadlines && directHeadlines.length > 0) return directHeadlines;
    appLogger.warn({ siteUrl }, 'Direct RSS feed URL returned no headlines');
  }

  // Шаг 1: загрузить URL
  let pageBody: string | null = null;
  let pageIsRss = false;

  if (!isDirectFeedUrl(siteUrl)) {
    try {
      const directResponse = await fetchWithTimeout(siteUrl, 8000);
      if (directResponse.ok) {
        const contentType = directResponse.headers.get('content-type') ?? '';
        pageBody = await directResponse.text();
        pageIsRss = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom') ||
          pageBody.trimStart().startsWith('<?xml') || pageBody.trimStart().startsWith('<rss') || pageBody.trimStart().startsWith('<feed');

        if (pageIsRss) {
          const headlines = parseRssFeed(pageBody, origin, parseOptions);
          if (headlines.length > 0) {
            appLogger.info({ siteUrl, count: headlines.length }, 'Direct RSS parsed from URL');
            return headlines;
          }
        }
      }
    } catch (err) {
      appLogger.debug({ error: err, siteUrl }, 'Direct URL fetch failed');
    }
  }

  // Шаг 2: RSS autodiscovery
  if (pageBody && !pageIsRss) {
    try {
      const $meta = load(pageBody);
      const rssLink = $meta('link[type="application/rss+xml"]').attr('href')
        ?? $meta('link[type="application/atom+xml"]').attr('href');
      if (rssLink) {
        const feedUrl = normalizeUrl(rssLink, origin);
        if (feedUrl) {
          const rssResponse = await fetchWithTimeout(feedUrl, 5000);
          if (rssResponse.ok) {
            const feedXml = await rssResponse.text();
            const rssHeadlines = parseRssFeed(feedXml, origin, parseOptions);
            if (rssHeadlines.length > 0) {
              appLogger.info({ feedUrl, count: rssHeadlines.length }, 'RSS autodiscovery parsed');
              return rssHeadlines;
            }
          }
        }
      }
    } catch { /* продолжаем */ }
  }

  // Шаг 3: стандартные RSS пути
  try {
    const rssHeadlines = await tryRssFeed(siteUrl, parseOptions);
    if (rssHeadlines && rssHeadlines.length > 0) return rssHeadlines;
  } catch (err) {
    appLogger.debug({ error: err, siteUrl }, 'RSS feed attempt failed');
  }

  // Шаг 4: HTML парсинг (fallback)
  if (pageBody && !pageIsRss) {
    const htmlHeadlines = parseHtmlContent(pageBody, siteUrl, origin, parseOptions);
    if (htmlHeadlines.length > 0) return htmlHeadlines;
  }

  if (!pageBody) {
    try {
      const response = await fetchWithTimeout(siteUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const html = await response.text();
      return parseHtmlContent(html, siteUrl, origin, parseOptions);
    } catch (error) {
      const err = error as { name?: string; message?: string };
      if (err.name === 'AbortError') {
        throw new Error(`Таймаут при загрузке ${siteUrl} (>${FETCH_TIMEOUT_MS / 1000}с)`);
      }
      throw error;
    }
  }

  return [];
}

// ===== Парсинг всех настроенных сайтов =====

let parsedNewsCache: { headlines: ParsedHeadline[]; ts: number } | null = null;
const PARSED_NEWS_CACHE_TTL_MS = 10 * 60 * 1000;

export async function parseAllConfiguredSites(): Promise<ParsedHeadline[]> {
  if (parsedNewsCache && Date.now() - parsedNewsCache.ts < PARSED_NEWS_CACHE_TTL_MS) {
    appLogger.debug({ cached: parsedNewsCache.headlines.length }, 'Returning cached news headlines');
    return parsedNewsCache.headlines;
  }

  const sites = await getConfiguredSites();
  const enabledSites = sites.filter(s => s.enabled);

  if (enabledSites.length === 0) {
    appLogger.debug('No enabled news sites configured — skipping parse');
    return [];
  }

  appLogger.info({ count: enabledSites.length }, 'Parsing news from configured sites');

  const results = await Promise.allSettled(
    enabledSites.map(async (site) => {
      const headlines = await parseNewsFromSite(site);
      return headlines.map(h => ({ ...h, source: site.name }));
    }),
  );

  const allHeadlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  let duplicatesFiltered = 0;

  results.forEach((result, i) => {
    const site = enabledSites[i]!;
    if (result.status === 'fulfilled') {
      for (const headline of result.value) {
        const titleNorm = normalizeTitle(headline.title);
        const urlNorm = headline.url.toLowerCase();

        if (seenTitles.has(titleNorm) || seenUrls.has(urlNorm)) {
          duplicatesFiltered++;
          continue;
        }

        seenTitles.add(titleNorm);
        seenUrls.add(urlNorm);
        allHeadlines.push(headline);
      }
    } else {
      appLogger.warn(
        { error: result.reason, siteName: site.name, siteUrl: site.url },
        'Failed to parse news site for digest',
      );
    }
  });

  if (duplicatesFiltered > 0) {
    appLogger.info({ duplicatesFiltered }, 'Cross-source duplicates filtered');
  }

  appLogger.info({ totalHeadlines: allHeadlines.length, sites: enabledSites.length }, 'News parsing complete');

  parsedNewsCache = { headlines: allHeadlines, ts: Date.now() };
  return allHeadlines;
}

/**
 * Получить заголовки по категории
 */
export function filterByCategory(headlines: ParsedHeadline[], category: NewsSourceCategory): ParsedHeadline[] {
  return headlines.filter(h => h.category === category);
}

/**
 * Получить заголовки по языку
 */
export function filterByLanguage(headlines: ParsedHeadline[], language: NewsSourceLanguage): ParsedHeadline[] {
  return headlines.filter(h => h.language === language);
}
