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

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { load, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { settingsRepo } from '../db/index.js';
import { appLogger } from '../config/logger.js';
import { hasMostlyRussianText, localizeParsedHeadlines } from './news-localization.js';
import { enrichParsedHeadlineDescriptions, isWeakHeadlineDescription } from './news-description-enrichment.js';
import { filterHeadlinesForVibecoding } from './news-vibecoding-filter.js';
import {
  FETCH_TIMEOUT_MS,
  MAX_HEADLINES_PER_SITE,
  MIN_TITLE_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_NEWS_AGE_HOURS,
  PARSED_NEWS_CACHE_TTL as PARSED_NEWS_CACHE_TTL_MS,
  NEWS_FEED_PROBE_TIMEOUT_MS,
  NEWS_SITE_TIMEOUT_MS,
  NEWS_PARSE_BATCH_SIZE,
} from '../config/constants.js';
import { ASIA_NEWS_SOURCE_MANIFEST } from './asian-news-sources.js';
import type {
  NewsSite,
  ParsedHeadline,
  ParsedHeadlineCategory,
  NewsSourceCategory,
  NewsSourceLanguage,
  NewsSourceTier,
  JsonFieldMapping,
  HtmlFieldMapping,
} from '../../../shared/types/index.js';

// Re-export shared types
export type { NewsSite, ParsedHeadline } from '../../../shared/types/index.js';

// ===== Константы =====

const SETTINGS_KEY = 'digest_news_sites';

export type NewsPresetGroup = 'all' | 'global' | 'asia';

interface ParseOptions {
  category?: NewsSourceCategory;
  language?: NewsSourceLanguage;
  filterKeywords?: string[];
  htmlMapping?: HtmlFieldMapping;
  source?: string;
  sourceUrl?: string;
  sourceTier?: NewsSourceTier;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RSS_PATHS = ['/feed', '/rss', '/rss.xml', '/feed/rss', '/atom.xml', '/feed/atom', '/index.xml', '/rss/all', '/rss/new'];
const NEWS_HOST_VALIDATION_TTL_MS = 10 * 60 * 1000;
const MAX_FETCH_REDIRECTS = 5;

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

const validatedNewsHostCache = new Map<string, { safe: boolean; ts: number }>();

// Circuit breaker для постоянно падающих сайтов
const siteFailureTracker = new Map<string, { failures: number; lastFailAt: number }>();
const SITE_CB_THRESHOLD = 3;       // 3 подряд fail → skip
const SITE_CB_COOLDOWN_MS = 30 * 60_000; // 30 мин пауза

function shouldSkipSite(url: string): boolean {
  const entry = siteFailureTracker.get(url);
  if (!entry || entry.failures < SITE_CB_THRESHOLD) return false;
  return Date.now() - entry.lastFailAt < SITE_CB_COOLDOWN_MS;
}

function recordSiteSuccess(url: string): void {
  siteFailureTracker.delete(url);
}

function recordSiteFailure(url: string): void {
  const entry = siteFailureTracker.get(url);
  siteFailureTracker.set(url, { failures: (entry?.failures ?? 0) + 1, lastFailAt: Date.now() });
  // Защита от утечки памяти
  if (siteFailureTracker.size > 500) {
    const oldest = siteFailureTracker.keys().next().value;
    if (oldest) siteFailureTracker.delete(oldest);
  }
}

// ===== Пресетные AI/Tech источники =====

export const DEFAULT_AI_TECH_SOURCES: NewsSite[] = [
  // ===== AI Labs & Research =====
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
  },
  {
    name: 'arXiv cs.CL (NLP/LLM)',
    url: 'https://rss.arxiv.org/rss/cs.CL',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'arXiv cs.LG (Machine Learning)',
    url: 'https://rss.arxiv.org/rss/cs.LG',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Google AI Blog',
    url: 'https://blog.google/technology/ai/rss/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Meta AI Blog',
    url: 'https://ai.meta.com/blog/rss/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Anthropic News',
    url: 'https://www.anthropic.com/rss.xml',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'DeepMind Blog',
    url: 'https://deepmind.google/blog/rss.xml',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Microsoft AI Blog',
    url: 'https://blogs.microsoft.com/ai/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  // ===== Developer Communities =====
  {
    name: 'Hacker News (AI/VibeCoding)',
    url: 'https://hn.algolia.com/api/v1/search_by_date?query=AI+OR+LLM+OR+vibecoding+OR+%22vibe+coding%22+OR+cursor+OR+copilot+OR+%22code+generation%22+OR+anthropic+OR+openai&tags=story&hitsPerPage=40',
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
    url: 'https://dev.to/api/articles?tag=ai&top=7&per_page=30',
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
    name: 'Dev.to (Machine Learning)',
    url: 'https://dev.to/api/articles?tag=machinelearning&top=7&per_page=20',
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
    name: 'Reddit r/MachineLearning',
    url: 'https://www.reddit.com/r/MachineLearning/hot/.rss',
    enabled: true,
    type: 'rss',
    category: 'community',
    language: 'en',
  },
  {
    name: 'Reddit r/artificial',
    url: 'https://www.reddit.com/r/artificial/hot/.rss',
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
  // ===== Tech Blogs & Aggregators =====
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
  {
    name: 'The Verge (AI)',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Ars Technica (AI)',
    url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'TechCrunch (AI)',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'VentureBeat (AI)',
    url: 'https://venturebeat.com/category/ai/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'MIT Technology Review (AI)',
    url: 'https://www.technologyreview.com/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Towards Data Science (Medium)',
    url: 'https://towardsdatascience.com/feed',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'AI News (artificialintelligence-news.com)',
    url: 'https://www.artificialintelligence-news.com/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Wired (AI)',
    url: 'https://www.wired.com/feed/tag/ai/latest/rss',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Lex Fridman Podcast',
    url: 'https://lexfridman.com/feed/podcast/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'The Batch (DeepLearning.AI)',
    url: 'https://www.deeplearning.ai/the-batch/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Nvidia AI Blog',
    url: 'https://blogs.nvidia.com/feed/',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Stability AI Blog',
    url: 'https://stability.ai/blog/feed',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'Reddit r/CursorAI',
    url: 'https://www.reddit.com/r/CursorAI/new/.rss',
    enabled: true,
    type: 'rss',
    category: 'community',
    language: 'en',
  },
  {
    name: 'Reddit r/singularity',
    url: 'https://www.reddit.com/r/singularity/hot/.rss',
    enabled: true,
    type: 'rss',
    category: 'community',
    language: 'en',
  },
  {
    name: 'Reddit r/ChatGPT',
    url: 'https://www.reddit.com/r/ChatGPT/hot/.rss',
    enabled: true,
    type: 'rss',
    category: 'community',
    language: 'en',
  },
  {
    name: 'Dev.to (GitHub Copilot)',
    url: 'https://dev.to/api/articles?tag=github-copilot&top=7&per_page=20',
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
    name: 'Habr (AI)',
    url: 'https://habr.com/ru/rss/hub/artificial_intelligence/all/?fl=ru',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'ru',
  },
  {
    name: 'Habr (Machine Learning)',
    url: 'https://habr.com/ru/rss/hub/machine_learning/all/?fl=ru',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'ru',
  },
  {
    name: 'Thoughtworks Insights',
    url: 'https://www.thoughtworks.com/rss/insights.xml',
    enabled: true,
    type: 'rss',
    category: 'ai_tech',
    language: 'en',
  },
  {
    name: 'PaperWithCode (trending)',
    url: 'https://paperswithcode.com/latest',
    enabled: true,
    type: 'html_scrape',
    category: 'ai_tech',
    language: 'en',
  },
  // ===== Asia: China / Japan / Korea =====
  ...ASIA_NEWS_SOURCE_MANIFEST,
];

const VALID_TYPES: NewsSite['type'][] = ['rss', 'json_api', 'html_scrape'];
const VALID_CATEGORIES: NewsSourceCategory[] = ['ai_tech', 'city_local', 'community', 'asia_tech'];
const VALID_LANGUAGES: NewsSourceLanguage[] = ['ru', 'en', 'zh', 'ja', 'ko'];
const VALID_TIERS: NewsSourceTier[] = ['tier1', 'tier2', 'tier3'];

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeSourceKey = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeJsonMapping(mapping: unknown): JsonFieldMapping | undefined {
  if (!isObjectRecord(mapping)) return undefined;

  const itemsPath = typeof mapping.itemsPath === 'string' ? mapping.itemsPath.trim() : '';
  const titleField = typeof mapping.titleField === 'string' ? mapping.titleField.trim() : '';
  const urlField = typeof mapping.urlField === 'string' ? mapping.urlField.trim() : '';
  const dateField = typeof mapping.dateField === 'string' ? mapping.dateField.trim() : undefined;
  const descriptionField = typeof mapping.descriptionField === 'string' ? mapping.descriptionField.trim() : undefined;

  if (!titleField || !urlField) {
    throw new Error('jsonMapping must include titleField and urlField');
  }

  return {
    itemsPath,
    titleField,
    urlField,
    ...(dateField ? { dateField } : {}),
    ...(descriptionField ? { descriptionField } : {}),
  };
}

function normalizeHtmlMapping(mapping: unknown): HtmlFieldMapping | undefined {
  if (!isObjectRecord(mapping)) return undefined;

  const itemSelectors = normalizeStringArray(Array.isArray(mapping.itemSelectors) ? mapping.itemSelectors.map(String) : undefined);
  const linkSelectors = normalizeStringArray(Array.isArray(mapping.linkSelectors) ? mapping.linkSelectors.map(String) : undefined);
  const titleSelectors = normalizeStringArray(Array.isArray(mapping.titleSelectors) ? mapping.titleSelectors.map(String) : undefined);
  const descriptionSelectors = normalizeStringArray(Array.isArray(mapping.descriptionSelectors) ? mapping.descriptionSelectors.map(String) : undefined);
  const dateSelectors = normalizeStringArray(Array.isArray(mapping.dateSelectors) ? mapping.dateSelectors.map(String) : undefined);
  const removeSelectors = normalizeStringArray(Array.isArray(mapping.removeSelectors) ? mapping.removeSelectors.map(String) : undefined);
  const dateAttribute = typeof mapping.dateAttribute === 'string' ? mapping.dateAttribute.trim() : undefined;

  if (!itemSelectors && !linkSelectors && !titleSelectors && !descriptionSelectors) {
    throw new Error('htmlMapping must include at least one selector array');
  }

  return {
    ...(itemSelectors ? { itemSelectors } : {}),
    ...(linkSelectors ? { linkSelectors } : {}),
    ...(titleSelectors ? { titleSelectors } : {}),
    ...(descriptionSelectors ? { descriptionSelectors } : {}),
    ...(dateSelectors ? { dateSelectors } : {}),
    ...(removeSelectors ? { removeSelectors } : {}),
    ...(dateAttribute ? { dateAttribute } : {}),
  };
}

export function normalizeNewsSite(site: NewsSite): NewsSite {
  const name = site.name?.trim();
  const url = site.url?.trim();
  if (!name) throw new Error('News site must have a name');
  if (!url) throw new Error('News site must have a url');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid news site URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported protocol in news site URL: ${url}`);
  }

  const hostValidationError = getUnsafeNewsHostError(parsedUrl.hostname);
  if (hostValidationError) {
    throw new Error(hostValidationError);
  }

  const normalizedType = typeof site.type === 'string' ? site.type.trim() as NewsSite['type'] : undefined;
  const normalizedCategory = typeof site.category === 'string' ? site.category.trim() as NewsSourceCategory : undefined;
  const normalizedLanguage = typeof site.language === 'string' ? site.language.trim() as NewsSourceLanguage : undefined;
  const normalizedTier = typeof site.tier === 'string' ? site.tier.trim() as NewsSourceTier : undefined;

  if (normalizedType && !VALID_TYPES.includes(normalizedType)) {
    throw new Error(`Invalid news site type: ${normalizedType}`);
  }
  if (normalizedCategory && !VALID_CATEGORIES.includes(normalizedCategory)) {
    throw new Error(`Invalid news site category: ${normalizedCategory}`);
  }
  if (normalizedLanguage && !VALID_LANGUAGES.includes(normalizedLanguage)) {
    throw new Error(`Invalid news site language: ${normalizedLanguage}`);
  }
  if (normalizedTier && !VALID_TIERS.includes(normalizedTier)) {
    throw new Error(`Invalid news site tier: ${normalizedTier}`);
  }

  const jsonMapping = normalizeJsonMapping(site.jsonMapping);
  const htmlMapping = normalizeHtmlMapping(site.htmlMapping);
  const filterKeywords = normalizeStringArray(site.filterKeywords);

  return {
    name,
    url,
    enabled: site.enabled !== false,
    ...(normalizedType ? { type: normalizedType } : {}),
    ...(normalizedCategory ? { category: normalizedCategory } : {}),
    ...(normalizedLanguage ? { language: normalizedLanguage } : {}),
    ...(normalizedTier ? { tier: normalizedTier } : {}),
    ...(jsonMapping ? { jsonMapping } : {}),
    ...(htmlMapping ? { htmlMapping } : {}),
    ...(filterKeywords ? { filterKeywords } : {}),
  };
}

function isPrivateIpv4Address(hostname: string): boolean {
  if (/^0\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(hostname)) return true;
  if (/^198\.(1[89])\.\d+\.\d+$/.test(hostname)) return true;

  const privateRange = /^172\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (!privateRange) return false;

  const secondOctet = Number(privateRange[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function isPrivateIpv6Address(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fe90:')
    || normalized.startsWith('fea0:')
    || normalized.startsWith('feb0:');
}

function getUnsafeNewsHostError(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) {
    return 'News site URL must include a hostname';
  }

  if (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || normalized === '::'
  ) {
    return 'News site URL must not target a local or private host';
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4 && isPrivateIpv4Address(normalized)) {
    return 'News site URL must not target a local or private host';
  }

  if (ipVersion === 6 && isPrivateIpv6Address(normalized)) {
    return 'News site URL must not target a local or private host';
  }

  if (ipVersion === 0 && !normalized.includes('.')) {
    return 'News site URL must use a public hostname';
  }

  return null;
}

export async function assertNewsSiteUrlIsSafe(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid news site URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol in news site URL: ${url}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const syncValidationError = getUnsafeNewsHostError(hostname);
  if (syncValidationError) {
    throw new Error(syncValidationError);
  }

  const cached = validatedNewsHostCache.get(hostname);
  if (cached && Date.now() - cached.ts < NEWS_HOST_VALIDATION_TTL_MS) {
    if (!cached.safe) {
      throw new Error('News site URL must not resolve to a local or private host');
    }
    return;
  }

  if (isIP(hostname)) {
    validatedNewsHostCache.set(hostname, { safe: true, ts: Date.now() });
    return;
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error(`Unable to resolve news site host: ${hostname}`);
    }

    const resolvedPrivate = records.some((record) => getUnsafeNewsHostError(record.address));
    validatedNewsHostCache.set(hostname, { safe: !resolvedPrivate, ts: Date.now() });

    if (resolvedPrivate) {
      throw new Error('News site URL must not resolve to a local or private host');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('local or private host')) {
      throw error;
    }
    throw new Error(`Unable to resolve news site host: ${hostname}`);
  }
}

export function normalizeNewsSites(sites: NewsSite[]): NewsSite[] {
  const byUrl = new Map<string, NewsSite>();
  for (const site of sites) {
    const normalized = normalizeNewsSite(site);
    byUrl.set(normalizeSourceKey(normalized.url), normalized);
  }
  return [...byUrl.values()];
}

export function getPresetSources(group: NewsPresetGroup = 'all'): NewsSite[] {
  const all = normalizeNewsSites(DEFAULT_AI_TECH_SOURCES);
  if (group === 'all') return all;
  if (group === 'asia') return all.filter(site => site.category === 'asia_tech');
  return all.filter(site => site.category !== 'asia_tech');
}

export function getPresetSourceCounts(): Record<NewsPresetGroup, number> {
  return {
    all: getPresetSources('all').length,
    global: getPresetSources('global').length,
    asia: getPresetSources('asia').length,
  };
}

export function mergeNewsSites(existing: NewsSite[], incoming: NewsSite[]): NewsSite[] {
  const merged = new Map<string, NewsSite>();

  for (const site of normalizeNewsSites(existing)) {
    merged.set(normalizeSourceKey(site.url), site);
  }

  for (const preset of normalizeNewsSites(incoming)) {
    const key = normalizeSourceKey(preset.url);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, preset);
      continue;
    }

    merged.set(key, {
      ...current,
      ...preset,
      enabled: current.enabled,
      jsonMapping: preset.jsonMapping ?? current.jsonMapping,
      htmlMapping: preset.htmlMapping ?? current.htmlMapping,
      filterKeywords: preset.filterKeywords ?? current.filterKeywords,
    });
  }

  return [...merged.values()];
}

export function clearParsedNewsCache(): void {
  parsedNewsCache = null;
}

// ===== Получение/сохранение сайтов =====

export async function getConfiguredSites(): Promise<NewsSite[]> {
  try {
    const raw = await settingsRepo.get(SETTINGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const normalizedSites: NewsSite[] = [];
    for (const candidate of parsed) {
      if (!isObjectRecord(candidate)) continue;
      try {
        normalizedSites.push(normalizeNewsSite(candidate as unknown as NewsSite));
      } catch (error) {
        appLogger.warn({ error, candidate }, 'Skipping invalid digest_news_sites entry');
      }
    }

    return normalizedSites;
  } catch (err) {
    appLogger.warn({ error: err }, 'Failed to parse digest_news_sites setting');
    return [];
  }
}

export async function saveConfiguredSites(sites: NewsSite[]): Promise<void> {
  const normalizedSites = normalizeNewsSites(sites);
  await settingsRepo.set(SETTINGS_KEY, JSON.stringify(normalizedSites));
  clearParsedNewsCache();
}

// ===== Утилиты =====

function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      return null;
    }
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.href;
  } catch {
    return null;
  }
}

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'feature',
  'source',
  'rss',
  'output',
]);

export function canonicalizeHeadlineUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    const keptParams = [...parsed.searchParams.entries()]
      .filter(([key, value]) =>
        !TRACKING_QUERY_PARAMS.has(key.toLowerCase()) &&
        !key.toLowerCase().startsWith('utm_') &&
        value.trim().length > 0,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    parsed.search = '';
    for (const [key, value] of keptParams) {
      parsed.searchParams.append(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]/g, ' ')
    .trim();
}

function cleanHtmlSnippet(text: string): string {
  if (!text) return '';
  const withoutTags = text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ');
  return cleanTitle(withoutTags)
    .replace(/\s+[|·•-]\s*$/, '')
    .slice(0, 400);
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function resolveHeadlineCategory(category?: NewsSourceCategory): ParsedHeadlineCategory {
  return category ?? 'uncategorized';
}

function buildDescriptionFallback(
  title: string,
  source: string,
  category: ParsedHeadlineCategory,
): string {
  const titleParts = title.split(':').map(part => cleanTitle(part));
  const titleSuffix = titleParts.length > 1 ? titleParts.slice(1).join(': ') : '';
  if (titleSuffix && titleSuffix.length >= 20 && hasMostlyRussianText(titleSuffix)) {
    return titleSuffix.slice(0, 240);
  }

  switch (category) {
    case 'ai_tech':
      return `${source}: материал о новых AI-инструментах, моделях или продуктах для разработки.`;
    case 'community':
      return `${source}: практический материал или обсуждение из сообщества разработчиков и AI-энтузиастов.`;
    case 'asia_tech':
      return `${source}: важная новость про AI-рынок, продукты или экосистему Азии.`;
    case 'city_local':
      return `${source}: локальная новость о событиях города, транспорте, инфраструктуре или решениях властей.`;
    default:
      return `${source}: структурированная новость из источника без явной категории.`;
  }
}

export function buildHeadlineFingerprint(
  title: string,
  canonicalUrl: string,
  pubDate: string | undefined,
  category: ParsedHeadlineCategory,
): string {
  const parsedCanonical = canonicalizeHeadlineUrl(canonicalUrl);
  const parsedDomain = extractDomain(parsedCanonical);
  const normalizedDate = pubDate ? pubDate.slice(0, 10) : 'no-date';
  return createHash('sha1')
    .update([normalizeTitle(title), parsedDomain, normalizedDate, category].join('|'))
    .digest('hex');
}

function createParsedHeadline(
  title: string,
  url: string,
  options?: {
    pubDate?: Date;
    category?: NewsSourceCategory;
    language?: NewsSourceLanguage;
    source?: string;
    sourceUrl?: string;
    sourceTier?: NewsSourceTier;
    description?: string;
  },
): ParsedHeadline {
  const category = resolveHeadlineCategory(options?.category);
  const source = options?.source?.trim() || extractDomain(options?.sourceUrl ?? url) || 'Unknown source';
  const sourceUrl = options?.sourceUrl?.trim() || undefined;
  const canonicalUrl = canonicalizeHeadlineUrl(url);
  const description = cleanHtmlSnippet(options?.description ?? '') || buildDescriptionFallback(title, source, category);
  const pubDate = options?.pubDate?.toISOString();
  return {
    title,
    url,
    canonicalUrl,
    source,
    sourceDomain: extractDomain(sourceUrl ?? url),
    description,
    fingerprint: buildHeadlineFingerprint(title, canonicalUrl, pubDate, category),
    alternateSources: [],
    pubDate,
    category,
    language: options?.language,
    sourceUrl,
    sourceTier: options?.sourceTier,
  };
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
  if (ageMs < 0) return true;
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
 * Проверить соответствие заголовка ключевым словам (case-insensitive).
 * При пустом массиве keywords пропускает всё.
 * Для CJK-контента (китайский/японский/корейский) без ASCII keywords —
 * пропускаем фильтр, т.к. ключевые слова заданы на латинице.
 */
function matchesKeywords(title: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true;
  const titleLower = title.toLowerCase();
  const hasLatinKeywords = keywords.some(kw => /^[a-zA-Z0-9\s\-]+$/.test(kw));
  const isCjkTitle = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(title);
  if (hasLatinKeywords && isCjkTitle) return true;
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
    source?: string;
    sourceUrl?: string;
    sourceTier?: NewsSourceTier;
    description?: string;
  },
): boolean {
  if (headlines.length >= MAX_HEADLINES_PER_SITE) return false;
  if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) {
    appLogger.debug({ title: title?.slice(0, 50), len: title?.length, reason: 'length' }, 'Headline rejected');
    return false;
  }
  if (isSkipText(title)) return false;
  if (!isNewsRecent(options?.pubDate)) {
    appLogger.debug({ title: title.slice(0, 50), pubDate: options?.pubDate?.toISOString(), reason: 'age' }, 'Headline rejected');
    return false;
  }
  if (!matchesKeywords(title, options?.filterKeywords)) {
    appLogger.debug({ title: title.slice(0, 50), reason: 'keywords' }, 'Headline rejected');
    return false;
  }

  const titleNormalized = normalizeTitle(title);
  if (seenTitles.has(titleNormalized)) return false;

  seenTitles.add(titleNormalized);
  headlines.push(createParsedHeadline(title, url, options));
  return true;
}

// ===== Fetch с таймаутом =====

async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_FETCH_REDIRECTS; redirectCount += 1) {
    await assertNewsSiteUrlIsSafe(currentUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8',
          'Accept-Language': 'ja-JP,ja;q=0.95,ko-KR,ko;q=0.9,zh-CN,zh;q=0.9,en-US,en;q=0.7,ru-RU,ru;q=0.5',
        },
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect location is missing for news site: ${currentUrl}`);
      }

      if (redirectCount === MAX_FETCH_REDIRECTS) {
        throw new Error(`Too many redirects while fetching news site: ${url}`);
      }

      currentUrl = new URL(location, currentUrl).toString();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`Too many redirects while fetching news site: ${url}`);
}

