import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoistedMocks = vi.hoisted(() => ({
  config: {
    isProd: true,
  },
  digestCacheRepo: {
    listRecentCities: vi.fn(),
  },
  userPrefsRepo: {
    listDigestCities: vi.fn(),
  },
  prepareHybridDigestBase: vi.fn(),
  appLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config/index.js', () => ({
  config: hoistedMocks.config,
}));

vi.mock('../config/logger.js', () => ({
  appLogger: hoistedMocks.appLogger,
}));

vi.mock('./digest-hybrid-repo.js', () => ({
  digestCacheRepo: hoistedMocks.digestCacheRepo,
}));

vi.mock('./user-prefs-repo.js', () => ({
  userPrefsRepo: hoistedMocks.userPrefsRepo,
}));

vi.mock('./digest-hybrid.js', () => ({
  prepareHybridDigestBase: hoistedMocks.prepareHybridDigestBase,
}));

import { digestCacheRepo } from './digest-hybrid-repo.js';
import { userPrefsRepo } from './user-prefs-repo.js';
import { prepareHybridDigestBase } from './digest-hybrid.js';
import {
  collectHybridPrewarmCities,
  prewarmHybridDigestCaches,
  scheduleHybridDigestPrewarm,
  stopHybridDigestPrewarm,
} from './digest-hybrid-prewarm.js';

const mockedDigestCacheRepo = vi.mocked(digestCacheRepo);
const mockedUserPrefsRepo = vi.mocked(userPrefsRepo);
const mockedPrepareHybridDigestBase = vi.mocked(prepareHybridDigestBase);

function buildPreparedResult(city: string) {
  return {
    cacheKey: `digest:hybrid-v3:2026-03-13:${city}`,
    payload: {
      version: 'hybrid-v3',
      city,
      generated_at: '2026-03-13T06:10:00.000Z',
      digest_date: '2026-03-13',
      source_hash: `${city}-hash`,
      counts: {
        total: 10,
        ai: 4,
        community: 1,
        asia: 3,
        local: 2,
        uncategorized: 0,
        merged_duplicates: 1,
      },
      weather: null,
      headlines: [],
      sections: {
        ai_tech: [],
        community: [],
        asia_tech: [],
        city_local: [],
        uncategorized: [],
      },
      local_section: '',
      uncategorized_section: '',
      ai_sections: [],
      asia_sections: [],
    },
  };
}

describe('digest hybrid prewarm', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockedDigestCacheRepo.listRecentCities.mockReset();
    mockedUserPrefsRepo.listDigestCities.mockReset();
    mockedPrepareHybridDigestBase.mockReset();
    hoistedMocks.config.isProd = true;

    mockedDigestCacheRepo.listRecentCities.mockResolvedValue([]);
    mockedUserPrefsRepo.listDigestCities.mockResolvedValue([]);
    mockedPrepareHybridDigestBase.mockImplementation(async city => buildPreparedResult(city));
  });

  afterEach(() => {
    stopHybridDigestPrewarm();
    vi.useRealTimers();
  });

  it('collects unique startup cities from defaults, cache history and user prefs', async () => {
    mockedDigestCacheRepo.listRecentCities.mockResolvedValue(['Минск', 'Москва', 'Токио']);
    mockedUserPrefsRepo.listDigestCities.mockResolvedValue(['Сеул', 'Минск']);

    const cities = await collectHybridPrewarmCities();

    expect(cities).toEqual(['Москва', 'Минск', 'Токио', 'Сеул']);
  });

  it('prewarms collected cities sequentially with full refresh mode', async () => {
    mockedDigestCacheRepo.listRecentCities.mockResolvedValue(['Минск']);
    mockedUserPrefsRepo.listDigestCities.mockResolvedValue(['Токио', 'Минск']);

    await prewarmHybridDigestCaches('manual');

    expect(mockedPrepareHybridDigestBase.mock.calls).toEqual([
      ['Москва', { forceRefresh: true, searchMode: 'full' }],
      ['Минск', { forceRefresh: true, searchMode: 'full' }],
      ['Токио', { forceRefresh: true, searchMode: 'full' }],
    ]);
  });

  it('schedules startup prewarm in production mode', async () => {
    vi.useFakeTimers();
    mockedDigestCacheRepo.listRecentCities.mockResolvedValue(['Минск']);

    scheduleHybridDigestPrewarm(25);
    expect(mockedPrepareHybridDigestBase).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);

    expect(mockedPrepareHybridDigestBase.mock.calls).toEqual([
      ['Москва', { forceRefresh: true, searchMode: 'full' }],
      ['Минск', { forceRefresh: true, searchMode: 'full' }],
    ]);
  });
});
