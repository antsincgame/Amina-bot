import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { remindersRepo } from '../reminders/reminders-repo.js';
import { todosRepo } from './todos-repo.js';
import { buildParserOnlyNewsBundle } from './digest-core.js';
import { buildHybridDigestDeliveryKey, renderHybridDigestFromPreparedBase } from './digest-hybrid.js';
import type { PreparedDigestCachePayload } from './digest-hybrid-repo.js';

const mockedRemindersRepo = vi.mocked(remindersRepo);
const mockedTodosRepo = vi.mocked(todosRepo);

function buildPreparedPayload(): PreparedDigestCachePayload {
  return {
    version: 'hybrid-v3',
    city: 'Tokyo',
    generated_at: '2026-03-12T07:00:00.000Z',
    digest_date: '2026-03-12',
    source_hash: 'abc123',
    counts: {
      total: 3,
      ai: 1,
      community: 0,
      asia: 0,
      local: 1,
      uncategorized: 1,
      merged_duplicates: 1,
    },
    weather: {
      answer: 'Солнечно и ясно [1]',
      citations: ['https://weather.example/tokyo'],
    },
    headlines: [
      {
        title: 'Tokyo local AI lab opens',
        url: 'https://city.example/tokyo-ai',
        canonicalUrl: 'https://city.example/tokyo-ai',
        source: 'Tokyo City',
        sourceDomain: 'city.example',
        description: 'В Токио открыли новую AI-лабораторию для локальных стартапов.',
        fingerprint: 'fp-local',
        alternateSources: ['City Mirror'],
        category: 'city_local',
        language: 'en',
      },
      {
        title: 'New vibecoding release',
        url: 'https://ai.example/release',
        canonicalUrl: 'https://ai.example/release',
        source: 'AI Source',
        sourceDomain: 'ai.example',
        description: 'Новый релиз инструмента для AI-разработки и vibecoding.',
        fingerprint: 'fp-ai',
        alternateSources: [],
        category: 'ai_tech',
        language: 'en',
      },
      {
        title: 'Orphan source headline',
        url: 'https://misc.example/orphan',
        canonicalUrl: 'https://misc.example/orphan',
        source: 'Misc Source',
        sourceDomain: 'misc.example',
        description: 'Материал без явной категории, но со структурированным описанием.',
        fingerprint: 'fp-orphan',
        alternateSources: [],
        category: 'uncategorized',
        language: 'en',
      },
    ],
    sections: {
      ai_tech: [
        {
          title: 'New vibecoding release',
          url: 'https://ai.example/release',
          canonicalUrl: 'https://ai.example/release',
          source: 'AI Source',
          sourceDomain: 'ai.example',
          description: 'Новый релиз инструмента для AI-разработки и vibecoding.',
          fingerprint: 'fp-ai',
          alternateSources: [],
          category: 'ai_tech',
          language: 'en',
        },
      ],
      community: [],
      asia_tech: [],
      city_local: [
        {
          title: 'Tokyo local AI lab opens',
          url: 'https://city.example/tokyo-ai',
          canonicalUrl: 'https://city.example/tokyo-ai',
          source: 'Tokyo City',
          sourceDomain: 'city.example',
          description: 'В Токио открыли новую AI-лабораторию для локальных стартапов.',
          fingerprint: 'fp-local',
          alternateSources: ['City Mirror'],
          category: 'city_local',
          language: 'en',
        },
      ],
      uncategorized: [
        {
          title: 'Orphan source headline',
          url: 'https://misc.example/orphan',
          canonicalUrl: 'https://misc.example/orphan',
          source: 'Misc Source',
          sourceDomain: 'misc.example',
          description: 'Материал без явной категории, но со структурированным описанием.',
          fingerprint: 'fp-orphan',
          alternateSources: [],
          category: 'uncategorized',
          language: 'en',
        },
      ],
    },
    local_section: '## Новости Tokyo\n\n**1. [Tokyo local AI lab opens](https://city.example/tokyo-ai)**\nИсточник: Tokyo City · Категория: Город\nОписание: В Токио открыли новую AI-лабораторию для локальных стартапов.\nАльтернативные источники: City Mirror.',
    uncategorized_section: '## Некатегоризированные источники\n\n**1. [Orphan source headline](https://misc.example/orphan)**\nИсточник: Misc Source · Категория: Без категории\nОписание: Материал без явной категории, но со структурированным описанием.',
    ai_sections: [
      '## Технологии и AI\n\n**1. [New vibecoding release](https://ai.example/release)**\nИсточник: AI Source · Категория: AI/Tech\nОписание: Новый релиз инструмента для AI-разработки и vibecoding.',
    ],
    asia_sections: [
      '## AI из Азии\n\n**1. [生成AIの最新動向](https://asia.example/jp)**\nИсточник: Asia Wire · Категория: AI Азия\nОписание: Важная новость для мониторинга рынка.',
    ],
  };
}

