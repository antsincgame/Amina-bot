import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bell,
  BellOff,
  CheckCircle,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  Plus,
  Save,
  Shield,
  Sparkles,
  Trash2,
  User,
  UserMinus,
  UserPlus,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { fetchBotApi, settingsApi } from '../api/supabase';
import type {
  TelephonyCallArtifact,
  TelephonyCallEvent,
  TelephonyCallOutcome,
  TelephonyCallTurn,
  TelephonyAiCallPlan,
  TelephonyAiCallSession,
  TelephonyAiScenario,
  TelephonyRuntimeMode,
} from '../../../shared/types/telephony.js';

interface LiraXStatus {
  configured: boolean;
  url: string;
  defaultExt: string;
  webhookUrl: string;
  hasWebhookToken: boolean;
}

interface RealtimeBridgeStatus {
  enabled: boolean;
  configured: boolean;
  url: string;
  healthUrl: string;
  reachable: boolean | null;
  archiveRecordings: boolean;
  storePartialTranscript: boolean;
  latencyBudgetMs: number;
  recordingRetentionDays: number;
  voiceProvider: string;
  voiceModel: string;
  speechModel: string;
}

interface TelephonyUser {
  telegram_id: string;
  name: string;
  added_at: string;
}

interface TelephonyAiPreviewResponse {
  scenario: TelephonyAiScenario;
  plan: TelephonyAiCallPlan;
}

interface TelephonyAiStartResponse extends TelephonyAiPreviewResponse {
  result: {
    id: string;
    mode: string;
  };
}

interface TelephonySessionDetails {
  session: TelephonyAiCallSession;
  events: TelephonyCallEvent[];
  turns: TelephonyCallTurn[];
  artifacts: TelephonyCallArtifact[];
  outcome: TelephonyCallOutcome | null;
}

function createScenarioDraft(): TelephonyAiScenario {
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
    openingLine: 'Здравствуйте. Вас беспокоит AI-ассистент Амина.',
    questionHint: '',
    successCriteria: '',
    resultPrompt: '',
    maxSpeechChars: 420,
    createdAt: now,
    updatedAt: now,
  };
}

function formatScenarioMode(mode: TelephonyAiScenario['callMode']): string {
  return mode === 'speech' ? 'Только речь' : 'Вопрос с ожиданием ответа';
}

function formatRuntimeMode(mode: TelephonyAiScenario['runtimeMode']): string {
  switch (mode) {
    case 'shadow':
      return 'Shadow';
    case 'hybrid':
      return 'Hybrid';
    case 'realtime':
      return 'Realtime';
    default:
      return 'Scripted';
  }
}

function formatRuntimeOverride(mode: TelephonyRuntimeMode | ''): string {
  return mode ? formatRuntimeMode(mode) : 'По сценарию';
}

function formatSessionStatus(status: TelephonyAiCallSession['status']): string {
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

function formatSessionStatusClass(status: TelephonyAiCallSession['status']): string {
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

function formatBridgeReachability(value: boolean | null): string {
  if (value === true) {
    return 'Bridge отвечает';
  }

  if (value === false) {
    return 'Bridge недоступен';
  }

  return 'Проверка недоступна';
}

function formatEventType(value: string): string {
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

async function readJson<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => ({ error: 'Unknown error' }));
  if (!response.ok) {
    throw new Error((json as { error?: string }).error || 'Request failed');
  }

  return json as T;
}

async function fetchLiraXStatus(): Promise<LiraXStatus> {
  const response = await fetchBotApi('/api/lirax/status');
  const json = await readJson<{ data: LiraXStatus }>(response);
  return json.data;
}

async function fetchScenarios(): Promise<TelephonyAiScenario[]> {
  const response = await fetchBotApi('/api/lirax/scenarios');
  const json = await readJson<{ data: TelephonyAiScenario[] }>(response);
  return json.data ?? [];
}

async function saveScenarios(scenarios: TelephonyAiScenario[]): Promise<TelephonyAiScenario[]> {
  const response = await fetchBotApi('/api/lirax/scenarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenarios),
  });
  const json = await readJson<{ data: TelephonyAiScenario[] }>(response);
  return json.data ?? [];
}

async function fetchTelephonyUsers(): Promise<TelephonyUser[]> {
  const response = await fetchBotApi('/api/lirax/users');
  const json = await readJson<{ data: TelephonyUser[] }>(response);
  return json.data ?? [];
}

async function addTelephonyUserApi(telegramId: string, name: string): Promise<TelephonyUser[]> {
  const response = await fetchBotApi('/api/lirax/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_id: telegramId, name }),
  });
  const json = await readJson<{ data: TelephonyUser[] }>(response);
  return json.data ?? [];
}

async function removeTelephonyUserApi(telegramId: string): Promise<TelephonyUser[]> {
  const response = await fetchBotApi(`/api/lirax/users/${telegramId}`, {
    method: 'DELETE',
  });
  const json = await readJson<{ data: TelephonyUser[] }>(response);
  return json.data ?? [];
}

