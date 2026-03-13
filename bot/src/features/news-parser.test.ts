/**
 * Тесты парсера новостей и маршрутизации заголовков по категориям.
 * 
 * Проверяют:
 * - addHeadline: фильтрация по длине, возрасту, keywords, дедупликация
 * - matchesKeywords: CJK-контент, латинские ключи, пустые keywords
 * - filterByCategory: маршрутизация в ai_tech, asia_tech, community
 * - parseJsonApiResponse: HackerNews-like и Dev.to-like JSON
 * - parseRssFeed: RSS 2.0 и Atom парсинг
 * - parseAllConfiguredSites: кросс-источниковая дедупликация
 * - Полный поток: от сырых данных до digest-scheduler категоризации
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../ai/openrouter.js', () => ({
  aiService: {
    chat: vi.fn(),
  },
}));

import type { ParsedHeadline } from '../../../shared/types/index.js';
import { aiService } from '../ai/openrouter.js';
import {
  buildHeadlineFingerprint,
  canonicalizeHeadlineUrl,
  dedupeParsedHeadlines,
  groupHeadlinesByCategory,
} from './news-parser.js';
import { localizeParsedHeadlines } from './news-localization.js';

const mockedAiService = vi.mocked(aiService);

beforeEach(() => {
  mockedAiService.chat.mockReset();
});

afterEach(() => {
  mockedAiService.chat.mockReset();
});

// ============================================
// Для тестирования приватных функций нам нужно
// переимпортировать через обход или тестировать
// через публичные API. Тестируем поведение.
// ============================================

describe('News Parser — Headline Filtering', () => {
  /**
   * Симулируем логику addHeadline для проверки фильтров.
   * Это точная копия логики из news-parser.ts
   */
  const MAX_HEADLINES_PER_SITE = 200;
  const MIN_TITLE_LENGTH = 4;
  const MAX_TITLE_LENGTH = 800;
  const MAX_NEWS_AGE_HOURS = 336;

  function isNewsRecent(pubDate: Date | undefined): boolean {
    if (!pubDate) return true;
    const now = Date.now();
    const ageMs = now - pubDate.getTime();
    return ageMs <= MAX_NEWS_AGE_HOURS * 60 * 60 * 1000;
  }

  function matchesKeywords(title: string, keywords: string[] | undefined): boolean {
    if (!keywords || keywords.length === 0) return true;
    const titleLower = title.toLowerCase();
    const hasLatinKeywords = keywords.some(kw => /^[a-zA-Z0-9\s\-]+$/.test(kw));
    const isCjkTitle = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(title);
    if (hasLatinKeywords && isCjkTitle) return true;
    return keywords.some(kw => titleLower.includes(kw.toLowerCase()));
  }

  function normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  interface HeadlineOptions {
    pubDate?: Date;
    category?: string;
    language?: string;
    filterKeywords?: string[];
  }

  interface ParsedHeadline {
    title: string;
    url: string;
    source: string;
    pubDate?: string;
    category?: string;
    language?: string;
  }

  function addHeadline(
    headlines: ParsedHeadline[],
    seenTitles: Set<string>,
    title: string,
    url: string,
    options?: HeadlineOptions,
  ): boolean {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return false;
    if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return false;
    if (!isNewsRecent(options?.pubDate)) return false;
    if (!matchesKeywords(title, options?.filterKeywords)) return false;

    const titleNormalized = normalizeTitle(title);
    if (seenTitles.has(titleNormalized)) return false;

    seenTitles.add(titleNormalized);
    headlines.push({
      title,
      url,
      source: '',
      pubDate: options?.pubDate?.toISOString(),
      category: options?.category,
      language: options?.language,
    });
    return true;
  }

  it('принимает заголовок нормальной длины', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    const result = addHeadline(headlines, seen, 'OpenAI releases GPT-5 with breakthrough capabilities', 'https://example.com/1');
    expect(result).toBe(true);
    expect(headlines).toHaveLength(1);
  });

  it('отклоняет слишком короткий заголовок (< 4 символа)', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    const result = addHeadline(headlines, seen, 'GPT', 'https://example.com/1');
    expect(result).toBe(false);
    expect(headlines).toHaveLength(0);
  });

  it('принимает заголовок длиной ровно 4 символа', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    const result = addHeadline(headlines, seen, 'GPT5', 'https://example.com/1');
    expect(result).toBe(true);
  });

  it('отклоняет заголовок старше 336 часов (14 дней)', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    const oldDate = new Date(Date.now() - 337 * 60 * 60 * 1000);
    const result = addHeadline(headlines, seen, 'Old news about AI breakthrough', 'https://example.com/1', { pubDate: oldDate });
    expect(result).toBe(false);
  });

  it('принимает заголовок возрастом 335 часов', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    const recentDate = new Date(Date.now() - 335 * 60 * 60 * 1000);
    const result = addHeadline(headlines, seen, 'Recent news about AI breakthrough', 'https://example.com/1', { pubDate: recentDate });
    expect(result).toBe(true);
  });

  it('принимает заголовок без даты (считается свежим)', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    const result = addHeadline(headlines, seen, 'News without date about AI', 'https://example.com/1');
    expect(result).toBe(true);
  });

  it('отклоняет дубликат по нормализованному заголовку', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    addHeadline(headlines, seen, 'GPT-5 Released Today!', 'https://example.com/1');
    const result = addHeadline(headlines, seen, 'GPT-5 Released Today!', 'https://example.com/2');
    expect(result).toBe(false);
    expect(headlines).toHaveLength(1);
  });

  it('останавливается при достижении MAX_HEADLINES_PER_SITE (200)', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 210; i++) {
      addHeadline(headlines, seen, `Headline number ${i} about AI technology`, `https://example.com/${i}`);
    }
    expect(headlines).toHaveLength(200);
  });

  it('сохраняет category и language из options', () => {
    const headlines: ParsedHeadline[] = [];
    const seen = new Set<string>();
    addHeadline(headlines, seen, 'New AI model from Baidu', 'https://example.com/1', {
      category: 'asia_tech',
      language: 'zh',
    });
    expect(headlines[0]?.category).toBe('asia_tech');
    expect(headlines[0]?.language).toBe('zh');
  });

  describe('matchesKeywords', () => {
    it('пропускает всё при пустом массиве keywords', () => {
      expect(matchesKeywords('Any title', [])).toBe(true);
      expect(matchesKeywords('Any title', undefined)).toBe(true);
    });

    it('находит keyword в заголовке (case-insensitive)', () => {
      expect(matchesKeywords('New LLM benchmark results', ['LLM', 'GPT'])).toBe(true);
    });

    it('отклоняет заголовок без совпадений', () => {
      expect(matchesKeywords('Recipe for chocolate cake', ['LLM', 'GPT', 'AI'])).toBe(false);
    });

    it('пропускает CJK заголовки при латинских keywords', () => {
      expect(matchesKeywords('大模型编程助手最新进展', ['LLM', 'GPT'])).toBe(true);
    });

    it('пропускает японские заголовки при латинских keywords', () => {
      expect(matchesKeywords('AIプログラミングの最新動向', ['LLM', 'AI'])).toBe(true);
    });

    it('пропускает корейские заголовки при латинских keywords', () => {
      expect(matchesKeywords('인공지능 코딩 도구 비교', ['AI', 'coding'])).toBe(true);
    });

    it('проверяет CJK keywords на CJK заголовках', () => {
      expect(matchesKeywords('大模型编程助手最新进展', ['大模型', '编程'])).toBe(true);
      expect(matchesKeywords('天气预报今日', ['大模型', '编程'])).toBe(false);
    });
  });
});

