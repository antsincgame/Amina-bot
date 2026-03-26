import { aiService } from '../ai/openrouter.js';
import { appLogger } from '../config/logger.js';
import { settingsRepo } from '../db/appwrite.js';
import type { ParsedHeadline } from '../../../shared/types/index.js';

const DESCRIPTION_TRANSLATION_BATCH_SIZE = 4;
const DESCRIPTION_TRANSLATION_RETRY_BATCH_SIZE = 2;
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
  return /[\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\uff00-\uffef]/.test(text);
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

  if (id === null || id === undefined || !description) return null;
  return { id, description, title };
}

// FIX: обёрнуто в try-catch — JSON.parse может выбросить SyntaxError
function parseTranslationResponse(content: string): DescriptionTranslationOutput[] {
  const sanitized = stripMarkdownFences(content);
  const arrayText = extractJsonArray(sanitized);
  if (!arrayText) return [];

  try {
    const parsed = JSON.parse(arrayText) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(parseTranslationItem)
      .filter((item): item is DescriptionTranslationOutput => item !== null);
  } catch {
    appLogger.debug({ content: arrayText.slice(0, 100) }, 'News localization: failed to parse translation JSON');
    return [];
  }
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
  const lines = items.map(({ id, headline }) => {
    const excerpt = headline.articleExcerpt?.slice(0, 300) ?? '';
    const desc = headline.description.slice(0, 200);
    return `[${id}] "${headline.title}" | ${desc}${excerpt ? ` | ${excerpt}` : ''}`;
  }).join('\n');

  return `Переведи каждый пункт на РУССКИЙ язык. ОБЯЗАТЕЛЬНО верни оба поля:
- title: переведённый заголовок на русском
- description: о чём статья, 1-2 предложения на русском

Названия продуктов (Claude Code, Cursor, Copilot, DeepSeek и т.д.) оставь на латинице.
Японские, корейские, китайские заголовки — ОБЯЗАТЕЛЬНО перевести на русский.
Максимум ${MAX_LOCALIZED_DESCRIPTION_LENGTH} символов на description.
Ответ — ТОЛЬКО JSON: [{"id":0,"title":"заголовок на русском","description":"описание на русском"}]

${lines}`;
}

function isTranslationAcceptable(text: string): boolean {
  const normalized = normalizeDescriptionText(text);
  if (!normalized) return false;

  const cyrillicCount = countMatches(normalized, /[а-яё]/gi);
  if (cyrillicCount < 4) return false;

  const cjkCount = countMatches(normalized, /[\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\uff00-\uffef]/g);
  if (cjkCount > cyrillicCount) return false;

  return true;
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
    if (!translation) {
      appLogger.debug({ id, source: headline.source }, 'News localization: no translation returned for item');
      return;
    }
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

const DEFAULT_TRANSLATION_PROVIDERS = ['cerebras', 'groq', 'openrouter'] as const;

async function getTranslationProviders(): Promise<string[]> {
  try {
    const saved = await settingsRepo.get('news_translation_provider');
    if (!saved || saved === 'auto') return [...DEFAULT_TRANSLATION_PROVIDERS];
    return [saved];
  } catch {
    return [...DEFAULT_TRANSLATION_PROVIDERS];
  }
}

async function callTranslationProvider(
  items: DescriptionTranslationInput[],
  provider: string,
  scope: string,
): Promise<Map<number, AcceptedTranslation>> {
  const response = await withTimeout(
    aiService.chat(
      [
        {
          role: 'system',
          content: 'Переводчик технических новостей. Ответ: только JSON-массив. Никакого другого текста.',
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
        providerOverride: provider,
        priority: 'background',
      },
    ),
    DESCRIPTION_TRANSLATION_TIMEOUT_MS,
    `News localization ${scope} (${provider})`,
  );

  const parsed = parseTranslationResponse(response.content);
  if (parsed.length === 0) return new Map<number, AcceptedTranslation>();

  return acceptTranslatedDescriptions(items, parsed);
}

async function translateDescriptionBatch(
  items: DescriptionTranslationInput[],
  scope: 'batch' | 'retry_batch' | 'single',
): Promise<Map<number, AcceptedTranslation>> {
  if (items.length === 0) return new Map<number, AcceptedTranslation>();

  const providers = await getTranslationProviders();

  for (const provider of providers) {
    try {
      const accepted = await callTranslationProvider(items, provider, scope);
      if (accepted.size > 0) {
        if (provider !== providers[0]) {
          appLogger.info({ provider, batchSize: items.length, accepted: accepted.size, scope }, 'News localization: fallback provider succeeded');
        }
        return accepted;
      }
      appLogger.warn({ provider, batchSize: items.length, scope }, 'News localization: provider returned no acceptable translations, trying next');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      appLogger.warn({ error: errorMsg, provider, batchSize: items.length, scope }, 'News localization: provider failed, trying next');
    }
  }

  appLogger.warn({ batchSize: items.length, scope, providers }, 'News localization: all providers failed');
  return new Map<number, AcceptedTranslation>();
  }
}

// FIX: убрано `|| items.length <= 1` — single-item батчи тоже должны иметь retry
async function translateDescriptionBatchWithFallback(
  items: DescriptionTranslationInput[],
): Promise<Map<number, AcceptedTranslation>> {
  const translated = await translateDescriptionBatch(items, 'batch');
  if (translated.size === items.length) {
    return translated;
  }

  let missingItems = items.filter(({ id }) => !translated.has(id));

  // FIX: сначала запоминаем failed, потом merge — правильный порядок
  const failedInRetry = new Set<number>();
  if (missingItems.length > 1) {
    const retryBatches = chunkTranslationInputs(missingItems, DESCRIPTION_TRANSLATION_RETRY_BATCH_SIZE);
    for (const retryBatch of retryBatches) {
      const retryResult = await translateDescriptionBatch(retryBatch, 'retry_batch');
      for (const item of retryBatch) {
        if (!retryResult.has(item.id)) {
          failedInRetry.add(item.id);
        }
      }
      mergeTranslationMaps(translated, retryResult);
    }
  }

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

  for (const batch of translationBatches) {
    const translatedBatch = await translateDescriptionBatchWithFallback(batch);

    batch.forEach(({ id, headline }) => {
      const translation = translatedBatch.get(id);
      if (!translation) return;

      const needsTitle = needsTitleTranslation(headline.title);
      const translatedTitle = translation.title && isTranslationAcceptable(translation.title)
        ? translation.title
        : undefined;

      localizedHeadlines[id] = {
        ...headline,
        description: translation.description,
        ...(translatedTitle ? { translatedTitle } : {}),
        // Если title нужен перевод но LLM не дал title — ставим description как fallback hint
        ...(needsTitle && !translatedTitle && translation.description
          ? { translatedTitle: translation.description.split('.')[0]?.slice(0, 120) || headline.title }
          : {}),
      };
    });
  }

  return localizedHeadlines;
}
