import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsGetManyMock = vi.fn();
const scenarioRepoGetAllMock = vi.fn();
const scenarioRepoSaveAllMock = vi.fn();
const previewTelephonyCallMock = vi.fn();
const startTelephonyCallMock = vi.fn();

vi.mock('../../db/index.js', () => ({
  settingsRepo: {
    getMany: settingsGetManyMock,
  },
}));

vi.mock('./repository/scenario-repo.js', () => ({
  scenarioRepo: {
    getAll: scenarioRepoGetAllMock,
    saveAll: scenarioRepoSaveAllMock,
  },
}));

vi.mock('./service/call-launch-service.js', () => ({
  previewTelephonyCall: previewTelephonyCallMock,
  startTelephonyCall: startTelephonyCallMock,
}));

describe('telephony ai scenarios facade', () => {
  beforeEach(() => {
    settingsGetManyMock.mockReset();
    scenarioRepoGetAllMock.mockReset();
    scenarioRepoSaveAllMock.mockReset();
    previewTelephonyCallMock.mockReset();
    startTelephonyCallMock.mockReset();
    settingsGetManyMock.mockResolvedValue({});
  });

  it('exposes default scenarios with hybrid runtime', async () => {
    const { getDefaultTelephonyAiScenarios } = await import('./ai-scenarios.js');

    const scenarios = getDefaultTelephonyAiScenarios();

    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios[0]?.id).toBe('confirm-meeting');
    expect(scenarios[0]?.runtimeMode).toBe('hybrid');
    expect(scenarios[0]?.policy.fallbackMode).toBe('scripted');
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

  it('delegates scenario reads and writes to repository', async () => {
    const scenarios = [
      {
        id: 'confirm-meeting',
        name: 'Подтверждение встречи',
        enabled: true,
        callMode: 'ask_question',
        runtimeMode: 'hybrid',
        policyVersion: 1,
        policy: {
          allowedClaims: [],
          requiredSlots: [],
          exitConditions: [],
          handoffRules: [],
          maxSilenceMs: 6000,
          maxTurns: 6,
          fallbackMode: 'scripted',
        },
        goal: 'Подтвердить встречу',
        systemPrompt: '',
        openingLine: '',
        questionHint: '',
        successCriteria: '',
        resultPrompt: '',
        maxSpeechChars: 420,
        createdAt: '2026-03-09T00:00:00.000Z',
        updatedAt: '2026-03-09T00:00:00.000Z',
      },
    ] as const;

    scenarioRepoGetAllMock.mockResolvedValue(scenarios);
    scenarioRepoSaveAllMock.mockResolvedValue(scenarios);

    const { getTelephonyAiScenarios, saveTelephonyAiScenarios } = await import('./ai-scenarios.js');

    await expect(getTelephonyAiScenarios()).resolves.toEqual(scenarios);
    await expect(saveTelephonyAiScenarios([...scenarios])).resolves.toEqual(scenarios);
  });

  it('delegates preview and start to launch service', async () => {
    const previewResult = {
      scenario: { id: 'confirm-meeting' },
      plan: { summary: 'Подтвердить встречу' },
    };
    const startResult = {
      scenario: { id: 'confirm-meeting' },
      plan: { summary: 'Подтвердить встречу' },
      result: { id: 'call-1', mode: 'ask_question' },
    };

    previewTelephonyCallMock.mockResolvedValue(previewResult);
    startTelephonyCallMock.mockResolvedValue(startResult);

    const { previewTelephonyAiCall, startTelephonyAiCall } = await import('./ai-scenarios.js');

    await expect(previewTelephonyAiCall('confirm-meeting', 'task', '+375291234567')).resolves.toEqual(previewResult);
    await expect(
      startTelephonyAiCall({
        scenarioId: 'confirm-meeting',
        phone: '+375291234567',
        task: 'task',
        ownerTelegramId: '7867087040',
        initiatedBy: 'amina-admin',
      }),
    ).resolves.toEqual(startResult);
  });
});
