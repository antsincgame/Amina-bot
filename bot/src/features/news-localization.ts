import { aiService } from '../ai/openrouter.js';
import { appLogger } from '../config/logger.js';
import type { ParsedHeadline } from '../../../shared/types/index.js';

const DESCRIPTION_TRANSLATION_BATCH_SIZE = 12;
const DESCRIPTION_TRANSLATION_TIMEOUT_MS = 45_000;
const MAX_LOCALIZED_DESCRIPTION_LENGTH = 320;

interface DescriptionTranslationInput {
  id: number;
  headline: ParsedHeadline;
}

interface DescriptionTranslationOutput {
  id: number;
  description: string;
}

function normalizeDescriptionText(text: string): string {
  return text
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

export function hasMostlyRussianText(text: string): boolean {
  const normalized = normalizeDescriptionText(text);
  if (!normalized) return false;

  const cyrillicCount = countMatches(normalized, /[а-яё]/gi);
  if (cyrillicCount === 0) return false;

  const latinCount = countMatches(normalized, /[a-z]/gi);
  return cyrillicCount >= 6 || cyrillicCount >= latinCount;
}

export function shouldTranslateHeadlineDescription(headline: ParsedHeadline): boolean {
  const normalizedDescription = normalizeDescriptionText(headline.description);
  if (!normalizedDescription) return false;
  return !hasMostlyRussianText(normalizedDescription);
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

  if (id == null || !description) return null;
  return { id, description };
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
    category: headline.category,
    language: headline.language ?? 'unknown',
    description: headline.description,
  }));

  return [
    'Переведи descriptions новостных карточек на точный естественный русский язык.',
    'Правила:',
    '- Не выдумывай новые факты, причины, выводы и детали.',
    '- Сохраняй смысл, степень уверенности и фактические формулировки исходника.',
    '- Названия компаний, моделей, продуктов, библиотек и городов оставляй в оригинальном написании, если так точнее.',
    '- Если описание уже на русском, только нормализуй формулировку.',
    `- Максимум ${MAX_LOCALIZED_DESCRIPTION_LENGTH} символов на description.`,
    '- Верни только JSON-массив без markdown fences.',
    '- Формат ответа: [{"id":1,"description":"..."}].',
    '',
    'Входные данные:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

async function translateDescriptionBatch(items: DescriptionTranslationInput[]): Promise<Map<number, string>> {
  if (items.length === 0) return new Map<number, string>();

  try {
    const response = await withTimeout(
      aiService.chat(
        [
          {
            role: 'system',
            content: 'Ты переводчик новостных дайджестов. Отвечай только валидным JSON-массивом без пояснений.',
          },
          {
            role: 'user',
            content: buildTranslationPrompt(items),
          },
        ],
        'telegram',
      ),
      DESCRIPTION_TRANSLATION_TIMEOUT_MS,
      'News description localization batch',
    );

    const parsed = parseTranslationResponse(response.content);
    if (parsed.length === 0) {
      appLogger.warn({ batchSize: items.length }, 'News localization: model returned empty translation batch');
      return new Map<number, string>();
    }

    return new Map(parsed.map(item => [item.id, item.description]));
  } catch (error) {
    appLogger.warn({ error, batchSize: items.length }, 'News localization: translation batch failed');
    return new Map<number, string>();
  }
}

export async function localizeParsedHeadlines(headlines: ParsedHeadline[]): Promise<ParsedHeadline[]> {
  if (headlines.length === 0) return headlines;

  const normalizedHeadlines = headlines.map(headline => ({
    ...headline,
    description: truncateDescription(normalizeDescriptionText(headline.description)),
  }));

  const translationQueue = normalizedHeadlines
    .map((headline, index) => ({ id: index, headline }))
    .filter(({ headline }) => shouldTranslateHeadlineDescription(headline));

  if (translationQueue.length === 0) {
    return normalizedHeadlines;
  }

  const localizedHeadlines = [...normalizedHeadlines];

  for (let index = 0; index < translationQueue.length; index += DESCRIPTION_TRANSLATION_BATCH_SIZE) {
    const batch = translationQueue.slice(index, index + DESCRIPTION_TRANSLATION_BATCH_SIZE);
    const translatedBatch = await translateDescriptionBatch(batch);

    batch.forEach(({ id, headline }) => {
      const translatedDescription = translatedBatch.get(id);
      if (!translatedDescription) return;

      localizedHeadlines[id] = {
        ...headline,
        description: translatedDescription,
      };
    });
  }

  return localizedHeadlines;
}
