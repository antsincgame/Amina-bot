import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsGetManyMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../db/supabase.js', () => ({
  settingsRepo: {
    getMany: settingsGetManyMock,
  },
}));

describe('lirax telephony integration', () => {
  beforeEach(() => {
    settingsGetManyMock.mockReset();
    fetchMock.mockReset();

    settingsGetManyMock.mockResolvedValue({
      lirax_url: 'https://api.lirax.net/general',
      lirax_token: 'test-token',
      lirax_webhook_token: 'webhook-token',
      lirax_default_ext: '201',
      lirax_operator_phone: '',
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  it('reads AskQuestion id from id_make2calls response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id_make2calls: 'make2calls-42' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { askQuestion, clearLiraXConfigCache } = await import('./lirax.js');
    clearLiraXConfigCache();

    const result = await askQuestion({
      to: '+375291234567',
      ask: 'ru Подтвердите встречу',
    });

    expect(result.id).toBe('make2calls-42');
    expect(result.mode).toBe('ask_question');
  });
});
