import { webSearch } from '../ai/websearch.js';
import { aiService } from '../ai/openrouter.js';
import { appLogger } from '../config/logger.js';
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

const DIGEST_HEADLINE_BATCH_MAX_ITEMS = 18;
const DIGEST_HEADLINE_BATCH_MAX_CHARS = 4500;
const DIGEST_FALLBACK_BATCH_MAX_ITEMS = 42;
const DIGEST_FALLBACK_BATCH_MAX_CHARS = 11000;
const DIGEST_HEADLINE_LLM_MAX_BATCHES = 8;

function estimateHeadlineSize(headline: ParsedHeadline): number {
  return headline.title.length + headline.url.length + headline.source.length + 80;
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
      appLogger.warn({ error, query: query.substring(0, 50), attempt }, `Digest: search attempt ${attempt} failed`);
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

function validateAnnotatedBatch(text: string, headlines: ParsedHeadline[]): boolean {
  return headlines.every(headline => text.includes(headline.url));
}

export function shouldUseFallbackForDigestBatches(totalBatches: number): boolean {
  return totalBatches > DIGEST_HEADLINE_LLM_MAX_BATCHES;
}

export function renderFallbackHeadlineBatch(
  sectionTitle: string,
  mode: DigestHeadlineMode,
  batchIndex: number,
  totalBatches: number,
  batch: HeadlineBatch,
): string {
  const heading = formatBatchHeading(sectionTitle, batchIndex, totalBatches);
  const lines = batch.headlines.map((headline, index) => {
    const number = batch.startNumber + index;
    const context = mode === 'asia'
      ? `${headline.source}: важная азиатская новость для мониторинга AI-программирования и локального рынка.`
      : `${headline.source}: важный сигнал для AI, локальных LLM и vibecoding-инструментов.`;
    return `**${number}. [${headline.title}](${headline.url})** — ${context}`;
  });

  return `## ${heading}\n\n${lines.join('\n')}`;
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
    return `${number}. [${headline.title}](${headline.url}) | source=${headline.source}${language}`;
  }).join('\n');

  const prompt = mode === 'asia'
    ? `Ты — Amina, редактор дайджеста по азиатскому AI-рынку.

Верни ТОЛЬКО готовый Markdown-раздел без вступления и без заключения.
ЗАПРЕЩЕНО пропускать пункты, менять номера и менять URL.
Каждый входной пункт должен появиться ровно один раз.
Формат каждой строки:
**N. [Перевод заголовка (оригинал можно оставить в скобках)](url)** — 1 короткое предложение: что это и почему важно.

Заголовок раздела:
## ${heading}

ВХОДНЫЕ ПУНКТЫ:
${inputLines}`
    : `Ты — Amina, редактор AI/vibecoding-дайджеста.

Верни ТОЛЬКО готовый Markdown-раздел без вступления и без заключения.
ЗАПРЕЩЕНО пропускать пункты, менять номера и менять URL.
Каждый входной пункт должен появиться ровно один раз.
Формат каждой строки:
**N. [Перевод заголовка](url)** — 1 короткое предложение: что произошло и почему это важно для AI, локальных LLM или vibecoding.

Заголовок раздела:
## ${heading}

ВХОДНЫЕ ПУНКТЫ:
${inputLines}`;

  try {
    const response = await aiService.chat([{ role: 'user', content: prompt }], 'telegram');
    const content = response.content.trim();
    if (!content || !validateAnnotatedBatch(content, batch.headlines)) {
      appLogger.warn({ sectionTitle, batchIndex, totalBatches }, 'Digest: annotated batch validation failed, using fallback');
      return renderFallbackHeadlineBatch(sectionTitle, mode, batchIndex, totalBatches, batch);
    }
    return content.startsWith('##') ? content : `## ${heading}\n\n${content}`;
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
    appLogger.warn(
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
