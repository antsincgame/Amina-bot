import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestCacheRecord, PreparedDigestCachePayload } from './digest-hybrid-repo.js';

const hoistedMocks = vi.hoisted(() => ({
  digestCacheRepo: {
    getByKey: vi.fn(),
    getLatestByCity: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock('../db/index.js', () => ({
  settingsRepo: {
    get: vi.fn().mockResolvedValue('[]'),
  },
}));

vi.mock('../config/logger.js', () => ({
  appLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config/index.js', () => ({
  config: {
    server: {
      timeZone: 'UTC',
    },
  },
}));

vi.mock('../reminders/reminders-repo.js', () => ({
  remindersRepo: {
    getByUser: vi.fn(),
  },
}));

vi.mock('./todos-repo.js', () => ({
  todosRepo: {
    getForDigest: vi.fn(),
  },
}));

vi.mock('./news-parser.js', () => ({
  parseAllConfiguredSites: vi.fn(),
}));

vi.mock('./digest-core.js', () => ({
  buildDigestClosing: vi.fn(() => 'closing'),
  buildParserOnlyNewsBundle: vi.fn(),
  getTimeGreeting: vi.fn(() => 'hello'),
  webSearchWithRetry: vi.fn(),
}));

vi.mock('./digest-hybrid-repo.js', () => ({
  digestCacheRepo: hoistedMocks.digestCacheRepo,
}));

vi.mock('../telegram/format.js', () => ({
  escapeMarkdown: (text: string) => text,
  inlineCitations: (text: string) => text,
}));

import { settingsRepo } from '../db/index.js';
import { parseAllConfiguredSites } from './news-parser.js';
import { buildParserOnlyNewsBundle, webSearchWithRetry } from './digest-core.js';
import { digestCacheRepo } from './digest-hybrid-repo.js';
import { PreparedDigestUnavailableError, prepareHybridDigestBase } from './digest-hybrid.js';

const mockedSettingsRepo = vi.mocked(settingsRepo);
const mockedParseAllConfiguredSites = vi.mocked(parseAllConfiguredSites);
const mockedBuildParserOnlyNewsBundle = vi.mocked(buildParserOnlyNewsBundle);
const mockedWebSearchWithRetry = vi.mocked(webSearchWithRetry);
const mockedDigestCacheRepo = vi.mocked(digestCacheRepo);

function buildPreparedPayload(city = 'Минск'): PreparedDigestCachePayload {
  return {
    version: 'hybrid-v1',
    city,
    generated_at: '2026-03-13T05:00:00.000Z',
    digest_date: '2026-03-13',
    source_hash: 'legacy-cache-hash',
    counts: {
      total: 2,
      ai: 1,
      community: 0,
      asia: 1,
      local: 0,
      uncategorized: 0,
      merged_duplicates: 0,
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
    ai_sections: ['## Технологии и AI'],
    asia_sections: ['## AI из Азии'],
  };
}

function buildLatestCacheRecord(city = 'Минск'): DigestCacheRecord {
  return {
    id: 'cache-record-1',
    cache_key: 'digest:hybrid-v1:2026-03-13:минск:legacy-cache-hash',
    pipeline: 'hybrid_appwrite',
    digest_date: '2026-03-13',
    city,
    source_hash: 'legacy-cache-hash',
    payload: buildPreparedPayload(city),
    last_error: null,
    expires_at: null,
    created_at: '2026-03-13T05:00:00.000Z',
    updated_at: '2026-03-13T05:00:00.000Z',
  };
}

describe('prepareHybridDigestBase cache fallback', () => {
  beforeEach(() => {
    mockedSettingsRepo.get.mockReset();
    mockedSettingsRepo.get.mockResolvedValue('[]');
    mockedParseAllConfiguredSites.mockReset();
    mockedBuildParserOnlyNewsBundle.mockReset();
    mockedWebSearchWithRetry.mockReset();
    mockedDigestCacheRepo.getByKey.mockReset();
    mockedDigestCacheRepo.getLatestByCity.mockReset();
    mockedDigestCacheRepo.upsert.mockReset();
  });

  it('uses latest prepared cache for public skip mode without rebuilding digest', async () => {
    const latestCache = buildLatestCacheRecord();

    mockedDigestCacheRepo.getByKey.mockResolvedValue(null);
    mockedDigestCacheRepo.getLatestByCity.mockResolvedValue(latestCache);

    const result = await prepareHybridDigestBase('Минск', { searchMode: 'skip' });

    expect(result.cacheKey).toBe(latestCache.cache_key);
    expect(result.payload).toEqual(latestCache.payload);
    expect(mockedDigestCacheRepo.getLatestByCity).toHaveBeenCalledWith('Минск');
    expect(mockedParseAllConfiguredSites).not.toHaveBeenCalled();
    expect(mockedBuildParserOnlyNewsBundle).not.toHaveBeenCalled();
    expect(mockedWebSearchWithRetry).not.toHaveBeenCalled();
    expect(mockedDigestCacheRepo.upsert).not.toHaveBeenCalled();
  });

  it('throws controlled error when no prepared cache exists for public skip mode', async () => {
    mockedDigestCacheRepo.getByKey.mockResolvedValue(null);
    mockedDigestCacheRepo.getLatestByCity.mockResolvedValue(null);

    await expect(prepareHybridDigestBase('Минск', { searchMode: 'skip' }))
      .rejects
      .toBeInstanceOf(PreparedDigestUnavailableError);

    expect(mockedParseAllConfiguredSites).not.toHaveBeenCalled();
    expect(mockedBuildParserOnlyNewsBundle).not.toHaveBeenCalled();
    expect(mockedDigestCacheRepo.upsert).not.toHaveBeenCalled();
  });
});
