import type { NewsSite, ParsedHeadline, JsonFieldMapping, ParseOptions } from './news-parser-types.js';
import { addHeadline, cleanTitle, cleanHtmlSnippet, parsePubDate, normalizeUrl } from './headline-utils.js';
import { fetchWithTimeout } from './news-fetch.js';
import { FETCH_TIMEOUT_MS, MAX_HEADLINES_PER_SITE } from '../../config/constants.js';
import { appLogger } from '../../config/logger.js';

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

function extractUrl(item: Record<string, unknown>, urlField: string): string | null {
  const value = extractStringField(item, urlField);
  return value.startsWith('http') ? value : null;
}

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

export async function parseJsonApi(site: NewsSite): Promise<ParsedHeadline[]> {
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
