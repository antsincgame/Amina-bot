import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatMock = vi.fn();
const askQuestionMock = vi.fn();
const connectCallMock = vi.fn();
const registerSessionMock = vi.fn();
const settingsGetMock = vi.fn();
const settingsGetManyMock = vi.fn();
const settingsSetMock = vi.fn();

vi.mock('../../ai/openrouter.js', () => ({
  aiService: {
    chat: chatMock,
  },
}));

vi.mock('../../db/supabase.js', () => ({
  settingsRepo: {
    get: settingsGetMock,
    getMany: settingsGetManyMock,
    set: settingsSetMock,
  },
}));

vi.mock('./lirax.js', () => ({
  askQuestion: askQuestionMock,
  connectCall: connectCallMock,
}));

vi.mock('./ai-call-sessions.js', () => ({
  registerTelephonyAiCallSession: registerSessionMock,
}));

describe('telephony ai scenarios', () => {
  beforeEach(() => {
    chatMock.mockReset();
    askQuestionMock.mockReset();
    connectCallMock.mockReset();
    registerSessionMock.mockReset();
    settingsGetMock.mockReset();
    settingsGetManyMock.mockReset();
    settingsSetMock.mockReset();

    settingsGetMock.mockResolvedValue(null);
    settingsGetManyMock.mockResolvedValue({});
    settingsSetMock.mockResolvedValue(undefined);
    registerSessionMock.mockResolvedValue(undefined);
  });

  it('returns default scenarios when settings are empty', async () => {
    const { getTelephonyAiScenarios } = await import('./ai-scenarios.js');

    const scenarios = await getTelephonyAiScenarios();

    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios[0]?.id).toBe('confirm-meeting');
    expect(scenarios.every((scenario) => scenario.enabled)).toBe(true);
  });

  it('uses owner fallback from lirax_admin_chat_id', async () => {
    settingsGetManyMock.mockResolvedValue({
      lirax_owner_chat_id: '',
      lirax_admin_chat_id: '7867087040',
      admin_chat_id: '',
    });

    const { getTelephonyOwnerTelegramId, isTelephonyOwner } = await import('./ai-scenarios.js');

    await expect(getTelephonyOwnerTelegramId()).resolves.toBe('7867087040');
    await expect(isTelephonyOwner('7867087040')).resolves.toBe(true);
    await expect(isTelephonyOwner('123')).resolves.toBe(false);
  });

  it('builds ask_question plan from AI JSON and starts LiraX call', async () => {
    chatMock.mockResolvedValue({
      content: JSON.stringify({
        summary: 'Подтвердить встречу',
        helloText: 'Здравствуйте, вас беспокоит Амина.',
        askText: 'Подтвердите, пожалуйста, встречу завтра в 14:00.',
        okText: 'Спасибо, фиксирую подтверждение.',
        byeText: 'Благодарю за ответ, до свидания.',
        successHint: 'Нужно понять, подтверждена ли встреча.',
      }),
      model: 'local-model',
      tokens_used: { prompt: 10, completion: 20, total: 30 },
      finish_reason: 'stop',
    });

    askQuestionMock.mockResolvedValue({ id: 'ask-1', mode: 'ask_question' });

    const { startTelephonyAiCall } = await import('./ai-scenarios.js');

    const result = await startTelephonyAiCall({
      scenarioId: 'confirm-meeting',
      phone: '+375291234567',
      task: 'Подтверди встречу на завтра в 14:00.',
      ownerTelegramId: '7867087040',
      initiatedBy: 'Амина',
    });

    expect(result.plan.callMode).toBe('ask_question');
    expect(result.plan.askText).toContain('встречу');
    expect(askQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '+375291234567',
        ask: expect.stringContaining('ru '),
      }),
    );
    expect(registerSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerTelegramId: '7867087040',
        requestId: 'ask-1',
      }),
    );
  });

  it('falls back to connectCall for speech mode', async () => {
    settingsGetMock.mockResolvedValue(
      JSON.stringify([
        {
          id: 'delivery-update',
          name: 'Оповещение',
          enabled: true,
          callMode: 'speech',
          goal: 'Озвучить сообщение',
          systemPrompt: 'Говори коротко.',
          openingLine: 'Здравствуйте.',
          questionHint: '',
          successCriteria: 'Сообщение доставлено.',
          resultPrompt: 'Кратко опиши реакцию.',
          maxSpeechChars: 300,
          createdAt: '2026-03-09T00:00:00.000Z',
          updatedAt: '2026-03-09T00:00:00.000Z',
        },
      ]),
    );

    chatMock.mockResolvedValue({
      content: JSON.stringify({
        summary: 'Озвучить перенос доставки',
        speechText: 'Здравствуйте. Сообщаю, что доставка переносится на завтра после обеда.',
        successHint: 'Важно донести перенос.',
      }),
      model: 'local-model',
      tokens_used: { prompt: 10, completion: 20, total: 30 },
      finish_reason: 'stop',
    });
    connectCallMock.mockResolvedValue({ id: 'call-1', mode: 'makecall' });

    const { startTelephonyAiCall } = await import('./ai-scenarios.js');

    const result = await startTelephonyAiCall({
      scenarioId: 'delivery-update',
      phone: '+375291234567',
      task: 'Сообщи о переносе доставки на завтра.',
      ownerTelegramId: '7867087040',
      initiatedBy: 'Амина',
    });

    expect(result.plan.callMode).toBe('speech');
    expect(connectCallMock).toHaveBeenCalledWith(
      '+375291234567',
      expect.stringContaining('доставка'),
    );
  });
});