function createTimeoutError(scope: string, timeoutMs: number): Error {
  return new Error(`${scope} timed out after ${Math.ceil(timeoutMs / 1000)}s`);
}

async function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  scope: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(createTimeoutError(scope, timeoutMs)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
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

function extractStringField(item: Record<string, unknown>, fieldSpec: string | undefined): string {
  if (!fieldSpec) return '';
  for (const rawField of fieldSpec.split('|')) {
    const field = rawField.trim();
    if (!field) continue;
    const value = getNestedValue(item, field);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/**
 * Извлечь URL из объекта с поддержкой fallback (pipe-separated): "url|story_url"
 */
function extractUrl(item: Record<string, unknown>, urlField: string): string | null {
  const value = extractStringField(item, urlField);
  return value.startsWith('http') ? value : null;
}

/**
 * Парсинг JSON API ответа
 */
function parseJsonApiResponse(
  data: unknown,
  mapping: JsonFieldMapping,
  baseUrl: string,
  options?: ParseOptions,
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
    const title = cleanTitle(extractStringField(record, mapping.titleField));
    const rawUrl = extractUrl(record, mapping.urlField);
    const url = rawUrl ? normalizeUrl(rawUrl, baseUrl) : null;
    const pubDate = parsePubDate(extractStringField(record, mapping.dateField));
    const description = cleanHtmlSnippet(extractStringField(record, mapping.descriptionField));

    if (!url) continue;

    addHeadline(headlines, seenTitles, title, url, {
      pubDate,
      category: options?.category,
      language: options?.language,
      filterKeywords: options?.filterKeywords,
      source: options?.source,
      sourceUrl: options?.sourceUrl,
      sourceTier: options?.sourceTier,
      description,
    });
  }

  return headlines;
}

async function parseJsonApi(site: NewsSite): Promise<ParsedHeadline[]> {
  if (!site.jsonMapping) {
    appLogger.warn({ url: site.url }, 'JSON API site missing jsonMapping config');
    return [];
  }

  const response = await fetchWithTimeout(site.url, FETCH_TIMEOUT_MS);
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

function parseGitHubTrending(html: string, options?: ParseOptions): ParsedHeadline[] {
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
    const title = repoName;

    addHeadline(headlines, seenTitles, title, url, {
      category: options?.category ?? 'ai_tech',
      language: options?.language ?? 'en',
      source: options?.source,
      sourceUrl: options?.sourceUrl,
      sourceTier: options?.sourceTier,
      description,
    });
  });

  appLogger.info({ count: headlines.length }, 'GitHub Trending parsed');
  return headlines;
}

// ===== TLDR AI Archives Parser =====

function parseTldrArchives(html: string, baseUrl: string, options?: ParseOptions): ParsedHeadline[] {
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
      category: options?.category ?? 'ai_tech',
      language: options?.language ?? 'en',
      source: options?.source,
      sourceUrl: options?.sourceUrl,
      sourceTier: options?.sourceTier,
    });
  });

  appLogger.info({ count: headlines.length }, 'TLDR AI Archives parsed');
  return headlines;
}

