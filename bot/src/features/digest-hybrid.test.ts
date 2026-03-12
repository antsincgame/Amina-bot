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
import { buildHybridDigestDeliveryKey, renderHybridDigestFromPreparedBase } from './digest-hybrid.js';
import type { PreparedDigestCachePayload } from './digest-hybrid-repo.js';

const mockedRemindersRepo = vi.mocked(remindersRepo);
const mockedTodosRepo = vi.mocked(todosRepo);

function buildPreparedPayload(): PreparedDigestCachePayload {
  return {
    version: 'hybrid-v1',
    city: 'Tokyo',
    generated_at: '2026-03-12T07:00:00.000Z',
    digest_date: '2026-03-12',
    source_hash: 'abc123',
    counts: {
      total: 6,
      ai: 3,
      community: 1,
      asia: 2,
      local: 1,
    },
    weather: {
      answer: 'Солнечно и ясно [1]',
      citations: ['https://weather.example/tokyo'],
    },
    local_search: {
      answer: 'Открыли новую AI-лабораторию [1]',
      citations: ['https://city.example/tokyo-ai'],
    },
    headlines: [
      {
        title: 'Tokyo local AI lab opens',
        url: 'https://city.example/tokyo-ai',
        source: 'Tokyo City',
        category: 'city_local',
        language: 'en',
      },
      {
        title: 'New vibecoding release',
        url: 'https://ai.example/release',
        source: 'AI Source',
        category: 'ai_tech',
        language: 'en',
      },
    ],
    local_section: '## Новости Tokyo\n\n1. [Tokyo local AI lab opens](https://city.example/tokyo-ai) — Tokyo City',
    ai_sections: [
      '## Технологии и AI\n\n**1. [New vibecoding release](https://ai.example/release)** — важный релиз для AI-разработки.',
    ],
    asia_sections: [
      '## AI из Азии\n\n**1. [生成AIの最新動向](https://asia.example/jp)** — важная новость для мониторинга рынка.',
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

    expect(key).toBe('digest:manual:42:2026-03-12:new-york:hybrid-v1');
  });

  it('renders full prepared digest for public consumer without losing cached sections', async () => {
    mockedRemindersRepo.getByUser.mockResolvedValue([]);
    mockedTodosRepo.getForDigest.mockResolvedValue([]);

    const rendered = await renderHybridDigestFromPreparedBase('public', 'Dzmitry', buildPreparedPayload());

    expect(rendered).toContain('## Полный дайджест из всех источников');
    expect(rendered).toContain('Всего заголовков: 6');
    expect(rendered).toContain('https://weather.example/tokyo');
    expect(rendered).toContain('## Новости Tokyo');
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
});
