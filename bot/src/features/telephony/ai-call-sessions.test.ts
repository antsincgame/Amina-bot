import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordEventMock = vi.fn();
const findPendingByPhoneMock = vi.fn();
const getByRequestIdMock = vi.fn();
const getByCallIdMock = vi.fn();
const updateSessionMock = vi.fn();
const listRecentMock = vi.fn();
const createSessionMock = vi.fn();
const enqueueRecordingProcessingMock = vi.fn();
const sendTelephonyOwnerMessageMock = vi.fn();

vi.mock('./repository/call-event-repo.js', () => ({
  callEventRepo: {
    record: recordEventMock,
  },
}));

vi.mock('./repository/call-session-repo.js', () => ({
  callSessionRepo: {
    create: createSessionMock,
    listRecent: listRecentMock,
    findPendingByPhone: findPendingByPhoneMock,
    getByRequestId: getByRequestIdMock,
    getByCallId: getByCallIdMock,
    update: updateSessionMock,
  },
}));

vi.mock('./service/postcall-job-worker.js', () => ({
  enqueueRecordingProcessing: enqueueRecordingProcessingMock,
}));

vi.mock('./service/notification-service.js', () => ({
  sendTelephonyOwnerMessage: sendTelephonyOwnerMessageMock,
}));

describe('telephony ai call sessions facade', () => {
  beforeEach(() => {
    recordEventMock.mockReset();
    findPendingByPhoneMock.mockReset();
    getByRequestIdMock.mockReset();
    getByCallIdMock.mockReset();
    updateSessionMock.mockReset();
    listRecentMock.mockReset();
    createSessionMock.mockReset();
    enqueueRecordingProcessingMock.mockReset();
    sendTelephonyOwnerMessageMock.mockReset();
  });

  it('links pending session to call id and records event', async () => {
    findPendingByPhoneMock.mockResolvedValue({ id: 'session-1' });
    updateSessionMock.mockResolvedValue({ id: 'session-1', status: 'linked' });

    const { linkTelephonyAiSessionCallId } = await import('./ai-call-sessions.js');

    await expect(linkTelephonyAiSessionCallId('+375291234567', 'call-1')).resolves.toEqual({
      id: 'session-1',
      status: 'linked',
    });
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', {
      callId: 'call-1',
      status: 'linked',
    });
    expect(recordEventMock).toHaveBeenCalledWith('session-1', 'call_linked', expect.objectContaining({
      callId: 'call-1',
    }));
  });

  it('marks failed session by request id and notifies owner', async () => {
    getByRequestIdMock.mockResolvedValue({
      id: 'session-1',
      requestId: 'req-1',
      ownerTelegramId: '7867087040',
      scenarioName: 'Подтверждение встречи',
      targetPhone: '+375291234567',
    });
    updateSessionMock.mockResolvedValue({
      id: 'session-1',
      requestId: 'req-1',
      ownerTelegramId: '7867087040',
      scenarioName: 'Подтверждение встречи',
      targetPhone: '+375291234567',
      status: 'failed',
    });

    const { failTelephonyAiCallByRequestId } = await import('./ai-call-sessions.js');

    const result = await failTelephonyAiCallByRequestId('req-1');

    expect(result?.status).toBe('failed');
    expect(recordEventMock).toHaveBeenCalledWith('session-1', 'call_failed', { requestId: 'req-1' });
    expect(sendTelephonyOwnerMessageMock).toHaveBeenCalledTimes(1);
  });

  it('enqueues record processing instead of fire-and-forget analysis', async () => {
    getByCallIdMock.mockResolvedValue({ id: 'session-1' });

    const { processTelephonyAiCallRecording } = await import('./ai-call-sessions.js');

    const result = await processTelephonyAiCallRecording('call-1', 'https://example.com/record.mp3');

    expect(result).toEqual({ id: 'session-1' });
    expect(recordEventMock).toHaveBeenCalledWith('session-1', 'webhook_event_received', {
      cmd: 'record',
      callId: 'call-1',
      recordLink: 'https://example.com/record.mp3',
    });
    expect(enqueueRecordingProcessingMock).toHaveBeenCalledWith('session-1', 'https://example.com/record.mp3');
  });
});
