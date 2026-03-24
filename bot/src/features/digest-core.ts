import { webSearch } from '../ai/websearch.js';
import { summarizeWithAminaCore } from '../ai/amina-core-runtime.js';
import { appLogger } from '../config/logger.js';
import { countMergedDuplicates, groupHeadlinesByCategory } from './news-parser.js';
import { shouldTranslateHeadlineDescription } from './news-localization.js';
import type { ParsedHeadline } from '../../../shared/types/index.js';

export interface DigestSearchResult {
  answer: string;
  citations: string[];
}

export type DigestHeadlineMode = 'ai' | 'asia';

export interface HeadlineBatch {
  headlines: ParsedHeadline[];
  startNumber: number;
}

export interface ChunkHeadlinesOptions {
  maxItems?: number;
  maxChars?: number;
}

export interface ParserOnlyNewsBundle {
  sections: ReturnType<typeof groupHeadlinesByCategory>;
  counts: {
    total: number;
    ai: number;
    community: number;
    asia: number;
    local: number;
    uncategorized: number;
    merged_duplicates: number;
  };
  localHeadlines: ParsedHeadline[];
  aiTechHeadlines: ParsedHeadline[];
  communityHeadlines: ParsedHeadline[];
  asiaHeadlines: ParsedHeadline[];
  uncategorizedHeadlines: ParsedHeadline[];
  allAiHeadlines: ParsedHeadline[];
  localSection: string;
  uncategorizedSection: string;
  aiSections: string[];
  asiaSections: string[];
}

const DIGEST_HEADLINE_BATCH_MAX_ITEMS = 18;
const DIGEST_HEADLINE_BATCH_MAX_CHARS = 4500;
const DIGEST_FALLBACK_BATCH_MAX_ITEMS = 42;
const DIGEST_FALLBACK_BATCH_MAX_CHARS = 11000;
const DIGEST_HEADLINE_LLM_MAX_BATCHES = 8;
const DIGEST_HEADLINE_ANNOTATION_MAX_TOKENS = 1800;
const DIGEST_HEADLINE_ANNOTATION_TEMPERATURE = 0.2;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

function estimateHeadlineSize(headline: ParsedHeadline): number {
  return headline.title.length
    + headline.url.length
    + headline.source.length
    + headline.description.length
    + headline.alternateSources.join(', ').length
    + 180;
}

export async function webSearchWithRetry(
  query: string,
  retries = 2,
): Promise<DigestSearchResult | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await webSearch(query, { forDigest: true });
      if (result.answer && result.answer.length > 10) {
        return { answer: result.answer, citations: result.citations ?? [] };
      }
      appLogger.warn(
        { query: query.substring(0, 50), attempt, answerLength: result.answer?.length ?? 0 },
        'Digest: search returned weak result',
      );
    } catch (error) {
      const errorCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code ?? '')
        : '';
      appLogger.warn({ error, errorCode, query: query.substring(0, 50), attempt }, `Digest: search attempt ${attempt} failed`);

      if (
        errorCode === 'PERPLEXITY_NOT_CONFIGURED'
        || errorCode === 'PERPLEXITY_AUTH_ERROR'
        || errorCode === 'PERPLEXITY_PAYMENT_REQUIRED'
        || errorCode === 'SEARCH_CIRCUIT_OPEN'
      ) {
        return null;
      }

      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }

  return null;
}

