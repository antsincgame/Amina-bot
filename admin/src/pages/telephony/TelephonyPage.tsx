import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bell,
  BellOff,
  CheckCircle,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  Plus,
  Save,
  Shield,
  Sparkles,
  User,
  UserMinus,
  UserPlus,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { fetchBotApi, settingsApi } from '../../api/appwrite';
import type { TelephonyAiScenario, TelephonyRuntimeMode } from '../../../../shared/types/telephony.js';
import type { SimpleModel, TelephonyAiPreviewResponse, TestConnectionResult } from './types';
import { DEFAULT_PREMIUM_MODELS } from './types';
import {
  formatBridgeReachability,
  formatRuntimeMode,
  formatRuntimeOverride,
  formatScenarioMode,
  formatSessionStatus,
  formatSessionStatusClass,
  formatSourceLabel,
  createScenarioDraft,
} from './telephonyFormatters';
import {
  addTelephonyUserApi,
  fetchAiSessions,
  fetchLiraXStatus,
  fetchPremiumOpenRouterModels,
  fetchRealtimeStatus,
  fetchScenarios,
  fetchSessionDetails,
  fetchTelephonyUsers,
  previewAiCall,
  removeTelephonyUserApi,
  saveScenarios,
  startAiCall,
  testLiraXConnection,
} from './telephonyApi';
import { Field, PreviewRow, StatusRow, ToggleButton } from './ui';
import { ScenarioEditor } from './ScenarioEditor';
import { SessionDetailPanel } from './SessionDetailPanel';

