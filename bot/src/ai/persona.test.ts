import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Persona читает настройки через settingsRepo.getMany — мокаем, чтобы получить
// дефолтный профиль без обращения к Appwrite.
const getManyMock = vi.fn();
vi.mock('../db/index.js', () => ({
  settingsRepo: {
    getMany: (...args: unknown[]) => getManyMock(...args),
  },
}));

import { buildPersonaSystemPrompt, clearPersonaCache } from './persona.js';

describe('buildPersonaSystemPrompt — блок достоверности (анти-галлюцинации)', () => {
  beforeEach(() => {
    getManyMock.mockReset();
    getManyMock.mockResolvedValue({}); // дефолты персоны
    clearPersonaCache();
  });

  afterEach(() => {
    clearPersonaCache();
  });

  // modelId передаём явно, чтобы не дёргать runtime-truth.
  const channels = ['telegram', 'voice', 'digest', 'system'] as const;

  it.each(channels)('включает раздел «Достоверность» для канала %s', async (channel) => {
    const prompt = await buildPersonaSystemPrompt({ channel, modelId: 'test/model:free' });
    expect(prompt).toContain('Достоверность');
    expect(prompt).toMatch(/не выдумывай/i);
    expect(prompt).toMatch(/не уверена/i);
  });

  it('ставит достоверность выше тона и для слабых (compact), и для сильных моделей', async () => {
    const weak = await buildPersonaSystemPrompt({ channel: 'telegram', modelId: 'mistral-7b:free' });
    const strong = await buildPersonaSystemPrompt({ channel: 'telegram', modelId: 'anthropic/claude-3-5' });
    for (const prompt of [weak, strong]) {
      expect(prompt).toContain('Точность важнее уверенного тона');
      expect(prompt).toMatch(/не ссылайся на несуществующие источники/i);
    }
  });
});
