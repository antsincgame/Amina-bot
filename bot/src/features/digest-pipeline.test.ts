import { describe, expect, it } from 'vitest';
import type { ParsedHeadline } from '../../../shared/types/index.js';
import {
  chunkHeadlinesForDigest,
  renderFallbackHeadlineBatch,
  shouldUseFallbackForDigestBatches,
} from './digest-scheduler.js';
import { getPresetSources, mergeNewsSites } from './news-parser.js';

function buildHeadline(index: number, overrides: Partial<ParsedHeadline> = {}): ParsedHeadline {
  return {
    title: `Headline ${index} about AI agents and vibecoding`,
    url: `https://example.com/news/${index}`,
    source: `Source ${index}`,
    category: 'ai_tech',
    language: 'en',
    ...overrides,
  };
}

describe('Digest pipeline — preset sync', () => {
  it('asia preset group includes korean sources and expanded catalog', () => {
    const asiaSources = getPresetSources('asia');

    expect(asiaSources.length).toBeGreaterThan(20);
    expect(asiaSources.some(site => site.language === 'ko')).toBe(true);
    expect(asiaSources.some(site => site.name === 'GeekNews')).toBe(true);
    expect(asiaSources.some(site => site.name === 'ITmedia AI+')).toBe(true);
  });

  it('mergeNewsSites preserves enabled flag and enriches metadata from catalog', () => {
    const existing = [
      {
        name: 'Qiita (AI)',
        url: 'https://qiita.com/api/v2/items?query=title:AI+OR+title:LLM+OR+title:ChatGPT+OR+title:GPT+OR+title:Copilot+OR+title:Cursor&per_page=60',
        enabled: false,
      },
    ];

    const merged = mergeNewsSites(existing, getPresetSources('asia'));
    const qiita = merged.find(site => site.name === 'Qiita (AI)');

    expect(qiita).toBeDefined();
    expect(qiita?.enabled).toBe(false);
    expect(qiita?.category).toBe('asia_tech');
    expect(qiita?.language).toBe('ja');
    expect(qiita?.jsonMapping?.titleField).toBe('title');
    expect(qiita?.filterKeywords?.length).toBeGreaterThan(0);
  });
});

describe('Digest pipeline — headline batching', () => {
  it('chunkHeadlinesForDigest keeps every headline and preserves order', () => {
    const headlines = Array.from({ length: 47 }, (_, index) => buildHeadline(index + 1));

    const batches = chunkHeadlinesForDigest(headlines);
    const flattened = batches.flatMap(batch => batch.headlines.map(headline => headline.url));

    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0]?.startNumber).toBe(1);
    expect(flattened).toEqual(headlines.map(headline => headline.url));
    expect(batches.reduce((sum, batch) => sum + batch.headlines.length, 0)).toBe(47);
  });

  it('renderFallbackHeadlineBatch keeps all markdown links in AI batch', () => {
    const headlines = [buildHeadline(1), buildHeadline(2), buildHeadline(3)];
    const batch = chunkHeadlinesForDigest(headlines)[0]!;

    const rendered = renderFallbackHeadlineBatch('Технологии и AI', 'ai', 0, 1, batch);

    expect(rendered).toContain('## Технологии и AI');
    expect(rendered).toContain(headlines[0].url);
    expect(rendered).toContain(headlines[1].url);
    expect(rendered).toContain(headlines[2].url);
  });

  it('renderFallbackHeadlineBatch keeps all markdown links in Asia batch', () => {
    const headlines = [
      buildHeadline(1, { title: '生成AIの最新動向', language: 'ja', category: 'asia_tech', url: 'https://example.jp/1' }),
      buildHeadline(2, { title: '바이브 코딩 도구 비교', language: 'ko', category: 'asia_tech', url: 'https://example.kr/2' }),
    ];
    const batch = chunkHeadlinesForDigest(headlines)[0]!;

    const rendered = renderFallbackHeadlineBatch('AI из Азии', 'asia', 0, 1, batch);

    expect(rendered).toContain('## AI из Азии');
    expect(rendered).toContain('https://example.jp/1');
    expect(rendered).toContain('https://example.kr/2');
    expect(rendered).toContain('生成AIの最新動向');
    expect(rendered).toContain('바이브 코딩 도구 비교');
  });

  it('switches to deterministic fallback when there are too many llm batches', () => {
    expect(shouldUseFallbackForDigestBatches(8)).toBe(false);
    expect(shouldUseFallbackForDigestBatches(9)).toBe(true);
  });

  it('supports larger fallback chunk sizing without losing ordering', () => {
    const headlines = Array.from({ length: 95 }, (_, index) => buildHeadline(index + 1));
    const batches = chunkHeadlinesForDigest(headlines, { maxItems: 42, maxChars: 11000 });
    const flattened = batches.flatMap(batch => batch.headlines.map(headline => headline.url));

    expect(batches.length).toBeLessThan(10);
    expect(flattened).toEqual(headlines.map(headline => headline.url));
  });
});