export function chunkHeadlinesForDigest(
  headlines: ParsedHeadline[],
  options?: ChunkHeadlinesOptions,
): HeadlineBatch[] {
  const maxItems = options?.maxItems ?? DIGEST_HEADLINE_BATCH_MAX_ITEMS;
  const maxChars = options?.maxChars ?? DIGEST_HEADLINE_BATCH_MAX_CHARS;
  const batches: HeadlineBatch[] = [];
  let currentBatch: ParsedHeadline[] = [];
  let currentChars = 0;
  let startNumber = 1;

  for (const headline of headlines) {
    const nextSize = estimateHeadlineSize(headline);
    const exceedsItemLimit = currentBatch.length >= maxItems;
    const exceedsCharLimit = currentChars + nextSize > maxChars;

    if (currentBatch.length > 0 && (exceedsItemLimit || exceedsCharLimit)) {
      batches.push({ headlines: currentBatch, startNumber });
      startNumber += currentBatch.length;
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(headline);
    currentChars += nextSize;
  }

  if (currentBatch.length > 0) {
    batches.push({ headlines: currentBatch, startNumber });
  }

  return batches;
}

function formatBatchHeading(sectionTitle: string, batchIndex: number, totalBatches: number): string {
  return totalBatches > 1 ? `${sectionTitle} (${batchIndex + 1}/${totalBatches})` : sectionTitle;
}

function formatCategoryLabel(category: ParsedHeadline['category']): string {
  switch (category) {
    case 'ai_tech':
      return 'AI/Tech';
    case 'community':
      return 'Сообщество';
    case 'asia_tech':
      return 'AI Азия';
    case 'city_local':
      return 'Город';
    default:
      return 'Без категории';
  }
}

function buildAlternateSourcesText(headline: ParsedHeadline): string {
  if (headline.alternateSources.length === 0) return '';
  return `Альтернативные источники: ${headline.alternateSources.join(', ')}.`;
}

export function renderStructuredHeadlineItem(headline: ParsedHeadline, number: number): string {
  const displayTitle = headline.translatedTitle ?? headline.title;
  const metaLine = `Источник: ${headline.source} · Категория: ${formatCategoryLabel(headline.category)}`;
  const descriptionLine = `Описание: ${headline.description}`;
  const alternateSources = buildAlternateSourcesText(headline);

  return [
    `**${number}. [${displayTitle}](${headline.url})**`,
    metaLine,
    descriptionLine,
    alternateSources,
  ].filter(Boolean).join('\n');
}

export function renderStructuredHeadlineList(headlines: ParsedHeadline[], startNumber = 1): string {
  return headlines
    .map((headline, index) => renderStructuredHeadlineItem(headline, startNumber + index))
    .join('\n\n');
}

export function buildParserOnlyLocalSection(city: string, headlines: ParsedHeadline[]): string {
  if (headlines.length === 0) return '';
  return `## Новости ${city}\n\n${renderStructuredHeadlineList(headlines)}`;
}

export function buildParserOnlyUncategorizedSection(headlines: ParsedHeadline[]): string {
  if (headlines.length === 0) return '';
  return `## Некатегоризированные источники\n\n${renderStructuredHeadlineList(headlines)}`;
}

export function validateAnnotatedBatch(text: string, headlines: ParsedHeadline[]): boolean {
  const links = [...text.matchAll(MARKDOWN_LINK_REGEX)].map(match => match[2]);
  if (links.length !== headlines.length) return false;
  if (new Set(links).size !== links.length) return false;
  if (links.some((link, index) => link !== headlines[index]?.url)) return false;

  const descriptionLines = [...text.matchAll(/^Описание:\s*(.+)$/gm)].map(match => match[1]?.trim() ?? '');
  if (descriptionLines.length !== headlines.length) return false;
  if (descriptionLines.some(description => !description)) return false;

  return headlines.every(headline =>
    text.includes(headline.source) &&
    text.includes(headline.url) &&
    text.includes(formatCategoryLabel(headline.category)),
  ) && descriptionLines.every((description, index) => {
    const headline = headlines[index];
    if (!headline) return false;
    return !shouldTranslateHeadlineDescription({ ...headline, description });
  });
}

export function shouldUseFallbackForDigestBatches(totalBatches: number): boolean {
  return totalBatches > DIGEST_HEADLINE_LLM_MAX_BATCHES;
}

export function renderFallbackHeadlineBatch(
  sectionTitle: string,
  _mode: DigestHeadlineMode,
  batchIndex: number,
  totalBatches: number,
  batch: HeadlineBatch,
): string {
  const heading = formatBatchHeading(sectionTitle, batchIndex, totalBatches);
  const body = renderStructuredHeadlineList(batch.headlines, batch.startNumber);
  return `## ${heading}\n\n${body}`;
}

async function annotateHeadlineBatch(
  sectionTitle: string,
  mode: DigestHeadlineMode,
  batchIndex: number,
  totalBatches: number,
  batch: HeadlineBatch,
): Promise<string> {
  const heading = formatBatchHeading(sectionTitle, batchIndex, totalBatches);
  const inputLines = batch.headlines.map((headline, index) => {
    const number = batch.startNumber + index;
    const language = headline.language ? ` | language=${headline.language}` : '';
    const alternateSources = headline.alternateSources.length > 0
      ? ` | alternate_sources=${headline.alternateSources.join(', ')}`
      : '';
    const displayTitle = headline.translatedTitle ?? headline.title;
    return `${number}. [${displayTitle}](${headline.url}) | source=${headline.source} | category=${formatCategoryLabel(headline.category)} | description=${headline.description}${language}${alternateSources}`;
  }).join('\n');

  const digestScope = mode === 'asia'
    ? 'азиатскому AI-рынку'
    : 'AI, локальным LLM и vibecoding';
  const descriptionHint = mode === 'asia'
    ? 'что произошло и почему это важно.'
    : 'что произошло и почему это важно для AI, локальных LLM или vibecoding.';
  const titleHint = mode === 'asia'
    ? 'Перевод заголовка (оригинал можно оставить в скобках)'
    : 'Перевод заголовка';

  const prompt = `Ты — Amina, техножрица Омниссии и летописец дня по ${digestScope}.

Верни ТОЛЬКО готовый Markdown-раздел без вступления и без заключения.
ЗАПРЕЩЕНО пропускать пункты, менять номера и менять URL.
Каждый входной пункт должен появиться ровно один раз.
Формат каждого пункта:
**N. [${titleHint}](url)**
Источник: <source> · Категория: <category>
Описание: 1-2 точных предложения на русском языке: ${descriptionHint}
Если есть alternate_sources, добавь отдельную строку "Альтернативные источники: ...".

Заголовок раздела:
## ${heading}

ВХОДНЫЕ ПУНКТЫ:
${inputLines}`;

  try {
    const { response } = await summarizeWithAminaCore({
      channel: 'digest',
      messages: [{ role: 'user', content: prompt }],
      extraRules: [
        'Режим задачи: структурированная аннотация новостных headline batches.',
        'Сохраняй образ техножрицы-летописца, но не нарушай формат.',
        'Верни только готовый Markdown-блок без пояснений.',
      ],
      context: {
        includeTime: false,
        includeMemory: false,
        includeSearch: false,
        taskContext: heading,
      },
      options: {
        promptMode: 'passthrough',
        maxTokens: DIGEST_HEADLINE_ANNOTATION_MAX_TOKENS,
        temperature: DIGEST_HEADLINE_ANNOTATION_TEMPERATURE,
        priority: 'background',
      },
    });
    const content = response.content.trim();
    const normalizedContent = content.startsWith('##') ? content : `## ${heading}\n\n${content}`;
    if (!content || !validateAnnotatedBatch(normalizedContent, batch.headlines)) {
      appLogger.warn({ sectionTitle, batchIndex, totalBatches }, 'Digest: annotated batch validation failed, using fallback');
      return renderFallbackHeadlineBatch(sectionTitle, mode, batchIndex, totalBatches, batch);
    }
    return normalizedContent;
  } catch (error) {
    appLogger.warn({ error, sectionTitle, batchIndex, totalBatches }, 'Digest: batch annotation failed, using fallback');
    return renderFallbackHeadlineBatch(sectionTitle, mode, batchIndex, totalBatches, batch);
  }
}

export async function buildHeadlineSections(
  sectionTitle: string,
  mode: DigestHeadlineMode,
  headlines: ParsedHeadline[],
): Promise<string[]> {
  if (headlines.length === 0) return [];

  const batches = chunkHeadlinesForDigest(headlines);
  if (shouldUseFallbackForDigestBatches(batches.length)) {
    const fallbackBatches = chunkHeadlinesForDigest(headlines, {
      maxItems: DIGEST_FALLBACK_BATCH_MAX_ITEMS,
      maxChars: DIGEST_FALLBACK_BATCH_MAX_CHARS,
    });
    appLogger.info(
      { sectionTitle, mode, llmBatches: batches.length, fallbackBatches: fallbackBatches.length, headlines: headlines.length },
      'Digest: too many headline batches, switching section to deterministic fallback',
    );
    return fallbackBatches.map((batch, index) =>
      renderFallbackHeadlineBatch(sectionTitle, mode, index, fallbackBatches.length, batch),
    );
  }

  const rendered: string[] = [];
  for (let i = 0; i < batches.length; i += 2) {
    const batchSlice = batches.slice(i, i + 2);
    const batchTexts = await Promise.all(
      batchSlice.map((batch, offset) =>
        annotateHeadlineBatch(sectionTitle, mode, i + offset, batches.length, batch),
      ),
    );
    rendered.push(...batchTexts);
  }

  return rendered;
}

export async function buildParserOnlyNewsBundle(
  city: string,
  headlines: ParsedHeadline[],
): Promise<ParserOnlyNewsBundle> {
  const sections = groupHeadlinesByCategory(headlines);
  const localHeadlines = sections.city_local;
  const aiTechHeadlines = sections.ai_tech;
  const communityHeadlines = sections.community;
  const asiaHeadlines = sections.asia_tech;
  const uncategorizedHeadlines = sections.uncategorized;
  const allAiHeadlines = [...aiTechHeadlines, ...communityHeadlines];

  const [aiSections, asiaSections] = await Promise.all([
    buildHeadlineSections('Технологии и AI', 'ai', allAiHeadlines),
    buildHeadlineSections('AI из Азии', 'asia', asiaHeadlines),
  ]);

  return {
    sections,
    counts: {
      total: headlines.length,
      ai: aiTechHeadlines.length,
      community: communityHeadlines.length,
      asia: asiaHeadlines.length,
      local: localHeadlines.length,
      uncategorized: uncategorizedHeadlines.length,
      merged_duplicates: countMergedDuplicates(headlines),
    },
    localHeadlines,
    aiTechHeadlines,
    communityHeadlines,
    asiaHeadlines,
    uncategorizedHeadlines,
    allAiHeadlines,
    localSection: buildParserOnlyLocalSection(city, localHeadlines),
    uncategorizedSection: buildParserOnlyUncategorizedSection(uncategorizedHeadlines),
    aiSections,
    asiaSections,
  };
}

export function buildDigestClosing(firstName: string | null): string {
  const nameStr = firstName?.trim() ? `, ${firstName.trim()}` : '';
  return `## Настрой на день\n${nameStr ? `Сегодня${nameStr} ` : 'Сегодня '}важно не просто читать новости, а сразу отмечать идеи, которые можно превратить в контент, прототип или новый AI-эксперимент.`;
}

export function getTimeGreeting(name: string | null): string {
  const hour = new Date().getHours();
  const nameStr = name ? `, ${name}` : '';

  if (hour >= 5 && hour < 12) return `☀️ *Доброе утро${nameStr}!*`;
  if (hour >= 12 && hour < 17) return `🌤 *Добрый день${nameStr}!*`;
  if (hour >= 17 && hour < 22) return `🌆 *Добрый вечер${nameStr}!*`;
  return `🌙 *Доброй ночи${nameStr}!*`;
}
