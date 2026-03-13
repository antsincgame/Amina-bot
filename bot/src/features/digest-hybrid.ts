import { createHash } from 'node:crypto';
import { settingsRepo } from '../db/supabase.js';
import { appLogger } from '../config/logger.js';
import { config } from '../config/index.js';
import { remindersRepo } from '../reminders/reminders-repo.js';
import { todosRepo } from './todos-repo.js';
import { countMergedDuplicates, groupHeadlinesByCategory, parseAllConfiguredSites, type ParsedHeadline } from './news-parser.js';
import { buildDigestClosing, buildHeadlineSections, getTimeGreeting, renderStructuredHeadlineList, type DigestSearchResult, webSearchWithRetry } from './digest-core.js';
import { digestCacheRepo, type DigestDeliveryKind, type PreparedDigestCachePayload } from './digest-hybrid-repo.js';
import { escapeMarkdown, inlineCitations } from '../telegram/format.js';

const HYBRID_DIGEST_VERSION = 'hybrid-v1';
const HYBRID_CACHE_TTL_MS = 90 * 60 * 1000;
export type HybridDigestSearchMode = 'full' | 'skip';

interface HybridDigestBuildOptions {
  forceRefresh?: boolean;
  searchMode?: HybridDigestSearchMode;
}

function getCurrentDateKey(): string {
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.server.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  return dateKey || new Date().toISOString().slice(0, 10);
}

function getTodayLabel(): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.server.timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
}

function getPreparedAtLabel(isoDate: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.server.timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoDate));
}

function isCacheFresh(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() > Date.now();
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'digest';
}

function normalizeDigestCity(city: string | null | undefined): string {
  const trimmed = city?.trim();
  return trimmed || 'Москва';
}

async function buildSourceHash(
  city: string,
  digestDate: string,
  searchMode: HybridDigestSearchMode,
): Promise<string> {
  let rawSites = '';
  try {
    rawSites = await settingsRepo.get('digest_news_sites') ?? '';
  } catch (error) {
    appLogger.warn({ error, city, digestDate, searchMode }, 'Hybrid digest source hash fallback: settings unavailable');
  }
  return createHash('sha256')
    .update([HYBRID_DIGEST_VERSION, digestDate, city, searchMode, rawSites].join('|'))
    .digest('hex')
    .slice(0, 20);
}

function buildCacheKey(city: string, digestDate: string, sourceHash: string): string {
  return `digest:${HYBRID_DIGEST_VERSION}:${digestDate}:${toSlug(city)}:${sourceHash}`;
}

export function buildHybridDigestDeliveryKey(
  userId: string,
  deliveryKind: DigestDeliveryKind,
  city: string,
  digestDate: string,
): string {
  return `digest:${deliveryKind}:${userId}:${digestDate}:${toSlug(city)}:${HYBRID_DIGEST_VERSION}`;
}

function buildLocalSection(
  city: string,
  headlines: ParsedHeadline[],
  localSearch: DigestSearchResult | null,
): string {
  const blocks: string[] = [];

  if (localSearch?.answer) {
    const localAnswer = localSearch.citations.length > 0
      ? inlineCitations(localSearch.answer, localSearch.citations)
      : localSearch.answer;
    blocks.push(localAnswer);
  }

  if (headlines.length > 0) {
    blocks.push(`### Лента локальных источников\n\n${renderStructuredHeadlineList(headlines)}`);
  }

  if (blocks.length === 0) return '';
  return `## Новости ${city}\n\n${blocks.join('\n\n')}`;
}

function buildUncategorizedSection(headlines: ParsedHeadline[]): string {
  if (headlines.length === 0) return '';
  return `## Некатегоризированные источники\n\n${renderStructuredHeadlineList(headlines)}`;
}

function buildWeatherSection(city: string, weather: DigestSearchResult | null): string {
  if (!weather?.answer) {
    return `## Погода в ${city}\n\nДанные о погоде временно недоступны.`;
  }

  const weatherAnswer = weather.citations.length > 0
    ? inlineCitations(weather.answer, weather.citations)
    : weather.answer;
  return `## Погода в ${city}\n\n${weatherAnswer}`;
}

