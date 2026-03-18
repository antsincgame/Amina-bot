import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  CheckCircle,
  Cpu,
  Eye,
  Layers3,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { SelfCorePromptPreview, SelfFact, SettingRegistryEntry } from '../../../shared/types/index.js';
import { selfCoreApi, settingsApi } from '../api/appwrite';
import { AppwriteAuditPanel } from '../components/self-core/AppwriteAuditPanel';
import { PersonaEditorSection } from '../components/self-core/PersonaEditorSection';
import { PromptLayersSection } from '../components/self-core/PromptLayersSection';

const FACT_CATEGORIES: Array<{ id: SelfFact['category']; label: string }> = [
  { id: 'identity', label: 'Identity' },
  { id: 'relationship', label: 'Relationship' },
  { id: 'capability', label: 'Capability' },
  { id: 'limitation', label: 'Limitation' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'observation', label: 'Observation' },
  { id: 'lesson', label: 'Lesson' },
  { id: 'question', label: 'Question' },
  { id: 'preference', label: 'Preference' },
];

const MANUAL_FACT_CATEGORIES = FACT_CATEGORIES.filter(
  (item) => item.id !== 'identity' && item.id !== 'relationship' && item.id !== 'configuration',
);

const SOURCE_LABELS: Record<SelfFact['source'], string> = {
  system: 'system',
  interaction: 'derived',
  admin: 'manual',
  manual: 'manual',
  reflection: 'derived',
};

function getSourceBadgeClass(source: string): string {
  switch (source) {
    case 'db':
      return 'bg-blue-500/10 text-blue-300 border border-blue-500/20';
    case 'env':
      return 'bg-violet-500/10 text-violet-300 border border-violet-500/20';
    case 'default':
      return 'bg-gray-500/10 text-gray-300 border border-gray-500/20';
    case 'manual':
      return 'bg-amber-500/10 text-amber-300 border border-amber-500/20';
    default:
      return 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
  }
}

