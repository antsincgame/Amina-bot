import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionByIdMock = vi.fn();
const updateSessionMock = vi.fn();
const recordEventMock = vi.fn();
const upsertArtifactMock = vi.fn();
const upsertTurnMock = vi.fn();
const enqueueRecordingProcessingMock = vi.fn();
const getRealtimeBridgeConfigMock = vi.fn();
const finalizeTranscriptMock = vi.fn();
const generateLiveAgentTurnMock = vi.fn();

vi.mock('../repository/call-session-repo.js', () => ({
  callSessionRepo: {
    getById: getSessionByIdMock,
    update: updateSessionMock,
  },
}));

vi.mock('../repository/call-event-repo.js', () => ({
  callEventRepo: {
    record: recordEventMock,
  },
}));

vi.mock('../repository/call-artifact-repo.js', () => ({
  callArtifactRepo: {
    upsertForSession: upsertArtifactMock,
  },
}));

vi.mock('../repository/call-turn-repo.js', () => ({
  callTurnRepo: {
    upsertForSession: upsertTurnMock,
  },
}));

vi.mock('./postcall-job-worker.js', () => ({
  enqueueRecordingProcessing: enqueueRecordingProcessingMock,
}));

vi.mock('./realtime-bridge-config.js', () => ({
  getRealtimeBridgeConfig: getRealtimeBridgeConfigMock,
}));

vi.mock('./telephony-session-finalizer.js', () => ({
  finalizeTelephonyTranscript: finalizeTranscriptMock,
}));

vi.mock('./live-turn-engine.js', () => ({
  generateLiveAgentTurn: generateLiveAgentTurnMock,
}));

describe('realtime bridge service', () => {
  beforeEach(() => {
    getSessionByIdMock.mockReset();
    updateSessionMock.mockReset();
    recordEventMock.mockReset();
    upsertArtifactMock.mockReset();
    upsertTurnMock.mockReset();
    enqueueRecordingProcessingMock.mockReset();
    getRealtimeBridgeConfigMock.mockReset();
    finalizeTranscriptMock.mockReset();
    generateLiveAgentTurnMock.mockReset();

    getSessionByIdMock.mockResolvedValue({
      id: 'session-1',
      requestId: 'req-1',
      callId: 'call-1',
      status: 'live',
      recordLink: null,
    });
    updateSessionMock.mockResolvedValue({
      id: 'session-1',
      requestId: 'req-1',
      callId: 'call-1',
      status: 'completed',
      recordLink: null,
    });
    getRealtimeBridgeConfigMock.mockResolvedValue({
      storePartialTranscript: true,
      recordingRetentionDays: 30,
      latencyBudgetMs: 1800,
    });
  });

  it('finalizes transcript on call completed callback', async () => {
    finalizeTranscriptMock.mockResolvedValue({
      id: 'session-1',
      status: 'processed',
    });

    const { handleRealtimeBridgeEvent } = await import('./realtime-bridge-service.js');
    const result = await handleRealtimeBridgeEvent({
      sessionId: 'session-1',
      eventType: 'callCompleted',
      requestId: 'req-1',
      callId: 'call-1',
      transcript: 'Да, подтверждаю.',
      recordingUrl: 'https://example.com/record.mp3',
      recordingStoragePath: '2026/03/09/session-1.mp3',
      recordingSignedUrl: 'https://signed.example.com/record.mp3',
    });

    expect(updateSessionMock).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        status: 'completed',
        provider: 'media_bridge',
      }),
    );
    expect(upsertArtifactMock).toHaveBeenCalledWith(
      'session-1',
      'recording',
      expect.objectContaining({
        storagePath: '2026/03/09/session-1.mp3',
        archiveStatus: 'archived',
      }),
    );
    expect(finalizeTranscriptMock).toHaveBeenCalledWith(
      'session-1',
      'Да, подтверждаю.',
      expect.objectContaining({
        recordLink: 'https://signed.example.com/record.mp3',
        finalStatus: 'processed',
      }),
    );
    expect(result.status).toBe('processed');
  });

  it('proxies respond endpoint to live turn engine', async () => {
    getRealtimeBridgeConfigMock.mockResolvedValue({
      storePartialTranscript: true,
      recordingRetentionDays: 30,
      latencyBudgetMs: 1800,
    });
    generateLiveAgentTurnMock.mockResolvedValue({
      replyText: 'Отлично, фиксирую.',
      shouldEndCall: false,
      shouldFallback: false,
      fallbackReason: null,
      outcomeLabel: 'успех',
      resultSummary: 'Собеседник согласился.',
    });

    const { respondToRealtimeBridge } = await import('./realtime-bridge-service.js');
    const result = await respondToRealtimeBridge({
      sessionId: 'session-1',
      transcript: 'Да, удобно.',
      isFinal: true,
      providerEventId: 'evt-1',
    });

    expect(generateLiveAgentTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        providerEventId: 'evt-1',
      }),
    );
    expect(result.replyText).toBe('Отлично, фиксирую.');
    expect(result.outcomeLabel).toBe('успех');
  });

  it('allows bootstrap respond without customer transcript', async () => {
    getRealtimeBridgeConfigMock.mockResolvedValue({
      storePartialTranscript: true,
      recordingRetentionDays: 30,
      latencyBudgetMs: 1800,
    });
    generateLiveAgentTurnMock.mockResolvedValue({
      replyText: 'Здравствуйте, вас беспокоит AI-ассистент Амина. Подскажите, пожалуйста, вы придёте?',
      shouldEndCall: false,
      shouldFallback: false,
      fallbackReason: null,
      outcomeLabel: 'неясно',
      resultSummary: 'Стартовый вопрос отправлен.',
    });

    const { respondToRealtimeBridge } = await import('./realtime-bridge-service.js');
    const result = await respondToRealtimeBridge({
      sessionId: 'session-1',
      transcript: '',
      bootstrap: true,
      isFinal: true,
      providerEventId: 'evt-bootstrap',
    });

    expect(generateLiveAgentTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        bootstrap: true,
        transcript: '',
      }),
    );
    expect(result.replyText).toContain('AI-ассистент Амина');
  });

  it('requests fallback when latency budget is exceeded', async () => {
    getRealtimeBridgeConfigMock.mockResolvedValue({
      storePartialTranscript: true,
      recordingRetentionDays: 30,
      latencyBudgetMs: 500,
    });

    const { respondToRealtimeBridge } = await import('./realtime-bridge-service.js');
    const result = await respondToRealtimeBridge({
      sessionId: 'session-1',
      transcript: 'Да, удобно.',
      latencyMs: 900,
      providerEventId: 'evt-latency',
    });

    expect(updateSessionMock).toHaveBeenCalledWith('session-1', { status: 'fallback' });
    expect(recordEventMock).toHaveBeenCalledWith(
      'session-1',
      'fallback_triggered',
      expect.objectContaining({
        triggeredBy: 'latency_budget',
      }),
      'evt-latency',
    );
    expect(result.shouldFallback).toBe(true);
    expect(generateLiveAgentTurnMock).not.toHaveBeenCalled();
  });
});
