import { config } from '../config/index.js';
import { appLogger } from '../config/logger.js';
import { prepareHybridDigestBase } from './digest-hybrid.js';
import { digestCacheRepo } from './digest-hybrid-repo.js';
import { userPrefsRepo } from './user-prefs-repo.js';

const DEFAULT_PREWARM_CITIES = ['Москва'];
const PREWARM_STARTUP_DELAY_MS = 20_000;
const PREWARM_MAX_CITIES = 8;
const PREWARM_RECENT_CACHE_LIMIT = 20;
const PREWARM_USER_CITY_LIMIT = 20;

let scheduledPrewarmTimer: ReturnType<typeof setTimeout> | null = null;
let activePrewarmPromise: Promise<void> | null = null;

function normalizeCity(city: string | null | undefined): string | null {
  const trimmedCity = city?.trim();
  return trimmedCity ? trimmedCity : null;
}

function mergeCities(...cityGroups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const seenCities = new Set<string>();
  const mergedCities: string[] = [];

  cityGroups.forEach(group => {
    group.forEach(city => {
      const normalizedCity = normalizeCity(city);
      if (!normalizedCity || seenCities.has(normalizedCity)) return;
      seenCities.add(normalizedCity);
      mergedCities.push(normalizedCity);
    });
  });

  return mergedCities.slice(0, PREWARM_MAX_CITIES);
}

export async function collectHybridPrewarmCities(): Promise<string[]> {
  const [recentCacheCitiesResult, userDigestCitiesResult] = await Promise.allSettled([
    digestCacheRepo.listRecentCities(PREWARM_RECENT_CACHE_LIMIT),
    userPrefsRepo.listDigestCities(PREWARM_USER_CITY_LIMIT),
  ]);

  if (recentCacheCitiesResult.status === 'rejected') {
    appLogger.warn({ error: recentCacheCitiesResult.reason }, 'Hybrid digest prewarm: recent cache cities unavailable');
  }

  if (userDigestCitiesResult.status === 'rejected') {
    appLogger.warn({ error: userDigestCitiesResult.reason }, 'Hybrid digest prewarm: user digest cities unavailable');
  }

  return mergeCities(
    DEFAULT_PREWARM_CITIES,
    recentCacheCitiesResult.status === 'fulfilled' ? recentCacheCitiesResult.value : [],
    userDigestCitiesResult.status === 'fulfilled' ? userDigestCitiesResult.value : [],
  );
}

export async function prewarmHybridDigestCaches(reason: 'startup' | 'manual' = 'startup'): Promise<void> {
  if (activePrewarmPromise) {
    appLogger.info({ reason }, 'Hybrid digest prewarm already running');
    return activePrewarmPromise;
  }

  activePrewarmPromise = (async () => {
    const targetCities = await collectHybridPrewarmCities();
    if (targetCities.length === 0) {
      appLogger.warn({ reason }, 'Hybrid digest prewarm skipped: no target cities');
      return;
    }

    const startedAt = Date.now();
    appLogger.info({ reason, cities: targetCities }, 'Hybrid digest prewarm started');

    for (const city of targetCities) {
      try {
        const prepared = await prepareHybridDigestBase(city, {
          forceRefresh: true,
          searchMode: 'full',
        });

        appLogger.info(
          {
            reason,
            city,
            cacheKey: prepared.cacheKey,
            generatedAt: prepared.payload.generated_at,
            totalHeadlines: prepared.payload.counts.total,
          },
          'Hybrid digest prewarm city prepared',
        );
      } catch (error) {
        appLogger.warn({ error, reason, city }, 'Hybrid digest prewarm city failed');
      }
    }

    appLogger.info(
      {
        reason,
        cities: targetCities,
        elapsedMs: Date.now() - startedAt,
      },
      'Hybrid digest prewarm finished',
    );
  })().finally(() => {
    activePrewarmPromise = null;
  });

  return activePrewarmPromise;
}

export function scheduleHybridDigestPrewarm(delayMs = PREWARM_STARTUP_DELAY_MS): void {
  if (!config.isProd) return;
  if (scheduledPrewarmTimer) return;

  scheduledPrewarmTimer = setTimeout(() => {
    scheduledPrewarmTimer = null;
    prewarmHybridDigestCaches('startup').catch(error => {
      appLogger.error({ error }, 'Hybrid digest prewarm failed');
    });
  }, delayMs);

  scheduledPrewarmTimer.unref();
  appLogger.info({ delayMs }, 'Hybrid digest prewarm scheduled');
}

export function stopHybridDigestPrewarm(): void {
  if (!scheduledPrewarmTimer) return;
  clearTimeout(scheduledPrewarmTimer);
  scheduledPrewarmTimer = null;
}
