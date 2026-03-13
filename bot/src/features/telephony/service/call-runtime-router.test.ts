import { beforeEach, describe, expect, it, vi } from 'vitest';

const scriptedStartMock = vi.fn();
const realtimeStartMock = vi.fn();
const isRealtimeBridgeAvailableMock = vi.fn();

vi.mock('./scripted-runtime.js', () => ({
  scriptedRuntime: {
    start: scriptedStartMock,
  },
}));

vi.mock('./realtime-runtime.js', () => ({
  realtimeRuntime: {
    start: realtimeStartMock,
  },
  isRealtimeBridgeAvailable: isRealtimeBridgeAvailableMock,
}));

describe('call runtime router', () => {
  beforeEach(() => {
    scriptedStartMock.mockReset();
    realtimeStartMock.mockReset();
    isRealtimeBridgeAvailableMock.mockReset();
    scriptedStartMock.mockResolvedValue({
      provider: 'lirax',
      requestId: 'scripted-1',
      requestMode: 'ask_question',
      callId: null,
      metadata: {},
    });
    realtimeStartMock.mockResolvedValue({
      provider: 'media_bridge',
      requestId: 'rt-1',
      requestMode: 'realtime',
      callId: 'call-1',
      metadata: {},
    });
  });

  it('falls back to scripted for hybrid runtime when bridge is unavailable', async () => {
    isRealtimeBridgeAvailableMock.mockResolvedValue(false);
    const { startThroughRuntimeRouter } = await import('./call-runtime-router.js');

    const result = await startThroughRuntimeRouter({
      session: {
        id: 'session-1',
      } as never,
      scenario: {
        runtimeMode: 'hybrid',
        policy: { fallbackMode: 'scripted' },
      } as never,
      plan: { callMode: 'ask_question' } as never,
      phone: '+375291234567',
      task: 'task',
    });

    expect(scriptedStartMock).toHaveBeenCalledTimes(1);
    expect(realtimeStartMock).not.toHaveBeenCalled();
    expect(result.provider).toBe('lirax');
    expect(result.metadata.executedRuntime).toBe('scripted');
    expect(result.metadata.fallbackReason).toContain('unavailable');
  });

  it('uses realtime runtime when bridge is available', async () => {
    isRealtimeBridgeAvailableMock.mockResolvedValue(true);
    const { startThroughRuntimeRouter } = await import('./call-runtime-router.js');

    const result = await startThroughRuntimeRouter({
      session: {
        id: 'session-1',
      } as never,
      scenario: {
        runtimeMode: 'realtime',
        policy: { fallbackMode: 'scripted' },
      } as never,
      plan: { callMode: 'ask_question' } as never,
      phone: '+375291234567',
      task: 'task',
    });

    expect(realtimeStartMock).toHaveBeenCalledTimes(1);
    expect(scriptedStartMock).not.toHaveBeenCalled();
    expect(result.provider).toBe('media_bridge');
    expect(result.metadata.executedRuntime).toBe('realtime');
  });

  it('throws when realtime is required and fallback is disabled', async () => {
    isRealtimeBridgeAvailableMock.mockResolvedValue(false);
    const { startThroughRuntimeRouter } = await import('./call-runtime-router.js');

    await expect(
      startThroughRuntimeRouter({
        session: {
          id: 'session-1',
        } as never,
        scenario: {
          runtimeMode: 'realtime',
          policy: { fallbackMode: 'fail' },
        } as never,
        plan: { callMode: 'ask_question' } as never,
        phone: '+375291234567',
        task: 'task',
      }),
    ).rejects.toThrow('Realtime runtime requested');
  });
});