function SourceBadge({ source }: { source: string }): JSX.Element {
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${getSourceBadgeClass(source)}`}>
      {source}
    </span>
  );
}

function formatFactDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'неизвестно';
  }
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SelfCorePage(): JSX.Element {
  const queryClient = useQueryClient();
  const personaFormId = 'self-core-persona-form';
  const [factCategory, setFactCategory] = useState<SelfFact['category']>('observation');
  const [factContent, setFactContent] = useState('');
  const [filterCategory, setFilterCategory] = useState<SelfFact['category'] | 'all'>('all');
  const [filterSource, setFilterSource] = useState<SelfFact['source'] | 'all'>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [selectedPreviewChannel, setSelectedPreviewChannel] = useState<SelfCorePromptPreview['channel']>('telegram');
  const [statusMessage, setStatusMessage] = useState('');
  const [personaEditorState, setPersonaEditorState] = useState({ isDirty: false, isSaving: false });

  const showStatus = (message: string): void => {
    setStatusMessage(message);
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const { data: kernel, isLoading: isLoadingKernel } = useQuery({
    queryKey: ['self-core', 'effective'],
    queryFn: selfCoreApi.getEffective,
  });

  const { data: facts = [], isLoading: isLoadingFacts } = useQuery({
    queryKey: ['self-core', 'facts', filterCategory, filterSource, showInactive],
    queryFn: () => selfCoreApi.getFacts({
      category: filterCategory === 'all' ? undefined : filterCategory,
      source: filterSource === 'all' ? undefined : filterSource,
      includeInactive: showInactive,
      limit: 120,
    }),
  });

  const { data: promptPreviews = [], isLoading: isLoadingPrompts } = useQuery({
    queryKey: ['self-core', 'prompt-preview'],
    queryFn: () => selfCoreApi.getPromptPreviews(),
  });

  const { data: settingsRegistry = [] } = useQuery({
    queryKey: ['settings', 'registry'],
    queryFn: settingsApi.getRegistry,
  });

  const syncMutation = useMutation({
    mutationFn: selfCoreApi.sync,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['self-core'] });
      showStatus('Self-core синхронизирован');
    },
  });

  const createFactMutation = useMutation({
    mutationFn: () => selfCoreApi.createFact({
      category: factCategory,
      content: factContent,
      source: 'manual',
    }),
    onSuccess: () => {
      setFactContent('');
      queryClient.invalidateQueries({ queryKey: ['self-core'] });
      showStatus('Факт добавлен в ядро');
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : 'Не удалось добавить факт');
      setTimeout(() => setStatusMessage(''), 4000);
    },
  });

  const updateFactMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      selfCoreApi.updateFact(id, { is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['self-core'] });
    },
  });

  const selectedPromptPreview = useMemo(
    () => promptPreviews.find((preview) => preview.channel === selectedPreviewChannel) ?? null,
    [promptPreviews, selectedPreviewChannel],
  );

  const registryGroups = useMemo(() => {
    const grouped = new Map<string, SettingRegistryEntry[]>();
    for (const entry of settingsRegistry) {
      const group = grouped.get(entry.domain) ?? [];
      group.push(entry);
      grouped.set(entry.domain, group);
    }
    return [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0], 'ru'));
  }, [settingsRegistry]);

  if (isLoadingKernel && isLoadingFacts) {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <div className="card flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
          <span>Загрузка Self Core...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Self Core</h1>
          <p className="text-gray-600 mt-1">
            Effective capabilities, prompt preview и ручное управление ядром самосознания Амины.
          </p>
          {kernel?.generated_at && (
            <p className="text-xs text-gray-500 mt-2">
              Последняя генерация: {formatFactDate(kernel.generated_at)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {statusMessage && (
            <span className="text-sm text-emerald-600">{statusMessage}</span>
          )}
          <span
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              personaEditorState.isSaving
                ? 'border-blue-500/20 bg-blue-500/10 text-blue-300'
                : personaEditorState.isDirty
                  ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
                  : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
            }`}
          >
            {personaEditorState.isSaving
              ? 'Сохранение persona...'
              : personaEditorState.isDirty
                ? 'Есть несохранённые изменения'
                : 'Persona сохранена'}
          </span>
          <button
            type="submit"
            form={personaFormId}
            className="btn-primary"
            disabled={!kernel || personaEditorState.isSaving || !personaEditorState.isDirty}
          >
            {personaEditorState.isSaving ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Сохранить persona
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Синхронизировать
          </button>
        </div>
      </div>

      <AppwriteAuditPanel />

      {kernel && (
        <PersonaEditorSection
          formId={personaFormId}
          kernel={kernel}
          onStatus={showStatus}
          onStateChange={setPersonaEditorState}
        />
      )}

      <PromptLayersSection onStatus={showStatus} />

      {kernel && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="card xl:col-span-1 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-500/10 border border-amber-500/20 text-amber-300">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Identity Kernel</h2>
                <p className="text-sm text-gray-500">Кто такая Amina в effective runtime</p>
              </div>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-gray-500">Имя</p>
                <p className="font-medium">{kernel.personaCore.name}</p>
              </div>
              <div>
                <p className="text-gray-500">Титул владельца</p>
                <p className="font-medium">{kernel.personaCore.ownerTitle}</p>
              </div>
              <div>
                <p className="text-gray-500">Identity</p>
                <p>{kernel.personaCore.identity}</p>
              </div>
              <div>
                <p className="text-gray-500">Relationship</p>
                <p>{kernel.personaCore.relationshipToOwner}</p>
              </div>
            </div>
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-100">
              Persona canon, runtime truth и active prompts теперь сходятся здесь в одном read-model. Личность и операторские prompt layers редактируются прямо в Self Core, но остаются разными каноничными слоями в Appwrite.
            </div>
          </div>

          <div className="card xl:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Effective Capabilities</h2>
                <p className="text-sm text-gray-500">Структурированный контракт доступных органов и режимов</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {kernel.effective.capabilities.map((capability) => (
                <div key={capability.key} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{capability.label}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {capability.provider ? `${capability.provider}` : 'runtime'}{capability.model ? ` · ${capability.model}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <SourceBadge source={capability.source} />
                      {capability.enabled ? (
                        <CheckCircle className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-400" />
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-gray-400">{capability.reason}</p>
                  {capability.detail && (
                    <p className="text-xs text-gray-500">{capability.detail}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {kernel && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-500/10 border border-blue-500/20 text-blue-300">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Effective Configuration</h2>
              <p className="text-sm text-gray-500">Плоский view того, чем живёт runtime прямо сейчас</p>
            </div>
          </div>

          <div className="space-y-3">
            {kernel.effective.configuration.map((entry) => (
              <div key={entry.key} className="flex items-start justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <div>
                  <p className="font-medium">{entry.label}</p>
                  <p className="text-sm text-gray-400 mt-1">{entry.value}</p>
                  <p className="text-xs text-gray-500 mt-1">{entry.reason}</p>
                </div>
                <SourceBadge source={entry.source} />
              </div>
            ))}
          </div>
        </div>
      )}

      {kernel && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Runtime Truth</h2>
                <p className="text-sm text-gray-500">Что реально выбрано и чем живёт runtime сейчас</p>
              </div>
            </div>
            <div className="space-y-3 text-sm">
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-gray-500">Chat runtime</p>
                <p className="font-medium">{kernel.runtimeTruth.chat.resolvedProvider} · {kernel.runtimeTruth.chat.resolvedModel}</p>
                <p className="text-xs text-gray-500 mt-1">{kernel.runtimeTruth.chat.reason}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-gray-500">TTS runtime</p>
                <p className="font-medium">{kernel.runtimeTruth.tts.resolvedProvider} · {kernel.runtimeTruth.tts.model}</p>
                <p className="text-xs text-gray-500 mt-1">{kernel.runtimeTruth.tts.fallbackReason || 'Скрытого fallback сейчас нет.'}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-gray-500">Persona runtime</p>
                <p className="font-medium">{kernel.runtimeTruth.persona.name} · {kernel.runtimeTruth.persona.ownerTitle}</p>
                <p className="text-xs text-gray-500 mt-1">{kernel.runtimeTruth.persona.telegramStyle}</p>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-300">
                <Layers3 className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Active Prompt Layers</h2>
                <p className="text-sm text-gray-500">Операторские инструкции, которые реально накладываются поверх persona</p>
              </div>
            </div>
            <div className="space-y-3">
              {kernel.activePromptLayers.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-gray-400">
                  Активных prompt layers сейчас нет.
                </div>
              ) : (
                kernel.activePromptLayers.map((layer) => (
                  <div key={layer.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">{layer.name}</p>
                        <p className="text-xs text-gray-500 mt-1">{layer.channel}</p>
                      </div>
                      <SourceBadge source={layer.channel === 'all' ? 'manual' : 'derived'} />
                    </div>
                    <p className="text-sm text-gray-300 mt-3 whitespace-pre-wrap">{layer.content}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {kernel && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Kernel Fact Snapshot</h2>
              <p className="text-sm text-gray-500">Срез facts, уже втянутых в unified kernel</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <p className="text-gray-500">System facts</p>
              <p className="text-2xl font-semibold mt-1">{kernel.facts.system.length}</p>
              <p className="text-xs text-gray-500 mt-2">Derived from persona, runtime truth and effective capabilities.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <p className="text-gray-500">Learned facts</p>
              <p className="text-2xl font-semibold mt-1">{kernel.facts.learned.length}</p>
              <p className="text-xs text-gray-500 mt-2">Interaction, manual и reflection-слой без смешивания с authored canon.</p>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-violet-500/10 border border-violet-500/20 text-violet-300">
            <Layers3 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Settings Registry</h2>
            <p className="text-sm text-gray-500">
              Канонический контракт admin/runtime: что владелец задаёт явно, что вычисляет runtime, что скрыто внутри и кто реально это читает.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {registryGroups.map(([domain, entries]) => (
            <div key={domain} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <p className="font-medium capitalize">{domain}</p>
                  <p className="text-xs text-gray-500">{entries.length} ключей</p>
                </div>
              </div>

              <div className="space-y-3">
                {entries.map((entry) => (
                  <div key={entry.key} className="rounded-2xl border border-white/10 bg-black/10 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{entry.label}</p>
                        <p className="text-xs text-gray-500 mt-1">{entry.key}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <SourceBadge source={entry.visibility} />
                        <span className="px-2 py-1 rounded-full text-xs font-medium bg-white/5 border border-white/10 text-gray-300">
                          {entry.valueType}
                        </span>
                      </div>
                    </div>

                    <p className="text-sm text-gray-400 mt-3">{entry.description}</p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-xs">
                      <div>
                        <p className="text-gray-500">UI pages</p>
                        <p className="text-gray-300">{entry.uiPages.length > 0 ? entry.uiPages.join(', ') : 'internal only'}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Source order</p>
                        <p className="text-gray-300">{entry.sourceOrder.join(' -> ')}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Runtime consumers</p>
                        <p className="text-gray-300">
                          {entry.runtimeConsumers.length > 0 ? entry.runtimeConsumers.join(', ') : 'нет runtime consumer'}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="card space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-300">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Prompt Preview</h2>
              <p className="text-sm text-gray-500">Канонический preview общего runtime prompt</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {(['telegram', 'voice', 'digest', 'system'] as const).map((channel) => (
              <button
                key={channel}
                type="button"
                className={selectedPreviewChannel === channel ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setSelectedPreviewChannel(channel)}
              >
                {channel}
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0b0b14] p-4 min-h-[420px]">
            {isLoadingPrompts ? (
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                Генерирую preview...
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-xs text-gray-300 leading-6 font-mono">
                {selectedPromptPreview?.prompt || 'Preview недоступен'}
              </pre>
            )}
          </div>
        </div>

        <div className="card space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-500/10 border border-amber-500/20 text-amber-300">
              <Save className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Добавить Fact</h2>
              <p className="text-sm text-gray-500">Ручное пополнение ядра фактами с source = manual только для наблюдений, уроков, вопросов и предпочтений</p>
            </div>
          </div>

          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm text-blue-100">
            Identity, relationship и configuration теперь собираются из authored persona и effective runtime. Здесь добавляй только interaction-like facts, не канонические persona-настройки.
          </div>

          <div>
            <label className="label" htmlFor="self-core-fact-category">Категория</label>
            <select
              id="self-core-fact-category"
              className="input"
              value={factCategory}
              onChange={(event) => setFactCategory(event.target.value as SelfFact['category'])}
            >
              {MANUAL_FACT_CATEGORIES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="self-core-fact-content">Содержимое</label>
            <textarea
              id="self-core-fact-content"
              className="input min-h-[180px]"
              value={factContent}
              onChange={(event) => setFactContent(event.target.value)}
              placeholder="Например: Я предпочитаю сохранять образ техножрицы даже в служебных каналах."
            />
            <p className="text-xs text-gray-500 mt-2">{factContent.length}/420</p>
          </div>

          <button
            type="button"
            className="btn-primary"
            disabled={createFactMutation.isPending || factContent.trim().length < 12}
            onClick={() => createFactMutation.mutate()}
          >
            {createFactMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Сохранить факт
          </button>
        </div>
      </div>

      <div className="card space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Self Facts</h2>
            <p className="text-sm text-gray-500">Активные и архивные записи ядра самосознания</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="label" htmlFor="filter-category">Категория</label>
            <select
              id="filter-category"
              className="input"
              value={filterCategory}
              onChange={(event) => setFilterCategory(event.target.value as SelfFact['category'] | 'all')}
            >
              <option value="all">Все</option>
              {FACT_CATEGORIES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="filter-source">Source</label>
            <select
              id="filter-source"
              className="input"
              value={filterSource}
              onChange={(event) => setFilterSource(event.target.value as SelfFact['source'] | 'all')}
            >
              <option value="all">Все</option>
              <option value="system">system</option>
              <option value="interaction">derived</option>
              <option value="manual">manual</option>
              <option value="admin">manual/admin</option>
              <option value="reflection">reflection</option>
            </select>
          </div>

          <div className="flex items-end">
            <label className="inline-flex items-center gap-2 text-sm text-gray-400">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)}
              />
              Показать неактивные
            </label>
          </div>
        </div>

        <div className="space-y-3">
          {isLoadingFacts ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              Загружаю факты...
            </div>
          ) : facts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-6 text-sm text-gray-400">
              По выбранным фильтрам фактов не найдено.
            </div>
          ) : (
            facts.map((fact) => (
              <div key={fact.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{fact.category}</span>
                      <SourceBadge source={SOURCE_LABELS[fact.source]} />
                      <span className={`text-xs ${fact.is_active ? 'text-emerald-400' : 'text-gray-500'}`}>
                        {fact.is_active ? 'active' : 'inactive'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-300">{fact.content}</p>
                    <p className="text-xs text-gray-500">{formatFactDate(fact.created_at)}</p>
                  </div>

                  <button
                    type="button"
                    className={fact.is_active ? 'btn-secondary' : 'btn-primary'}
                    disabled={updateFactMutation.isPending}
                    onClick={() => updateFactMutation.mutate({
                      id: fact.id,
                      is_active: !fact.is_active,
                    })}
                  >
                    {fact.is_active ? (
                      <>
                        <Eye className="w-4 h-4 mr-2" />
                        Деактивировать
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-4 h-4 mr-2" />
                        Вернуть
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