async function previewAiCall(
  scenarioId: string,
  phone: string,
  task: string,
): Promise<TelephonyAiPreviewResponse> {
  const response = await fetchBotApi('/api/lirax/ai-calls/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId, phone, task }),
  });
  const json = await readJson<{ data: TelephonyAiPreviewResponse }>(response);
  return json.data;
}

async function startAiCall(
  scenarioId: string,
  phone: string,
  task: string,
  plan?: TelephonyAiCallPlan,
  runtimeOverride?: TelephonyRuntimeMode | '',
): Promise<TelephonyAiStartResponse> {
  const response = await fetchBotApi('/api/lirax/ai-calls/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenarioId,
      phone,
      task,
      plan,
      runtimeOverride: runtimeOverride || undefined,
    }),
  });
  const json = await readJson<{ data: TelephonyAiStartResponse }>(response);
  return json.data;
}

async function fetchAiSessions(): Promise<TelephonyAiCallSession[]> {
  const response = await fetchBotApi('/api/lirax/ai-calls/sessions');
  const json = await readJson<{ data: TelephonyAiCallSession[] }>(response);
  return json.data ?? [];
}

async function fetchRealtimeStatus(): Promise<RealtimeBridgeStatus> {
  const response = await fetchBotApi('/api/telephony/realtime/status');
  const json = await readJson<{ data: RealtimeBridgeStatus }>(response);
  return json.data;
}

async function fetchSessionDetails(sessionId: string): Promise<TelephonySessionDetails> {
  const response = await fetchBotApi(`/api/lirax/ai-calls/sessions/${sessionId}`);
  const json = await readJson<{ data: TelephonySessionDetails }>(response);
  return json.data;
}

