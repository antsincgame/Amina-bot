import { load } from 'cheerio';
import { appLogger } from '../config/logger.js';
import type { ParsedHeadline } from '../../../shared/types/index.js';

const ARTICLE_DESCRIPTION_FETCH_TIMEOUT_MS = 8_000;
const ARTICLE_DESCRIPTION_CONCURRENCY = 4;
const MIN_MEANINGFUL_DESCRIPTION_LENGTH = 50;
const MAX_ARTICLE_DESCRIPTION_LENGTH = 420;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GENERIC_DESCRIPTION_PATTERNS = [
  /^[^:]{2,200}: материал о новых AI-инструментах, моделях или продуктах для разработки\.$/iu,
  /^[^:]{2,200}: практический материал или обсуждение из сообщества разработчиков и AI-энтузиастов\.$/iu,
  /^[^:]{2,200}: важная новость про AI-рынок, продукты или экосистему Азии\.$/iu,
  /^[^:]{2,200}: локальная новость о событиях города, транспорте, инфраструктуре или решениях властей\.$/iu,
  /^[^:]{2,200}: структурированная новость из источника без явной категории\.$/iu,
  /we(?:'|’)re on a journey to advance and democratize artificial intelligence/i,
];

const PARAGRAPH_SELECTORS = [
  'article p',
  'main article p',
  'main p',
  '.prose p',
  '.markdown p',
  '.content p',
  '.article-content p',
  '.post-content p',
];

const TITLE_STOPWORDS = new Set([
  'about',
  'after',
  'against',
  'bringing',
  'from',
  'into',
  'part',
  'parts',
  'that',
  'this',
  'with',
  'without',
  'your',
  'using',
  'guide',
  'introducing',
  'training',
  'release',
  'scaling',
  'every',
  'dimension',
  'blog',
]);

interface CandidateWithScore {
  text: string;
  score: number;
}

function cleanText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function truncateText(text: string): string {
  if (text.length <= MAX_ARTICLE_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_ARTICLE_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function normalizeCandidate(text: string): string {
  return truncateText(cleanText(text));
}

function isGenericDescriptionText(description: string): boolean {
  const normalized = normalizeCandidate(description);
  if (!normalized) return true;
  return GENERIC_DESCRIPTION_PATTERNS.some(pattern => pattern.test(normalized));
}

function tokenize(text: string): Set<string> {
  return new Set(
    normalizeCandidate(text)
      .toLowerCase()
      .split(/[^a-zа-яё0-9]+/iu)
      .map(token => token.trim())
      .filter(token => token.length >= 4 && !TITLE_STOPWORDS.has(token)),
  );
}

function countKeywordOverlap(title: string, candidate: string): number {
  const titleTokens = tokenize(title);
  if (titleTokens.size === 0) return 0;

  const candidateTokens = tokenize(candidate);
  let matches = 0;
  titleTokens.forEach(token => {
    if (candidateTokens.has(token)) {
      matches += 1;
    }
  });
  return matches;
}

function scoreDescriptionCandidate(
  headline: ParsedHeadline,
  text: string,
  source: 'meta' | 'jsonld' | 'paragraph',
): CandidateWithScore | null {
  const normalized = normalizeCandidate(text);
  if (!normalized) return null;
  if (normalized === cleanText(headline.title)) return null;
  if (isGenericDescriptionText(normalized)) return null;

  let score = 0;
  if (normalized.length >= 80 && normalized.length <= 320) {
    score += 5;
  } else if (normalized.length >= MIN_MEANINGFUL_DESCRIPTION_LENGTH) {
    score += 2;
  } else {
    score -= 3;
  }

  if (/[.!?]/.test(normalized)) score += 1;
  score += Math.min(countKeywordOverlap(headline.title, normalized), 3) * 2;

  if (source === 'paragraph') score += 4;
  if (source === 'jsonld') score += 2;
  if (source === 'meta') score += 1;

  return { text: normalized, score };
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function collectJsonLdDescriptions(value: unknown, sink: string[]): void {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach(item => collectJsonLdDescriptions(item, sink));
    return;
  }

  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.description === 'string') {
    sink.push(record.description);
  }
  if (typeof record.articleBody === 'string') {
    sink.push(record.articleBody);
  }

  Object.values(record).forEach(child => collectJsonLdDescriptions(child, sink));
}

function extractJsonLdCandidates(html: string): string[] {
  const $ = load(html);
  const candidates: string[] = [];

  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).html() ?? $(element).text();
    const parsed = tryParseJson(raw.trim());
    if (parsed) {
      collectJsonLdDescriptions(parsed, candidates);
    }
  });

  return candidates;
}

