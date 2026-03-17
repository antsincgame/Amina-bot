import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDocumentMock = vi.fn();
const updateDocumentMock = vi.fn();

vi.mock('../config/index.js', () => ({
  config: {
    appwrite: {
      databaseId: 'test-db',
    },
  },
}));

vi.mock('../config/logger.js', () => ({
  dbLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db/appwrite.js', () => ({
  getAppwrite: () => ({
    getDocument: getDocumentMock,
    updateDocument: updateDocumentMock,
  }),
}));

describe('remindersRepo.markFailed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:05:00.000Z'));
    getDocumentMock.mockReset();
    updateDocumentMock.mockReset();
    updateDocumentMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reschedules failed reminders via scheduled_at backoff', async () => {
    getDocumentMock.mockResolvedValue({
      scheduled_at: '2026-03-17T09:00:00.000Z',
      updated_at: '2026-03-17T08:55:00.000Z',
      completed_at: null,
    });

    const { remindersRepo } = await import('./reminders-repo.js');
    await remindersRepo.markFailed('rem-1');

    expect(updateDocumentMock).toHaveBeenCalledWith(
      'test-db',
      'amina_reminders',
      'rem-1',
      expect.objectContaining({
        scheduled_at: '2026-03-17T10:20:00.000Z',
        completed_at: null,
        updated_at: '2026-03-17T10:05:00.000Z',
      }),
    );
  });

  it('marks reminder completed after max retry windows are exhausted', async () => {
    getDocumentMock.mockResolvedValue({
      scheduled_at: '2026-03-17T10:05:00.000Z',
      updated_at: '2026-03-16T10:05:00.000Z',
      completed_at: null,
    });

    const { remindersRepo } = await import('./reminders-repo.js');
    await remindersRepo.markFailed('rem-final');

    expect(updateDocumentMock).toHaveBeenCalledWith(
      'test-db',
      'amina_reminders',
      'rem-final',
      expect.objectContaining({
        is_completed: true,
        completed_at: '2026-03-17T10:05:00.000Z',
        updated_at: '2026-03-17T10:05:00.000Z',
      }),
    );
  });
});
