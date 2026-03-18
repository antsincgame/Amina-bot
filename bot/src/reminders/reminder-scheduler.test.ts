import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDueMock = vi.fn();
const markCompletedMock = vi.fn();
const markFailedMock = vi.fn();
const getReminderDeliveryMapMock = vi.fn();
const markReminderSentMock = vi.fn();
const clearReminderSentMock = vi.fn();

vi.mock('./reminders-repo.js', () => ({
  remindersRepo: {
    getDue: getDueMock,
    markCompleted: markCompletedMock,
    markFailed: markFailedMock,
  },
}));

vi.mock('./reminder-delivery-registry.js', () => ({
  getReminderDeliveryMap: getReminderDeliveryMapMock,
  markReminderSent: markReminderSentMock,
  clearReminderSent: clearReminderSentMock,
}));

vi.mock('../config/logger.js', () => ({
  appLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('reminder scheduler delivery integrity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T12:00:00.000Z'));
    getDueMock.mockReset();
    markCompletedMock.mockReset();
    markFailedMock.mockReset();
    getReminderDeliveryMapMock.mockReset();
    markReminderSentMock.mockReset();
    clearReminderSentMock.mockReset();
    getReminderDeliveryMapMock.mockResolvedValue(new Map());
    markCompletedMock.mockResolvedValue(undefined);
    markFailedMock.mockResolvedValue(undefined);
    markReminderSentMock.mockResolvedValue(undefined);
    clearReminderSentMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { stopReminderScheduler } = await import('./reminder-scheduler.js');
    stopReminderScheduler();
    vi.useRealTimers();
  });

  it('records sent marker before DB confirmation and clears it on success', async () => {
    getDueMock.mockResolvedValue([
      {
        id: 'rem-1',
        user_id: 'user-1',
        chat_id: 42,
        task: 'Проверить релиз',
      },
    ]);

    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const { startReminderScheduler } = await import('./reminder-scheduler.js');

    startReminderScheduler({ api: { sendMessage: sendMessageMock } } as never);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sendMessageMock).toHaveBeenCalledWith(42, expect.stringContaining('Проверить релиз'));
    expect(markReminderSentMock).toHaveBeenCalledWith('rem-1', '2026-03-17T12:00:30.000Z');
    expect(markCompletedMock).toHaveBeenCalledWith('rem-1');
    expect(clearReminderSentMock).toHaveBeenCalledWith('rem-1');
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it('does not re-send reminders already marked as sent in registry', async () => {
    getDueMock.mockResolvedValue([
      {
        id: 'rem-2',
        user_id: 'user-2',
        chat_id: 77,
        task: 'Не дублировать',
      },
    ]);
    getReminderDeliveryMapMock.mockResolvedValue(new Map([
      ['rem-2', { reminderId: 'rem-2', sentAt: '2026-03-17T11:58:00.000Z' }],
    ]));

    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const { startReminderScheduler } = await import('./reminder-scheduler.js');

    startReminderScheduler({ api: { sendMessage: sendMessageMock } } as never);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(markCompletedMock).toHaveBeenCalledWith('rem-2');
    expect(clearReminderSentMock).toHaveBeenCalledWith('rem-2');
    expect(markReminderSentMock).not.toHaveBeenCalled();
    expect(markFailedMock).not.toHaveBeenCalled();
  });
});