function buildOverviewSection(firstName: string | null, payload: PreparedDigestCachePayload): string {
  const greeting = getTimeGreeting(firstName);
  return [
    greeting,
    '## Полный дайджест из всех источников',
    `Город: ${payload.city}`,
    `Подготовлено: ${getPreparedAtLabel(payload.generated_at)} (${payload.digest_date})`,
    `Всего заголовков: ${payload.counts.total}`,
    `AI/Vibecoding: ${payload.counts.ai}`,
    `Сообщество: ${payload.counts.community}`,
    `AI из Азии: ${payload.counts.asia}`,
    `Локальные новости: ${payload.counts.local}`,
    `Без категории: ${payload.counts.uncategorized}`,
    `Схлопнуто дублей: ${payload.counts.merged_duplicates}`,
  ].join('\n');
}

function buildPersonalSection(
  reminders: ReadonlyArray<{ scheduled_at: string; task: string }>,
  todos: ReadonlyArray<{ task: string }>,
): string {
  const blocks: string[] = [];
  const todayISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.server.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const todayReminders = reminders.filter(reminder => {
    const reminderDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.server.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(reminder.scheduled_at));
    return reminderDate === todayISO;
  });

  if (todayReminders.length > 0) {
    const lines = todayReminders.map(reminder => {
      const time = new Intl.DateTimeFormat('ru-RU', {
        timeZone: config.server.timeZone,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(reminder.scheduled_at));
      return `- ${time} — ${escapeMarkdown(reminder.task)}`;
    });
    blocks.push(`### Напоминания на сегодня\n${lines.join('\n')}`);
  }

  if (todos.length > 0) {
    const lines = todos.slice(0, 10).map(todo => `- ${escapeMarkdown(todo.task)}`);
    blocks.push(`### Активные задачи\n${lines.join('\n')}`);
  }

  if (blocks.length === 0) return '';
  return `## Напоминания и задачи\n\n${blocks.join('\n\n')}`;
}

