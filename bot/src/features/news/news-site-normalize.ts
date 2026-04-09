import type { NewsSite, NewsSourceCategory, NewsSourceLanguage, NewsSourceTier, JsonFieldMapping, HtmlFieldMapping } from './news-parser-types.js';
import {
  VALID_TYPES,
  VALID_CATEGORIES,
  VALID_LANGUAGES,
  VALID_TIERS,
  isObjectRecord,
  normalizeSourceKey,
  normalizeStringArray,
} from './news-parser-constants.js';
import { getUnsafeNewsHostError } from './news-host-validation.js';

export function normalizeJsonMapping(mapping: unknown): JsonFieldMapping | undefined {
  if (!isObjectRecord(mapping)) return undefined;

  const itemsPath = typeof mapping.itemsPath === 'string' ? mapping.itemsPath.trim() : '';
  const titleField = typeof mapping.titleField === 'string' ? mapping.titleField.trim() : '';
  const urlField = typeof mapping.urlField === 'string' ? mapping.urlField.trim() : '';
  const dateField = typeof mapping.dateField === 'string' ? mapping.dateField.trim() : undefined;
  const descriptionField = typeof mapping.descriptionField === 'string' ? mapping.descriptionField.trim() : undefined;

  if (!titleField || !urlField) {
    throw new Error('jsonMapping must include titleField and urlField');
  }

  return {
    itemsPath,
    titleField,
    urlField,
    ...(dateField ? { dateField } : {}),
    ...(descriptionField ? { descriptionField } : {}),
  };
}

export function normalizeHtmlMapping(mapping: unknown): HtmlFieldMapping | undefined {
  if (!isObjectRecord(mapping)) return undefined;

  const itemSelectors = normalizeStringArray(Array.isArray(mapping.itemSelectors) ? mapping.itemSelectors.map(String) : undefined);
  const linkSelectors = normalizeStringArray(Array.isArray(mapping.linkSelectors) ? mapping.linkSelectors.map(String) : undefined);
  const titleSelectors = normalizeStringArray(Array.isArray(mapping.titleSelectors) ? mapping.titleSelectors.map(String) : undefined);
  const descriptionSelectors = normalizeStringArray(Array.isArray(mapping.descriptionSelectors) ? mapping.descriptionSelectors.map(String) : undefined);
  const dateSelectors = normalizeStringArray(Array.isArray(mapping.dateSelectors) ? mapping.dateSelectors.map(String) : undefined);
  const removeSelectors = normalizeStringArray(Array.isArray(mapping.removeSelectors) ? mapping.removeSelectors.map(String) : undefined);
  const dateAttribute = typeof mapping.dateAttribute === 'string' ? mapping.dateAttribute.trim() : undefined;

  if (!itemSelectors && !linkSelectors && !titleSelectors && !descriptionSelectors) {
    throw new Error('htmlMapping must include at least one selector array');
  }

  return {
    ...(itemSelectors ? { itemSelectors } : {}),
    ...(linkSelectors ? { linkSelectors } : {}),
    ...(titleSelectors ? { titleSelectors } : {}),
    ...(descriptionSelectors ? { descriptionSelectors } : {}),
    ...(dateSelectors ? { dateSelectors } : {}),
    ...(removeSelectors ? { removeSelectors } : {}),
    ...(dateAttribute ? { dateAttribute } : {}),
  };
}

export function normalizeNewsSite(site: NewsSite): NewsSite {
  const name = site.name?.trim();
  const url = site.url?.trim();
  if (!name) throw new Error('News site must have a name');
  if (!url) throw new Error('News site must have a url');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid news site URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported protocol in news site URL: ${url}`);
  }

  const hostValidationError = getUnsafeNewsHostError(parsedUrl.hostname);
  if (hostValidationError) {
    throw new Error(hostValidationError);
  }

  const normalizedType = typeof site.type === 'string' ? site.type.trim() as NewsSite['type'] : undefined;
  const normalizedCategory = typeof site.category === 'string' ? site.category.trim() as NewsSourceCategory : undefined;
  const normalizedLanguage = typeof site.language === 'string' ? site.language.trim() as NewsSourceLanguage : undefined;
  const normalizedTier = typeof site.tier === 'string' ? site.tier.trim() as NewsSourceTier : undefined;

  if (normalizedType && !VALID_TYPES.includes(normalizedType)) {
    throw new Error(`Invalid news site type: ${normalizedType}`);
  }
  if (normalizedCategory && !VALID_CATEGORIES.includes(normalizedCategory)) {
    throw new Error(`Invalid news site category: ${normalizedCategory}`);
  }
  if (normalizedLanguage && !VALID_LANGUAGES.includes(normalizedLanguage)) {
    throw new Error(`Invalid news site language: ${normalizedLanguage}`);
  }
  if (normalizedTier && !VALID_TIERS.includes(normalizedTier)) {
    throw new Error(`Invalid news site tier: ${normalizedTier}`);
  }

  const jsonMapping = normalizeJsonMapping(site.jsonMapping);
  const htmlMapping = normalizeHtmlMapping(site.htmlMapping);
  const filterKeywords = normalizeStringArray(site.filterKeywords);

  return {
    name,
    url,
    enabled: site.enabled !== false,
    ...(normalizedType ? { type: normalizedType } : {}),
    ...(normalizedCategory ? { category: normalizedCategory } : {}),
    ...(normalizedLanguage ? { language: normalizedLanguage } : {}),
    ...(normalizedTier ? { tier: normalizedTier } : {}),
    ...(jsonMapping ? { jsonMapping } : {}),
    ...(htmlMapping ? { htmlMapping } : {}),
    ...(filterKeywords ? { filterKeywords } : {}),
    ...(site.autoMode ? { autoMode: true } : {}),
  };
}

export function normalizeNewsSites(sites: NewsSite[]): NewsSite[] {
  const byUrl = new Map<string, NewsSite>();
  for (const site of sites) {
    const normalized = normalizeNewsSite(site);
    byUrl.set(normalizeSourceKey(normalized.url), normalized);
  }
  return [...byUrl.values()];
}