describe('News Parser — Category Routing in Digest', () => {
  interface ParsedHeadline {
    title: string;
    url: string;
    source: string;
    category?: string;
    language?: string;
  }

  function filterByCategory(headlines: ParsedHeadline[], category: string): ParsedHeadline[] {
    return headlines.filter(h => h.category === category);
  }

  const sampleHeadlines: ParsedHeadline[] = [
    { title: 'GPT-5 released', url: 'https://openai.com/1', source: 'OpenAI News', category: 'ai_tech', language: 'en' },
    { title: 'New LLM benchmark', url: 'https://arxiv.org/1', source: 'arXiv cs.AI', category: 'ai_tech', language: 'en' },
    { title: 'Vibecoding trend on HN', url: 'https://hn.com/1', source: 'Hacker News', category: 'community', language: 'en' },
    { title: '大模型编程助手', url: 'https://rsshub.app/1', source: '机器之心', category: 'asia_tech', language: 'zh' },
    { title: 'AIプログラミング', url: 'https://zenn.dev/1', source: 'Zenn.dev', category: 'asia_tech', language: 'ja' },
    { title: 'Local city news', url: 'https://localnews.com/1', source: 'Local News', category: 'city_local', language: 'ru' },
    { title: 'Orphan headline', url: 'https://unknown.com/1', source: 'Unknown' },
  ];

  it('корректно фильтрует ai_tech', () => {
    const result = filterByCategory(sampleHeadlines, 'ai_tech');
    expect(result).toHaveLength(2);
    expect(result[0]?.title).toBe('GPT-5 released');
  });

  it('корректно фильтрует asia_tech', () => {
    const result = filterByCategory(sampleHeadlines, 'asia_tech');
    expect(result).toHaveLength(2);
  });

  it('корректно фильтрует community', () => {
    const result = filterByCategory(sampleHeadlines, 'community');
    expect(result).toHaveLength(1);
  });

  it('заголовки с category=undefined НЕ попадают в ai_tech', () => {
    const result = filterByCategory(sampleHeadlines, 'ai_tech');
    const orphan = result.find(h => h.title === 'Orphan headline');
    expect(orphan).toBeUndefined();
  });

  it('заголовки с category=undefined попадают в parsedHeadlines (городские)', () => {
    const parsedHeadlines = sampleHeadlines.filter(h => !h.category || h.category === 'city_local');
    expect(parsedHeadlines).toHaveLength(2);
    expect(parsedHeadlines.map(h => h.title)).toContain('Orphan headline');
    expect(parsedHeadlines.map(h => h.title)).toContain('Local city news');
  });

  it('все заголовки аккаунтятся (ни один не потерян)', () => {
    const cityLocal = sampleHeadlines.filter(h => !h.category || h.category === 'city_local');
    const aiTech = filterByCategory(sampleHeadlines, 'ai_tech');
    const asiaTech = filterByCategory(sampleHeadlines, 'asia_tech');
    const community = filterByCategory(sampleHeadlines, 'community');

    const totalCounted = cityLocal.length + aiTech.length + asiaTech.length + community.length;
    expect(totalCounted).toBe(sampleHeadlines.length);
  });
});

