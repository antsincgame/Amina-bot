import type { ParsedHeadline } from './news-parser-types.js';
import {
  PARSED_NEWS_CACHE_TTL as PARSED_NEWS_CACHE_TTL_MS,
  NEWS_SITE_TIMEOUT_MS,
  NEWS_PARSE_BATCH_SIZE,
} from '../../config/constants.js';
import { getParsedNewsCache, setParsedNewsCache, getConfiguredSites } from './news-sites-storage.js';
import { parseNewsFromSite } from './parse-news-from-site.js';
import { dedupeParsedHeadlines, groupHeadlinesByCategory, countMergedDuplicates } from './headline-dedupe.js';
import { shouldSkipSite, recordSiteSuccess, recordSiteFailure } from './news-parser-constants.js';
import { withPromiseTimeout } from './news-fetch.js';
import { localizeParsedHeadlines } from '../news-localization.js';
import { enrichParsedHeadlineDescriptions } from '../news-description-enrichment.js';
import { filterHeadlinesForVibecoding } from '../news-vibecoding-filter.js';
import { appLogger } from '../../config/logger.js';

let newsParsingKilled = false;

export function setNewsParsingKilled(killed: boolean): void {
  newsParsingKilled = killed;
  appLogger.info({ killed }, killed ? '🛑 News parsing KILLED by admin' : '✅ News parsing RESUMED by admin');
}

export function isNewsParsingKilled(): boolean { return newsParsingKilled; }

export async function parseAllConfiguredSites(): Promise<ParsedHeadline[]> {
  if (newsParsingKilled) {
    appLogger.info('News parsing is killed by admin — returning empty');
    return [];
  }

  const cached = getParsedNewsCache();
  if (cached && Date.now() - cached.ts < PARSED_NEWS_CACHE_TTL_MS) {
    appLogger.debug({ cached: cached.headlines.length }, 'Returning cached news headlines');
    return cached.headlines;
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
    if (newsParsingKilled) {
      appLogger.info('News parsing kill-switch triggered mid-batch — aborting');
      return [];
    }
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
  const vibeFiltered = await filterHeadlinesForVibecoding(localizedHeadlines);
  const filteredHeadlines = vibeFiltered.filter(
    h => h.category !== 'city_local' && h.category !== 'uncategorized',
  );
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

  setParsedNewsCache({ headlines: filteredHeadlines, ts: Date.now() });
  return filteredHeadlines;
}
