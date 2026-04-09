import { createHash } from 'node:crypto';
import type {
  ParsedHeadline,
  ParsedHeadlineCategory,
  NewsSourceCategory,
  NewsSourceLanguage,
  NewsSourceTier,
} from './news-parser-types.js';
import {
  TRACKING_QUERY_PARAMS,
  ARTICLE_URL_PATTERNS,
  SKIP_LINK_PATTERNS,
} from './news-parser-constants.js';
import {
  FETCH_TIMEOUT_MS,
  MAX_HEADLINES_PER_SITE,
  MIN_TITLE_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_NEWS_AGE_HOURS,
} from '../../config/constants.js';
import { hasMostlyRussianText } from '../news-localization.js';
import { appLogger } from '../../config/logger.js';

export function normalizeUrl(href: string, baseUrl: string): string | null {
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

export function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]/g, ' ')
    .trim();
}

export function cleanHtmlSnippet(text: string): string {
  if (!text) return '';
  const withoutTags = text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ');
  return cleanTitle(withoutTags)
    .replace(/\s+[|·•-]\s*$/, '')
    .slice(0, 400);
}

export function extractDomain(url: string): string {
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

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-zа-яёїіє\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildHeadlineFingerprint(
  title: string,
  canonicalUrl: string,
  _pubDate: string | undefined,
  category: ParsedHeadlineCategory,
): string {
  const parsedCanonical = canonicalizeHeadlineUrl(canonicalUrl);
  const parsedDomain = extractDomain(parsedCanonical);
  return createHash('sha1')
    .update([normalizeTitle(title), parsedDomain, category].join('|'))
    .digest('hex');
}

export function createParsedHeadline(
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

export function isArticleUrl(url: string, siteOrigin: string): boolean {
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

export function isSkipText(text: string): boolean {
  return SKIP_LINK_PATTERNS.some(p => p.test(text));
}

export function parsePubDate(dateStr: string): Date | undefined {
  if (!dateStr?.trim()) return undefined;
  try {
    const date = new Date(dateStr.trim());
    if (isNaN(date.getTime())) return undefined;
    return date;
  } catch {
    return undefined;
  }
}

export function isNewsRecent(pubDate: Date | undefined): boolean {
  if (!pubDate) return true;
  const ageMs = Date.now() - pubDate.getTime();
  if (ageMs < 0) return true;
  const ageHours = ageMs / (1000 * 60 * 60);
  return ageHours <= MAX_NEWS_AGE_HOURS;
}

export function matchesKeywords(title: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true;
  const titleLower = title.toLowerCase();
  const hasLatinKeywords = keywords.some(kw => /^[a-zA-Z0-9\s\-]+$/.test(kw));
  const isCjkTitle = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(title);
  if (hasLatinKeywords && isCjkTitle) return true;
  return keywords.some(kw => titleLower.includes(kw.toLowerCase()));
}

export function addHeadline(
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