const TelephonyPage = () => {
  const queryClient = useQueryClient();

  const [adminChatId, setAdminChatId] = useState('');
  const [ownerChatId, setOwnerChatId] = useState('');
  const [webhookToken, setWebhookToken] = useState('');
  const [defaultExt, setDefaultExt] = useState('201');
  const [operatorPhone, setOperatorPhone] = useState('');
  const [notifyCalls, setNotifyCalls] = useState(true);
  const [notifyRecords, setNotifyRecords] = useState(true);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const [mediaBridgeUrl, setMediaBridgeUrl] = useState('');
  const [mediaBridgeToken, setMediaBridgeToken] = useState('');
  const [archiveRecordings, setArchiveRecordings] = useState(true);
  const [storePartialTranscript, setStorePartialTranscript] = useState(true);
  const [latencyBudgetMs, setLatencyBudgetMs] = useState('1800');
  const [recordingRetentionDays, setRecordingRetentionDays] = useState('30');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [reloadWarning, setReloadWarning] = useState(false);

  const [newUserId, setNewUserId] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [scenarios, setScenarios] = useState<TelephonyAiScenario[]>([]);
  const [studioScenarioId, setStudioScenarioId] = useState('');
  const [studioPhone, setStudioPhone] = useState('');
  const [studioTask, setStudioTask] = useState('');
  const [studioRuntimeOverride, setStudioRuntimeOverride] = useState<TelephonyRuntimeMode | ''>('');
  const [previewData, setPreviewData] = useState<TelephonyAiPreviewResponse | null>(null);
  const [startSuccess, setStartSuccess] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['lirax-status'],
    queryFn: fetchLiraXStatus,
    refetchInterval: 30_000,
  });

  const { data: realtimeStatus, isLoading: realtimeStatusLoading } = useQuery({
    queryKey: ['telephony-realtime-status'],
    queryFn: fetchRealtimeStatus,
    refetchInterval: 30_000,
  });

  const { data: allSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.getAll(),
  });

  const { data: telephonyUsers = [], isLoading: usersLoading } = useQuery({
    queryKey: ['lirax-users'],
    queryFn: fetchTelephonyUsers,
  });

  const { data: scenariosData = [], isLoading: scenariosLoading } = useQuery({
    queryKey: ['lirax-scenarios'],
    queryFn: fetchScenarios,
  });

  const { data: aiSessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['lirax-ai-sessions'],
    queryFn: fetchAiSessions,
    refetchInterval: 20_000,
  });

  const { data: selectedSessionDetails, isLoading: sessionDetailsLoading } = useQuery({
    queryKey: ['lirax-ai-session-detail', selectedSessionId],
    queryFn: () => fetchSessionDetails(selectedSessionId!),
    enabled: Boolean(selectedSessionId),
    refetchInterval: selectedSessionId ? 15_000 : false,
  });

  useEffect(() => {
    if (!allSettings) {
      return;
    }

    const map = new Map(allSettings.map((item) => [item.key, item.value]));
    setAdminChatId(map.get('lirax_admin_chat_id') || '');
    setOwnerChatId(map.get('lirax_owner_chat_id') || '');
    setWebhookToken(map.get('lirax_webhook_token') || '');
    setDefaultExt(map.get('lirax_default_ext') || '201');
    setOperatorPhone(map.get('lirax_operator_phone') || '');
    setNotifyCalls(map.get('lirax_notify_calls') !== 'false');
    setNotifyRecords(map.get('lirax_notify_records') !== 'false');
    setRealtimeEnabled(map.get('telephony_realtime_enabled') === 'true');
    setMediaBridgeUrl(map.get('telephony_media_bridge_url') || '');
    setMediaBridgeToken(map.get('telephony_media_bridge_token') || '');
    setArchiveRecordings(map.get('telephony_recordings_archive_enabled') !== 'false');
    setStorePartialTranscript(map.get('telephony_partial_transcript_enabled') !== 'false');
    setLatencyBudgetMs(map.get('telephony_latency_budget_ms') || '1800');
    setRecordingRetentionDays(map.get('telephony_recording_retention_days') || '30');
  }, [allSettings]);

  useEffect(() => {
    if (scenariosData.length === 0) {
      return;
    }

    setScenarios(scenariosData);
  }, [scenariosData]);

  useEffect(() => {
    if (!studioScenarioId && scenarios.length > 0) {
      setStudioScenarioId(scenarios[0]!.id);
    }
  }, [studioScenarioId, scenarios]);

  useEffect(() => {
    setPreviewData(null);
    setStartSuccess(null);
  }, [studioScenarioId, studioPhone, studioTask, studioRuntimeOverride]);

  const enabledScenarios = useMemo(
    () => scenarios.filter((scenario) => scenario.enabled),
    [scenarios],
  );

  const { mutate: saveSettings, isPending: savingSettings } = useMutation({
    mutationFn: async () => {
      await settingsApi.updateMany({
        lirax_admin_chat_id: adminChatId,
        lirax_owner_chat_id: ownerChatId,
        lirax_webhook_token: webhookToken,
        lirax_default_ext: defaultExt,
        lirax_operator_phone: operatorPhone,
        lirax_notify_calls: notifyCalls ? 'true' : 'false',
        lirax_notify_records: notifyRecords ? 'true' : 'false',
        telephony_realtime_enabled: realtimeEnabled ? 'true' : 'false',
        telephony_media_bridge_url: mediaBridgeUrl,
        telephony_media_bridge_token: mediaBridgeToken,
        telephony_recordings_archive_enabled: archiveRecordings ? 'true' : 'false',
        telephony_partial_transcript_enabled: storePartialTranscript ? 'true' : 'false',
        telephony_latency_budget_ms: latencyBudgetMs,
        telephony_recording_retention_days: recordingRetentionDays,
      });

      const reloadResponse = await fetchBotApi('/api/lirax/reload-config', { method: 'POST' }).catch(() => null);
      if (!reloadResponse || !reloadResponse.ok) {
        setReloadWarning(true);
        setTimeout(() => setReloadWarning(false), 5000);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['lirax-status'] });
      queryClient.invalidateQueries({ queryKey: ['telephony-realtime-status'] });
      setSettingsSaved(true);
      setMutationError(null);
      setTimeout(() => setSettingsSaved(false), 3000);
    },
    onError: (error) => {
      setMutationError(`Ошибка сохранения: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const { mutate: addUser, isPending: addingUser } = useMutation({
    mutationFn: () => addTelephonyUserApi(newUserId.trim(), newUserName.trim() || newUserId.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lirax-users'] });
      setNewUserId('');
      setNewUserName('');
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(`Ошибка добавления пользователя: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const { mutate: removeUser } = useMutation({
    mutationFn: (telegramId: string) => removeTelephonyUserApi(telegramId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lirax-users'] });
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(`Ошибка удаления пользователя: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const { mutate: persistScenarios, isPending: savingScenarios } = useMutation({
    mutationFn: () => saveScenarios(scenarios),
    onSuccess: (saved) => {
      setScenarios(saved);
      queryClient.invalidateQueries({ queryKey: ['lirax-scenarios'] });
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(`Ошибка сохранения сценариев: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const { mutate: previewCall, isPending: previewingCall } = useMutation({
    mutationFn: () => previewAiCall(studioScenarioId, studioPhone, studioTask),
    onSuccess: (data) => {
      setPreviewData(data);
      setStartSuccess(null);
      setMutationError(null);
    },
    onError: (error) => {
      setPreviewData(null);
      setMutationError(`Ошибка preview: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const { mutate: executeCall, isPending: startingCall } = useMutation({
    mutationFn: async () => {
      const preview = previewData ?? await previewAiCall(studioScenarioId, studioPhone, studioTask);
      return startAiCall(studioScenarioId, studioPhone, studioTask, preview.plan, studioRuntimeOverride);
    },
    onSuccess: (data) => {
      setPreviewData(data);
      setStartSuccess(`Звонок инициирован. ID: ${data.result.id || 'pending'}`);
      queryClient.invalidateQueries({ queryKey: ['lirax-ai-sessions'] });
      setMutationError(null);
    },
    onError: (error) => {
      setStartSuccess(null);
      setMutationError(`Ошибка запуска AI-звонка: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const updateScenario = (id: string, field: keyof TelephonyAiScenario, value: string | boolean | number) => {
    setScenarios((prev) =>
      prev.map((scenario) =>
        scenario.id === id ? { ...scenario, [field]: value, updatedAt: new Date().toISOString() } : scenario,
      ),
    );
  };

  const updateScenarioPolicy = (
    id: string,
    field: keyof TelephonyAiScenario['policy'],
    value: string | number,
  ) => {
    setScenarios((prev) =>
      prev.map((scenario) =>
        scenario.id === id
          ? {
              ...scenario,
              policy: {
                ...scenario.policy,
                [field]: value,
              },
              updatedAt: new Date().toISOString(),
            }
          : scenario,
      ),
    );
  };

  const addScenario = () => {
    const scenario = createScenarioDraft();
    setScenarios((prev) => [...prev, scenario]);
    setStudioScenarioId(scenario.id);
  };

  const removeScenario = (id: string) => {
    setScenarios((prev) => prev.filter((scenario) => scenario.id !== id));
    if (studioScenarioId === id) {
      const nextScenario = scenarios.find((scenario) => scenario.id !== id);
      setStudioScenarioId(nextScenario?.id || '');
    }
  };

  const canRunStudio = Boolean(studioScenarioId.trim() && studioPhone.trim() && studioTask.trim());

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex items-center gap-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(16, 185, 129, 0.1))',
            border: '1px solid rgba(34, 197, 94, 0.3)',
          }}
        >
          <Phone className="w-7 h-7 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold text-gradient-gold" style={{ fontFamily: 'var(--font-display)' }}>
            Телефония
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            LiraX, owner-only AI-звонки, сценарии, расшифровка записей и отчёт владельцу.
          </p>
        </div>
      </div>

      {mutationError && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
          <span className="text-sm text-red-300">{mutationError}</span>
          <button className="ml-auto text-xs text-red-400 hover:text-red-300" onClick={() => setMutationError(null)}>
            Закрыть
          </button>
        </div>
      )}

      {reloadWarning && (
        <div className="p-4 rounded-xl bg-yellow-500/10 border border-yellow-500/30 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-400 shrink-0" />
          <span className="text-sm text-yellow-300">
            Настройки сохранены, но LiraX-конфиг не перечитался. Перезапусти backend вручную.
          </span>
        </div>
      )}

      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          {status?.configured ? (
            <Wifi className="w-5 h-5 text-emerald-400" />
          ) : (
            <WifiOff className="w-5 h-5 text-red-400" />
          )}
          <h2 className="text-lg font-semibold text-white">Статус подключения</h2>
          {statusLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
        </div>

        {status ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <StatusRow label="Подключение" value={status.configured ? 'Настроено' : 'Не настроено'} ok={status.configured} />
            <StatusRow label="URL АТС" value={status.url} ok={!!status.url} mono />
            <StatusRow label="Внутренний номер" value={status.defaultExt} ok={!!status.defaultExt} />
            <StatusRow label="Webhook URL" value={status.webhookUrl} ok={!!status.webhookUrl} mono />
            <StatusRow label="Webhook токен" value={status.hasWebhookToken ? 'Установлен' : 'Не установлен'} ok={status.hasWebhookToken} />
          </div>
        ) : (
          !statusLoading && <p className="text-sm text-gray-500">Не удалось загрузить статус LiraX</p>
        )}
      </div>

      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          {realtimeStatus?.enabled ? (
            <Mic className="w-5 h-5 text-sky-400" />
          ) : (
            <MicOff className="w-5 h-5 text-gray-500" />
          )}
          <h2 className="text-lg font-semibold text-white">Realtime voice bridge</h2>
          {realtimeStatusLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
        </div>

        {realtimeStatus ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <StatusRow label="Режим realtime" value={realtimeStatus.enabled ? 'Включён' : 'Выключен'} ok={realtimeStatus.enabled} />
            <StatusRow label="Bridge URL" value={realtimeStatus.url || 'Не задан'} ok={realtimeStatus.configured} mono />
            <StatusRow label="Bridge health" value={formatBridgeReachability(realtimeStatus.reachable)} ok={realtimeStatus.reachable !== false} />
            <StatusRow label="Голос" value={`${realtimeStatus.voiceProvider} / ${realtimeStatus.voiceModel}`} ok={!!realtimeStatus.voiceProvider} mono />
            <StatusRow label="STT" value={realtimeStatus.speechModel} ok={!!realtimeStatus.speechModel} mono />
            <StatusRow label="Latency budget" value={`${realtimeStatus.latencyBudgetMs} ms`} ok={realtimeStatus.latencyBudgetMs > 0} />
          </div>
        ) : (
          !realtimeStatusLoading && <p className="text-sm text-gray-500">Не удалось загрузить статус realtime bridge</p>
        )}
      </div>

      <div className="card p-6">
        <div className="flex items-center gap-3 mb-6">
          <User className="w-5 h-5 text-amber-400" />
          <h2 className="text-lg font-semibold text-white">Настройки управления</h2>
        </div>

        <div className="space-y-5">
          <Field label="Telegram ID администратора звонков" hint="Получает сервисные уведомления и доступ к /call.">
            <input className="input w-full" value={adminChatId} onChange={(e) => setAdminChatId(e.target.value)} placeholder="7867087040" />
          </Field>

          <Field
            label="Telegram ID владельца AI-звонков"
            hint="Только этот Telegram ID сможет запускать /callai. Если пусто, backend использует lirax_admin_chat_id."
          >
            <input className="input w-full" value={ownerChatId} onChange={(e) => setOwnerChatId(e.target.value)} placeholder="7867087040" />
          </Field>

          <Field label="Webhook токен (from_LiraX_token)" hint="Токен верификации вебхуков LiraX.">
            <input
              className="input w-full font-mono text-sm"
              value={webhookToken}
              onChange={(e) => setWebhookToken(e.target.value)}
              placeholder="Токен из LiraX → Интеграция General"
            />
          </Field>

          <Field label="Телефон оператора" hint="Нужен для обычных /call и connectCall. Для AI-сценариев с AskQuestion основной упор идёт на автозвонок.">
            <input className="input w-full" value={operatorPhone} onChange={(e) => setOperatorPhone(e.target.value)} placeholder="+375291234567" />
          </Field>

          <Field label="Внутренний номер (ext)" hint="Используется как from/ext для LiraX-команд.">
            <input className="input w-48" value={defaultExt} onChange={(e) => setDefaultExt(e.target.value)} placeholder="201" />
          </Field>

          <div className="flex flex-col sm:flex-row gap-4">
            <ToggleButton
              active={notifyCalls}
              iconOn={<Bell className="w-4 h-4" />}
              iconOff={<BellOff className="w-4 h-4" />}
              label="Уведомления о звонках"
              onClick={() => setNotifyCalls((value) => !value)}
            />
            <ToggleButton
              active={notifyRecords}
              iconOn={<Mic className="w-4 h-4" />}
              iconOff={<MicOff className="w-4 h-4" />}
              label="Уведомления о записях"
              onClick={() => setNotifyRecords((value) => !value)}
            />
          </div>

          <div className="pt-2 border-t border-white/5">
            <p className="text-sm font-medium text-white mb-3">Realtime AI voice</p>
            <div className="space-y-5">
              <Field label="Media bridge URL" hint="Bridge принимает start payload и шлёт callbacks обратно в backend.">
                <input
                  className="input w-full font-mono text-sm"
                  value={mediaBridgeUrl}
                  onChange={(e) => setMediaBridgeUrl(e.target.value)}
                  placeholder="https://bridge.example.com/v1/calls/start"
                />
              </Field>

              <Field label="Bridge bearer token" hint="Используется и для outbound start, и для входящих callbackов bridge.">
                <input
                  className="input w-full font-mono text-sm"
                  value={mediaBridgeToken}
                  onChange={(e) => setMediaBridgeToken(e.target.value)}
                  placeholder="bridge-secret-token"
                />
              </Field>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Latency budget (ms)" hint="Если realtime pipeline выходит за бюджет, bridge должен инициировать fallback.">
                  <input
                    type="number"
                    className="input w-full"
                    value={latencyBudgetMs}
                    onChange={(e) => setLatencyBudgetMs(e.target.value)}
                    placeholder="1800"
                  />
                </Field>
                <Field label="Retention (days)" hint="Сколько дней хранить raw recording в Supabase Storage.">
                  <input
                    type="number"
                    className="input w-full"
                    value={recordingRetentionDays}
                    onChange={(e) => setRecordingRetentionDays(e.target.value)}
                    placeholder="30"
                  />
                </Field>
              </div>

              <div className="flex flex-col sm:flex-row gap-4">
                <ToggleButton
                  active={realtimeEnabled}
                  iconOn={<Mic className="w-4 h-4" />}
                  iconOff={<MicOff className="w-4 h-4" />}
                  label="Realtime runtime включён"
                  onClick={() => setRealtimeEnabled((value) => !value)}
                />
                <ToggleButton
                  active={archiveRecordings}
                  iconOn={<Mic className="w-4 h-4" />}
                  iconOff={<MicOff className="w-4 h-4" />}
                  label="Архивировать raw recording"
                  onClick={() => setArchiveRecordings((value) => !value)}
                />
                <ToggleButton
                  active={storePartialTranscript}
                  iconOn={<Sparkles className="w-4 h-4" />}
                  iconOff={<Sparkles className="w-4 h-4" />}
                  label="Хранить partial transcript"
                  onClick={() => setStorePartialTranscript((value) => !value)}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button className="btn-gold flex items-center gap-2" disabled={savingSettings} onClick={() => saveSettings()}>
              {savingSettings ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : settingsSaved ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {settingsSaved ? 'Сохранено!' : 'Сохранить настройки'}
            </button>
          </div>
        </div>
      </div>

      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          <Shield className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">Авторизованные пользователи телефонии</h2>
          {usersLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
        </div>

        <p className="text-xs text-gray-500 mb-4">
          Эти пользователи могут пользоваться обычными командами <code>/call</code> и <code>/calls</code>. AI-команда <code>/callai</code> дополнительно ограничена владельцем.
        </p>

        <div className="space-y-2 mb-4">
          {telephonyUsers.length === 0 && !usersLoading && (
            <p className="text-sm text-gray-500 italic py-2">Нет авторизованных пользователей.</p>
          )}
          {telephonyUsers.map((user) => (
            <div key={user.telegram_id} className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/5">
              <div className="flex items-center gap-3">
                <User className="w-4 h-4 text-gray-500" />
                <div>
                  <span className="text-sm font-medium text-white">{user.name}</span>
                  <span className="text-xs text-gray-500 ml-2">ID: {user.telegram_id}</span>
                </div>
              </div>
              <button
                className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                onClick={() => removeUser(user.telegram_id)}
                title="Удалить"
              >
                <UserMinus className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-2 items-end">
          <Field label="Telegram ID" className="flex-1">
            <input className="input w-full" value={newUserId} onChange={(e) => setNewUserId(e.target.value)} placeholder="7867087040" />
          </Field>
          <Field label="Имя" className="flex-1">
            <input className="input w-full" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} placeholder="Дмитрий" />
          </Field>
          <button className="btn-gold flex items-center gap-1.5 whitespace-nowrap" disabled={addingUser || !newUserId.trim()} onClick={() => addUser()}>
            {addingUser ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            Добавить
          </button>
        </div>
      </div>

      <div className="card p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-violet-400" />
            <h2 className="text-lg font-semibold text-white">AI-сценарии звонков</h2>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost flex items-center gap-1.5 text-sm" onClick={addScenario}>
              <Plus className="w-4 h-4" />
              Добавить
            </button>
            <button className="btn-gold flex items-center gap-1.5 text-sm" disabled={savingScenarios} onClick={() => persistScenarios()}>
              {savingScenarios ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Сохранить сценарии
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          Сценарий хранит бизнес-цель, тональность, стартовую реплику и правила summary после звонка. Генерация речи идёт через LM Studio, а если он недоступен — через OpenRouter fallback.
        </p>

        {scenariosLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
          </div>
        ) : (
          <div className="space-y-4">
            {scenarios.map((scenario) => (
              <ScenarioEditor
                key={scenario.id}
                scenario={scenario}
                onUpdate={updateScenario}
                onPolicyUpdate={updateScenarioPolicy}
                onRemove={removeScenario}
              />
            ))}
          </div>
        )}
      </div>

      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          <PhoneCall className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg font-semibold text-white">AI Call Studio</h2>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          Preview показывает, что именно скажет AI по сценарию. Запуск создаёт реальный звонок и потом присылает владельцу summary по записи.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <Field label="Сценарий">
            <select className="input w-full" value={studioScenarioId} onChange={(e) => setStudioScenarioId(e.target.value)}>
              {enabledScenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name} ({formatScenarioMode(scenario.callMode)} / {formatRuntimeMode(scenario.runtimeMode)})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Телефон">
            <input
              className="input w-full"
              value={studioPhone}
              onChange={(e) => setStudioPhone(e.target.value)}
              placeholder="+375291234567"
            />
          </Field>

          <Field label="Владелец">
            <div className="input w-full flex items-center text-sm text-gray-300">
              {ownerChatId || adminChatId || 'Не задан в настройках'}
            </div>
          </Field>

          <Field label="Runtime override">
            <select className="input w-full" value={studioRuntimeOverride} onChange={(e) => setStudioRuntimeOverride(e.target.value as TelephonyRuntimeMode | '')}>
              <option value="">По сценарию</option>
              <option value="scripted">Scripted</option>
              <option value="hybrid">Hybrid</option>
              <option value="realtime">Realtime</option>
            </select>
          </Field>
        </div>

        <Field label="Задача для AI" hint="Например: подтвердить встречу на завтра 14:00, если неудобно — попросить сообщить новое время.">
          <textarea
            className="input w-full min-h-[110px] text-sm resize-y"
            value={studioTask}
            onChange={(e) => setStudioTask(e.target.value)}
            placeholder="Опиши, что именно должен сделать AI в звонке..."
          />
        </Field>

        <div className="flex flex-wrap gap-3 mt-4">
          <button className="btn-ghost flex items-center gap-2" disabled={!canRunStudio || previewingCall} onClick={() => previewCall()}>
            {previewingCall ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Preview
          </button>
          <button className="btn-gold flex items-center gap-2" disabled={!canRunStudio || startingCall} onClick={() => executeCall()}>
            {startingCall ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneCall className="w-4 h-4" />}
            Запустить AI-звонок
          </button>
        </div>

        {startSuccess && (
          <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            {startSuccess}
          </div>
        )}

        {previewData && (
          <div className="mt-5 rounded-2xl border border-white/5 bg-black/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-white">{previewData.scenario.name}</p>
                <p className="text-xs text-gray-500">
                  {formatScenarioMode(previewData.plan.callMode)} / {formatRuntimeMode(previewData.scenario.runtimeMode)} / override: {formatRuntimeOverride(studioRuntimeOverride)}
                </p>
              </div>
              <span className="text-xs px-2 py-1 rounded-full border border-violet-500/20 bg-violet-500/10 text-violet-300">
                Preview плана
              </span>
            </div>

            <PreviewRow label="Summary" value={previewData.plan.summary} />
            {previewData.plan.speechText && <PreviewRow label="Speech" value={previewData.plan.speechText} />}
            {previewData.plan.helloText && <PreviewRow label="Hello" value={previewData.plan.helloText} />}
            {previewData.plan.askText && <PreviewRow label="Question" value={previewData.plan.askText} />}
            {previewData.plan.okText && <PreviewRow label="On success" value={previewData.plan.okText} />}
            {previewData.plan.byeText && <PreviewRow label="Goodbye" value={previewData.plan.byeText} />}
            {previewData.plan.successHint && <PreviewRow label="Success hint" value={previewData.plan.successHint} />}
          </div>
        )}
      </div>

      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          <Mic className="w-5 h-5 text-amber-400" />
          <h2 className="text-lg font-semibold text-white">Последние AI-звонки</h2>
          {sessionsLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
        </div>

        {aiSessions.length === 0 && !sessionsLoading ? (
          <p className="text-sm text-gray-500">Пока нет AI-звонков. Запусти первый сценарий через AI Call Studio или /callai.</p>
        ) : (
          <div className="space-y-3">
            {aiSessions.map((session) => (
              <div key={session.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-white">{session.scenarioName}</p>
                    <p className="text-xs text-gray-500">
                      {session.targetPhone} · {new Date(session.createdAt).toLocaleString('ru-RU')} · {formatRuntimeMode(session.runtimeMode)} · {session.provider}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full border ${formatSessionStatusClass(session.status)}`}>
                    {formatSessionStatus(session.status)}
                  </span>
                </div>

                <PreviewRow label="Задача" value={session.task} />
                <PreviewRow label="План" value={session.summary} />
                {session.resultSummary && <PreviewRow label="Итог" value={session.resultSummary} />}
                {session.transcript && <PreviewRow label="Расшифровка" value={session.transcript} />}
                {session.recordLink && (
                  <a href={session.recordLink} target="_blank" rel="noreferrer" className="text-sm text-emerald-400 hover:text-emerald-300">
                    Открыть запись звонка
                  </a>
                )}

                <div className="flex items-center gap-3 pt-1">
                  <button
                    className="text-sm text-violet-300 hover:text-violet-200"
                    onClick={() => setSelectedSessionId((current) => current === session.id ? null : session.id)}
                  >
                    {selectedSessionId === session.id ? 'Скрыть live detail' : 'Открыть live detail'}
                  </button>
                  {selectedSessionId === session.id && sessionDetailsLoading && (
                    <span className="text-xs text-gray-500 flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Загрузка таймлайна
                    </span>
                  )}
                </div>

                {selectedSessionId === session.id && selectedSessionDetails?.session.id === session.id && (
                  <SessionDetailPanel details={selectedSessionDetails} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}

const Field = ({ label, children, hint, className }: FieldProps) => (
  <div className={className}>
    <label className="block text-sm font-medium text-gray-300 mb-1.5">{label}</label>
    {children}
    {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
  </div>
);

interface StatusRowProps {
  label: string;
  value: string;
  ok: boolean;
  mono?: boolean;
}

const StatusRow = ({ label, value, ok, mono }: StatusRowProps) => (
  <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/5">
    <span className="text-sm text-gray-400">{label}</span>
    <span className={`text-sm font-medium ${ok ? 'text-emerald-400' : 'text-red-400'} ${mono ? 'font-mono text-xs' : ''}`}>
      {value}
    </span>
  </div>
);

interface ToggleButtonProps {
  active: boolean;
  label: string;
  iconOn: ReactNode;
  iconOff: ReactNode;
  onClick: () => void;
}

const ToggleButton = ({ active, label, iconOn, iconOff, onClick }: ToggleButtonProps) => (
  <button
    type="button"
    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all ${
      active ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-gray-700 bg-gray-800/50 text-gray-500'
    }`}
    onClick={onClick}
  >
    {active ? iconOn : iconOff}
    <span className="text-sm">{label}</span>
  </button>
);

interface ScenarioEditorProps {
  scenario: TelephonyAiScenario;
  onUpdate: (id: string, field: keyof TelephonyAiScenario, value: string | boolean | number) => void;
  onPolicyUpdate: (
    id: string,
    field: keyof TelephonyAiScenario['policy'],
    value: string | number,
  ) => void;
  onRemove: (id: string) => void;
}

const ScenarioEditor = ({ scenario, onUpdate, onPolicyUpdate, onRemove }: ScenarioEditorProps) => (
  <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-4">
    <div className="grid grid-cols-1 md:grid-cols-[1fr,1fr,180px,180px,120px] gap-3">
      <Field label="ID">
        <input className="input w-full font-mono text-sm" value={scenario.id} onChange={(e) => onUpdate(scenario.id, 'id', e.target.value)} />
      </Field>
      <Field label="Название">
        <input className="input w-full" value={scenario.name} onChange={(e) => onUpdate(scenario.id, 'name', e.target.value)} />
      </Field>
      <Field label="Режим">
        <select className="input w-full" value={scenario.callMode} onChange={(e) => onUpdate(scenario.id, 'callMode', e.target.value)}>
          <option value="ask_question">Ask question</option>
          <option value="speech">Speech only</option>
        </select>
      </Field>
      <Field label="Runtime">
        <select className="input w-full" value={scenario.runtimeMode} onChange={(e) => onUpdate(scenario.id, 'runtimeMode', e.target.value)}>
          <option value="scripted">Scripted</option>
          <option value="shadow">Shadow</option>
          <option value="hybrid">Hybrid</option>
          <option value="realtime">Realtime</option>
        </select>
      </Field>
      <div className="flex items-end gap-2">
        <button
          type="button"
          className={`flex-1 px-3 py-2 rounded-xl border text-sm ${
            scenario.enabled ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-gray-700 bg-gray-800/50 text-gray-500'
          }`}
          onClick={() => onUpdate(scenario.id, 'enabled', !scenario.enabled)}
        >
          {scenario.enabled ? 'Включён' : 'Выключен'}
        </button>
        <button className="p-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors" onClick={() => onRemove(scenario.id)}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>

    <Field label="Цель сценария">
      <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.goal} onChange={(e) => onUpdate(scenario.id, 'goal', e.target.value)} />
    </Field>

    <Field label="System prompt для голосового агента">
      <textarea className="input w-full min-h-[88px] text-sm resize-y" value={scenario.systemPrompt} onChange={(e) => onUpdate(scenario.id, 'systemPrompt', e.target.value)} />
    </Field>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Field label="Fallback">
        <select className="input w-full" value={scenario.policy.fallbackMode} onChange={(e) => onPolicyUpdate(scenario.id, 'fallbackMode', e.target.value)}>
          <option value="scripted">Scripted fallback</option>
          <option value="fail">Fail fast</option>
        </select>
      </Field>
      <Field label="Max silence (ms)">
        <input
          type="number"
          className="input w-full"
          value={scenario.policy.maxSilenceMs}
          onChange={(e) => onPolicyUpdate(scenario.id, 'maxSilenceMs', Number(e.target.value))}
        />
      </Field>
      <Field label="Max turns">
        <input
          type="number"
          className="input w-full"
          value={scenario.policy.maxTurns}
          onChange={(e) => onPolicyUpdate(scenario.id, 'maxTurns', Number(e.target.value))}
        />
      </Field>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="Стартовая реплика">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.openingLine} onChange={(e) => onUpdate(scenario.id, 'openingLine', e.target.value)} />
      </Field>
      <Field label="Подсказка по вопросу">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.questionHint} onChange={(e) => onUpdate(scenario.id, 'questionHint', e.target.value)} />
      </Field>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="Что считать успехом">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.successCriteria} onChange={(e) => onUpdate(scenario.id, 'successCriteria', e.target.value)} />
      </Field>
      <Field label="Подсказка для summary после записи">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.resultPrompt} onChange={(e) => onUpdate(scenario.id, 'resultPrompt', e.target.value)} />
      </Field>
    </div>

    <Field label="Лимит символов для speech-only">
      <input
        type="number"
        className="input w-40"
        value={scenario.maxSpeechChars}
        onChange={(e) => onUpdate(scenario.id, 'maxSpeechChars', Number(e.target.value))}
      />
    </Field>
  </div>
);

interface PreviewRowProps {
  label: string;
  value: string;
}

const PreviewRow = ({ label, value }: PreviewRowProps) => (
  <div>
    <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">{label}</p>
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
      {value}
    </div>
  </div>
);

interface SessionDetailPanelProps {
  details: TelephonySessionDetails;
}

const SessionDetailPanel = ({ details }: SessionDetailPanelProps) => (
  <div className="rounded-2xl border border-violet-500/10 bg-black/20 p-4 space-y-4">
    {details.outcome && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PreviewRow label="Outcome" value={details.outcome.outcomeLabel} />
        <PreviewRow label="Result summary" value={details.outcome.resultSummary} />
      </div>
    )}

    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-gray-500">Артефакты</p>
        {details.artifacts.length === 0 ? (
          <p className="text-sm text-gray-500">Пока нет артефактов.</p>
        ) : (
          <div className="space-y-2">
            {details.artifacts.map((artifact) => (
              <div key={artifact.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white">{artifact.artifactType}</span>
                  <span className="text-xs text-gray-500">{artifact.status}</span>
                </div>
                {artifact.url && (
                  <a href={artifact.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-emerald-400 hover:text-emerald-300">
                    Открыть артефакт
                  </a>
                )}
                {artifact.storagePath && (
                  <p className="mt-2 text-xs font-mono text-gray-500 break-all">{artifact.storagePath}</p>
                )}
                {artifact.content && (
                  <p className="mt-2 text-sm text-gray-300 whitespace-pre-wrap">{artifact.content}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-gray-500">Таймлайн событий</p>
        {details.events.length === 0 ? (
          <p className="text-sm text-gray-500">Событий пока нет.</p>
        ) : (
          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {details.events.map((event) => (
              <div key={event.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-white">{formatEventType(event.eventType)}</span>
                  <span className="text-[11px] text-gray-500">{new Date(event.createdAt).toLocaleTimeString('ru-RU')}</span>
                </div>
                {Object.keys(event.payload).length > 0 && (
                  <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-gray-400">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>

    <div className="space-y-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">Turns</p>
      {details.turns.length === 0 ? (
        <p className="text-sm text-gray-500">Пока нет turns.</p>
      ) : (
        <div className="space-y-2">
          {details.turns.map((turn) => (
            <div key={turn.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm text-white">{turn.turnIndex}. {turn.speaker}</span>
                <span className="text-[11px] text-gray-500">{turn.source}</span>
              </div>
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{turn.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
);

export default TelephonyPage;
