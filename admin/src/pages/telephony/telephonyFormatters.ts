import type {
  TelephonyAiCallSession,
  TelephonyAiScenario,
  TelephonyRuntimeMode,
} from '../../../../shared/types/telephony.js';

export function createScenarioDraft(): TelephonyAiScenario {
  const now = new Date().toISOString();

  return {
    id: `custom-${Date.now()}`,
    name: 'Новый AI-сценарий',
    enabled: true,
    callMode: 'ask_question',
    runtimeMode: 'scripted',
    policyVersion: 1,
    policy: {
      allowedClaims: [],
      requiredSlots: [],
      exitConditions: [
        'Получен явный ответ собеседника',
        'Собеседник завершает разговор',
      ],
      handoffRules: [
        'Если собеседник просит живого человека, переведи звонок в fallback режим и пометь handoff.',
      ],
      maxSilenceMs: 6000,
      maxTurns: 6,
      fallbackMode: 'scripted',
    },
    goal: '',
    systemPrompt: '',
    openingLine: 'Здравствуйте. Вас беспокоит Амина, жена Дмитрия Орлова — звоню по его поручению.',
    questionHint: '',
    successCriteria: '',
    resultPrompt: '',
    maxSpeechChars: 420,
    createdAt: now,
    updatedAt: now,
  };
}

export function formatScenarioMode(mode: TelephonyAiScenario['callMode']): string {
  return mode === 'speech' ? 'Только речь' : 'Вопрос с ожиданием ответа';
}

export function formatRuntimeMode(mode: TelephonyAiScenario['runtimeMode']): string {
  switch (mode) {
    case 'hybrid':
      return 'Hybrid';
    case 'realtime':
      return 'Realtime';
    default:
      return 'Scripted';
  }
}

export function formatRuntimeOverride(mode: TelephonyRuntimeMode | ''): string {
  return mode ? formatRuntimeMode(mode) : 'По сценарию';
}

export function formatSessionStatus(status: TelephonyAiCallSession['status']): string {
  switch (status) {
    case 'initiated':
      return 'Инициирован';
    case 'queued':
      return 'В очереди bridge';
    case 'dialing':
      return 'Набор номера';
    case 'live':
      return 'Живой диалог';
    case 'linked':
      return 'Связан с callid';
    case 'recorded':
      return 'Запись получена';
    case 'completed':
      return 'Звонок завершён';
    case 'processed':
      return 'Обработан';
    case 'fallback':
      return 'Ушёл в fallback';
    case 'cancelled':
      return 'Отменён';
    case 'failed':
      return 'Ошибка';
    default:
      return status;
  }
}

export function formatSessionStatusClass(status: TelephonyAiCallSession['status']): string {
  switch (status) {
    case 'live':
      return 'text-sky-300 border-sky-500/20 bg-sky-500/10';
    case 'completed':
    case 'processed':
      return 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10';
    case 'fallback':
      return 'text-violet-300 border-violet-500/20 bg-violet-500/10';
    case 'cancelled':
    case 'failed':
      return 'text-red-400 border-red-500/20 bg-red-500/10';
    default:
      return 'text-amber-300 border-amber-500/20 bg-amber-500/10';
  }
}

export function formatBridgeReachability(value: boolean | null): string {
  if (value === true) {
    return 'Bridge отвечает';
  }

  if (value === false) {
    return 'Bridge недоступен';
  }

  return 'Проверка недоступна';
}

export function formatSourceLabel(value: string): string {
  switch (value) {
    case 'db':
      return 'db';
    case 'env':
      return 'env';
    case 'default':
      return 'default';
    case 'derived':
      return 'derived';
    default:
      return value || 'unknown';
  }
}

export function formatEventType(value: string): string {
  switch (value) {
    case 'bridge_session_started':
      return 'Bridge session started';
    case 'call_dialing':
      return 'Dialing';
    case 'call_connected':
      return 'Connected';
    case 'partial_transcript_updated':
      return 'Partial transcript';
    case 'transcript_finalized':
      return 'Transcript finalized';
    case 'agent_turn_started':
      return 'Agent turn started';
    case 'agent_turn_completed':
      return 'Agent turn completed';
    case 'fallback_triggered':
      return 'Fallback triggered';
    case 'recording_archived':
      return 'Recording archived';
    case 'call_completed':
      return 'Call completed';
    case 'call_failed':
      return 'Call failed';
    default:
      return value;
  }
}