const TelephonyPage = () => {
  const queryClient = useQueryClient();

  const [adminChatId, setAdminChatId] = useState('');
  const [ownerChatId, setOwnerChatId] = useState('');
  const [liraxUrl, setLiraxUrl] = useState('');
  const [liraxToken, setLiraxToken] = useState('');
  const [webhookToken, setWebhookToken] = useState('');
  const [defaultExt, setDefaultExt] = useState('201');
  const [operatorPhone, setOperatorPhone] = useState('');
  const [sipServer, setSipServer] = useState('');
  const [sipLogin, setSipLogin] = useState('');
  const [sipPassword, setSipPassword] = useState('');
  const [externalNumber, setExternalNumber] = useState('');
  const [telephonyAiProvider, setTelephonyAiProvider] = useState<'inherit' | 'openrouter' | 'lmstudio' | 'cerebras' | 'groq'>('inherit');
  const [telephonyOpenrouterModel, setTelephonyOpenrouterModel] = useState('');
  const [notifyCalls, setNotifyCalls] = useState(true);
  const [notifyRecords, setNotifyRecords] = useState(true);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const [mediaBridgeUrl, setMediaBridgeUrl] = useState('');
  const [mediaBridgeToken, setMediaBridgeToken] = useState('');
  const [archiveRecordings, setArchiveRecordings] = useState(true);
  const [storePartialTranscript, setStorePartialTranscript] = useState(true);
  const [latencyBudgetMs, setLatencyBudgetMs] = useState('1800');
  const [recordingRetentionDays, setRecordingRetentionDays] = useState('30');
  const [premiumModels, setPremiumModels] = useState<SimpleModel[]>(DEFAULT_PREMIUM_MODELS);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [reloadWarning, setReloadWarning] = useState(false);

  const [showLiraxToken, setShowLiraxToken] = useState(false);
  const [showWebhookToken, setShowWebhookToken] = useState(false);
  const [showSipPassword, setShowSipPassword] = useState(false);
  const [showBridgeToken, setShowBridgeToken] = useState(false);

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

  const [connectionTestResult, setConnectionTestResult] = useState<TestConnectionResult | null>(null);
  const [connectionTestError, setConnectionTestError] = useState<string | null>(null);
  const [connectionTesting, setConnectionTesting] = useState(false);

  const handleTestConnection = async () => {
    setConnectionTesting(true);
    setConnectionTestResult(null);
    setConnectionTestError(null);
    try {
      const result = await testLiraXConnection();
      setConnectionTestResult(result);
    } catch (error) {
      setConnectionTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionTesting(false);
    }
  };

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
    setLiraxUrl(map.get('lirax_url') || 'https://api.lirax.net/general');
    setLiraxToken(map.get('lirax_token') || '');
    setWebhookToken(map.get('lirax_webhook_token') || '');
    setDefaultExt(map.get('lirax_default_ext') || '201');
    setOperatorPhone(map.get('lirax_operator_phone') || '');
    setSipServer(map.get('telephony_sip_server') || '');
    setSipLogin(map.get('telephony_sip_login') || '');
    setSipPassword(map.get('telephony_sip_password') || '');
    setExternalNumber(map.get('telephony_external_number') || '');
    const provider = map.get('telephony_ai_provider');
    setTelephonyAiProvider(
      provider === 'openrouter' || provider === 'lmstudio' || provider === 'cerebras' || provider === 'groq' ? provider : 'inherit',
    );
    setTelephonyOpenrouterModel(map.get('telephony_openrouter_model') || '');
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

  const handleRefreshModels = async (): Promise<void> => {
    setIsRefreshingModels(true);
    try {
      const models = await fetchPremiumOpenRouterModels();
      setPremiumModels(models.length > 0 ? models : DEFAULT_PREMIUM_MODELS);
      setRefreshMessage(`Загружено ${models.length} премиум моделей`);
    } catch (error) {
      setRefreshMessage(`Ошибка загрузки моделей: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRefreshingModels(false);
      setTimeout(() => setRefreshMessage(''), 4000);
    }
  };

  const { mutate: saveSettings, isPending: savingSettings } = useMutation({
    mutationFn: async () => {
      await settingsApi.updateMany({
        lirax_admin_chat_id: adminChatId,
        lirax_owner_chat_id: ownerChatId,
        lirax_url: liraxUrl,
        lirax_token: liraxToken,
        lirax_webhook_token: webhookToken,
        lirax_default_ext: defaultExt,
        lirax_operator_phone: operatorPhone,
        lirax_notify_calls: notifyCalls ? 'true' : 'false',
        lirax_notify_records: notifyRecords ? 'true' : 'false',
        telephony_sip_server: sipServer,
        telephony_sip_login: sipLogin,
        telephony_sip_password: sipPassword,
        telephony_external_number: externalNumber,
        telephony_ai_provider: telephonyAiProvider,
        telephony_openrouter_model: telephonyOpenrouterModel,
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

  const renderSettingsSaveButton = (label: string) => (
    <div className="flex justify-end pt-4 border-t border-white/5">
      <button className="btn-gold flex items-center gap-2" disabled={savingSettings} onClick={() => saveSettings()}>
        {savingSettings ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : settingsSaved ? (
          <CheckCircle className="w-4 h-4" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {settingsSaved ? 'Сохранено!' : label}
      </button>
    </div>
  );

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
            <StatusRow label="Оператор" value={status.operatorPhone} ok={status.operatorPhone !== '—'} mono />
            <StatusRow label="Владелец AI-звонков" value={status.ownerChatId} ok={status.ownerChatId !== '—'} />
            <StatusRow label="Webhook URL" value={status.webhookUrl} ok={!!status.webhookUrl} mono />
            <StatusRow label="Webhook токен" value={status.hasWebhookToken ? 'Установлен' : 'Не установлен'} ok={status.hasWebhookToken} />
            <StatusRow label="SIP server" value={status.sipServer} ok={status.sipServer !== '—'} mono />
            <StatusRow label="SIP credentials" value={status.hasSipCredentials ? 'Установлены' : 'Не заданы'} ok={status.hasSipCredentials} />
            <StatusRow label="Внешний номер" value={status.externalNumber} ok={status.externalNumber !== '—'} mono />
          </div>
        ) : (
          !statusLoading && <p className="text-sm text-gray-500">Не удалось загрузить статус LiraX</p>
        )}

        <div className="mt-5 pt-5 border-t border-white/10">
          <div className="flex items-center gap-3">
            <button
              onClick={handleTestConnection}
              disabled={connectionTesting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {connectionTesting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Phone className="w-4 h-4" />
              )}
              Тест подключения LiraX
            </button>
            {connectionTestResult?.connected && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-400">
                <CheckCircle className="w-4 h-4" />
                Подключено за {connectionTestResult.latencyMs}ms · {connectionTestResult.usersCount} пользователей
              </span>
            )}
            {connectionTestResult && !connectionTestResult.connected && (
              <span className="flex items-center gap-1.5 text-sm text-red-400">
                <AlertCircle className="w-4 h-4" />
                Не подключено
              </span>
            )}
            {connectionTestError && (
              <span className="flex items-center gap-1.5 text-sm text-red-400">
                <AlertCircle className="w-4 h-4" />
                {connectionTestError}
              </span>
            )}
          </div>
          {connectionTestResult?.connected && connectionTestResult.users && connectionTestResult.users.length > 0 && (
            <div className="mt-3 text-xs text-gray-400 space-y-1">
              {connectionTestResult.users.map((u) => (
                <div key={u.id} className="flex gap-3">
                  <span className="text-gray-500">ext {u.ext}</span>
                  <span>{u.name}</span>
                  <span className={u.active === '1' ? 'text-emerald-500' : 'text-gray-600'}>
                    {u.active === '1' ? 'активен' : 'неактивен'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
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
            <StatusRow
              label="Предпочитаемый AI provider телефонии"
              value={`${realtimeStatus.telephonyAiProvider} · ${formatSourceLabel(realtimeStatus.telephonyAiProviderSource)}`}
              ok={!!realtimeStatus.telephonyAiProvider}
              mono
            />
            <StatusRow
              label="Предпочитаемая OpenRouter model"
              value={`${realtimeStatus.telephonyPreferredOpenrouterModel || 'Не задана'} · ${formatSourceLabel(realtimeStatus.telephonyPreferredOpenrouterModelSource)}`}
              ok
              mono
            />
            <StatusRow
              label="Effective AI provider телефонии"
              value={`${realtimeStatus.telephonyEffectiveAiProvider} · ${formatSourceLabel(realtimeStatus.telephonyEffectiveAiProviderSource)}`}
              ok={!!realtimeStatus.telephonyEffectiveAiProvider}
              mono
            />
            <StatusRow
              label="Effective AI model телефонии"
              value={`${realtimeStatus.telephonyEffectiveModel || 'Не задана'} · ${formatSourceLabel(realtimeStatus.telephonyEffectiveModelSource)}`}
              ok={!!realtimeStatus.telephonyEffectiveModel}
              mono
            />
            <StatusRow label="SIP server bridge" value={realtimeStatus.sipServer || 'Не задан'} ok={!!realtimeStatus.sipServer} mono />
            <StatusRow label="SIP учётка" value={realtimeStatus.hasSipCredentials ? 'Готова' : 'Не настроена'} ok={realtimeStatus.hasSipCredentials} />
          </div>
        ) : (
          !realtimeStatusLoading && <p className="text-sm text-gray-500">Не удалось загрузить статус realtime bridge</p>
        )}
        {realtimeStatus && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-gray-400">
            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
              <p className="text-gray-500 mb-1">Почему preferred provider такой</p>
              <p>{realtimeStatus.telephonyAiProviderReason}</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
              <p className="text-gray-500 mb-1">Почему preferred model такая</p>
              <p>{realtimeStatus.telephonyPreferredOpenrouterModelReason}</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
              <p className="text-gray-500 mb-1">Почему effective provider такой</p>
              <p>{realtimeStatus.telephonyEffectiveAiProviderReason}</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
              <p className="text-gray-500 mb-1">Почему effective model такая</p>
              <p>{realtimeStatus.telephonyEffectiveModelReason}</p>
            </div>
          </div>
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

          <Field label="LiraX API URL" hint="General API URL для команд makeCall / AskQuestion / get_calls.">
            <input
              className="input w-full font-mono text-sm"
              value={liraxUrl}
              onChange={(e) => setLiraxUrl(e.target.value)}
              placeholder="https://api.lirax.net/general"
            />
          </Field>

          <Field label="LiraX API token" hint="Значение из БД. Fallback: переменная окружения LIRAX_TOKEN.">
            <div className="relative">
              <input
                type={showLiraxToken ? 'text' : 'password'}
                className="input w-full font-mono text-sm pr-10"
                value={liraxToken}
                onChange={(e) => setLiraxToken(e.target.value)}
                placeholder="token из LiraX"
              />
              <button
                type="button"
                onClick={() => setShowLiraxToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                aria-label={showLiraxToken ? 'Скрыть' : 'Показать'}
              >
                {showLiraxToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>

          <Field label="Webhook токен (from_LiraX_token)" hint="Токен верификации вебхуков LiraX. Fallback: LIRAX_WEBHOOK_TOKEN.">
            <div className="relative">
              <input
                type={showWebhookToken ? 'text' : 'password'}
                className="input w-full font-mono text-sm pr-10"
                value={webhookToken}
                onChange={(e) => setWebhookToken(e.target.value)}
                placeholder="Токен из LiraX → Интеграция General"
              />
              <button
                type="button"
                onClick={() => setShowWebhookToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                aria-label={showWebhookToken ? 'Скрыть' : 'Показать'}
              >
                {showWebhookToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>

          <Field label="Телефон оператора" hint="Нужен для обычных /call и connectCall. Для AI-сценариев может использоваться другой runtime path в зависимости от сценария и провайдера.">
            <input className="input w-full" value={operatorPhone} onChange={(e) => setOperatorPhone(e.target.value)} placeholder="+375291234567" />
          </Field>

          <Field label="Внутренний номер (ext)" hint="Используется как from/ext для LiraX-команд.">
            <input className="input w-48" value={defaultExt} onChange={(e) => setDefaultExt(e.target.value)} placeholder="201" />
          </Field>

          {renderSettingsSaveButton('Сохранить блок LiraX')}

          <div className="pt-2 border-t border-white/5">
            <p className="text-sm font-medium text-white mb-3">SIP / внешняя связность</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="SIP server" hint="Сервер SIP-регистрации для bridge / внешнего voice runtime.">
                <input
                  className="input w-full font-mono text-sm"
                  value={sipServer}
                  onChange={(e) => setSipServer(e.target.value)}
                  placeholder="lira.lirax.net"
                />
              </Field>
              <Field label="SIP login" hint="Логин SIP-учётки.">
                <input
                  className="input w-full font-mono text-sm"
                  value={sipLogin}
                  onChange={(e) => setSipLogin(e.target.value)}
                  placeholder="1129570"
                />
              </Field>
              <Field label="SIP password" hint="Fallback: переменная окружения TELEPHONY_SIP_PASSWORD.">
                <div className="relative">
                  <input
                    type={showSipPassword ? 'text' : 'password'}
                    className="input w-full font-mono text-sm pr-10"
                    value={sipPassword}
                    onChange={(e) => setSipPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSipPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                    aria-label={showSipPassword ? 'Скрыть' : 'Показать'}
                  >
                    {showSipPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </Field>
              <Field label="Внешний номер" hint="Номер для внешней телефонии, если runtime или bridge требует явный outbound identity.">
                <input
                  className="input w-full"
                  value={externalNumber}
                  onChange={(e) => setExternalNumber(e.target.value)}
                  placeholder="+375291234567"
                />
              </Field>
            </div>

            {renderSettingsSaveButton('Сохранить SIP и внешнюю связность')}
          </div>

          <div className="pt-2 border-t border-white/5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="text-sm font-medium text-white">AI-ядро телефонии</p>
              <button
                type="button"
                onClick={() => void handleRefreshModels()}
                disabled={isRefreshingModels}
                className="btn-secondary"
              >
                {isRefreshingModels ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Обновление...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 mr-2" />
                    Премиум модели OpenRouter
                  </>
                )}
              </button>
            </div>
            {refreshMessage && (
              <div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                {refreshMessage}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Telephony AI provider" hint="Это preferred provider телефонии. При inherit телефония строит собственный effective stack из глобального runtime и показывает результат выше в статусе.">
                <select
                  className="input w-full"
                  value={telephonyAiProvider}
                  onChange={(e) => setTelephonyAiProvider(e.target.value as 'inherit' | 'openrouter' | 'lmstudio' | 'cerebras' | 'groq')}
                >
                  <option value="inherit">Наследовать общий provider</option>
                  <option value="openrouter">Принудительно OpenRouter</option>
                  <option value="lmstudio">Принудительно LM Studio</option>
                  <option value="cerebras">Принудительно Cerebras</option>
                  <option value="groq">Принудительно Groq</option>
                </select>
              </Field>
              <Field label="Telephony OpenRouter model" hint="Это preferred OpenRouter model телефонии. Она применяется напрямую при provider=openrouter и используется как telephony-specific model, если inherit в итоге резолвится в OpenRouter.">
                <select
                  className="input w-full"
                  value={telephonyOpenrouterModel}
                  onChange={(e) => setTelephonyOpenrouterModel(e.target.value)}
                >
                  <option value="">Не задано</option>
                  {telephonyOpenrouterModel
                    && !premiumModels.some((model) => model.id === telephonyOpenrouterModel) && (
                    <option value={telephonyOpenrouterModel}>
                      {telephonyOpenrouterModel}
                    </option>
                  )}
                  {premiumModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {renderSettingsSaveButton('Сохранить AI-ядро телефонии')}
          </div>

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

          {renderSettingsSaveButton('Сохранить уведомления')}

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

              <Field label="Bridge bearer token" hint="Используется и для outbound start, и для входящих callbackов bridge. Fallback: TELEPHONY_MEDIA_BRIDGE_TOKEN.">
                <div className="relative">
                  <input
                    type={showBridgeToken ? 'text' : 'password'}
                    className="input w-full font-mono text-sm pr-10"
                    value={mediaBridgeToken}
                    onChange={(e) => setMediaBridgeToken(e.target.value)}
                    placeholder="bridge-secret-token"
                  />
                  <button
                    type="button"
                    onClick={() => setShowBridgeToken((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                    aria-label={showBridgeToken ? 'Скрыть' : 'Показать'}
                  >
                    {showBridgeToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </Field>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Latency budget (ms)" hint="Если realtime pipeline выходит за бюджет, bridge или runtime может уйти в fallback. Это целевой бюджет, а не жёсткая гарантия поведения.">
                  <input
                    type="number"
                    className="input w-full"
                    value={latencyBudgetMs}
                    onChange={(e) => setLatencyBudgetMs(e.target.value)}
                    placeholder="1800"
                  />
                </Field>
                <Field label="Retention (days)" hint="Сколько дней хранить raw recording в Appwrite Storage.">
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

            {renderSettingsSaveButton('Сохранить Realtime voice')}
          </div>

          {renderSettingsSaveButton('Сохранить все настройки')}
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
          Сценарий хранит бизнес-цель, тональность, стартовую реплику и правила summary после звонка. Фактический AI runtime для звонка выбирается из preferred/effective telephony stack и может отличаться от глобального chat runtime.
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
          Preview показывает план ответа по сценарию. Запуск действительно создаёт звонок, но итоговый runtime path может уйти в fallback, а summary зависит от записи и post-call обработки.
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

export default TelephonyPage;
