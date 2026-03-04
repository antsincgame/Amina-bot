import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import {
  Phone,
  PhoneCall,
  Save,
  Loader2,
  CheckCircle,
  AlertCircle,
  Wifi,
  WifiOff,
  Bell,
  BellOff,
  Mic,
  Plus,
  Trash2,
  Sparkles,
  Copy,
  User,
  Zap,
} from 'lucide-react';

const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

interface LiraXStatus {
  configured: boolean;
  url: string;
  defaultExt: string;
  webhookUrl: string;
  hasWebhookToken: boolean;
}

interface Scenario {
  id: string;
  name: string;
  rule: string;
  generatedPrompt: string;
}

const DEFAULT_SCENARIOS: Scenario[] = [
  {
    id: 'callback',
    name: 'Обратный звонок на пропущенный',
    rule: 'Позвонить клиенту, сказать "Здравствуйте, вы нам звонили, соединяю с менеджером", затем соединить с оператором.',
    generatedPrompt: '',
  },
  {
    id: 'reminder',
    name: 'Напоминание о встрече',
    rule: 'Позвонить клиенту, сказать "Здравствуйте, напоминаем вам о встрече завтра в 14:00. Если подтверждаете, скажите да.", дождаться подтверждения, попрощаться.',
    generatedPrompt: '',
  },
  {
    id: 'qualification',
    name: 'Холодный обзвон с квалификацией',
    rule: 'Позвонить клиенту, сказать "Здравствуйте, компания предлагает услуги разработки сайтов. Вас интересует создание или обновление сайта?". Если ответ положительный — соединить с менеджером. Если нет — попрощаться.',
    generatedPrompt: '',
  },
];

// ---------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------

async function fetchLiraXStatus(): Promise<LiraXStatus> {
  const res = await fetch(`${BOT_URL}/api/lirax/status`);
  if (!res.ok) throw new Error('Failed to fetch LiraX status');
  const json = await res.json();
  return json.data;
}

async function fetchScenarios(): Promise<Scenario[]> {
  const res = await fetch(`${BOT_URL}/api/lirax/scenarios`);
  if (!res.ok) throw new Error('Failed to fetch scenarios');
  const json = await res.json();
  return json.data?.length ? json.data : [];
}

async function saveScenarios(scenarios: Scenario[]): Promise<void> {
  const res = await fetch(`${BOT_URL}/api/lirax/scenarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenarios),
  });
  if (!res.ok) throw new Error('Failed to save scenarios');
}

async function generatePrompt(rule: string): Promise<{ generatedPrompt: string; model: string }> {
  const res = await fetch(`${BOT_URL}/api/lirax/generate-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rule }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to generate prompt');
  }
  const json = await res.json();
  return json.data;
}