// ===== RSS/Atom парсинг =====

function parseRssFeed(
  xml: string,
  baseUrl: string,
  options?: ParseOptions,
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
    const description = cleanHtmlSnippet(
      $item.find('description').first().text()
      || $item.find('content\\:encoded').first().text()
      || $item.find('summary').first().text(),
    );

    const url = normalizeUrl(link, baseUrl);
    if (url) addHeadline(headlines, seenTitles, title, url, { pubDate, description, ...options });
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
      const description = cleanHtmlSnippet(
        $entry.find('summary').first().text()
        || $entry.find('content').first().text(),
      );

      const url = normalizeUrl(link, baseUrl);
      if (url) addHeadline(headlines, seenTitles, title, url, { pubDate, description, ...options });
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
      const response = await fetchWithTimeout(feedUrl, NEWS_FEED_PROBE_TIMEOUT_MS);
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
    const response = await fetchWithTimeout(feedUrl, NEWS_FEED_PROBE_TIMEOUT_MS);
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
        const json = JSON.parse(text) as {
          items?: Array<{
            title?: string;
            url?: string;
            external_url?: string;
            summary?: string;
            content_text?: string;
          }>;
        };
        if (json.items && Array.isArray(json.items)) {
          const headlines: ParsedHeadline[] = [];
          const seenTitles = new Set<string>();
          for (const item of json.items) {
            if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
            const title = cleanTitle(item.title ?? '');
            const url = item.url ?? item.external_url ?? '';
            const description = cleanHtmlSnippet(item.summary ?? item.content_text ?? '');
            if (url) addHeadline(headlines, seenTitles, title, url, { ...options, description });
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

function extractDescriptionFromContainer(
  $container: Cheerio<AnyNode>,
  titleText: string,
  selectors?: string[],
): string {
  if (selectors && selectors.length > 0) {
    for (const selector of selectors) {
      const text = cleanHtmlSnippet($container.find(selector).first().text());
      if (text) return text;
    }
  }

  const paragraphText = cleanHtmlSnippet($container.find('p').first().text());
  if (paragraphText && paragraphText !== titleText) {
    return paragraphText;
  }

  const containerText = cleanHtmlSnippet($container.text());
  if (!containerText) return '';
  if (containerText === titleText) return '';
  if (containerText.startsWith(titleText)) {
    return cleanTitle(containerText.slice(titleText.length));
  }
  return containerText;
}

function parseHtmlWithMapping(
  html: string,
  siteUrl: string,
  origin: string,
  mapping: HtmlFieldMapping,
  options?: ParseOptions,
): ParsedHeadline[] {
  const $ = load(html);
  if (mapping.removeSelectors && mapping.removeSelectors.length > 0) {
    $(mapping.removeSelectors.join(',')).remove();
  }

  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const itemSelectors = mapping.itemSelectors ?? [];

  const collectFromContainer = ($container: ReturnType<typeof $>) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;

    let linkNode = $container.is('a') ? $container : $container.find('a[href]').first();
    if (mapping.linkSelectors && mapping.linkSelectors.length > 0) {
      for (const selector of mapping.linkSelectors) {
        const candidate = $container.find(selector).first();
        if (candidate.length > 0) {
          linkNode = candidate;
          break;
        }
      }
    }

    let titleText = '';
    let titleNode: ReturnType<typeof $> | null = null;
    if (mapping.titleSelectors && mapping.titleSelectors.length > 0) {
      for (const selector of mapping.titleSelectors) {
        const candidate = $container.find(selector).first();
        const candidateText = cleanTitle(candidate.text());
        if (candidate.length > 0 && candidateText) {
          titleNode = candidate;
          titleText = candidateText;
          break;
        }
      }
    }

    if (!titleText) {
      titleText = cleanTitle(linkNode.first().text()) || cleanTitle($container.text());
    }

    const href = linkNode.attr('href') ?? titleNode?.closest('a').attr('href') ?? '';

    const url = normalizeUrl(href, origin);
    if (!url || seenUrls.has(url)) return;
    const description = extractDescriptionFromContainer($container, titleText, mapping.descriptionSelectors);

    let pubDate: Date | undefined;
    if (mapping.dateSelectors && mapping.dateSelectors.length > 0) {
      for (const selector of mapping.dateSelectors) {
        const dateNode = $container.find(selector).first();
        if (dateNode.length === 0) continue;
        const rawDate = mapping.dateAttribute
          ? String(dateNode.attr(mapping.dateAttribute) ?? dateNode.text())
          : String(dateNode.text());
        pubDate = parsePubDate(rawDate);
        if (pubDate) break;
      }
    }

    if (addHeadline(headlines, seenTitles, titleText, url, { ...options, pubDate, description })) {
      seenUrls.add(url);
    }
  };

  if (itemSelectors.length > 0) {
    for (const selector of itemSelectors) {
      $(selector).each((_i: number, el: AnyNode) => collectFromContainer($(el)));
      if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
    }
  }

  if (headlines.length === 0 && mapping.linkSelectors && mapping.linkSelectors.length > 0) {
    for (const selector of mapping.linkSelectors) {
      $(selector).each((_i: number, el: AnyNode) => collectFromContainer($(el)));
      if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
    }
  }

  appLogger.info({ siteUrl, headlinesFound: headlines.length }, 'News site parsed (custom HTML mapping)');
  return headlines.slice(0, MAX_HEADLINES_PER_SITE);
}

function parseHtmlContent(
  html: string,
  siteUrl: string,
  origin: string,
  options?: ParseOptions,
): ParsedHeadline[] {
  // Специальные парсеры
  if (siteUrl.includes('github.com/trending')) {
    return parseGitHubTrending(html, options);
  }
  if (siteUrl.includes('tldr.tech')) {
    return parseTldrArchives(html, origin, options);
  }

  if (options?.htmlMapping) {
    const mappedHeadlines = parseHtmlWithMapping(html, siteUrl, origin, options.htmlMapping, options);
    if (mappedHeadlines.length > 0) {
      return mappedHeadlines;
    }
  }

  const $ = load(html);
  $('nav, footer, script, style, noscript, iframe, .ad, .ads, .advertisement, .banner, .sidebar, .widget, .menu, .navigation, header').remove();

  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const getContainerDescription = ($node: Cheerio<AnyNode>, title: string): string => {
    const $container = $node.closest('article, li, section, div');
    return extractDescriptionFromContainer($container.length > 0 ? $container : $node.parent(), title);
  };

  // Стратегия A: ссылки внутри h1-h3
  $('h1 a, h2 a, h3 a').each((_i: number, _el: AnyNode) => {
    const $el = $(_el);
    const title = cleanTitle($el.text());
    const href = $el.attr('href');
    const url = normalizeUrl(href ?? '', origin);
    if (url && !seenUrls.has(url)) {
      const description = getContainerDescription($el, title);
      if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) {
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
      const description = getContainerDescription($heading, title);
      if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) {
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
        const description = getContainerDescription($heading, title);
        if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
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
        const description = getContainerDescription($heading, title);
        if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
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
        const description = getContainerDescription($heading, title);
        if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
      }
    }
  });

  // Стратегия D: широкий проход по ссылкам, если до лимита ещё есть место
  if (headlines.length < MAX_HEADLINES_PER_SITE) {
    $('a[href]').each((_i: number, _el: AnyNode) => {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
      const $el = $(_el);
      const title = cleanTitle($el.text());
      const href = $el.attr('href') ?? '';

      if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
      if (isSkipText(title)) return;

      const url = normalizeUrl(href, origin);
      if (!url || seenUrls.has(url)) return;
      if (!isArticleUrl(url, origin)) return;

      const description = getContainerDescription($el, title);
      if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
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
    ? { name: extractDomain(siteOrUrl) || 'Unknown source', url: siteOrUrl, enabled: true }
    : siteOrUrl;

  const siteUrl = site.url;
  await assertNewsSiteUrlIsSafe(siteUrl);
  const parseOptions: ParseOptions = {
    category: site.category,
    language: site.language,
    filterKeywords: site.filterKeywords,
    htmlMapping: site.htmlMapping,
    source: site.name,
    sourceUrl: site.url,
    sourceTier: site.tier,
  };

  // JSON API — специальный путь
  if (site.type === 'json_api') {
    return parseJsonApi(site);
  }

  // HTML scrape — специальный путь
  if (site.type === 'html_scrape') {
    const response = await fetchWithTimeout(siteUrl, FETCH_TIMEOUT_MS);
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
      const directResponse = await fetchWithTimeout(siteUrl, FETCH_TIMEOUT_MS);
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
          const rssResponse = await fetchWithTimeout(feedUrl, NEWS_FEED_PROBE_TIMEOUT_MS);
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

function getTierScore(tier?: NewsSourceTier): number {
  switch (tier) {
    case 'tier1':
      return 3;
    case 'tier2':
      return 2;
    case 'tier3':
      return 1;
    default:
      return 0;
  }
}

function getDescriptionScore(headline: ParsedHeadline): number {
  const description = cleanTitle(headline.description);
  if (!description || description === headline.title || isWeakHeadlineDescription(headline)) return 0;
  if (description.length >= 120) return 3;
  if (description.length >= 60) return 2;
  return 1;
}

function parseHeadlineTimestamp(headline: ParsedHeadline): number {
  if (!headline.pubDate) return 0;
  const timestamp = new Date(headline.pubDate).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function shouldReplacePrimaryHeadline(current: ParsedHeadline, incoming: ParsedHeadline): boolean {
  const tierDiff = getTierScore(incoming.sourceTier) - getTierScore(current.sourceTier);
  if (tierDiff !== 0) return tierDiff > 0;

  const descriptionDiff = getDescriptionScore(incoming) - getDescriptionScore(current);
  if (descriptionDiff !== 0) return descriptionDiff > 0;

  const timestampDiff = parseHeadlineTimestamp(incoming) - parseHeadlineTimestamp(current);
  return timestampDiff > 0;
}

function mergeSourceNames(headline: ParsedHeadline, incoming: ParsedHeadline, primarySource: string): string[] {
  const merged = new Set<string>([
    headline.source,
    ...headline.alternateSources,
    incoming.source,
    ...incoming.alternateSources,
  ].filter(Boolean));
  merged.delete(primarySource);
  return [...merged];
}

function mergeParsedHeadlineEntry(current: ParsedHeadline, incoming: ParsedHeadline): ParsedHeadline {
  const replacePrimary = shouldReplacePrimaryHeadline(current, incoming);
  const primary = replacePrimary ? incoming : current;
  const secondary = replacePrimary ? current : incoming;
  const category = primary.category !== 'uncategorized'
    ? primary.category
    : secondary.category;
  const alternateSources = mergeSourceNames(current, incoming, primary.source);
  const primaryDescriptionIsRussian = hasMostlyRussianText(primary.description);
  const secondaryDescriptionIsRussian = hasMostlyRussianText(secondary.description);
  const richerDescription = primaryDescriptionIsRussian !== secondaryDescriptionIsRussian
    ? (primaryDescriptionIsRussian ? primary.description : secondary.description)
    : getDescriptionScore(primary) >= getDescriptionScore(secondary)
      ? primary.description
      : secondary.description;

  return {
    ...primary,
    category,
    description: richerDescription,
    alternateSources,
    sourceDomain: primary.sourceDomain || secondary.sourceDomain,
    sourceUrl: primary.sourceUrl || secondary.sourceUrl,
    pubDate: primary.pubDate || secondary.pubDate,
    language: primary.language || secondary.language,
  };
}

export function dedupeParsedHeadlines(headlines: ParsedHeadline[]): {
  headlines: ParsedHeadline[];
  duplicatesFiltered: number;
} {
  const deduped: ParsedHeadline[] = [];
  const canonicalMap = new Map<string, number>();
  const fingerprintMap = new Map<string, number>();
  let duplicatesFiltered = 0;

  for (const headline of headlines) {
    const canonicalKey = headline.canonicalUrl.toLowerCase();
    const fingerprintKey = headline.fingerprint;
    const existingIndex = canonicalMap.get(canonicalKey) ?? fingerprintMap.get(fingerprintKey);

    if (existingIndex == null) {
      const nextIndex = deduped.push(headline) - 1;
      canonicalMap.set(canonicalKey, nextIndex);
      fingerprintMap.set(fingerprintKey, nextIndex);
      continue;
    }

    duplicatesFiltered += 1;
    const mergedHeadline = mergeParsedHeadlineEntry(deduped[existingIndex]!, headline);
    deduped[existingIndex] = mergedHeadline;
    canonicalMap.set(canonicalKey, existingIndex);
    canonicalMap.set(mergedHeadline.canonicalUrl.toLowerCase(), existingIndex);
    fingerprintMap.set(fingerprintKey, existingIndex);
    fingerprintMap.set(mergedHeadline.fingerprint, existingIndex);
  }

  return { headlines: deduped, duplicatesFiltered };
}

export function groupHeadlinesByCategory(headlines: ParsedHeadline[]): Record<ParsedHeadlineCategory, ParsedHeadline[]> {
  return headlines.reduce<Record<ParsedHeadlineCategory, ParsedHeadline[]>>((groups, headline) => {
    groups[headline.category].push(headline);
    return groups;
  }, {
    ai_tech: [],
    asia_tech: [],
    community: [],
    city_local: [],
    uncategorized: [],
  });
}

export function countMergedDuplicates(headlines: ParsedHeadline[]): number {
  return headlines.reduce((total, headline) => total + headline.alternateSources.length, 0);
}

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

  const results: PromiseSettledResult<ParsedHeadline[]>[] = [];
  for (let i = 0; i < enabledSites.length; i += NEWS_PARSE_BATCH_SIZE) {
    const batch = enabledSites.slice(i, i + NEWS_PARSE_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (site) => {
        if (shouldSkipSite(site.url)) {
          appLogger.debug({ site: site.name }, 'Site skipped by circuit breaker');
          return [] as ParsedHeadline[];
        }
        try {
          const headlines = await withPromiseTimeout(
            parseNewsFromSite(site),
            NEWS_SITE_TIMEOUT_MS,
            `News site "${site.name}"`,
          );
          recordSiteSuccess(site.url);
          appLogger.info(
            { site: site.name, count: headlines.length, type: site.type, category: site.category },
            'Site parsed successfully',
          );
          return headlines;
        } catch (err) {
          recordSiteFailure(site.url);
          appLogger.warn(
            { site: site.name, url: site.url, error: err instanceof Error ? err.message : String(err) },
            'Site parse failed',
          );
          throw err;
        }
      }),
    );
    results.push(...batchResults);
  }

  const allHeadlines: ParsedHeadline[] = [];
  let failedSites = 0;

  results.forEach((result, i) => {
    const site = enabledSites[i]!;
    if (result.status === 'fulfilled') {
      allHeadlines.push(...result.value);
    } else {
      failedSites++;
      appLogger.warn(
        { error: result.reason, siteName: site.name, siteUrl: site.url },
        'Failed to parse news site for digest',
      );
    }
  });

  const deduped = dedupeParsedHeadlines(allHeadlines);
  const enrichedHeadlines = await enrichParsedHeadlineDescriptions(deduped.headlines);
  const localizedHeadlines = await localizeParsedHeadlines(enrichedHeadlines);
  const filteredHeadlines = await filterHeadlinesForVibecoding(localizedHeadlines);
  const grouped = groupHeadlinesByCategory(filteredHeadlines);

  appLogger.info(
    {
      totalHeadlines: filteredHeadlines.length,
      totalSites: enabledSites.length,
      failedSites,
      duplicatesFiltered: deduped.duplicatesFiltered,
      mergedDuplicates: countMergedDuplicates(filteredHeadlines),
      vibecodingFilteredOut: localizedHeadlines.length - filteredHeadlines.length,
      byCategory: {
        ai_tech: grouped.ai_tech.length,
        community: grouped.community.length,
        asia_tech: grouped.asia_tech.length,
        city_local: grouped.city_local.length,
        uncategorized: grouped.uncategorized.length,
      },
    },
    'News parsing complete',
  );

  parsedNewsCache = { headlines: filteredHeadlines, ts: Date.now() };
  return filteredHeadlines;
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
