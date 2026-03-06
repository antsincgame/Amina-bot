import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import {
  Save,
  Loader2,
  RefreshCw,
  Monitor,
  Wifi,
  WifiOff,
  Copy,
  Check,
  Server,
  Zap,
  Terminal,
  Clock,
  Shield,
  Search,
  Cpu,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Bug,
} from 'lucide-react';

const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

type AIProvider = 'auto' | 'lmstudio' | 'openrouter';

interface LMStudioModel {
  id: string;
  name: string;
  owned_by: string;
}

interface HealthStatus {
  configured: boolean;
  healthy: boolean;
  url: string | null;
  model?: string;
  source?: 'heartbeat' | 'direct' | null;
  heartbeatAt?: string;
}

const PROVIDER_LABELS: Record<AIProvider, { label: string; desc: string }> = {
  auto: {
    label: 'Auto',
    desc: 'LM Studio если доступна, иначе OpenRouter',
  },
  lmstudio: {
    label: 'LM Studio',
    desc: 'Только LM Studio (ошибка если offline)',
  },
  openrouter: {
    label: 'OpenRouter',
    desc: 'Только облачные модели (игнорировать LM Studio)',
  },
};

const LMStudioPage = () => {
  const queryClient = useQueryClient();

  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<AIProvider>('auto');

  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [models, setModels] = useState<LMStudioModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [urlUpdatedAt, setUrlUpdatedAt] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [debugInfo, setDebugInfo] = useState<{
    status?: number;
    latencyMs?: number;
    error?: string;
    configured?: boolean;
  } | null>(null);
  const [isLoadingDebug, setIsLoadingDebug] = useState(false);
  const [debugExpanded, setDebugExpanded] = useState(false);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaveMessage('Сохранено');
      setTimeout(() => setSaveMessage(''), 2000);
    },
    onError: (err) => {
      setSaveMessage(err instanceof Error ? err.message : 'Ошибка сохранения');
      setTimeout(() => setSaveMessage(''), 3000);
    },
  });

  useEffect(() => {
    if (!settings) return;
    const map = settings.reduce(
      (acc, s) => ({ ...acc, [s.key]: s.value }),
      {} as Record<string, string>,
    );
    setUrl(map['lmstudio_url'] ?? '');
    setModel(map['lmstudio_model'] ?? '');
    setApiKey(map['lmstudio_api_key'] ?? '');
    setUrlUpdatedAt(map['lmstudio_url_updated_at'] ?? '');
    const p = map['ai_provider'];
    if (p === 'lmstudio' || p === 'openrouter') {
      setProvider(p);
    } else {
      setProvider('auto');
    }
  }, [settings]);

  const checkHealth = useCallback(async (forceRefresh = false) => {
    setIsCheckingHealth(true);
    try {
      if (forceRefresh) {
        await fetch(`${BOT_URL}/api/lmstudio/reload`, { method: 'POST' });
        await new Promise((r) => setTimeout(r, 400));
      }
      const res = await fetch(`${BOT_URL}/api/lmstudio/health`);
      const json = await res.json().catch(() => null);
      const data = json?.data;
      if (res.ok && data && typeof data.configured === 'boolean') {
        setHealthStatus(data);
      } else {
        setHealthStatus({ configured: false, healthy: false, url: null });
      }
    } catch {
      setHealthStatus({ configured: false, healthy: false, url: null });
    } finally {
      setIsCheckingHealth(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    setIsLoadingModels(true);
    try {
      const res = await fetch(`${BOT_URL}/api/lmstudio/models`);
      if (res.ok) {
        const json = await res.json();
        const modelsList = json.data?.models ?? [];
        setModels(modelsList);
        if (modelsList.length > 0 && json.data?.url) {
          setHealthStatus((prev) => ({
            ...(prev ?? {}),
            configured: true,
            healthy: true,
            url: json.data.url,
            model: prev?.model,
          }));
        }
      }
    } catch {
      setModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  }, []);

  const fetchDebugInfo = useCallback(async () => {
    setIsLoadingDebug(true);
    setDebugInfo(null);
    try {
      const res = await fetch(`${BOT_URL}/api/lmstudio/health/debug`);
      const json = await res.json().catch(() => null);
      if (res.ok && json?.data) {
        setDebugInfo(json.data);
        if (json.data.healthy && json.data.url) {
          setHealthStatus((prev) => ({
            ...(prev ?? {}),
            configured: true,
            healthy: true,
            url: json.data.url,
            model: prev?.model,
          }));
        }
      } else {
        setDebugInfo({ error: json?.error || `HTTP ${res.status}` });
      }
    } catch {
      setDebugInfo({ error: 'Не удалось получить данные от бота' });
    } finally {
      setIsLoadingDebug(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  const needsPolling = healthStatus?.configured === true && healthStatus?.healthy === false;
  useEffect(() => {
    if (!needsPolling) return;
    const interval = setInterval(() => checkHealth(), 15_000);
    return () => clearInterval(interval);
  }, [needsPolling, checkHealth]);

  useEffect(() => {
    if (healthStatus?.healthy && models.length === 0 && !isLoadingModels) {
      loadModels();
    }
  }, [healthStatus?.healthy, models.length, isLoadingModels, loadModels]);

  const handleSave = () => {
    const toSave: Record<string, string> = {
      lmstudio_url: url.trim(),
      lmstudio_model: model.trim(),
      lmstudio_api_key: apiKey.trim(),
      ai_provider: provider,
    };
    saveSettings(toSave);
  };

  const handleCopyCommand = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-white/5 rounded w-1/3" />
          <div className="card space-y-4">
            <div className="h-10 bg-white/5 rounded" />
            <div className="h-10 bg-white/5 rounded" />
          </div>
        </div>
      </div>
    );
  }

  const isHealthy = healthStatus?.healthy === true;
  const isTunnelManaged = url.includes('trycloudflare.com');

  const formatUpdatedAt = (iso: string): string => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMin = Math.floor(diffMs / 60_000);
      if (diffMin < 1) return 'только что';
      if (diffMin < 60) return `${diffMin} мин назад`;
      const diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return `${diffHrs} ч назад`;
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
              border: '1px solid rgba(99,102,241,0.4)',
            }}
          >
            <Monitor className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1
              className="text-2xl font-bold text-gradient-gold"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              LM Studio
            </h1>
            <p className="text-white/50 text-sm">
              Локальные модели через Cloudflare Tunnel
            </p>
          </div>
        </div>
      </div>

      {/* Status Banner */}
      <div
        className="rounded-xl p-4 space-y-2"
        style={{
          background: isHealthy
            ? 'linear-gradient(135deg, rgba(34,197,94,0.1), rgba(34,197,94,0.05))'
            : 'linear-gradient(135deg, rgba(239,68,68,0.1), rgba(239,68,68,0.05))',
          border: `1px solid ${isHealthy ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.2)'}`,
        }}
      >
        <div className="flex items-center gap-3">
          {isCheckingHealth ? (
            <Loader2 className="w-5 h-5 text-white/50 animate-spin" />
          ) : isHealthy ? (
            <Wifi className="w-5 h-5 text-green-400" />
          ) : (
            <WifiOff className="w-5 h-5 text-red-400" />
          )}
          <div className="flex-1">
            <span className={`font-medium ${isHealthy ? 'text-green-400' : 'text-red-400'}`}>
              {isCheckingHealth
                ? 'Проверка...'
                : isHealthy
                  ? healthStatus?.source === 'heartbeat'
                    ? 'LM Studio Online (heartbeat)'
                    : 'LM Studio Online'
                  : healthStatus?.configured
                    ? 'LM Studio Offline'
                    : 'Не настроено'}
            </span>
            {healthStatus?.url && (
              <span className="text-white/30 text-sm ml-2">{healthStatus.url}</span>
            )}
          </div>
          <button
            onClick={() => checkHealth(true)}
            disabled={isCheckingHealth}
            className="p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-all"
          >
            <RefreshCw className={`w-4 h-4 ${isCheckingHealth ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Tunnel-managed indicator */}
        <div className="flex items-center gap-4 text-xs">
          {isTunnelManaged && (
            <span className="flex items-center gap-1.5 text-indigo-400/80">
              <Shield className="w-3 h-3" />
              tunnel.sh (авто)
            </span>
          )}
          {isHealthy && healthStatus?.source === 'heartbeat' && healthStatus?.heartbeatAt && (
            <span className="flex items-center gap-1.5 text-green-400/80">
              <Clock className="w-3 h-3" />
              heartbeat {formatUpdatedAt(healthStatus.heartbeatAt)}
            </span>
          )}
          {urlUpdatedAt && (
            <span className="flex items-center gap-1.5 text-white/30">
              <Clock className="w-3 h-3" />
              URL обновлён {formatUpdatedAt(urlUpdatedAt)}
            </span>
          )}
          {healthStatus?.model && (
            <span className="text-white/30 truncate">
              {healthStatus.model}
            </span>
          )}
        </div>

        {/* Debug: почему красный статус */}
        {!isHealthy && (
          <div className="mt-3 pt-3 border-t border-white/10">
            <button
              type="button"
              onClick={() => {
                setDebugExpanded(!debugExpanded);
                if (!debugExpanded && !debugInfo && !isLoadingDebug) fetchDebugInfo();
              }}
              className="flex items-center gap-2 text-xs text-red-300/80 hover:text-red-300 transition-colors"
            >
              <Bug className="w-3.5 h-3.5" />
              Почему Offline?
              {debugExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {debugExpanded && (
              <div className="mt-2 p-3 rounded-lg bg-black/20 text-xs space-y-2">
                {isLoadingDebug ? (
                  <div className="flex items-center gap-2 text-white/50">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Загрузка...
                  </div>
                ) : debugInfo ? (
                  <>
                    {debugInfo.status != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-white/50">HTTP код от LM Studio:</span>
                        <span
                          className={`font-mono font-semibold px-1.5 py-0.5 rounded ${
                            debugInfo.status === 200 ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                          }`}
                        >
                          {debugInfo.status}
                        </span>
                      </div>
                    )}
                    {debugInfo.latencyMs != null && (
                      <div className="text-white/50">
                        Задержка: {debugInfo.latencyMs} ms
                      </div>
                    )}
                    {debugInfo.error && (
                      <div className="text-red-400">{debugInfo.error}</div>
                    )}
                    {debugInfo.status === 404 && (
                      <p className="text-amber-400/90 mt-1">
                        LM Studio не отвечает на /v1/models. Убедитесь, что LM Studio запущен и модель загружена.
                      </p>
                    )}
                    {(debugInfo.status === 0 || debugInfo.error?.toLowerCase().includes('timeout') || debugInfo.error?.toLowerCase().includes('abort')) && (
                      <p className="text-amber-400/90 mt-1">
                        Бот на Render не может достучаться до туннеля. Проверьте: туннель запущен, LM Studio работает, URL в настройках совпадает с выводом tunnel.sh.
                      </p>
                    )}
                    {debugInfo.configured === false && (
                      <p className="text-amber-400/90 mt-1">
                        URL туннеля не зарегистрирован в боте. Убедитесь, что tunnel.sh успешно выполнил регистрацию (POST /api/tunnel/register). Бот на Render мог быть в режиме сна — попробуйте перезапустить tunnel.sh.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-white/50">Нажмите «Почему Offline?» для загрузки</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Provider Mode */}
      <div className="card animate-fade-in-up">
        <div className="flex items-center gap-3 mb-4">
          <Zap className="w-5 h-5 text-amber-400" />
          <h2
            className="text-lg font-semibold text-white"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Режим AI провайдера
          </h2>
        </div>

        <div className="grid gap-3">
          {(Object.entries(PROVIDER_LABELS) as [AIProvider, { label: string; desc: string }][]).map(
            ([key, { label, desc }]) => (
              <label
                key={key}
                className="flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-all"
                style={{
                  background:
                    provider === key
                      ? 'linear-gradient(135deg, rgba(255,215,0,0.1), rgba(139,92,246,0.1))'
                      : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${provider === key ? 'rgba(255,215,0,0.3)' : 'rgba(255,255,255,0.05)'}`,
                }}
              >
                <input
                  type="radio"
                  name="provider"
                  value={key}
                  checked={provider === key}
                  onChange={() => setProvider(key)}
                  className="mt-1 accent-amber-400"
                />
                <div>
                  <span className="text-white font-medium">{label}</span>
                  <p className="text-white/40 text-sm">{desc}</p>
                </div>
              </label>
            ),
          )}
        </div>
      </div>

      {/* Connection Settings */}
      <div className="card animate-fade-in-up">
        <div className="flex items-center gap-3 mb-4">
          <Server className="w-5 h-5 text-indigo-400" />
          <h2
            className="text-lg font-semibold text-white"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Подключение
          </h2>
        </div>

        <div className="space-y-4">
          <div>
            <label className="label">URL туннеля</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xxxx-xxxx.trycloudflare.com"
              className="input font-mono text-sm"
            />
            <p className="text-white/30 text-xs mt-1">
              Cloudflare Tunnel URL (без /v1 — добавится автоматически)
            </p>
          </div>

          <div>
            <label className="label">Модель</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="qwen3-14b-claude-4.5-opus-high-reasoning-distill"
              className="input font-mono text-sm"
            />
            <p className="text-white/40 text-xs mt-1">
              Или выберите из каталога моделей ниже
            </p>
          </div>

          <div>
            <label className="label">API Key (опционально)</label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="lm-studio"
              className="input font-mono text-sm"
            />
            <p className="text-white/30 text-xs mt-1">
              Обычно не требуется. По умолчанию: lm-studio
            </p>
          </div>
        </div>
      </div>

      {/* Model Picker */}
      <div className="card animate-fade-in-up">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Cpu className="w-5 h-5 text-purple-400" />
            <h2
              className="text-lg font-semibold text-white"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              Модели LM Studio
            </h2>
            {models.length > 0 && (
              <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">
                {models.length}
              </span>
            )}
          </div>
          <button
            onClick={loadModels}
            disabled={isLoadingModels}
            className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingModels ? 'animate-spin' : ''}`} />
            Обновить
          </button>
        </div>

        {isLoadingModels && models.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-white/60">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Загрузка моделей...</span>
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-8 text-white/50 text-sm">
            {isHealthy
              ? 'Нажмите «Обновить» для загрузки списка моделей'
              : 'LM Studio недоступна — запустите туннель для загрузки моделей'}
          </div>
        ) : (
          <>
            {models.length > 5 && (
              <div className="relative mb-3">
                <Search className="w-4 h-4 text-white/30 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Поиск модели..."
                  className="input pl-9 text-sm"
                />
              </div>
            )}
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {models
                .filter((m) => {
                  if (!modelSearch.trim()) return true;
                  const q = modelSearch.toLowerCase();
                  return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
                })
                .map((m) => {
                  const isSelected = model === m.id;
                  const isActive = healthStatus?.model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModel(m.id)}
                      className="w-full text-left p-3 rounded-xl transition-all group"
                      style={{
                        background: isSelected
                          ? 'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(99,102,241,0.15))'
                          : 'rgba(0,0,0,0.3)',
                        border: `1px solid ${isSelected ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.08)'}`,
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-mono text-sm truncate ${
                                isSelected ? 'text-purple-200 font-semibold' : 'text-amber-100/90 group-hover:text-white'
                              }`}
                            >
                              {m.id}
                            </span>
                            {isActive && (
                              <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/20 px-1.5 py-0.5 rounded-full whitespace-nowrap flex-shrink-0">
                                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                                active
                              </span>
                            )}
                          </div>
                          {m.name !== m.id && (
                            <span className="text-white/50 text-xs truncate block mt-0.5">
                              {m.name}
                            </span>
                          )}
                        </div>
                        {isSelected && (
                          <CheckCircle2 className="w-5 h-5 text-purple-300 flex-shrink-0" />
                        )}
                      </div>
                    </button>
                  );
                })}
            </div>
          </>
        )}
      </div>

      {/* Save Button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="btn-primary flex items-center gap-2"
        >
          {isSaving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Сохранить
        </button>
        {saveMessage && (
          <span
            className={`text-sm ${saveMessage === 'Сохранено' ? 'text-green-400' : 'text-red-400'}`}
          >
            {saveMessage}
          </span>
        )}
      </div>

      {/* Tunnel Instructions */}
      <div className="card animate-fade-in-up">
        <div className="flex items-center gap-3 mb-4">
          <Terminal className="w-5 h-5 text-emerald-400" />
          <h2
            className="text-lg font-semibold text-white"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Настройка туннеля
          </h2>
        </div>

        <div className="space-y-5 text-sm">
          {/* Auto mode */}
          <div>
            <p className="text-white/80 font-medium mb-1">Автоматический режим (рекомендуется)</p>
            <p className="text-white/40 text-xs mb-3">
              Скрипт сам запустит cloudflared, получит URL и обновит настройки бота.
            </p>

            <div className="space-y-3">
              <div>
                <p className="text-white/60 mb-2">1. Запусти LM Studio и загрузи модель</p>
              </div>

              <div>
                <p className="text-white/60 mb-2">2. Запусти tunnel.sh:</p>
                <CodeBlock
                  code="cd ~/Amina && ./tunnel.sh"
                  onCopy={handleCopyCommand}
                  copied={copied}
                />
              </div>

              <div>
                <p className="text-white/60 mb-2">3. Для автозапуска при логине:</p>
                <CodeBlock
                  code="systemctl --user enable --now amina-tunnel"
                  onCopy={handleCopyCommand}
                  copied={copied}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-white/5 pt-4">
            <p className="text-white/80 font-medium mb-1">Управление сервисом</p>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <CodeBlock
                code="systemctl --user status amina-tunnel"
                onCopy={handleCopyCommand}
                copied={copied}
              />
              <CodeBlock
                code="systemctl --user restart amina-tunnel"
                onCopy={handleCopyCommand}
                copied={copied}
              />
              <CodeBlock
                code="journalctl --user -u amina-tunnel -f"
                onCopy={handleCopyCommand}
                copied={copied}
              />
              <CodeBlock
                code="systemctl --user stop amina-tunnel"
                onCopy={handleCopyCommand}
                copied={copied}
              />
            </div>
          </div>

          <div className="p-3 rounded-xl bg-indigo-500/5 border border-indigo-500/20">
            <p className="text-indigo-400/80 text-xs">
              <strong>Как это работает:</strong> tunnel.sh ждёт LM Studio на
              localhost:1234, запускает cloudflared, извлекает URL и автоматически
              регистрирует его на боте. При падении туннеля или LM Studio скрипт
              автоматически перезапускает всё. URL в поле выше обновляется автоматически.
            </p>
          </div>

          <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
            <p className="text-amber-400/90 text-xs font-medium mb-1">Render Free Tier: Keep-Alive</p>
            <p className="text-white/50 text-xs">
              Бот на Render засыпает через 15 мин без запросов. Heartbeat от туннеля не дойдёт до спящего бота.
              Настрой <strong>UptimeRobot</strong> (бесплатно): мониторинг{' '}
              <code className="text-amber-300/80">https://amina-bot.onrender.com/health</code> каждые 14 мин.
              Альтернатива: cron-job.org или аналогичный сервис.
            </p>
          </div>

          {/* Manual fallback */}
          <div className="border-t border-white/5 pt-4">
            <p className="text-white/50 text-xs mb-2">Ручной режим (если tunnel.sh не подходит):</p>
            <CodeBlock
              code="cloudflared tunnel --url http://localhost:1234"
              onCopy={handleCopyCommand}
              copied={copied}
            />
            <p className="text-white/30 text-xs mt-2">
              Скопируй URL из вывода cloudflared и вставь в поле выше вручную.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

interface CodeBlockProps {
  code: string;
  onCopy: (text: string) => void;
  copied: boolean;
}

const CodeBlock = ({ code, onCopy, copied }: CodeBlockProps) => (
  <div
    className="flex items-center gap-2 p-3 rounded-lg font-mono text-xs overflow-x-auto"
    style={{
      background: 'rgba(0,0,0,0.4)',
      border: '1px solid rgba(255,255,255,0.05)',
    }}
  >
    <code className="text-emerald-300 flex-1 whitespace-pre">{code}</code>
    <button
      onClick={() => onCopy(code)}
      className="flex-shrink-0 p-1.5 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-all"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  </div>
);

export { LMStudioPage };
