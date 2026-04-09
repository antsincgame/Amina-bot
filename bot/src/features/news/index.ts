export type { NewsSite, ParsedHeadline, NewsPresetGroup } from './news-parser-types.js';

export { DEFAULT_AI_TECH_SOURCES } from './default-ai-tech-sources.js';

export { assertNewsSiteUrlIsSafe } from './news-host-validation.js';

export { normalizeNewsSite, normalizeNewsSites } from './news-site-normalize.js';

export { canonicalizeHeadlineUrl, buildHeadlineFingerprint } from './headline-utils.js';

export { getPresetSources, getPresetSourceCounts, mergeNewsSites } from './news-presets.js';

export { getConfiguredSites, saveConfiguredSites, clearParsedNewsCache } from './news-sites-storage.js';

export { parseNewsFromSite } from './parse-news-from-site.js';

export {
  dedupeParsedHeadlines,
  groupHeadlinesByCategory,
  countMergedDuplicates,
  filterByCategory,
  filterByLanguage,
} from './headline-dedupe.js';

export {
  setNewsParsingKilled,
  isNewsParsingKilled,
  parseAllConfiguredSites,
} from './parse-all-sites.js';