export async function prepareHybridDigestBase(
  city: string,
  options?: HybridDigestBuildOptions,
): Promise<{ cacheKey: string; payload: PreparedDigestCachePayload }> {
  const normalizedCity = normalizeDigestCity(city);
  const digestDate = getCurrentDateKey();
  const searchMode = options?.searchMode ?? 'full';
  const sourceHash = await buildSourceHash(normalizedCity, digestDate, searchMode);
  const cacheKey = buildCacheKey(normalizedCity, digestDate, sourceHash);

  if (!options?.forceRefresh) {
    try {
      const cached = await digestCacheRepo.getByKey(cacheKey);
      if (cached && isCacheFresh(cached.expires_at) && cached.payload?.source_hash === sourceHash) {
        appLogger.info({ city: normalizedCity, cacheKey, digestDate, searchMode }, 'Hybrid digest cache hit');
        return { cacheKey, payload: cached.payload };
      }
    } catch (error) {
      appLogger.warn({ error, city: normalizedCity, cacheKey, searchMode }, 'Hybrid digest cache read failed, continuing uncached');
    }
  }

  const todayLabel = getTodayLabel();
  const [weatherResult, parsedHeadlinesResult, localSearchResult] = await Promise.allSettled([
    searchMode === 'skip'
      ? Promise.resolve(null)
      : webSearchWithRetry(
        `Погода ${normalizedCity} сегодня ${todayLabel}: точная температура сейчас утром днём вечером, осадки, ветер, влажность, давление, ощущается как. Подробный прогноз на весь день.`,
      ),
    parseAllConfiguredSites(),
    searchMode === 'skip'
      ? Promise.resolve(null)
      : webSearchWithRetry(
        `Новости ${normalizedCity} сегодня ${todayLabel}: местные события, транспорт, благоустройство, культурная жизнь, решения властей и важные городские обновления. Верни только реальные локальные новости ${normalizedCity}.`,
      ),
  ]);

  const headlines = parsedHeadlinesResult.status === 'fulfilled' ? parsedHeadlinesResult.value : [];
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

  const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
  const localSearch = localSearchResult.status === 'fulfilled' ? localSearchResult.value : null;

  if (parsedHeadlinesResult.status === 'rejected') {
    appLogger.warn({ error: parsedHeadlinesResult.reason, city: normalizedCity }, 'Hybrid digest parser failed');
  }

  const payload: PreparedDigestCachePayload = {
    version: HYBRID_DIGEST_VERSION,
    city: normalizedCity,
    generated_at: new Date().toISOString(),
    digest_date: digestDate,
    source_hash: sourceHash,
    counts: {
      total: headlines.length,
      ai: aiTechHeadlines.length,
      community: communityHeadlines.length,
      asia: asiaHeadlines.length,
      local: localHeadlines.length,
      uncategorized: uncategorizedHeadlines.length,
      merged_duplicates: countMergedDuplicates(headlines),
    },
    weather,
    local_search: localSearch,
    headlines,
    sections,
    local_section: buildLocalSection(normalizedCity, localHeadlines, localSearch),
    uncategorized_section: buildUncategorizedSection(uncategorizedHeadlines),
    ai_sections: aiSections,
    asia_sections: asiaSections,
  };

  const expiresAt = new Date(Date.now() + HYBRID_CACHE_TTL_MS).toISOString();
  try {
    await digestCacheRepo.upsert({
      cache_key: cacheKey,
      digest_date: digestDate,
      city: normalizedCity,
      source_hash: sourceHash,
      payload,
      expires_at: expiresAt,
    });
  } catch (error) {
    appLogger.warn({ error, city: normalizedCity, cacheKey, searchMode }, 'Hybrid digest cache write failed, returning uncached payload');
  }

  appLogger.info(
    {
      city: normalizedCity,
      cacheKey,
      digestDate,
      searchMode,
      totalHeadlines: payload.counts.total,
      aiSections: payload.ai_sections.length,
      asiaSections: payload.asia_sections.length,
    },
    'Hybrid digest cache prepared',
  );

  return { cacheKey, payload };
}

export async function renderHybridDigestFromPreparedBase(
  userId: string,
  firstName: string | null,
  prepared: PreparedDigestCachePayload,
): Promise<string> {
  const shouldLoadPersonalData = userId !== 'public';
  const [remindersResult, todosResult] = shouldLoadPersonalData
    ? await Promise.allSettled([
      remindersRepo.getByUser(userId),
      todosRepo.getForDigest(userId),
    ])
    : [
      { status: 'fulfilled', value: [] } as const,
      { status: 'fulfilled', value: [] } as const,
    ];

  const reminders = remindersResult.status === 'fulfilled' ? remindersResult.value : [];
  const todos = todosResult.status === 'fulfilled' ? todosResult.value : [];

  if (remindersResult.status === 'rejected') {
    appLogger.warn({ error: remindersResult.reason, userId }, 'Hybrid digest reminders load failed');
  }

  if (todosResult.status === 'rejected') {
    appLogger.warn({ error: todosResult.reason, userId }, 'Hybrid digest todos load failed');
  }

  return [
    buildOverviewSection(firstName, prepared),
    buildWeatherSection(prepared.city, prepared.weather),
    prepared.local_section,
    prepared.uncategorized_section,
    buildPersonalSection(reminders, todos),
    ...prepared.ai_sections,
    ...prepared.asia_sections,
    buildDigestClosing(firstName),
  ].filter(Boolean).join('\n\n');
}

export async function buildHybridDigest(
  userId: string,
  firstName: string | null,
  city: string,
  options?: HybridDigestBuildOptions,
): Promise<{ cacheKey: string; digestText: string; payload: PreparedDigestCachePayload }> {
  const prepared = await prepareHybridDigestBase(city, options);
  const digestText = await renderHybridDigestFromPreparedBase(userId, firstName, prepared.payload);
  return { cacheKey: prepared.cacheKey, digestText, payload: prepared.payload };
}
