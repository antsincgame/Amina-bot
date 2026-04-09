import type { NewsSite, NewsSourceCategory, NewsSourceLanguage, NewsSourceTier } from './news-parser-types.js';

export const SETTINGS_KEY = 'digest_news_sites';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const RSS_PATHS = ['/feed', '/rss', '/rss.xml', '/feed/rss', '/atom.xml', '/feed/atom', '/index.xml', '/rss/all', '/rss/new'];
export const NEWS_HOST_VALIDATION_TTL_MS = 10 * 60 * 1000;
export const MAX_FETCH_REDIRECTS = 5;

export const ARTICLE_URL_PATTERNS = [
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

export const DIRECT_FEED_PATTERNS = [
  /\/rss\/?$/i,
  /\/rss\/\w+\/?$/i,
  /\/feed\/?$/i,
  /\/feed\/\w+\/?$/i,
  /\/atom\.xml$/i,
  /\/rss\.xml$/i,
  /\/index\.xml$/i,
  /\/feed\.xml$/i,
];

export const SKIP_LINK_PATTERNS = [
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

export const TRACKING_QUERY_PARAMS = new Set([
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

export const VALID_TYPES: NewsSite['type'][] = ['rss', 'json_api', 'html_scrape'];
export const VALID_CATEGORIES: NewsSourceCategory[] = ['ai_tech', 'city_local', 'community', 'asia_tech'];
export const VALID_LANGUAGES: NewsSourceLanguage[] = ['ru', 'en', 'zh', 'ja', 'ko'];
export const VALID_TIERS: NewsSourceTier[] = ['tier1', 'tier2', 'tier3'];

export const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const normalizeSourceKey = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

export function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

const siteFailureTracker = new Map<string, { failures: number; lastFailAt: number }>();
const SITE_CB_THRESHOLD = 3;
const SITE_CB_COOLDOWN_MS = 30 * 60_000;

export function shouldSkipSite(url: string): boolean {
  const entry = siteFailureTracker.get(url);
  if (!entry || entry.failures < SITE_CB_THRESHOLD) return false;
  return Date.now() - entry.lastFailAt < SITE_CB_COOLDOWN_MS;
}

export function recordSiteSuccess(url: string): void {
  siteFailureTracker.delete(url);
}

export function recordSiteFailure(url: string): void {
  const entry = siteFailureTracker.get(url);
  siteFailureTracker.set(url, { failures: (entry?.failures ?? 0) + 1, lastFailAt: Date.now() });
  if (siteFailureTracker.size > 500) {
    const oldest = siteFailureTracker.keys().next().value;
    if (oldest) siteFailureTracker.delete(oldest);
  }
}
