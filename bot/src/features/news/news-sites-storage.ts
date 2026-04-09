import type { NewsSite, ParsedHeadline } from './news-parser-types.js';
import { SETTINGS_KEY, isObjectRecord } from './news-parser-constants.js';
import { normalizeNewsSite, normalizeNewsSites } from './news-site-normalize.js';
import { settingsRepo } from '../../db/index.js';
import { appLogger } from '../../config/logger.js';

interface ParsedNewsCacheEntry {
  headlines: ParsedHeadline[];
  ts: number;
}

let parsedNewsCache: ParsedNewsCacheEntry | null = null;

export function clearParsedNewsCache(): void {
  parsedNewsCache = null;
}

export function getParsedNewsCache(): ParsedNewsCacheEntry | null {
  return parsedNewsCache;
}

export function setParsedNewsCache(entry: ParsedNewsCacheEntry): void {
  parsedNewsCache = entry;
}

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
  settingsRepo.invalidateCache?.();
  clearParsedNewsCache();
}