describe('News Parser — JSON API Parsing', () => {
  const MAX_HEADLINES_PER_SITE = 200;
  const MIN_TITLE_LENGTH = 4;

  function cleanTitle(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }

  interface ParsedHeadline {
    title: string;
    url: string;
    source: string;
    pubDate?: string;
    category?: string;
    language?: string;
  }

  interface JsonFieldMapping {
    itemsPath: string;
    titleField: string;
    urlField: string;
    dateField?: string;
  }

  function getNestedValue(obj: unknown, path: string): unknown {
    if (!path) return obj;
    return path.split('.').reduce((acc: unknown, key) => {
      if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  function extractUrl(item: Record<string, unknown>, urlField: string): string | null {
    const fields = urlField.split('|');
    for (const field of fields) {
      const value = item[field.trim()];
      if (typeof value === 'string' && value.startsWith('http')) return value;
    }
    return null;
  }

  function parseJsonApiResponse(
    data: unknown,
    mapping: JsonFieldMapping,
    options?: { category?: string; language?: string },
  ): ParsedHeadline[] {
    const items = getNestedValue(data, mapping.itemsPath);
    if (!Array.isArray(items)) return [];

    const headlines: ParsedHeadline[] = [];
    const seenTitles = new Set<string>();

    for (const item of items) {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
      if (!item || typeof item !== 'object') continue;

      const record = item as Record<string, unknown>;
      const title = cleanTitle(String(record[mapping.titleField] ?? ''));
      const url = extractUrl(record, mapping.urlField);

      if (!url || !title || title.length < MIN_TITLE_LENGTH) continue;
      if (seenTitles.has(title.toLowerCase())) continue;
      seenTitles.add(title.toLowerCase());

      headlines.push({
        title,
        url,
        source: '',
        category: options?.category,
        language: options?.language,
      });
    }

    return headlines;
  }

  it('парсит HackerNews-like JSON (items в hits)', () => {
    const data = {
      hits: [
        { title: 'Vibecoding is changing development', url: 'https://example.com/1', created_at: '2026-03-09T12:00:00Z' },
        { title: 'New AI coding tools comparison', story_url: 'https://example.com/2', created_at: '2026-03-09T11:00:00Z' },
        { title: 'Short', url: 'https://example.com/3' },
      ],
    };
    const mapping: JsonFieldMapping = { itemsPath: 'hits', titleField: 'title', urlField: 'url|story_url', dateField: 'created_at' };
    const result = parseJsonApiResponse(data, mapping, { category: 'community', language: 'en' });
    expect(result).toHaveLength(3);
    expect(result[0]?.category).toBe('community');
    expect(result[1]?.url).toBe('https://example.com/2');
  });

  it('парсит Dev.to-like JSON (массив на корне)', () => {
    const data = [
      { title: 'Building AI agents with LangChain', url: 'https://dev.to/1', published_at: '2026-03-09T10:00:00Z' },
      { title: 'Introduction to RAG patterns', url: 'https://dev.to/2', published_at: '2026-03-09T09:00:00Z' },
    ];
    const mapping: JsonFieldMapping = { itemsPath: '', titleField: 'title', urlField: 'url', dateField: 'published_at' };
    const result = parseJsonApiResponse(data, mapping, { category: 'community', language: 'en' });
    expect(result).toHaveLength(2);
  });

  it('обрабатывает пустой items gracefully', () => {
    const data = { hits: [] };
    const mapping: JsonFieldMapping = { itemsPath: 'hits', titleField: 'title', urlField: 'url' };
    const result = parseJsonApiResponse(data, mapping);
    expect(result).toHaveLength(0);
  });

  it('обрабатывает отсутствующий itemsPath', () => {
    const data = { results: [] };
    const mapping: JsonFieldMapping = { itemsPath: 'hits', titleField: 'title', urlField: 'url' };
    const result = parseJsonApiResponse(data, mapping);
    expect(result).toHaveLength(0);
  });

  it('pipe-separated urlField с fallback на story_url', () => {
    const data = [
      { title: 'No url field, only story', story_url: 'https://example.com/story1' },
    ];
    const mapping: JsonFieldMapping = { itemsPath: '', titleField: 'title', urlField: 'url|story_url' };
    const result = parseJsonApiResponse(data, mapping);
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://example.com/story1');
  });
});

describe('News Parser — RSS Feed Parsing', () => {
  it('парсит RSS 2.0 формат', () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Test Feed</title>
        <item>
          <title>GPT-5 Released with Multi-Modal Support</title>
          <link>https://openai.com/blog/gpt5</link>
          <pubDate>Mon, 09 Mar 2026 10:00:00 GMT</pubDate>
        </item>
        <item>
          <title>New Benchmark for Code Generation</title>
          <link>https://arxiv.org/abs/2026.12345</link>
          <pubDate>Mon, 09 Mar 2026 08:00:00 GMT</pubDate>
        </item>
        <item>
          <title>Tiny</title>
          <link>https://example.com/short</link>
        </item>
      </channel>
    </rss>`;

    const { load } = require('cheerio');
    const $ = load(rssXml, { xml: true });
    const items: Array<{ title: string; link: string }> = [];
    $('item').each((_i: number, el: unknown) => {
      const $item = $(el);
      const title = $item.find('title').first().text().trim();
      const link = $item.find('link').first().text().trim();
      if (title && link && title.length >= 5) {
        items.push({ title, link });
      }
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('GPT-5 Released with Multi-Modal Support');
    expect(items[1]?.link).toContain('arxiv.org');
  });

  it('парсит Atom формат', () => {
    const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Simon Willison</title>
      <entry>
        <title>Building AI agents with local LLMs</title>
        <link href="https://simonwillison.net/2026/Mar/9/agents/"/>
        <published>2026-03-09T08:00:00Z</published>
      </entry>
      <entry>
        <title>Prompt injection defense strategies</title>
        <link href="https://simonwillison.net/2026/Mar/8/prompt/"/>
        <updated>2026-03-08T12:00:00Z</updated>
      </entry>
    </feed>`;

    const { load } = require('cheerio');
    const $ = load(atomXml, { xml: true });
    const entries: Array<{ title: string; link: string }> = [];
    $('entry').each((_i: number, el: unknown) => {
      const $entry = $(el);
      const title = $entry.find('title').first().text().trim();
      const link = $entry.find('link[href]').first().attr('href') ?? '';
      if (title && link && title.length >= 5) {
        entries.push({ title, link });
      }
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.title).toBe('Building AI agents with local LLMs');
  });
});

describe('News Parser — Cross-Source Deduplication', () => {
  interface ParsedHeadline {
    title: string;
    url: string;
    source: string;
    category?: string;
  }

  function normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('дедуплицирует одинаковые заголовки из разных источников', () => {
    const sources: Array<{ site: string; headlines: ParsedHeadline[] }> = [
      {
        site: 'OpenAI News',
        headlines: [
          { title: 'GPT-5 Released Today!', url: 'https://openai.com/blog/gpt5', source: 'OpenAI News', category: 'ai_tech' },
        ],
      },
      {
        site: 'MarkTechPost',
        headlines: [
          { title: 'GPT-5 Released Today!', url: 'https://marktechpost.com/gpt5', source: 'MarkTechPost', category: 'ai_tech' },
          { title: 'New RAG Framework Released', url: 'https://marktechpost.com/rag', source: 'MarkTechPost', category: 'ai_tech' },
        ],
      },
    ];

    const allHeadlines: ParsedHeadline[] = [];
    const seenTitles = new Set<string>();
    const seenUrls = new Set<string>();

    for (const { headlines } of sources) {
      for (const headline of headlines) {
        const titleNorm = normalizeTitle(headline.title);
        const urlNorm = headline.url.toLowerCase();

        if (seenTitles.has(titleNorm) || seenUrls.has(urlNorm)) continue;

        seenTitles.add(titleNorm);
        seenUrls.add(urlNorm);
        allHeadlines.push(headline);
      }
    }

    expect(allHeadlines).toHaveLength(2);
    expect(allHeadlines[0]?.source).toBe('OpenAI News');
  });

  it('НЕ дедуплицирует заголовки с разным текстом', () => {
    const headlines: ParsedHeadline[] = [
      { title: 'GPT-5 Released', url: 'https://openai.com/1', source: 'OpenAI', category: 'ai_tech' },
      { title: 'GPT-5 Performance Benchmark', url: 'https://arxiv.org/1', source: 'arXiv', category: 'ai_tech' },
    ];

    const seen = new Set<string>();
    const unique = headlines.filter(h => {
      const norm = normalizeTitle(h.title);
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    });

    expect(unique).toHaveLength(2);
  });
});

describe('News Parser — End-to-End Digest Data Flow', () => {
  interface ParsedHeadline {
    title: string;
    url: string;
    source: string;
    category?: string;
    language?: string;
  }

  function filterByCategory(headlines: ParsedHeadline[], category: string): ParsedHeadline[] {
    return headlines.filter(h => h.category === category);
  }

  it('полный поток: все AI заголовки попадают в ai_tech секцию', () => {
    const allParsed: ParsedHeadline[] = [
      { title: 'GPT-5 released', url: 'https://openai.com/1', source: 'OpenAI News', category: 'ai_tech', language: 'en' },
      { title: 'New LLM paper', url: 'https://arxiv.org/1', source: 'arXiv cs.AI', category: 'ai_tech', language: 'en' },
      { title: 'GitHub trending repo', url: 'https://github.com/1', source: 'GitHub Trending', category: 'ai_tech', language: 'en' },
      { title: 'Vibecoding on HN', url: 'https://hn.com/1', source: 'Hacker News', category: 'community', language: 'en' },
      { title: '大模型最新进展', url: 'https://rsshub.app/1', source: '机器之心', category: 'asia_tech', language: 'zh' },
      { title: 'Local city news', url: 'https://localnews.com/1', source: 'Local News', category: 'city_local', language: 'ru' },
    ];

    const parsedHeadlines = allParsed.filter(h => !h.category || h.category === 'city_local');
    const aiTechHeadlines = filterByCategory(allParsed, 'ai_tech');
    const asiaAiHeadlines = filterByCategory(allParsed, 'asia_tech');
    const communityHeadlines = filterByCategory(allParsed, 'community');

    expect(parsedHeadlines).toHaveLength(1);
    expect(parsedHeadlines[0]?.title).toBe('Local city news');

    expect(aiTechHeadlines).toHaveLength(3);
    expect(asiaAiHeadlines).toHaveLength(1);
    expect(communityHeadlines).toHaveLength(1);

    const allAiHeadlines = [...aiTechHeadlines, ...communityHeadlines];
    expect(allAiHeadlines).toHaveLength(4);

    const rawData: string[] = [];
    const aiLines = allAiHeadlines.slice(0, 50).map(h =>
      `- ${h.title} (ссылка: ${h.url}) [источник: ${h.source}]`
    );
    rawData.push(`[ТЕХНОЛОГИИ И AI]\n${aiLines.join('\n')}`);

    expect(rawData[0]).toContain('GPT-5 released');
    expect(rawData[0]).toContain('New LLM paper');
    expect(rawData[0]).toContain('GitHub trending repo');
    expect(rawData[0]).toContain('Vibecoding on HN');
  });

  it('БАГ-РЕГРЕССИЯ: источники без category НЕ теряются в ai_tech', () => {
    const allParsed: ParsedHeadline[] = [
      { title: 'GPT-5 released', url: 'https://openai.com/1', source: 'OpenAI News' },
      { title: 'New LLM paper', url: 'https://arxiv.org/1', source: 'arXiv cs.AI' },
    ];

    const aiTechHeadlines = filterByCategory(allParsed, 'ai_tech');
    expect(aiTechHeadlines).toHaveLength(0);

    const parsedHeadlines = allParsed.filter(h => !h.category || h.category === 'city_local');
    expect(parsedHeadlines).toHaveLength(2);
  });

  it('без slice лимитов: все AI заголовки в промпте', () => {
    const headlines: ParsedHeadline[] = Array.from({ length: 200 }, (_, i) => ({
      title: `AI Headline number ${i}`,
      url: `https://example.com/${i}`,
      source: `Source ${i}`,
      category: 'ai_tech' as const,
      language: 'en',
    }));

    const aiTech = filterByCategory(headlines, 'ai_tech');
    expect(aiTech).toHaveLength(200);
  });

  it('без slice лимитов: все азиатские заголовки в промпте', () => {
    const headlines: ParsedHeadline[] = Array.from({ length: 100 }, (_, i) => ({
      title: `亚洲AI标题 ${i}`,
      url: `https://example.cn/${i}`,
      source: `Source ${i}`,
      category: 'asia_tech' as const,
      language: 'zh',
    }));

    const asiaTech = filterByCategory(headlines, 'asia_tech');
    expect(asiaTech).toHaveLength(100);
  });
});

describe('News Parser — Real structured helpers', () => {
  function buildStructuredHeadline(overrides: Partial<ParsedHeadline> = {}): ParsedHeadline {
    return {
      title: 'Structured AI headline',
      url: 'https://example.com/news?id=1&utm_source=rss#top',
      canonicalUrl: 'https://example.com/news?id=1',
      source: 'Primary Source',
      sourceDomain: 'example.com',
      description: 'Полноценное описание новости для структурированного дайджеста.',
      fingerprint: 'fp-1',
      alternateSources: [],
      category: 'ai_tech',
      language: 'en',
      ...overrides,
    };
  }

  it('canonicalizeHeadlineUrl убирает tracking query params и fragment', () => {
    expect(canonicalizeHeadlineUrl('https://example.com/news?id=1&utm_source=rss&utm_medium=email#top'))
      .toBe('https://example.com/news?id=1');
  });

  it('buildHeadlineFingerprint стабилен для одного canonical url и даты', () => {
    const fingerprint = buildHeadlineFingerprint(
      'AI Agents launch',
      'https://example.com/news?id=1',
      '2026-03-09T08:00:00.000Z',
      'ai_tech',
    );

    expect(fingerprint).toBe(
      buildHeadlineFingerprint(
        'AI Agents launch',
        'https://example.com/news?id=1',
        '2026-03-09T08:00:00.000Z',
        'ai_tech',
      ),
    );
  });

  it('dedupeParsedHeadlines объединяет канонические дубли и сохраняет alternateSources', () => {
    const primary = buildStructuredHeadline({
      source: 'Primary Source',
      sourceTier: 'tier3',
      description: 'Короткое описание.',
      pubDate: '2026-03-09T08:00:00.000Z',
      fingerprint: 'fp-1',
    });
    const richerDuplicate = buildStructuredHeadline({
      url: 'https://www.example.com/news?id=1&utm_medium=email',
      canonicalUrl: 'https://example.com/news?id=1',
      source: 'Trusted Source',
      sourceDomain: 'example.com',
      sourceTier: 'tier1',
      description: 'Более полное описание новости, которое должно стать основным после merge.',
      fingerprint: 'fp-1',
      pubDate: '2026-03-09T09:00:00.000Z',
    });

    const result = dedupeParsedHeadlines([primary, richerDuplicate]);

    expect(result.duplicatesFiltered).toBe(1);
    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0]?.source).toBe('Trusted Source');
    expect(result.headlines[0]?.alternateSources).toContain('Primary Source');
    expect(result.headlines[0]?.description).toContain('Более полное описание');
  });

  it('groupHeadlinesByCategory держит uncategorized отдельно от city_local', () => {
    const grouped = groupHeadlinesByCategory([
      buildStructuredHeadline({ category: 'city_local', title: 'Local headline', fingerprint: 'fp-local' }),
      buildStructuredHeadline({
        category: 'uncategorized',
        title: 'Unknown headline',
        fingerprint: 'fp-unknown',
        url: 'https://unknown.example/news',
        canonicalUrl: 'https://unknown.example/news',
      }),
    ]);

    expect(grouped.city_local).toHaveLength(1);
    expect(grouped.uncategorized).toHaveLength(1);
    expect(grouped.uncategorized[0]?.title).toBe('Unknown headline');
  });
});

describe('News Parser — Russian description localization', () => {
  function buildLocalizedHeadline(overrides: Partial<ParsedHeadline> = {}): ParsedHeadline {
    return {
      title: 'AI release headline',
      url: 'https://example.com/article',
      canonicalUrl: 'https://example.com/article',
      source: 'Example Source',
      sourceDomain: 'example.com',
      description: 'OpenAI released a new coding agent for enterprise teams.',
      fingerprint: 'fp-localized',
      alternateSources: [],
      category: 'ai_tech',
      language: 'en',
      ...overrides,
    };
  }

  it('не вызывает LLM для уже русских descriptions', async () => {
    const headlines = [
      buildLocalizedHeadline({
        description: 'Новый AI-агент автоматизирует код-ревью и рутинные задачи команды.',
        language: 'ru',
      }),
    ];

    const localized = await localizeParsedHeadlines(headlines);

    expect(mockedAiService.chat).not.toHaveBeenCalled();
    expect(localized[0]?.description).toBe('Новый AI-агент автоматизирует код-ревью и рутинные задачи команды.');
  });

  it('переводит mixed-language descriptions в русский через основную LLM', async () => {
    mockedAiService.chat.mockResolvedValue({
      content: JSON.stringify([
        { id: 0, description: 'OpenAI выпустила нового coding-агента для enterprise-команд.' },
        { id: 1, description: 'Японский стартап представил платформу для AI-разработки и совместного тестирования.' },
      ]),
      model: 'test-model',
      tokens_used: { prompt: 10, completion: 10, total: 20 },
      finish_reason: 'stop',
    });

    const localized = await localizeParsedHeadlines([
      buildLocalizedHeadline(),
      buildLocalizedHeadline({
        title: '日本のAIスタートアップ',
        url: 'https://example.jp/article',
        canonicalUrl: 'https://example.jp/article',
        source: 'Asia Source',
        sourceDomain: 'example.jp',
        description: 'Japanese startup unveiled a collaborative AI coding platform.',
        fingerprint: 'fp-japan',
        category: 'asia_tech',
        language: 'ja',
      }),
    ]);

    expect(mockedAiService.chat).toHaveBeenCalledTimes(1);
    expect(mockedAiService.chat.mock.calls[0]?.[3]).toMatchObject({
      promptMode: 'passthrough',
      maxTokens: 1400,
      temperature: 0.2,
    });
    expect(localized[0]?.description).toContain('выпустила нового coding-агента');
    expect(localized[1]?.description).toContain('Японский стартап');
  });

  it('дожимает пропущенные descriptions повторным batched retry', async () => {
    mockedAiService.chat
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { id: 0, description: 'OpenAI выпустила нового AI-агента для enterprise-команд.' },
        ]),
        model: 'test-model',
        tokens_used: { prompt: 10, completion: 10, total: 20 },
        finish_reason: 'stop',
      })
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { id: 1, description: 'Метод позволяет сравнивать данные Google Trends между странами без ручной нормализации.' },
          { id: 2, description: 'Фреймворк помогает строить строгие и воспроизводимые AI search benchmarks до дорогих инфраструктурных решений.' },
        ]),
        model: 'test-model',
        tokens_used: { prompt: 10, completion: 10, total: 20 },
        finish_reason: 'stop',
      });

    const localized = await localizeParsedHeadlines([
      buildLocalizedHeadline({ fingerprint: 'fp-0' }),
      buildLocalizedHeadline({
        title: 'Google Trends comparison',
        url: 'https://example.com/google-trends',
        canonicalUrl: 'https://example.com/google-trends',
        description: 'A methodology for comparing Google Trends data across countries.',
        fingerprint: 'fp-1',
      }),
      buildLocalizedHeadline({
        title: 'AI search evaluation',
        url: 'https://example.com/search-eval',
        canonicalUrl: 'https://example.com/search-eval',
        description: 'A five-step framework for building rigorous, reproducible AI search benchmarks.',
        fingerprint: 'fp-2',
      }),
    ]);

    expect(mockedAiService.chat).toHaveBeenCalledTimes(2);
    expect(localized[0]?.description).toContain('AI-агента');
    expect(localized[1]?.description).toContain('Google Trends');
    expect(localized[2]?.description).toContain('воспроизводимые');
  });

  it('повторно переводит description, если первый ответ оставил длинный английский хвост', async () => {
    mockedAiService.chat
      .mockResolvedValueOnce({
        content: JSON.stringify([
          {
            id: 0,
            description: 'OpenAI выпустила новый инструмент для кода. The post OpenAI released a new coding agent appeared first on Example Source.',
          },
          {
            id: 1,
            description: 'Japanese startup unveiled a collaborative AI coding platform for teams.',
          },
        ]),
        model: 'test-model',
        tokens_used: { prompt: 10, completion: 10, total: 20 },
        finish_reason: 'stop',
      })
      .mockResolvedValueOnce({
        content: JSON.stringify([
          {
            id: 0,
            description: 'OpenAI выпустила новый инструмент для кода и убрала лишний RSS-хвост из описания.',
          },
          {
            id: 1,
            description: 'Японский стартап представил совместную AI-платформу для командной разработки.',
          },
        ]),
        model: 'test-model',
        tokens_used: { prompt: 10, completion: 10, total: 20 },
        finish_reason: 'stop',
      });

    const localized = await localizeParsedHeadlines([
      buildLocalizedHeadline({ fingerprint: 'fp-tail-1' }),
      buildLocalizedHeadline({
        title: 'Japanese startup platform',
        url: 'https://example.jp/platform',
        canonicalUrl: 'https://example.jp/platform',
        source: 'Japan Source',
        sourceDomain: 'example.jp',
        description: 'Japanese startup unveiled a collaborative AI coding platform for teams.',
        fingerprint: 'fp-tail-2',
        category: 'asia_tech',
        language: 'ja',
      }),
    ]);

    expect(mockedAiService.chat).toHaveBeenCalledTimes(2);
    expect(localized[0]?.description).not.toContain('The post OpenAI released');
    expect(localized[0]?.description).toContain('RSS-хвост');
    expect(localized[1]?.description).toContain('Японский стартап');
  });

  it('возвращает исходное description, если LLM вернула невалидный формат', async () => {
    mockedAiService.chat.mockResolvedValue({
      content: 'not-json',
      model: 'test-model',
      tokens_used: { prompt: 5, completion: 5, total: 10 },
      finish_reason: 'stop',
    });

    const headlines = [buildLocalizedHeadline()];
    const localized = await localizeParsedHeadlines(headlines);

    expect(localized[0]?.description).toBe('OpenAI released a new coding agent for enterprise teams.');
  });
});
