import { appLogger } from '../config/logger.js';
import { digestCacheRepo } from './digest-hybrid-repo.js';
import { userPrefsRepo } from './user-prefs-repo.js';
import { prepareHybridDigestBase } from './digest-hybrid.js';

const DEFAULT_PREWARM_CITIES = ['Москва'];

let prewarmTimer: ReturnType<typeof setTimeout> | null = null;

export async function collectHybridPrewarmCities(): Promise<string[]> {
  const [recentCities, userCities] = await Promise.all([
    digestCacheRepo.listRecentCities().catch(() => []),
    userPrefsRepo.listDigestCities().catch(() => []),
  ]);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const city of [...DEFAULT_PREWARM_CITIES, ...recentCities, ...userCities]) {
    if (!seen.has(city)) {
      seen.add(city);
      result.push(city);
    }
  }

  return result;
}

export async function prewarmHybridDigestCaches(mode: string): Promise<void> {
  const cities = await collectHybridPrewarmCities();

  appLogger.info({ cities, mode }, 'digest prewarm starting');

  for (const city of cities) {
    try {
      await prepareHybridDigestBase(city, { forceRefresh: true, searchMode: 'full' });
    } catch (err) {
      appLogger.warn({ city, err }, 'digest prewarm failed for city');
    }
  }

  appLogger.info({ mode }, 'digest prewarm complete');
}

export function scheduleHybridDigestPrewarm(delayMs = 60_000): void {
  if (prewarmTimer) return;
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    prewarmHybridDigestCaches('startup').catch(err => {
      appLogger.error({ err }, 'digest prewarm startup error');
    });
  }, delayMs);
}

export function stopHybridDigestPrewarm(): void {
  if (prewarmTimer) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
  }
}
