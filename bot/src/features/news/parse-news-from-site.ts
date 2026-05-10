import { load } from 'cheerio';
import type { NewsSite, ParsedHeadline, ParseOptions } from './news-parser-types.js';
import { extractDomain, normalizeUrl } from './headline-utils.js';
import { fetchWithTimeout } from './news-fetch.js';
import { assertNewsSiteUrlIsSafe } from './news-host-validation.js';
import { parseJsonApi } from './parse-json-api.js';
import { parseRssFeed, tryRssFeed, isDirectFeedUrl, tryDirectFeed } from './parse-rss-feed.js';
import { parseHtmlContent } from './parse-html-generic.js';
import { dedupeParsedHeadlines } from './headline-dedupe.js';
import { FETCH_TIMEOUT_MS, NEWS_FEED_PROBE_TIMEOUT_MS } from '../../config/constants.js';
import { appLogger } from '../../config/logger.js';

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

  if (site.autoMode) {
    const allHeadlines: ParsedHeadline[] = [];
    const origin = new URL(siteUrl).origin;

    try {
      const rssSite = { ...site, type: 'rss' as const, autoMode: false };
      const rssHeadlines = await parseNewsFromSite(rssSite);
      if (rssHeadlines.length > 0) {
        allHeadlines.push(...rssHeadlines);
        appLogger.info({ siteUrl, rssCount: rssHeadlines.length }, 'Auto-mode: RSS channel');
      }
    } catch (err) {
      appLogger.debug({ error: err, siteUrl }, 'Auto-mode: RSS channel failed');
    }

    try {
      const response = await fetchWithTimeout(siteUrl, FETCH_TIMEOUT_MS);
      if (response.ok) {
        const html = await response.text();
        const htmlHeadlines = parseHtmlContent(html, siteUrl, origin, parseOptions);
        if (htmlHeadlines.length > 0) {
          allHeadlines.push(...htmlHeadlines);
          appLogger.info({ siteUrl, htmlCount: htmlHeadlines.length }, 'Auto-mode: HTML channel');
        }
      }
    } catch (err) {
      appLogger.debug({ error: err, siteUrl }, 'Auto-mode: HTML channel failed');
    }

    const deduped = dedupeParsedHeadlines(allHeadlines);
    appLogger.info({ siteUrl, totalDeduped: deduped.headlines.length, duplicatesFiltered: deduped.duplicatesFiltered, rawTotal: allHeadlines.length }, 'Auto-mode: merged results');
    return deduped.headlines;
  }

  if (site.type === 'json_api') {
    return parseJsonApi(site);
  }

  if (site.type === 'html_scrape') {
    const response = await fetchWithTimeout(siteUrl, FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const html = await response.text();
    const origin = new URL(siteUrl).origin;
    return parseHtmlContent(html, siteUrl, origin, parseOptions);
  }

  const origin = new URL(siteUrl).origin;

  if (isDirectFeedUrl(siteUrl)) {
    const directHeadlines = await tryDirectFeed(siteUrl, parseOptions);
    if (directHeadlines && directHeadlines.length > 0) return directHeadlines;
    appLogger.warn({ siteUrl }, 'Direct RSS feed URL returned no headlines');
  }

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
    } catch (err) {
      appLogger.debug({ error: err instanceof Error ? err.message : String(err), siteUrl }, 'RSS autodiscovery failed');
    }
  }

  try {
    const rssHeadlines = await tryRssFeed(siteUrl, parseOptions);
    if (rssHeadlines && rssHeadlines.length > 0) return rssHeadlines;
  } catch (err) {
    appLogger.debug({ error: err, siteUrl }, 'RSS feed attempt failed');
  }

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