async function testCall(phone: string): Promise<{ id_makecall: string }> {
  const res = await fetch(`${BOT_URL}/api/lirax/test-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Test call failed');
  }
  const json = await res.json();
  return json.data;
}

// ---------------------------------------------------------------
// Component
// ---------------------------------------------------------------

const TelephonyPage = () => {
  const queryClient = useQueryClient();

  // Settings state
  const [adminChatId, setAdminChatId] = useState('7867087040');
  const [notifyCalls, setNotifyCalls] = useState(true);
  const [notifyRecords, setNotifyRecords] = useState(true);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Scenarios state
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  // Test call state
  const [testPhone, setTestPhone] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // ---- Queries ----

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['lirax-status'],
    queryFn: fetchLiraXStatus,
    refetchInterval: 30_000,
  });

  const { data: allSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.getAll(),
  });

  const { isLoading: scenariosLoading } = useQuery({
    queryKey: ['lirax-scenarios'],
    queryFn: async () => {
      const data = await fetchScenarios();
      if (data.length > 0) {
        setScenarios(data);
      } else {
        setScenarios(DEFAULT_SCENARIOS);
      }
      return data;
    },
  });

  useEffect(() => {
    if (!allSettings) return;
    const map = new Map(allSettings.map((s) => [s.key, s.value]));
    setAdminChatId(map.get('lirax_admin_chat_id') || '7867087040');
    setNotifyCalls(map.get('lirax_notify_calls') !== 'false');
    setNotifyRecords(map.get('lirax_notify_records') !== 'false');
  }, [allSettings]);

  // ---- Mutations ----

  const { mutate: saveSettings, isPending: savingSettings } = useMutation({
    mutationFn: () =>
      settingsApi.updateMany({
        lirax_admin_chat_id: adminChatId,
        lirax_notify_calls: notifyCalls ? 'true' : 'false',
        lirax_notify_records: notifyRecords ? 'true' : 'false',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    },
  });

  const { mutate: persistScenarios, isPending: savingScenarios } = useMutation({
    mutationFn: () => saveScenarios(scenarios),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lirax-scenarios'] });
    },
  });

  const { mutate: doTestCall, isPending: callingTest } = useMutation({
    mutationFn: () => testCall(testPhone),
    onSuccess: (data) => {
      setTestResult({ success: true, message: `Звонок инициирован! ID: ${data.id_makecall}` });
    },
    onError: (err) => {
      setTestResult({ success: false, message: String(err instanceof Error ? err.message : err) });
    },
  });

  // ---- Handlers ----

  const handleGenerate = async (scenarioId: string) => {
    const scenario = scenarios.find((s) => s.id === scenarioId);
    if (!scenario) return;
    setGeneratingId(scenarioId);
    try {
      const result = await generatePrompt(scenario.rule);
      setScenarios((prev) =>
        prev.map((s) => (s.id === scenarioId ? { ...s, generatedPrompt: result.generatedPrompt } : s)),
      );
    } catch {
      // error handled silently
    } finally {
      setGeneratingId(null);
    }
  };

  const addScenario = () => {
    const id = `custom_${Date.now()}`;
    setScenarios((prev) => [
      ...prev,
      { id, name: 'Новый сценарий', rule: '', generatedPrompt: '' },
    ]);
  };

  const removeScenario = (id: string) => {
    setScenarios((prev) => prev.filter((s) => s.id !== id));
  };

  const updateScenario = (id: string, field: keyof Scenario, value: string) => {
    setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
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
          <h1
            className="text-3xl font-bold text-gradient-gold"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Телефония
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            LiraX АТС — управление звонками, сценарии, уведомления
          </p>
        </div>
      </div>

      {/* A. Connection Status */}
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
            <StatusRow
              label="Подключение"
              value={status.configured ? 'Настроено' : 'Не настроено'}
              ok={status.configured}
            />
            <StatusRow label="URL АТС" value={status.url} ok={true} mono />
            <StatusRow label="Внутренний номер" value={status.defaultExt} ok={true} />
            <StatusRow label="Webhook URL" value={status.webhookUrl} ok={true} mono />
            <StatusRow
              label="Webhook токен"
              value={status.hasWebhookToken ? 'Установлен' : 'Не установлен'}
              ok={status.hasWebhookToken}
            />
          </div>
        ) : (
          !statusLoading && (
            <p className="text-gray-500 text-sm">Не удалось загрузить статус LiraX</p>
          )
        )}
      </div>

      {/* B. Admin Setup + C. Notifications */}
      <div className="card p-6">
        <div className="flex items-center gap-3 mb-6">
          <User className="w-5 h-5 text-amber-400" />
          <h2 className="text-lg font-semibold text-white">Настройки управления</h2>
        </div>

        <div className="space-y-5">
          {/* Admin chat ID */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Telegram ID администратора звонков
            </label>
            <div className="flex gap-3">
              <input
                type="text"
                className="input flex-1"
                value={adminChatId}
                onChange={(e) => setAdminChatId(e.target.value)}
                placeholder="7867087040"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Этот пользователь получает уведомления о звонках и управляет сценариями
            </p>
          </div>

          {/* Notification toggles */}
          <div className="flex flex-col sm:flex-row gap-4">
            <button
              type="button"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all ${
                notifyCalls
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-gray-700 bg-gray-800/50 text-gray-500'
              }`}
              onClick={() => setNotifyCalls(!notifyCalls)}
            >
              {notifyCalls ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
              <span className="text-sm">Уведомления о звонках</span>
            </button>

            <button
              type="button"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all ${
                notifyRecords
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-gray-700 bg-gray-800/50 text-gray-500'
              }`}
              onClick={() => setNotifyRecords(!notifyRecords)}
            >
              {notifyRecords ? <Mic className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              <span className="text-sm">Уведомления о записях</span>
            </button>
          </div>

          {/* Save button */}
          <div className="flex items-center gap-3">
            <button
              className="btn-gold flex items-center gap-2"
              disabled={savingSettings}
              onClick={() => saveSettings()}
            >
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

      {/* D. Call Scenarios */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-violet-400" />
            <h2 className="text-lg font-semibold text-white">Сценарии звонков</h2>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost flex items-center gap-1.5 text-sm" onClick={addScenario}>
              <Plus className="w-4 h-4" />
              Добавить
            </button>
            <button
              className="btn-gold flex items-center gap-1.5 text-sm"
              disabled={savingScenarios}
              onClick={() => persistScenarios()}
            >
              {savingScenarios ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Сохранить все
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          Опишите правило на русском языке, нажмите &laquo;Генерировать&raquo; — ИИ преобразует его в
          конфигурацию вызова LiraX.
        </p>

        {scenariosLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
          </div>
        ) : (
          <div className="space-y-4">
            {scenarios.map((scenario) => (
              <ScenarioCard
                key={scenario.id}
                scenario={scenario}
                isGenerating={generatingId === scenario.id}
                onUpdate={updateScenario}
                onGenerate={handleGenerate}
                onRemove={removeScenario}
                onCopy={copyToClipboard}
              />
            ))}
          </div>
        )}
      </div>

      {/* E. Test Call */}
      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          <Zap className="w-5 h-5 text-amber-400" />
          <h2 className="text-lg font-semibold text-white">Тестовый звонок</h2>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          АТС сначала позвонит на ваш внутренний номер ({status?.defaultExt || '201'}), затем
          соединит с указанным абонентом.
        </p>

        <div className="flex gap-3 items-start">
          <input
            type="tel"
            className="input flex-1"
            placeholder="+375291234567"
            value={testPhone}
            onChange={(e) => {
              setTestPhone(e.target.value);
              setTestResult(null);
            }}
          />
          <button
            className="btn-gold flex items-center gap-2 whitespace-nowrap"
            disabled={callingTest || !testPhone.trim()}
            onClick={() => doTestCall()}
          >
            {callingTest ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <PhoneCall className="w-4 h-4" />
            )}
            Позвонить
          </button>
        </div>

        {testResult && (
          <div
            className={`mt-3 flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${
              testResult.success
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/10 border border-red-500/20 text-red-400'
            }`}
          >
            {testResult.success ? (
              <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <span>{testResult.message}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------

interface StatusRowProps {
  label: string;
  value: string;
  ok: boolean;
  mono?: boolean;
}

const StatusRow = ({ label, value, ok, mono }: StatusRowProps) => (
  <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/5">
    <span className="text-sm text-gray-400">{label}</span>
    <span
      className={`text-sm font-medium ${ok ? 'text-emerald-400' : 'text-red-400'} ${mono ? 'font-mono text-xs' : ''}`}
    >
      {value}
    </span>
  </div>
);

interface ScenarioCardProps {
  scenario: Scenario;
  isGenerating: boolean;
  onUpdate: (id: string, field: keyof Scenario, value: string) => void;
  onGenerate: (id: string) => void;
  onRemove: (id: string) => void;
  onCopy: (text: string) => void;
}

const ScenarioCard = ({
  scenario,
  isGenerating,
  onUpdate,
  onGenerate,
  onRemove,
  onCopy,
}: ScenarioCardProps) => (
  <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3">
    {/* Name */}
    <div className="flex items-center gap-2">
      <input
        type="text"
        className="input flex-1 text-sm font-semibold"
        value={scenario.name}
        onChange={(e) => onUpdate(scenario.id, 'name', e.target.value)}
        placeholder="Название сценария"
      />
      <button
        className="p-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
        onClick={() => onRemove(scenario.id)}
        title="Удалить"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>

    {/* Rule */}
    <div>
      <label className="block text-xs text-gray-500 mb-1">Правило (на русском)</label>
      <textarea
        className="input w-full min-h-[72px] text-sm resize-y"
        value={scenario.rule}
        onChange={(e) => onUpdate(scenario.id, 'rule', e.target.value)}
        placeholder="Опишите что должна делать Амина при звонке..."
      />
    </div>

    {/* Generate button */}
    <button
      className="btn-ghost flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300"
      disabled={isGenerating || !scenario.rule.trim()}
      onClick={() => onGenerate(scenario.id)}
    >
      {isGenerating ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Sparkles className="w-3.5 h-3.5" />
      )}
      Генерировать промпт
    </button>

    {/* Generated prompt */}
    {scenario.generatedPrompt && (
      <div className="relative">
        <label className="block text-xs text-gray-500 mb-1">Сгенерированная конфигурация LiraX</label>
        <pre className="rounded-lg bg-black/30 border border-white/5 p-3 text-xs text-emerald-300 overflow-x-auto whitespace-pre-wrap font-mono max-h-48">
          {scenario.generatedPrompt}
        </pre>
        <button
          className="absolute top-6 right-2 p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
          onClick={() => onCopy(scenario.generatedPrompt)}
          title="Скопировать"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
    )}
  </div>
);

export default TelephonyPage;
