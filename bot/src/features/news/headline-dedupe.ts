import type { ParsedHeadline, ParsedHeadlineCategory, NewsSourceTier, NewsSourceCategory, NewsSourceLanguage } from './news-parser-types.js';
import { cleanTitle } from './headline-utils.js';
import { hasMostlyRussianText } from '../news-localization.js';
import { isWeakHeadlineDescription } from '../news-description-enrichment.js';

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

export function filterByCategory(headlines: ParsedHeadline[], category: NewsSourceCategory): ParsedHeadline[] {
  return headlines.filter(h => h.category === category);
}

export function filterByLanguage(headlines: ParsedHeadline[], language: NewsSourceLanguage): ParsedHeadline[] {
  return headlines.filter(h => h.language === language);
}
