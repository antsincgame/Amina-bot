import { aiService } from '../ai/openrouter.js';
import { appLogger } from '../config/logger.js';
import type { ParsedHeadline } from '../../../shared/types/index.js';

const DESCRIPTION_TRANSLATION_BATCH_SIZE = 8;
const DESCRIPTION_TRANSLATION_RETRY_BATCH_SIZE = 3;
const DESCRIPTION_TRANSLATION_CONCURRENCY = 1;
const DESCRIPTION_TRANSLATION_TIMEOUT_MS = 45_000;
const DESCRIPTION_TRANSLATION_MAX_TOKENS = 2000;
const DESCRIPTION_TRANSLATION_TEMPERATURE = 0.2;
const MAX_LOCALIZED_DESCRIPTION_LENGTH = 200;

interface DescriptionTranslationInput {
  id: number;
  headline: ParsedHeadline;
}

interface DescriptionTranslationOutput {
  id: number;
  description: string;
  title?: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ');
}

function normalizeDescriptionText(text: string): string {
  return stripHtmlTags(decodeHtmlEntities(text))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function truncateDescription(text: string): string {
  if (text.length <= MAX_LOCALIZED_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_LOCALIZED_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function hasLongLatinPhrase(text: string): boolean {
  const normalized = normalizeDescriptionText(text);
  if (!normalized) return false;

  const matches = normalized.match(/[A-Za-z][A-Za-z0-9+/.-]*(?:\s+[A-Za-z0-9+/.-]+){3,}/g) ?? [];
  return matches.some(match => countMatches(match, /[a-z]/gi) >= 12);
}

function hasCjkCharacters(text: string): boolean {
  return /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(text);
}

export function hasMostlyRussianText(text: string): boolean {
  const normalized = normalizeDescriptionText(text);
  if (!normalized) return false;

  const cyrillicCount = countMatches(normalized, /[а-яё]/gi);
  if (cyrillicCount === 0) return false;

  if (hasCjkCharacters(normalized)) return false;

  const latinCount = countMatches(normalized, /[a-z]/gi);
  return cyrillicCount >= 6 || cyrillicCount >= latinCount;
}

function needsRussianLocalization(text: string): boolean {
  const normalized = normalizeDescriptionText(text);
  if (!normalized) return false;

  if (hasCjkCharacters(normalized)) return true;

  if (!hasMostlyRussianText(normalized)) {
    return true;
  }

  return hasLongLatinPhrase(normalized);
}

function needsTitleTranslation(title: string): boolean {
  const normalized = normalizeDescriptionText(title);
  if (!normalized) return false;
  if (hasCjkCharacters(normalized)) return true;

  const cyrillicCount = countMatches(normalized, /[а-яё]/gi);
  if (cyrillicCount >= 4) return false;

  const latinCount = countMatches(normalized, /[a-z]/gi);
  return latinCount > cyrillicCount;
}

export function shouldTranslateHeadlineDescription(headline: ParsedHeadline): boolean {
  return needsRussianLocalization(headline.description);
}

export function shouldTranslateHeadline(headline: ParsedHeadline): boolean {
  return needsRussianLocalization(headline.description) || needsTitleTranslation(headline.title);
}

function stripMarkdownFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonArray(text: string): string | null {
  const direct = text.trim();
  if (direct.startsWith('[') && direct.endsWith(']')) return direct;

  const match = text.match(/\[[\s\S]*\]/);
  return match?.[0] ?? null;
}

function parseTranslationItem(value: unknown): DescriptionTranslationOutput | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'number'
    ? record.id
    : typeof record.index === 'number'
      ? record.index
      : null;
  const description = typeof record.description === 'string'
    ? truncateDescription(normalizeDescriptionText(record.description))
    : '';
  const title = typeof record.title === 'string'
    ? normalizeDescriptionText(record.title).slice(0, 300)
    : undefined;

  if (id == null || !description) return null;
  return { id, description, title };
}

function parseTranslationResponse(content: string): DescriptionTranslationOutput[] {
  const sanitized = stripMarkdownFences(content);
  const arrayText = extractJsonArray(sanitized);
  if (!arrayText) return [];

  const parsed = JSON.parse(arrayText) as unknown;
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map(parseTranslationItem)
    .filter((item): item is DescriptionTranslationOutput => item !== null);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, scope: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${scope} timed out after ${Math.ceil(timeoutMs / 1000)}s`)), timeoutMs);
    });

    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildTranslationPrompt(items: DescriptionTranslationInput[]): string {
  const payload = items.map(({ id, headline }) => ({
    id,
    title: headline.title,
    source: headline.source,
    language: headline.language ?? 'unknown',
    description: headline.description,
    excerpt: headline.articleExcerpt?.slice(0, 400) ?? '',
  }));

  return [
    'Для каждой новостной карточки создай КРАТКУЮ ВЫЖИМКУ на русском языке.',
    '',
    'У тебя есть title, description и excerpt (начало статьи). На основании ВСЕХ этих данных:',
    '1. Напиши "title" — заголовок на русском. Если оригинал на английском/корейском/японском/китайском — переведи.',
    '2. Напиши "description" — выжимку сути статьи на русском (что произошло и почему это важно).',
    '',
    'Правила:',
    '- ВЕСЬ текст в title и description должен быть НА РУССКОМ ЯЗЫКЕ.',
    '- Запрещён текст на корейском, японском, китайском, английском в title и description.',
    '- Названия продуктов/компаний (Claude Code, Cursor, OpenAI) оставляй латиницей.',
    '- Не выдумывай факты — бери только из входных данных.',
    '- Убирай HTML-теги, RSS-мусор.',
    `- description: максимум ${MAX_LOCALIZED_DESCRIPTION_LENGTH} символов.`,
    '- Верни ТОЛЬКО JSON-массив.',
    '- Формат: [{"id":1,"title":"заголовок по-русски","description":"выжимка по-русски"}]',
    '',
    'Входные данные:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function isTranslationAcceptable(text: string): boolean {
  const normalized = normalizeDescriptionText(text);
  if (!normalized) return false;

  const cyrillicCount = countMatches(normalized, /[а-яё]/gi);
  if (cyrillicCount < 4) return false;

  const latinCount = countMatches(normalized, /[a-z]/gi);
  const cjkCount = countMatches(normalized, /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g);
  const foreignCount = latinCount + cjkCount;

  return cyrillicCount > foreignCount;
}

interface AcceptedTranslation {
  description: string;
  title?: string;
}

function acceptTranslatedDescriptions(
  items: DescriptionTranslationInput[],
  translations: DescriptionTranslationOutput[],
): Map<number, AcceptedTranslation> {
  const translationsById = new Map(translations.map(item => [item.id, item]));
  const accepted = new Map<number, AcceptedTranslation>();

  items.forEach(({ id, headline }) => {
    const translation = translationsById.get(id);
    if (!translation) return;
    if (!isTranslationAcceptable(translation.description)) {
      appLogger.debug(
        { id, source: headline.source, category: headline.category },
        'News localization: translated description is not mostly Russian, rejecting',
      );
      return;
    }
    const result: AcceptedTranslation = { description: translation.description };
    if (translation.title && translation.title.length >= 3) {
      result.title = translation.title;
    }
    accepted.set(id, result);
  });

  return accepted;
}

function chunkTranslationInputs(
  items: DescriptionTranslationInput[],
  batchSize: number,
): DescriptionTranslationInput[][] {
  const batches: DescriptionTranslationInput[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }

  return batches;
}

function mergeTranslationMaps(target: Map<number, AcceptedTranslation>, source: Map<number, AcceptedTranslation>): void {
  source.forEach((translation, id) => {
    target.set(id, translation);
  });
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

async function translateDescriptionBatch(
  items: DescriptionTranslationInput[],
  scope: 'batch' | 'retry_batch' | 'single',
): Promise<Map<number, AcceptedTranslation>> {
  if (items.length === 0) return new Map<number, AcceptedTranslation>();

  try {
    const response = await withTimeout(
      aiService.chat(
        [
          {
            role: 'system',
            content: 'Ты — AI-редактор новостного дайджеста. Твоя задача: прочитать excerpt статьи и написать краткую выжимку на русском. Отвечай ТОЛЬКО валидным JSON-массивом. Никакого текста кроме JSON.',
          },
          {
            role: 'user',
            content: buildTranslationPrompt(items),
          },
        ],
        'telegram',
        undefined,
        {
          promptMode: 'passthrough',
          maxTokens: DESCRIPTION_TRANSLATION_MAX_TOKENS,
          temperature: DESCRIPTION_TRANSLATION_TEMPERATURE,
          priority: 'background',
        },
      ),
      DESCRIPTION_TRANSLATION_TIMEOUT_MS,
      `News description localization ${scope}`,
    );

    const parsed = parseTranslationResponse(response.content);
    if (parsed.length === 0) {
      appLogger.warn({ batchSize: items.length, scope }, 'News localization: model returned empty translation batch');
      return new Map<number, AcceptedTranslation>();
    }

    const accepted = acceptTranslatedDescriptions(items, parsed);
    if (accepted.size === 0) {
      appLogger.warn({ batchSize: items.length, scope }, 'News localization: batch returned no acceptable Russian translations');
      return new Map<number, AcceptedTranslation>();
    }

    return accepted;
  } catch (error) {
    appLogger.warn({ error, batchSize: items.length, scope }, 'News localization: translation batch failed');
    return new Map<number, AcceptedTranslation>();
  }
}

async function translateDescriptionBatchWithFallback(
  items: DescriptionTranslationInput[],
): Promise<Map<number, AcceptedTranslation>> {
  const translated = await translateDescriptionBatch(items, 'batch');
  if (translated.size === items.length || items.length <= 1) {
    return translated;
  }

  let missingItems = items.filter(({ id }) => !translated.has(id));
  // Retry в мини-батчах по 4
  const failedInRetry = new Set<number>();
  if (missingItems.length > 1) {
    const retryBatches = chunkTranslationInputs(missingItems, DESCRIPTION_TRANSLATION_RETRY_BATCH_SIZE);
    for (const retryBatch of retryBatches) {
      const retryResult = await translateDescriptionBatch(retryBatch, 'retry_batch');
      mergeTranslationMaps(translated, retryResult);
      // Запоминаем items, которые не перевелись и в retry — нет смысла пробовать single
      for (const item of retryBatch) {
        if (!retryResult.has(item.id) && !translated.has(item.id)) {
          failedInRetry.add(item.id);
        }
      }
    }
  }

  // Single retry только для items, которые НЕ провалились в retry_batch
  // (те что провалились — модель уже 2 раза не справилась, третья попытка — waste)
  missingItems = items.filter(({ id }) => !translated.has(id) && !failedInRetry.has(id));
  if (missingItems.length > 0) {
    for (const missingItem of missingItems) {
      mergeTranslationMaps(translated, await translateDescriptionBatch([missingItem], 'single'));
    }
  }

  const unresolvedItems = items.filter(({ id }) => !translated.has(id));
  if (unresolvedItems.length > 0) {
    appLogger.warn(
      {
        total: items.length,
        unresolved: unresolvedItems.length,
        skippedRetry: failedInRetry.size,
        sources: unresolvedItems.map(({ headline }) => headline.source),
      },
      'News localization: some descriptions stayed untranslated after retries',
    );
  }

  return translated;
}

export async function localizeParsedHeadlines(headlines: ParsedHeadline[]): Promise<ParsedHeadline[]> {
  if (headlines.length === 0) return headlines;

  const normalizedHeadlines = headlines.map(headline => ({
    ...headline,
    description: truncateDescription(normalizeDescriptionText(headline.description)),
  }));

  const translationQueue = normalizedHeadlines
    .map((headline, index) => ({ id: index, headline }))
    .filter(({ headline }) => shouldTranslateHeadline(headline));

  if (translationQueue.length === 0) {
    return normalizedHeadlines;
  }

  const localizedHeadlines = [...normalizedHeadlines];
  const translationBatches = chunkTranslationInputs(translationQueue, DESCRIPTION_TRANSLATION_BATCH_SIZE);

  await runWithConcurrency(translationBatches, DESCRIPTION_TRANSLATION_CONCURRENCY, async batch => {
    const translatedBatch = await translateDescriptionBatchWithFallback(batch);

    batch.forEach(({ id, headline }) => {
      const translation = translatedBatch.get(id);
      if (!translation) return;

      localizedHeadlines[id] = {
        ...headline,
        description: translation.description,
        ...(translation.title ? { translatedTitle: translation.title } : {}),
      };
    });
  });

  return localizedHeadlines;
}
