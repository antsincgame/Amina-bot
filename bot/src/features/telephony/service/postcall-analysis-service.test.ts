import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transcribeAudioMock = vi.fn();
const logMock = vi.fn();
const upsertArtifactMock = vi.fn();
const recordEventMock = vi.fn();
const getSessionByIdMock = vi.fn();
const updateSessionMock = vi.fn();
const uploadRecordingMock = vi.fn();
const getRealtimeBridgeConfigMock = vi.fn();
const finalizeTranscriptMock = vi.fn();
const sendOwnerMessageMock = vi.fn();

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
  },
}));

vi.mock('../repository/call-session-repo.js', () => ({
  callSessionRepo: {
    getById: getSessionByIdMock,
    update: updateSessionMock,
  },
}));

vi.mock('../telephony-recordings-repo.js', () => ({
  telephonyRecordingsRepo: {
    uploadFromBuffer: uploadRecordingMock,
  },
}));

vi.mock('./realtime-bridge-config.js', () => ({
  getRealtimeBridgeConfig: getRealtimeBridgeConfigMock,
}));

vi.mock('./telephony-session-finalizer.js', () => ({
  finalizeTelephonyTranscript: finalizeTranscriptMock,
}));

vi.mock('./notification-service.js', () => ({
  sendTelephonyOwnerMessage: sendOwnerMessageMock,
}));

describe('postcall analysis service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    transcribeAudioMock.mockReset();
    logMock.mockReset();
    upsertArtifactMock.mockReset();
    recordEventMock.mockReset();
    getSessionByIdMock.mockReset();
    updateSessionMock.mockReset();
    uploadRecordingMock.mockReset();
    getRealtimeBridgeConfigMock.mockReset();
    finalizeTranscriptMock.mockReset();
    sendOwnerMessageMock.mockReset();

    logMock.mockResolvedValue(undefined);
    getRealtimeBridgeConfigMock.mockResolvedValue({ recordingRetentionDays: 30 });
    uploadRecordingMock.mockResolvedValue({
      bucket: 'telephony-recordings',
      path: '2026/03/09/session-1.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 3,
      checksumSha256: 'abc',
      signedUrl: 'https://signed.example.com/record.mp3',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: vi.fn().mockReturnValue('audio/mpeg') },
      arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
    }));
  });

  it('archives recording and delegates transcript finalization', async () => {
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
      createdAt: '2026-03-09T10:00:00.000Z',
      status: 'linked',
    });
    updateSessionMock.mockResolvedValue({
      id: 'session-1',
      status: 'recorded',
    });
    transcribeAudioMock.mockResolvedValue({
      text: 'Да, подтверждаю.',
      model: 'groq/whisper-large-v3-turbo',
      duration_seconds: 4,
    });
    finalizeTranscriptMock.mockResolvedValue({
      id: 'session-1',
      status: 'processed',
      outcomeLabel: 'успех',
    });

    const { processRecordingForSession } = await import('./postcall-analysis-service.js');
    const result = await processRecordingForSession('session-1', 'https://example.com/record.mp3');

    expect(result.status).toBe('processed');
    expect(uploadRecordingMock).toHaveBeenCalledTimes(1);
    expect(upsertArtifactMock).toHaveBeenCalledWith(
      'session-1',
      'recording',
      expect.objectContaining({
        archiveStatus: 'archived',
        storagePath: '2026/03/09/session-1.mp3',
      }),
    );
    expect(recordEventMock).toHaveBeenCalledWith(
      'session-1',
      'recording_archived',
      expect.objectContaining({
        storagePath: '2026/03/09/session-1.mp3',
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
  });

  it('marks session failed when archive or stt fails', async () => {
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
      createdAt: '2026-03-09T10:00:00.000Z',
      status: 'linked',
    });
    updateSessionMock
      .mockResolvedValueOnce({ id: 'session-2', status: 'recorded' })
      .mockResolvedValueOnce({
        id: 'session-2',
        ownerTelegramId: '7867087040',
        scenarioName: 'Подтверждение встречи',
        targetPhone: '+375291234567',
        status: 'failed',
      });
    transcribeAudioMock.mockRejectedValue(new Error('stt failed'));

    const { processRecordingForSession } = await import('./postcall-analysis-service.js');

    await expect(processRecordingForSession('session-2', 'https://example.com/record.mp3')).rejects.toThrow('stt failed');
    expect(updateSessionMock).toHaveBeenLastCalledWith('session-2', { status: 'failed' });
    expect(upsertArtifactMock).toHaveBeenCalledWith(
      'session-2',
      'analysis_report',
      expect.objectContaining({
        archiveStatus: 'failed',
      }),
    );
    expect(recordEventMock).toHaveBeenCalledWith('session-2', 'record_processing_failed', expect.any(Object));
    expect(sendOwnerMessageMock).toHaveBeenCalledTimes(1);
  });
});
