import type { NewsSite, NewsPresetGroup } from './news-parser-types.js';
import { normalizeSourceKey } from './news-parser-constants.js';
import { DEFAULT_AI_TECH_SOURCES } from './default-ai-tech-sources.js';
import { normalizeNewsSites } from './news-site-normalize.js';

export function getPresetSources(group: NewsPresetGroup = 'all'): NewsSite[] {
  const all = normalizeNewsSites(DEFAULT_AI_TECH_SOURCES);
  if (group === 'all') return all;
  if (group === 'asia') return all.filter(site => site.category === 'asia_tech');
  return all.filter(site => site.category !== 'asia_tech');
}

export function getPresetSourceCounts(): Record<NewsPresetGroup, number> {
  return {
    all: getPresetSources('all').length,
    global: getPresetSources('global').length,
    asia: getPresetSources('asia').length,
  };
}

export function mergeNewsSites(existing: NewsSite[], incoming: NewsSite[]): NewsSite[] {
  const merged = new Map<string, NewsSite>();

  for (const site of normalizeNewsSites(existing)) {
    merged.set(normalizeSourceKey(site.url), site);
  }

  for (const preset of normalizeNewsSites(incoming)) {
    const key = normalizeSourceKey(preset.url);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, preset);
      continue;
    }

    merged.set(key, {
      ...current,
      ...preset,
      enabled: current.enabled,
      jsonMapping: preset.jsonMapping ?? current.jsonMapping,
      htmlMapping: preset.htmlMapping ?? current.htmlMapping,
      filterKeywords: preset.filterKeywords ?? current.filterKeywords,
    });
  }

  return [...merged.values()];
}