function extractParagraphCandidates(html: string): string[] {
  const $ = load(html);
  $('script, style, noscript, svg, nav, header, footer, form, aside').remove();

  const candidates: string[] = [];
  for (const selector of PARAGRAPH_SELECTORS) {
    $(selector).each((_index, element) => {
      if (candidates.length >= 24) return false;
      const text = normalizeCandidate($(element).text());
      if (text) {
        candidates.push(text);
      }
      return undefined;
    });
    if (candidates.length > 0) break;
  }

  return candidates;
}

function pickBestCandidate(headline: ParsedHeadline, html: string): string | null {
  const $ = load(html);
  const rawMetaCandidates = [
    $('meta[property="og:description"]').attr('content') ?? '',
    $('meta[name="twitter:description"]').attr('content') ?? '',
    $('meta[name="description"]').attr('content') ?? '',
  ];

  const scoredCandidates: CandidateWithScore[] = [
    ...rawMetaCandidates
      .map(candidate => scoreDescriptionCandidate(headline, candidate, 'meta'))
      .filter((candidate): candidate is CandidateWithScore => candidate !== null),
    ...extractJsonLdCandidates(html)
      .map(candidate => scoreDescriptionCandidate(headline, candidate, 'jsonld'))
      .filter((candidate): candidate is CandidateWithScore => candidate !== null),
    ...extractParagraphCandidates(html)
      .map(candidate => scoreDescriptionCandidate(headline, candidate, 'paragraph'))
      .filter((candidate): candidate is CandidateWithScore => candidate !== null),
  ];

  if (scoredCandidates.length === 0) return null;

  scoredCandidates.sort((left, right) => right.score - left.score);
  return scoredCandidates[0]!.score >= 4
    ? scoredCandidates[0]!.text
    : null;
}

async function fetchArticleDescription(headline: ParsedHeadline): Promise<string | null> {
  try {
    const response = await fetch(headline.url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ARTICLE_DESCRIPTION_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html') && !contentType.includes('xml')) {
      return null;
    }

    const html = await response.text();
    return pickBestCandidate(headline, html);
  } catch (error) {
    appLogger.debug(
      { error, url: headline.url, source: headline.source },
      'News description enrichment failed to fetch article',
    );
    return null;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  const runner = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex]!);
    }
  };

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner(),
  );

  await Promise.all(runners);
}

export function isWeakHeadlineDescription(headline: ParsedHeadline): boolean {
  const description = normalizeCandidate(headline.description);
  if (!description) return true;
  if (description === cleanText(headline.title)) return true;
  if (description.length < MIN_MEANINGFUL_DESCRIPTION_LENGTH) return true;
  return isGenericDescriptionText(description);
}

export async function enrichParsedHeadlineDescriptions(headlines: ParsedHeadline[]): Promise<ParsedHeadline[]> {
  if (headlines.length === 0) return headlines;

  const enriched = [...headlines];
  const queue = headlines
    .map((headline, index) => ({ headline, index }))
    .filter(({ headline }) => isWeakHeadlineDescription(headline));

  if (queue.length === 0) {
    return enriched;
  }

  await runWithConcurrency(queue, ARTICLE_DESCRIPTION_CONCURRENCY, async ({ headline, index }) => {
    const articleDescription = await fetchArticleDescription(headline);
    if (!articleDescription) return;

    enriched[index] = {
      ...headline,
      description: articleDescription,
    };
  });

  return enriched;
}
