import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chatMock = vi.fn();
const transcribeAudioMock = vi.fn();
const logMock = vi.fn();
const upsertArtifactMock = vi.fn();
const recordEventMock = vi.fn();
const listEventsMock = vi.fn();
const saveOutcomeMock = vi.fn();
const getSessionByIdMock = vi.fn();
const updateSessionMock = vi.fn();
const replaceTurnsMock = vi.fn();
const sendOwnerMessageMock = vi.fn();

vi.mock('../../../ai/openrouter.js', () => ({
  aiService: {
    chat: chatMock,
  },
}));

vi.mock('../../../ai/multimodal.js', () => ({
  transcribeAudio: transcribeAudioMock,
}));

vi.mock('../../../db/supabase.js', () => ({
  analyticsRepo: {
    log: logMock,
  },
}));

vi.mock('../repository/call-artifact-repo.js', () => ({
  callArtifactRepo: {
    upsertForSession: upsertArtifactMock,
  },
}));

vi.mock('../repository/call-event-repo.js', () => ({
  callEventRepo: {
    record: recordEventMock,
    listBySession: listEventsMock,
  },
}));

vi.mock('../repository/call-outcome-repo.js', () => ({
  callOutcomeRepo: {
    saveForSession: saveOutcomeMock,
  },
}));

vi.mock('../repository/call-session-repo.js', () => ({
  callSessionRepo: {
    getById: getSessionByIdMock,
    update: updateSessionMock,
  },
}));

vi.mock('../repository/call-turn-repo.js', () => ({
  callTurnRepo: {
    replaceForSession: replaceTurnsMock,
  },
}));

vi.mock('./notification-service.js', () => ({
  sendTelephonyOwnerMessage: sendOwnerMessageMock,
}));

describe('postcall analysis service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    chatMock.mockReset();
    transcribeAudioMock.mockReset();
    logMock.mockReset();
    upsertArtifactMock.mockReset();
    recordEventMock.mockReset();
    listEventsMock.mockReset();
    saveOutcomeMock.mockReset();
    getSessionByIdMock.mockReset();
    updateSessionMock.mockReset();
    replaceTurnsMock.mockReset();
    sendOwnerMessageMock.mockReset();
    logMock.mockResolvedValue(undefined);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: vi.fn().mockReturnValue('audio/mpeg') },
      arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
    }));
  });

  it('processes recording end-to-end and stores transcript, turns and summary', async () => {
    getSessionByIdMock.mockResolvedValue({
      id: 'session-1',
      ownerTelegramId: '7867087040',
      scenarioId: 'confirm-meeting',
      scenarioName: 'Подтверждение встречи',
      scenarioGoal: 'Подтвердить встречу',
      successCriteria: 'Услышать подтверждение',
      resultPrompt: 'Краткий итог',
      task: 'Подтвердить встречу',
      targetPhone: '+375291234567',
      runtimeMode: 'hybrid',
      status: 'linked',
    });
    updateSessionMock
      .mockResolvedValueOnce({
        id: 'session-1',
        ownerTelegramId: '7867087040',
        scenarioId: 'confirm-meeting',
        scenarioName: 'Подтверждение встречи',
        scenarioGoal: 'Подтвердить встречу',
        successCriteria: 'Услышать подтверждение',
        resultPrompt: 'Краткий итог',
        task: 'Подтвердить встречу',
        targetPhone: '+375291234567',
        runtimeMode: 'hybrid',
        status: 'recorded',
      })
      .mockResolvedValueOnce({
        id: 'session-1',
        ownerTelegramId: '7867087040',
        scenarioId: 'confirm-meeting',
        scenarioName: 'Подтверждение встречи',
        scenarioGoal: 'Подтвердить встречу',
        successCriteria: 'Услышать подтверждение',
        resultPrompt: 'Краткий итог',
        task: 'Подтвердить встречу',
        targetPhone: '+375291234567',
        runtimeMode: 'hybrid',
        resultSummary: 'Встреча подтверждена.',
        outcomeLabel: 'успех',
        status: 'processed',
      });
    listEventsMock.mockResolvedValue([
      {
        payload: {
          plan: {
            summary: 'Подтвердить встречу',
            callMode: 'ask_question',
            helloText: 'Здравствуйте.',
            askText: 'Подтверждаете встречу?',
            okText: 'Спасибо.',
            byeText: 'До свидания.',
            successHint: 'Подтверждение встречи',
          },
        },
      },
    ]);
    transcribeAudioMock.mockResolvedValue({ text: 'Да, подтверждаю.' });
    chatMock.mockResolvedValue({
      content: '{"outcomeLabel":"успех","resultSummary":"Встреча подтверждена."}',
    });

    const { processRecordingForSession } = await import('./postcall-analysis-service.js');

    const result = await processRecordingForSession('session-1', 'https://example.com/record.mp3');

    expect(result.status).toBe('processed');
    expect(upsertArtifactMock).toHaveBeenCalled();
    expect(replaceTurnsMock).toHaveBeenCalledWith(
      'session-1',
      expect.arrayContaining([
        expect.objectContaining({ speaker: 'agent', source: 'script' }),
        expect.objectContaining({ speaker: 'customer', source: 'transcript' }),
      ]),
    );
    expect(saveOutcomeMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      outcomeLabel: 'успех',
    }));
    expect(recordEventMock).toHaveBeenCalledWith('session-1', 'record_processed', expect.any(Object));
    expect(sendOwnerMessageMock).toHaveBeenCalledTimes(1);
  });

  it('marks session failed when analysis throws', async () => {
    getSessionByIdMock.mockResolvedValue({
      id: 'session-2',
      ownerTelegramId: '7867087040',
      scenarioId: 'confirm-meeting',
      scenarioName: 'Подтверждение встречи',
      scenarioGoal: 'Подтвердить встречу',
      successCriteria: 'Услышать подтверждение',
      resultPrompt: 'Краткий итог',
      task: 'Подтвердить встречу',
      targetPhone: '+375291234567',
      runtimeMode: 'hybrid',
      status: 'linked',
    });
    updateSessionMock
      .mockResolvedValueOnce({
        id: 'session-2',
        ownerTelegramId: '7867087040',
        scenarioId: 'confirm-meeting',
        scenarioName: 'Подтверждение встречи',
        scenarioGoal: 'Подтвердить встречу',
        successCriteria: 'Услышать подтверждение',
        resultPrompt: 'Краткий итог',
        task: 'Подтвердить встречу',
        targetPhone: '+375291234567',
        runtimeMode: 'hybrid',
        status: 'recorded',
      })
      .mockResolvedValueOnce({
        id: 'session-2',
        ownerTelegramId: '7867087040',
        scenarioId: 'confirm-meeting',
        scenarioName: 'Подтверждение встречи',
        scenarioGoal: 'Подтвердить встречу',
        successCriteria: 'Услышать подтверждение',
        resultPrompt: 'Краткий итог',
        task: 'Подтвердить встречу',
        targetPhone: '+375291234567',
        runtimeMode: 'hybrid',
        status: 'failed',
      });
    transcribeAudioMock.mockRejectedValue(new Error('stt failed'));

    const { processRecordingForSession } = await import('./postcall-analysis-service.js');

    await expect(processRecordingForSession('session-2', 'https://example.com/record.mp3')).rejects.toThrow('stt failed');
    expect(updateSessionMock).toHaveBeenLastCalledWith('session-2', { status: 'failed' });
    expect(recordEventMock).toHaveBeenCalledWith('session-2', 'record_processing_failed', expect.any(Object));
    expect(sendOwnerMessageMock).toHaveBeenCalledTimes(1);
  });
});
