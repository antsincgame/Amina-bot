import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { fetchOpenRouterModels, filterFreeModels, filterPremiumModels, transformToSimpleModel } from '../api/openrouter';
import { Save, Loader2, RefreshCw, Info, Download } from 'lucide-react';

const settingsSchema = z.object({
  openrouter_model: z.string().min(1, 'Выберите модель'),
  custom_model_override: z.string().optional(),
  max_tokens: z.coerce.number().min(100).max(16000),
  temperature: z.coerce.number().min(0).max(2),
});

type SettingsForm = z.infer<typeof settingsSchema>;

// All FREE OpenRouter models (verified 2026-02-04)
// Use "Обновить модели" button to get latest list from API
const FREE_MODELS = [
  { id: 'openrouter/free', name: '🔄 Free Router (авто-выбор лучшей)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: '🦙 Meta: Llama 3.3 70B Instruct' },
  { id: 'meta-llama/llama-3.2-3b-instruct:free', name: '🦙 Meta: Llama 3.2 3B Instruct' },
  { id: 'deepseek/deepseek-r1-0528:free', name: '🔮 DeepSeek: R1 0528' },
  { id: 'qwen/qwen3-coder:free', name: '💻 Qwen: Qwen3 Coder' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct:free', name: '🌀 Mistral: Small 3.1 24B' },
  { id: 'google/gemma-3-27b-it:free', name: '💎 Google: Gemma 3 27B' },
  { id: 'google/gemma-3-12b-it:free', name: '💎 Google: Gemma 3 12B' },
  { id: 'google/gemma-3-4b-it:free', name: '💎 Google: Gemma 3 4B' },
  { id: 'nvidia/nemotron-nano-12b-v2-vl:free', name: '🟢 NVIDIA: Nemotron Nano 12B VL' },
  { id: 'nvidia/nemotron-nano-9b-v2:free', name: '🟢 NVIDIA: Nemotron Nano 9B' },
  { id: 'stepfun/step-3.5-flash:free', name: '⚡ StepFun: Step 3.5 Flash' },
  { id: 'arcee-ai/trinity-large-preview:free', name: '🔺 Arcee AI: Trinity Large' },
  { id: 'arcee-ai/trinity-mini:free', name: '🔺 Arcee AI: Trinity Mini' },
  { id: 'tngtech/deepseek-r1t-chimera:free', name: '🐉 TNG: DeepSeek R1T Chimera' },
  { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', name: '🐬 Dolphin Mistral 24B' },
];

// Popular PREMIUM models
const PREMIUM_MODELS = [
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus' },
  { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'google/gemini-pro', name: 'Gemini Pro' },
  { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large' },
  { id: 'meta-llama/llama-3-70b-instruct', name: 'Llama 3 70B' },
];

const CUSTOM_MODEL_VALUE = '__custom__';

const SettingsPage = () => {
  const queryClient = useQueryClient();
  const [customModelInput, setCustomModelInput] = useState('');
  const [freeModels, setFreeModels] = useState(FREE_MODELS);
  const [premiumModels, setPremiumModels] = useState(PREMIUM_MODELS);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      openrouter_model: 'openrouter/free',
      custom_model_override: '',
      max_tokens: 2048,
      temperature: 0.7,
    },
  });

  const selectedModel = watch('openrouter_model');
  const customModelOverride = watch('custom_model_override');

  // Refresh models from OpenRouter API
  const handleRefreshModels = async () => {
    setIsRefreshingModels(true);
    try {
      const response = await fetchOpenRouterModels(undefined, 300);
      const free = filterFreeModels(response.models).map(transformToSimpleModel);
      const premium = filterPremiumModels(response.models)
        .slice(0, 20) // Top 20 premium
        .map(transformToSimpleModel);
      
      setFreeModels(free);
      setPremiumModels(premium);
      setRefreshMessage(`✅ Загружено ${free.length} бесплатных и ${premium.length} премиум моделей`);
      setTimeout(() => setRefreshMessage(''), 3000);
    } catch {
      setRefreshMessage('❌ Ошибка загрузки моделей');
      setTimeout(() => setRefreshMessage(''), 3000);
    } finally {
      setIsRefreshingModels(false);
    }
  };

  // Load settings into form
  useEffect(() => {
    if (settings) {
      const settingsMap = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      const modelValue = settingsMap['openrouter_model'] ?? 'openrouter/free';
      const customOverride = settingsMap['custom_model_override'] ?? '';
      
      // Check if model is in current lists (state or hardcoded fallback)
      const allKnownModels = [...freeModels, ...premiumModels];
      const isKnownModel = allKnownModels.some(m => m.id === modelValue);
      
      if (!isKnownModel && !customOverride) {
        // Custom model - set select to __custom__ and store model in separate input
        setCustomModelInput(modelValue);
        reset({
          openrouter_model: CUSTOM_MODEL_VALUE,
          custom_model_override: '',
          max_tokens: Number(settingsMap['max_tokens']) || 2048,
          temperature: Number(settingsMap['temperature']) || 0.7,
        });
      } else {
        // Known model or custom_model_override exists - just set it
        reset({
          openrouter_model: modelValue,
          custom_model_override: customOverride,
          max_tokens: Number(settingsMap['max_tokens']) || 2048,
          temperature: Number(settingsMap['temperature']) || 0.7,
        });
      }
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsForm) => {
    // Priority: custom_model_override > custom select > normal select
    let actualModel = data.openrouter_model;
    
    if (data.custom_model_override && data.custom_model_override.trim()) {
      // Custom override has highest priority
      actualModel = data.custom_model_override.trim();
    } else if (data.openrouter_model === CUSTOM_MODEL_VALUE) {
      // If custom select is chosen, use the custom input
      actualModel = customModelInput;
    }

    saveSettings({
      openrouter_model: actualModel,
      custom_model_override: data.custom_model_override || '',
      max_tokens: String(data.max_tokens),
      temperature: String(data.temperature),
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="card space-y-4">
            <div className="h-10 bg-gray-200 rounded" />
            <div className="h-10 bg-gray-200 rounded" />
            <div className="h-10 bg-gray-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Настройки AI</h1>
        <p className="text-gray-600 mt-1">
          Конфигурация модели и параметров генерации
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* OpenRouter Settings */}
        <div className="card">
          <h3 className="font-semibold text-lg mb-4">Параметры OpenRouter</h3>
          
          <div className="space-y-4">
            {/* Model Selection with Refresh Button */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="openrouter_model" className="label mb-0">
                  Модель AI
                </label>
                <button
                  type="button"
                  onClick={handleRefreshModels}
                  disabled={isRefreshingModels}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-amber-500 to-orange-500 rounded-lg hover:from-amber-600 hover:to-orange-600 transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isRefreshingModels ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Загрузка...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Обновить модели
                    </>
                  )}
                </button>
              </div>
              
              {refreshMessage && (
                <div className={`text-sm p-2 rounded ${refreshMessage.startsWith('✅') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {refreshMessage}
                </div>
              )}
              
              <select
                id="openrouter_model"
                className="input bg-white text-gray-900"
                style={{ colorScheme: 'light' }}
                {...register('openrouter_model')}
              >
                <optgroup label={`🆓 Бесплатные модели (${freeModels.length} шт)`} className="bg-white text-gray-900">
                  {freeModels.map((model) => (
                    <option 
                      key={model.id} 
                      value={model.id}
                      className="bg-white text-gray-900 py-1"
                    >
                      {model.name}
                    </option>
                  ))}
                </optgroup>
                
                <optgroup label={`💎 Премиум модели (${premiumModels.length} шт)`} className="bg-white text-gray-900">
                  {premiumModels.map((model) => (
                    <option 
                      key={model.id} 
                      value={model.id}
                      className="bg-white text-gray-900 py-1"
                    >
                      {model.name}
                    </option>
                  ))}
                </optgroup>
                
                <optgroup label="⚙️ Другое" className="bg-white text-gray-900">
                  <option 
                    value={CUSTOM_MODEL_VALUE}
                    className="bg-white text-gray-900 py-1 font-medium"
                  >
                    ✏️ Другая модель (ввести вручную)
                  </option>
                </optgroup>
              </select>
              
              {errors.openrouter_model && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.openrouter_model.message}
                </p>
              )}
              
              <p className="mt-2 text-xs text-gray-500">
                🆓 Бесплатные модели не требуют оплаты. Премиум модели мощнее, но платные.
              </p>
            </div>

            {/* Custom Model Input (shown when "Other" is selected) */}
            {selectedModel === CUSTOM_MODEL_VALUE && (
              <div className="border-l-4 border-primary-500 pl-4 py-2 bg-gray-50 rounded-r">
                <label htmlFor="custom_model" className="label text-sm">
                  ID Модели
                </label>
                <input
                  id="custom_model"
                  type="text"
                  className="input bg-white text-gray-900 font-mono text-sm"
                  style={{ colorScheme: 'light' }}
                  placeholder="provider/model-name (например: deepseek/deepseek-chat)"
                  value={customModelInput}
                  onChange={(e) => setCustomModelInput(e.target.value)}
                />
                <p className="mt-2 text-xs text-gray-600">
                  💡 Найди модели на{' '}
                  <a 
                    href="https://openrouter.ai/models" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="text-primary-600 hover:underline font-medium"
                  >
                    openrouter.ai/models
                  </a>
                  {' '}и скопируй ID модели.
                </p>
              </div>
            )}

            {/* Max Tokens & Temperature */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="max_tokens" className="label">
                  Max Tokens
                </label>
                <input
                  id="max_tokens"
                  type="number"
                  className="input bg-white text-gray-900"
                  style={{ colorScheme: 'light' }}
                  min={100}
                  max={16000}
                  {...register('max_tokens')}
                />
                {errors.max_tokens && (
                  <p className="mt-1 text-sm text-red-600">
                    {errors.max_tokens.message}
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-500">
                  Максимальная длина ответа (100-16000)
                </p>
              </div>
              <div>
                <label htmlFor="temperature" className="label">
                  Temperature
                </label>
                <input
                  id="temperature"
                  type="number"
                  className="input bg-white text-gray-900"
                  style={{ colorScheme: 'light' }}
                  min={0}
                  max={2}
                  step={0.1}
                  {...register('temperature')}
                />
                {errors.temperature && (
                  <p className="mt-1 text-sm text-red-600">
                    {errors.temperature.message}
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-500">
                  Креативность: 0 = точный, 2 = творческий
                </p>
              </div>
            </div>

            {/* Custom Model Override (highest priority) */}
            <div className="border-2 border-primary-500 rounded-lg p-4 bg-primary-50">
              <div className="flex items-start gap-2 mb-2">
                <Info className="w-5 h-5 text-primary-600 mt-0.5 flex-shrink-0" />
                <div>
                  <label htmlFor="custom_model_override" className="label text-primary-900 mb-1">
                    🎯 Ручной ввод модели (приоритет над селектором)
                  </label>
                  <p className="text-xs text-primary-700 mb-2">
                    Если здесь введена модель, она будет использоваться вместо выбранной выше
                  </p>
                </div>
              </div>
              <input
                id="custom_model_override"
                type="text"
                className="input bg-white text-gray-900 font-mono text-sm"
                style={{ colorScheme: 'light' }}
                placeholder="Оставьте пустым для использования селектора или введите: provider/model-name"
                {...register('custom_model_override')}
              />
              {customModelOverride && customModelOverride.trim() && (
                <div className="mt-2 p-2 bg-green-100 border border-green-300 rounded text-sm text-green-800">
                  ✅ Активна модель: <code className="font-mono font-semibold">{customModelOverride}</code>
                </div>
              )}
              <p className="mt-2 text-xs text-gray-600">
                💡 Найди модели: <a 
                  href="https://openrouter.ai/models" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="text-primary-600 hover:underline font-medium"
                >
                  openrouter.ai/models
                </a>
              </p>
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="flex items-start gap-2 p-4 rounded-lg bg-blue-50 text-blue-700 text-sm">
          <Info className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">API ключ настраивается в Render</p>
            <p className="mt-1 text-blue-600">
              Переменная <code className="bg-blue-100 px-1 rounded">OPENROUTER_API_KEY</code> задаётся в Environment Variables сервиса на Render Dashboard.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => reset()}
            disabled={!isDirty}
            className="btn-secondary"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Сбросить
          </button>
          <button
            type="submit"
            disabled={isSaving || !isDirty}
            className="btn-primary"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Сохранение...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Сохранить
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

export default SettingsPage;
