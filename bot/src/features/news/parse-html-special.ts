import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { ParsedHeadline, ParseOptions } from './news-parser-types.js';
import { addHeadline, cleanTitle, normalizeUrl } from './headline-utils.js';
import { MAX_HEADLINES_PER_SITE } from '../../config/constants.js';
import { appLogger } from '../../config/logger.js';

export function parseGitHubTrending(html: string, options?: ParseOptions): ParsedHeadline[] {
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

export function parseTldrArchives(html: string, baseUrl: string, options?: ParseOptions): ParsedHeadline[] {
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
