import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, RefreshCw, Info } from 'lucide-react';

const settingsSchema = z.object({
  openrouter_model: z.string().min(1, 'Выберите модель'),
  max_tokens: z.coerce.number().min(100).max(16000),
  temperature: z.coerce.number().min(0).max(2),
});

type SettingsForm = z.infer<typeof settingsSchema>;

// All FREE OpenRouter models (pricing.prompt = "0" and pricing.completion = "0")
const FREE_MODELS = [
  { id: 'openrouter/free', name: 'Free Models Router (авто-выбор)' },
  { id: 'stepfun/step-3.5-flash:free', name: 'StepFun: Step 3.5 Flash' },
  { id: 'arcee-ai/trinity-large-preview:free', name: 'Arcee AI: Trinity Large Preview' },
  { id: 'upstage/solar-pro-3:free', name: 'Upstage: Solar Pro 3' },
  { id: 'liquid/lfm-2.5-1.2b-thinking:free', name: 'LiquidAI: LFM2.5-1.2B-Thinking' },
  { id: 'liquid/lfm-2.5-1.2b-instruct:free', name: 'LiquidAI: LFM2.5-1.2B-Instruct' },
  { id: 'allenai/molmo-2-8b:free', name: 'AllenAI: Molmo2 8B' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'NVIDIA: Nemotron 3 Nano 30B A3B' },
  { id: 'arcee-ai/trinity-mini:free', name: 'Arcee AI: Trinity Mini' },
  { id: 'tngtech/tng-r1t-chimera:free', name: 'TNG: R1T Chimera' },
  { id: 'qwen/qwen3.5-72b-instruct:free', name: 'Qwen: Qwen3.5 72B Instruct' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct' },
  { id: 'meta-llama/llama-3.2-90b-vision-instruct:free', name: 'Meta: Llama 3.2 90B Vision Instruct' },
  { id: 'meta-llama/llama-3.2-11b-vision-instruct:free', name: 'Meta: Llama 3.2 11B Vision Instruct' },
  { id: 'meta-llama/llama-3.2-3b-instruct:free', name: 'Meta: Llama 3.2 3B Instruct' },
  { id: 'meta-llama/llama-3.2-1b-instruct:free', name: 'Meta: Llama 3.2 1B Instruct' },
  { id: 'google/gemini-flash-1.5:free', name: 'Google: Gemini Flash 1.5' },
  { id: 'google/gemini-flash-1.5-8b:free', name: 'Google: Gemini Flash 1.5 8B' },
  { id: 'google/gemini-pro-1.5:free', name: 'Google: Gemini Pro 1.5' },
  { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral: Mistral 7B Instruct' },
  { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Nous Research: Hermes 3 Llama 3.1 405B' },
  { id: 'microsoft/phi-4:free', name: 'Microsoft: Phi-4' },
  { id: 'openai/gpt-4o-mini:free', name: 'OpenAI: GPT-4o Mini' },
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
      max_tokens: 2048,
      temperature: 0.7,
    },
  });

  const selectedModel = watch('openrouter_model');

  // Load settings into form
  useEffect(() => {
    if (settings) {
      const settingsMap = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      const modelValue = settingsMap['openrouter_model'] ?? 'openrouter/free';
      
      // Check if model is in predefined lists
      const allPredefinedModels = [...FREE_MODELS, ...PREMIUM_MODELS];
      const isKnownModel = allPredefinedModels.some(m => m.id === modelValue);
      
      if (!isKnownModel) {
        // Custom model - set select to __custom__ and store model in separate input
        setCustomModelInput(modelValue);
        reset({
          openrouter_model: CUSTOM_MODEL_VALUE,
          max_tokens: Number(settingsMap['max_tokens']) || 2048,
          temperature: Number(settingsMap['temperature']) || 0.7,
        });
      } else {
        // Known model - just set it
        reset({
          openrouter_model: modelValue,
          max_tokens: Number(settingsMap['max_tokens']) || 2048,
          temperature: Number(settingsMap['temperature']) || 0.7,
        });
      }
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsForm) => {
    // If custom model is selected, use the custom input value
    const actualModel = data.openrouter_model === CUSTOM_MODEL_VALUE 
      ? customModelInput 
      : data.openrouter_model;

    saveSettings({
      openrouter_model: actualModel,
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
            {/* Model Selection */}
            <div>
              <label htmlFor="openrouter_model" className="label">
                Модель AI
              </label>
              
              <select
                id="openrouter_model"
                className="input bg-white text-gray-900"
                style={{ colorScheme: 'light' }}
                {...register('openrouter_model')}
              >
                <optgroup label="🆓 Бесплатные модели (23 шт)" className="bg-white text-gray-900">
                  {FREE_MODELS.map((model) => (
                    <option 
                      key={model.id} 
                      value={model.id}
                      className="bg-white text-gray-900 py-1"
                    >
                      {model.name}
                    </option>
                  ))}
                </optgroup>
                
                <optgroup label="💎 Премиум модели" className="bg-white text-gray-900">
                  {PREMIUM_MODELS.map((model) => (
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