describe('digest hybrid pipeline', () => {
  beforeEach(() => {
    mockedRemindersRepo.getByUser.mockReset();
    mockedTodosRepo.getForDigest.mockReset();
  });

  it('builds stable delivery keys for hybrid pipeline', () => {
    const key = buildHybridDigestDeliveryKey('42', 'manual', '  New York  ', '2026-03-12');

    expect(key).toBe('digest:manual:42:2026-03-12:new-york:hybrid-v3');
  });

  it('renders full prepared digest for public consumer without losing cached sections', async () => {
    mockedRemindersRepo.getByUser.mockResolvedValue([]);
    mockedTodosRepo.getForDigest.mockResolvedValue([]);

    const rendered = await renderHybridDigestFromPreparedBase('public', 'Dzmitry', buildPreparedPayload());

    expect(rendered).toContain('## Полный дайджест из всех источников');
    expect(rendered).toContain('Всего заголовков: 3');
    expect(rendered).toContain('https://weather.example/tokyo');
    expect(rendered).toContain('## Новости Tokyo');
    expect(rendered).toContain('## Некатегоризированные источники');
    expect(rendered).toContain('## Технологии и AI');
    expect(rendered).toContain('## AI из Азии');
    expect(rendered).toContain('## Настрой на день');
  });

  it('adds reminders and todos for non-public users', async () => {
    const reminderDate = new Date().toISOString();
    mockedRemindersRepo.getByUser.mockResolvedValue([
      {
        id: 'rem-1',
        user_id: '42',
        chat_id: 1,
        task: 'Позвонить партнёру',
        scheduled_at: reminderDate,
        is_completed: false,
        created_at: reminderDate,
        updated_at: reminderDate,
      },
    ]);
    mockedTodosRepo.getForDigest.mockResolvedValue([
      {
        id: 'todo-1',
        user_id: '42',
        task: 'Проверить все AI-источники',
        is_done: false,
        done_at: null,
        created_at: reminderDate,
      },
    ]);

    const rendered = await renderHybridDigestFromPreparedBase('42', 'Dzmitry', buildPreparedPayload());

    expect(rendered).toContain('## Напоминания и задачи');
    expect(rendered).toContain('Позвонить партнёру');
    expect(rendered).toContain('Проверить все AI\\-источники');
  });

  it('builds parser-only local sections without local search payload', async () => {
    const bundle = await buildParserOnlyNewsBundle('Минск', [
      {
        title: 'Минск открыл городской AI-хаб',
        url: 'https://city.example/minsk-ai',
        canonicalUrl: 'https://city.example/minsk-ai',
        source: 'Minsk City',
        sourceDomain: 'city.example',
        description: 'В Минске открыли городской AI-хаб для стартапов и образовательных программ.',
        fingerprint: 'fp-minsk',
        alternateSources: [],
        category: 'city_local',
        language: 'ru',
      },
      {
        title: 'Редкий источник без категории',
        url: 'https://misc.example/item',
        canonicalUrl: 'https://misc.example/item',
        source: 'Misc Source',
        sourceDomain: 'misc.example',
        description: 'Материал без категории уже приходит из parser-only потока.',
        fingerprint: 'fp-misc',
        alternateSources: [],
        category: 'uncategorized',
        language: 'ru',
      },
    ]);

    expect(bundle.counts.local).toBe(1);
    expect(bundle.counts.uncategorized).toBe(1);
    expect(bundle.localSection).toContain('## Новости Минск');
    expect(bundle.localSection).toContain('Минск открыл городской AI-хаб');
    expect(bundle.uncategorizedSection).toContain('Редкий источник без категории');
    expect(bundle.aiSections).toEqual([]);
    expect(bundle.asiaSections).toEqual([]);
  });
});
