import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { ParsedHeadline, ParseOptions, NewsSourceCategory, NewsSourceLanguage } from './news-parser-types.js';
import { addHeadline, cleanTitle, cleanHtmlSnippet, parsePubDate, normalizeUrl } from './headline-utils.js';
import { fetchWithTimeout } from './news-fetch.js';
import { RSS_PATHS, DIRECT_FEED_PATTERNS } from './news-parser-constants.js';
import { NEWS_FEED_PROBE_TIMEOUT_MS, MAX_HEADLINES_PER_SITE } from '../../config/constants.js';
import { appLogger } from '../../config/logger.js';

export function parseRssFeed(
  xml: string,
  baseUrl: string,
  options?: ParseOptions,
): ParsedHeadline[] {
  const $ = load(xml, { xml: true });
  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();

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

export async function tryRssFeed(
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

export function isDirectFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return DIRECT_FEED_PATTERNS.some(p => p.test(parsed.pathname));
  } catch {
    return false;
  }
}

export async function tryDirectFeed(
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
